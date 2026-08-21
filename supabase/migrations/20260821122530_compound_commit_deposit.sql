-- ============================================================================
-- Record a deposit. One ledger entry, seq assigned server-side.
-- ============================================================================
--
-- No units_delta and no nav_at_entry (section 6.1). Both are derived by
-- folding, and storing either would create a second truth that can disagree
-- with engine/replay.ts the first time it changes. This function does not
-- compute units at all — it records the INPUT (an amount, on a date, for a
-- holder) and leaves the OUTPUT (units issued, at what NAV) to fold().
--
-- The row lock on compound_account is what makes two concurrent writers get
-- disjoint seq numbers rather than colliding on unique (account_id, seq).
-- Same mechanism as compound_commit_reading_plan; do not simplify it away.
--
-- THE INTERLOCK APPLIES HERE TOO. A deposit dated on or after an unclassified
-- capital event is refused, for the reason design spec section 5.3 gives: the
-- pool's state on that date is not known, so the NAV the deposit would issue
-- units at is not known either, and units issued at a wrong NAV cannot be
-- corrected without reversing everything after them.
--
-- SECURITY INVOKER, matching every other writer in this schema.
--
-- Custom SQLSTATEs:
--   CX001  no such account
--   CX002  dated on or after an unclassified capital event
--   CX205  no such holder on this account
--   CX206  amount is not positive
-- ============================================================================

create or replace function public.compound_commit_deposit(
  p_account_id   bigint,
  p_holder_id    bigint,
  p_occurred_on  date,
  p_amount_cents bigint,
  p_note         text,
  p_actor        uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_locked   bigint;
  v_next_seq bigint;
  v_entry_id bigint;
  v_blocker  date;
begin
  if p_amount_cents <= 0 then
    raise exception 'compound: a deposit must be positive, got %', p_amount_cents
      using errcode = 'CX206';
  end if;

  select a.id into v_locked
    from public.compound_account a where a.id = p_account_id for update;
  if v_locked is null then
    raise exception 'compound: no account %', p_account_id using errcode = 'CX001';
  end if;

  if not exists (
    select 1 from public.compound_holder h
     where h.id = p_holder_id and h.account_id = p_account_id
  ) then
    raise exception 'compound: holder % is not on account %', p_holder_id, p_account_id
      using errcode = 'CX205';
  end if;

  select min(k.trade_date) into v_blocker
    from public.compound_capital_event_candidate k
   where k.account_id = p_account_id
     and k.status = 'pending';

  if v_blocker is not null and p_occurred_on >= v_blocker then
    raise exception
      'compound: deposit dated % is on or after the unclassified capital event on %',
      p_occurred_on, v_blocker using errcode = 'CX002';
  end if;

  select coalesce(max(l.seq), 0) + 1 into v_next_seq
    from public.compound_ledger_entry l where l.account_id = p_account_id;

  insert into public.compound_ledger_entry
    (account_id, holder_id, seq, occurred_on, type, amount_cents, note, created_by)
  values
    (p_account_id, p_holder_id, v_next_seq, p_occurred_on, 'deposit',
     p_amount_cents, nullif(p_note, ''), p_actor)
  returning id into v_entry_id;

  insert into public.compound_audit (actor, action, entity, entity_id, account_id, prior_state)
  values (p_actor, 'commit_deposit', 'compound_ledger_entry', v_entry_id, p_account_id, null);

  return jsonb_build_object('ledger_entry_id', v_entry_id, 'seq', v_next_seq);
end;
$$;

-- Functions are granted EXECUTE to PUBLIC by default; every sibling writer in
-- this schema revokes that and grants explicitly. Matched here.
revoke execute on function public.compound_commit_deposit(
  bigint, bigint, date, bigint, text, uuid
) from public;
grant execute on function public.compound_commit_deposit(
  bigint, bigint, date, bigint, text, uuid
) to authenticated, service_role;
