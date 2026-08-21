-- ============================================================================
-- Partial capital withdrawal (P6). The settlement reading and the withdrawal,
-- together or not at all.
-- ============================================================================
--
-- A dedicated function rather than a third p_mode on compound_commit_payout,
-- deliberately: that function's lock/interlock/fingerprint sequence is
-- already covered by write-payout.db.test.ts, and this migration must not
-- risk it. Duplicating that ~20-line sequence costs less than the blast
-- radius of editing a working, tested function this task does not own —
-- the two now share a shape (and, in the caller, a Queryable), not a body.
--
-- Same atomicity contract as compound_commit_payout: the settlement reading
-- and the withdrawal entry are both inserted in this function body, which IS
-- one transaction. See that migration's header for the full reasoning; it
-- applies here without change.
--
-- p_holder_value_cents is the cap — valueOfUnits(totals, holderUnits),
-- floored, the SAME figure the receipt already shows (decision D-A) —
-- computed by the caller from the SAME fold() that produced p_expected_seq,
-- and therefore covered by the fingerprint check below exactly like every
-- other number the caller brings to this call. The database does not
-- re-derive it (engine/ never imports db/, and this project's whole point is
-- one place that does accounting arithmetic — see quote.ts and replay.ts);
-- it enforces the RULE against a value the fingerprint already guarantees is
-- current. That is what "the database is the authority" means in an
-- event-sourced schema with no stored balances: it owns the refusal, not a
-- second derivation of the number being checked.
--
-- p_holder_value_cents doubles as the signal for whether this withdrawal
-- drains the holder to zero units: p_amount_cents = p_holder_value_cents
-- happens exactly when quote()'s isFullWithdrawal was true, which is exactly
-- when the holder's status should close, mirroring compound_commit_payout's
-- unconditional close on p_mode = 'exit' (decision D-M). No separate boolean
-- parameter is needed — the equality is the same test quote.ts already made.
--
-- Custom SQLSTATEs:
--   CX001  no such account                                       (reused)
--   CX002  dated on or after an unclassified capital event        (reused)
--   CX204  the account moved since the receipt was worked out     (reused)
--   CX205  no such holder on this account                         (reused)
--   CX207  settlement equity must be positive                     (reused)
--   CX208  fee_settlement must be units or cash                   (reused)
--   CX212  withdrawal amount must be positive                     (new, P6)
--   CX213  withdrawal amount exceeds the holder's value            (new, P6)
-- ============================================================================

create or replace function public.compound_commit_withdrawal(
  p_account_id              bigint,
  p_holder_id               bigint,
  p_occurred_on             date,
  p_settlement_equity_cents bigint,
  p_amount_cents            bigint,   -- the requested withdrawal, A
  p_holder_value_cents      bigint,   -- the cap, fingerprinted like every other figure here
  p_fee_settlement          text,     -- 'units' | 'cash'
  p_split_bps_applied       int,
  p_expected_seq            bigint,
  p_note                    text,
  p_actor                   uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_locked     bigint;
  v_max_seq    bigint;
  v_reading_id bigint;
  v_entry_id   bigint;
  v_blocker    date;
begin
  if p_amount_cents <= 0 then
    raise exception 'compound: withdrawal amount must be positive, got %', p_amount_cents
      using errcode = 'CX212';
  end if;
  if p_amount_cents > p_holder_value_cents then
    raise exception
      'compound: withdrawal amount % exceeds the holder''s value of % cents',
      p_amount_cents, p_holder_value_cents using errcode = 'CX213';
  end if;
  if p_fee_settlement not in ('units', 'cash') then
    raise exception 'compound: fee settlement must be units or cash, got %', p_fee_settlement
      using errcode = 'CX208';
  end if;
  if p_settlement_equity_cents <= 0 then
    raise exception 'compound: settlement equity must be positive, got %',
      p_settlement_equity_cents using errcode = 'CX207';
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
   where k.account_id = p_account_id and k.status = 'pending';
  if v_blocker is not null and p_occurred_on >= v_blocker then
    raise exception
      'compound: withdrawal dated % is on or after the unclassified capital event on %',
      p_occurred_on, v_blocker using errcode = 'CX002';
  end if;

  select coalesce(max(l.seq), 0) into v_max_seq
    from public.compound_ledger_entry l where l.account_id = p_account_id;

  if v_max_seq <> p_expected_seq then
    raise exception
      'compound: account is at entry % and the receipt was worked out at entry %',
      v_max_seq, p_expected_seq using errcode = 'CX204';
  end if;

  insert into public.compound_ledger_entry
    (account_id, holder_id, seq, occurred_on, type, amount_cents, note, created_by)
  values
    (p_account_id, null, v_max_seq + 1, p_occurred_on, 'equity_reading',
     p_settlement_equity_cents,
     'Settlement reading for the withdrawal at seq ' || (v_max_seq + 2)::text, p_actor)
  returning id into v_reading_id;

  insert into public.compound_ledger_entry
    (account_id, holder_id, seq, occurred_on, type, amount_cents,
     fee_settlement, split_bps_applied, note, created_by)
  values
    (p_account_id, p_holder_id, v_max_seq + 2, p_occurred_on, 'withdrawal', p_amount_cents,
     p_fee_settlement, p_split_bps_applied, nullif(p_note, ''), p_actor)
  returning id into v_entry_id;

  -- Decision D-M, extended to withdrawal: kept in step with what fold
  -- derives (h.units === 0n closes the holder — see replay.ts). Equality,
  -- not a floor/ceil comparison: p_holder_value_cents is the exact cap
  -- quote() checked amountCents against, so "at the cap" is decidable
  -- exactly here too.
  if p_amount_cents = p_holder_value_cents then
    update public.compound_holder set status = 'closed' where id = p_holder_id;
  end if;

  insert into public.compound_audit (actor, action, entity, entity_id, account_id, prior_state)
  values (p_actor, 'commit_withdrawal', 'compound_ledger_entry', v_entry_id, p_account_id,
          jsonb_build_object('expected_seq', p_expected_seq,
                             'settlement_equity_cents', p_settlement_equity_cents,
                             'holder_value_cents', p_holder_value_cents));

  return jsonb_build_object(
    'reading_entry_id', v_reading_id,
    'withdrawal_entry_id', v_entry_id,
    'seq',              v_max_seq + 2
  );
end;
$$;

-- Functions are granted EXECUTE to PUBLIC by default.
revoke execute on function public.compound_commit_withdrawal(
  bigint, bigint, date, bigint, bigint, bigint, text, int, bigint, text, uuid)
  from public;
grant execute on function public.compound_commit_withdrawal(
  bigint, bigint, date, bigint, bigint, bigint, text, int, bigint, text, uuid)
  to authenticated, service_role;
