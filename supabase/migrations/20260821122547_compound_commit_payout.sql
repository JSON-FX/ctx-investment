-- ============================================================================
-- Pay out. The settlement reading and the payout, together or not at all.
-- ============================================================================
--
-- Spec 5.2: "A payout may never settle against a drifting intraday figure --
-- it writes an equity reading capturing the exact equity used, then the payout
-- entry, in one transaction." Both inserts are in this function body, which IS
-- one transaction. If the reading landed without the payout the account would
-- be revalued for no reason; if the payout landed without the reading it would
-- have settled against whatever equity happened to be current, which is the
-- figure nobody can reproduce afterwards.
--
-- The cursor is NOT moved. That is deliberate and it is not an oversight: the
-- settlement reading pins the equity for THIS payout at THIS seq, and the
-- reconciler's own reading for the same day arrives later at a higher seq and
-- supersedes it going forward. Moving the cursor would leave the payout's day
-- permanently unreconciled, and a capital event on it would never be seen.
--
-- p_expected_seq closes a race the application cannot. The caller re-folds and
-- checks a fingerprint before submitting, and between that check and this
-- insert another session can commit. Under the row lock, max(seq) is the
-- authoritative answer.
--
-- No units_delta and no nav_at_entry: both derived (spec 6.1). amount_cents
-- carries the gross the caller quoted, as a record of what was asked for;
-- replay.ts recomputes the payout from quote() and never reads it.
--
-- Custom SQLSTATEs:
--   CX001  no such account
--   CX002  dated on or after an unclassified capital event
--   CX204  the account moved since the receipt was worked out
--   CX205  no such holder on this account
--   CX207  settlement equity must be positive
--   CX208  invalid mode or fee_settlement value
-- ============================================================================

create or replace function public.compound_commit_payout(
  p_account_id              bigint,
  p_holder_id               bigint,
  p_occurred_on             date,
  p_settlement_equity_cents bigint,
  p_mode                    text,     -- 'payout' | 'exit'
  p_fee_settlement          text,     -- 'units' | 'cash'
  p_split_bps_applied       int,
  p_gross_cents             bigint,
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
  v_payout_id  bigint;
  v_blocker    date;
begin
  if p_mode not in ('payout', 'exit') then
    raise exception 'compound: mode must be payout or exit, got %', p_mode using errcode = 'CX208';
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
      'compound: payout dated % is on or after the unclassified capital event on %',
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
     'Settlement reading for the payout at seq ' || (v_max_seq + 2)::text, p_actor)
  returning id into v_reading_id;

  insert into public.compound_ledger_entry
    (account_id, holder_id, seq, occurred_on, type, amount_cents,
     fee_settlement, split_bps_applied, note, created_by)
  values
    (p_account_id, p_holder_id, v_max_seq + 2, p_occurred_on, p_mode, p_gross_cents,
     p_fee_settlement, p_split_bps_applied, nullif(p_note, ''), p_actor)
  returning id into v_payout_id;

  -- Decision D-M: the stored status is kept in step with what fold derives, so
  -- the database is not misleading to anyone reading it directly. Nothing in
  -- the application reads it.
  if p_mode = 'exit' then
    update public.compound_holder set status = 'closed' where id = p_holder_id;
  end if;

  insert into public.compound_audit (actor, action, entity, entity_id, account_id, prior_state)
  values (p_actor, 'commit_' || p_mode, 'compound_ledger_entry', v_payout_id, p_account_id,
          jsonb_build_object('expected_seq', p_expected_seq,
                             'settlement_equity_cents', p_settlement_equity_cents));

  return jsonb_build_object(
    'reading_entry_id', v_reading_id,
    'payout_entry_id',  v_payout_id,
    'seq',              v_max_seq + 2
  );
end;
$$;
