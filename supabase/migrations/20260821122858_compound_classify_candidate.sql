-- ============================================================================
-- Classify a capital-event candidate. The only way past the interlock.
-- ============================================================================
--
-- Three outcomes (decision D-J, plan section "Decisions this plan makes"):
--
--   deposit  someone put money in. A deposit entry is written DATED ON THE
--            CANDIDATE'S DAY. That is exactly the date compound_commit_deposit
--            refuses (its own CX002 check), which is why classification needs
--            its own writer: the interlock exists to stop entries crossing an
--            UNCLASSIFIED event, and this function is the act of classifying
--            it. It writes directly to compound_ledger_entry rather than
--            calling compound_commit_deposit, and only after confirming (via
--            the row lock below) that THIS candidate — the one whose date is
--            being written to — is the one being resolved.
--
--   match    the money moved for something already in the ledger — a payout
--            recorded here and then executed at the broker. Nothing new is
--            written; resolved_ledger_entry_id points at the existing entry.
--            That column exists for exactly this, and it is what keeps this
--            path from double-counting a deposit the manager already entered
--            by hand: no new compound_ledger_entry row is ever inserted on
--            this branch, so replay.ts's fold() sees the same money once.
--
--   ignore   a broker credit, a rebate, a correction. No entry. The amount is
--            absorbed into NAV pro-rata by the next reading, which is correct
--            for money that belongs to every holder. A NOTE IS REQUIRED,
--            because this is the outcome that discards information and the
--            note is the only record of why.
--
-- The candidate must be 'pending'. Classifying a resolved one twice would
-- write a second deposit for the same money — the CX203 check below, tested
-- directly in write-classify.db.test.ts, is what stops that.
--
-- This function does NOT touch compound_reconcile_cursor. Moving the cursor
-- forward past a resolved day is compound_commit_reading_plan's job (plan 3,
-- Task 5 — already merged), invoked separately by Task 11's refreshReadings
-- once planFor sees this candidate is no longer pending. Classifying a
-- candidate here can therefore never itself advance a reading past ANOTHER,
-- still-pending candidate: this function only ever locks and updates the ONE
-- candidate row named by p_candidate_id, and reads/writes nothing keyed by
-- any other candidate's date.
--
-- SECURITY INVOKER, deliberately, matching compound_commit_reading_plan: as
-- invoker this can only do what its caller's role can do (service_role in
-- production), so a bug here cannot exceed the append-only grant on
-- compound_ledger_entry that section 9 relies on.
--
-- Money crosses the boundary as strings, matching every other writer in this
-- product: JSON.stringify throws on a bigint, and a JSON number above 2^53 is
-- not the number that was sent.
--
-- Custom SQLSTATEs. Cross-checked against every other writer this plan
-- drafts (Task 11's lib/compound/present/errors.ts MESSAGES table, Task 12's
-- compound_commit_deposit / compound_add_holder, Task 13's
-- compound_commit_payout) to keep one code meaning one thing across the
-- product — explainCommitError looks a code up by number alone, with no
-- knowledge of which function raised it.
--
--   CX001  no such account                              (reused, Task 5's code)
--   CX203  that candidate is not pending                 (reused: Task 11's
--          errors.ts already reserves this exact code for this exact
--          message — "That capital event has already been classified.")
--   CX204  the account moved since the receipt was worked out
--          (reused: Task 13's compound_commit_payout uses CX204 for the same
--          stale-fingerprint meaning; Task 11's errors.ts message fits
--          verbatim)
--   CX205  no such holder on this account                (reused: Task 12's
--          compound_commit_deposit and Task 13's compound_commit_payout both
--          already use CX205 for this exact check)
--   CX208  outcome must be deposit, match or ignore
--          (reused: this migration first used CX212 here, reasoning that
--          Task 13's compound_commit_payout already raises CX208 for its own
--          "mode must be payout or exit" / "fee settlement must be units or
--          cash" checks, and explainCommitError maps a code to one message
--          with no knowledge of which function raised it — so a third,
--          unrelated meaning on the same code looked like it would surface
--          the wrong sentence. That assumption was checked against the
--          seam's actual, merged lib/compound/present/errors.ts rather than
--          left as a guess: CX208's real, registered message is the generic
--          "That is not a valid choice for this form. Nothing was
--          committed." — deliberately reused across Tasks 12-14 for exactly
--          this class of refusal, confirmed directly by the seam owner
--          (Task 11). Switched back to CX208 to match.)
--   CX209  the ignore outcome requires a note             (new, Task 14 only)
--   CX210  the matched entry is not on this account        (new, Task 14 only)
--   CX211  a deposit classification needs a positive amount (new, Task 14 only)
-- ============================================================================

create or replace function public.compound_classify_candidate(
  p_account_id     bigint,
  p_candidate_id   bigint,
  p_outcome        text,     -- 'deposit' | 'match' | 'ignore'
  p_holder_id      bigint,   -- deposit only
  p_amount_cents   bigint,   -- deposit only
  p_match_entry_id bigint,   -- match only
  p_note           text,
  p_expected_seq   bigint,
  p_actor          uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_locked    bigint;
  v_max_seq   bigint;
  v_trade_date date;
  v_status    text;
  v_entry_id  bigint := null;
begin
  if p_outcome not in ('deposit', 'match', 'ignore') then
    raise exception 'compound: outcome must be deposit, match or ignore, got %', p_outcome
      using errcode = 'CX208';
  end if;

  select a.id into v_locked
    from public.compound_account a where a.id = p_account_id for update;
  if v_locked is null then
    raise exception 'compound: no account %', p_account_id using errcode = 'CX001';
  end if;

  -- Row lock on the candidate itself: two concurrent classifications of the
  -- SAME candidate must not both see 'pending' and both write a deposit.
  select k.trade_date, k.status into v_trade_date, v_status
    from public.compound_capital_event_candidate k
   where k.id = p_candidate_id and k.account_id = p_account_id
     for update;

  if v_trade_date is null then
    raise exception 'compound: no candidate % on account %', p_candidate_id, p_account_id
      using errcode = 'CX203';
  end if;
  if v_status <> 'pending' then
    raise exception 'compound: candidate % is already %', p_candidate_id, v_status
      using errcode = 'CX203';
  end if;

  select coalesce(max(l.seq), 0) into v_max_seq
    from public.compound_ledger_entry l where l.account_id = p_account_id;
  if v_max_seq <> p_expected_seq then
    raise exception
      'compound: account is at entry % and the receipt was worked out at entry %',
      v_max_seq, p_expected_seq using errcode = 'CX204';
  end if;

  if p_outcome = 'deposit' then
    if p_amount_cents is null or p_amount_cents <= 0 then
      raise exception 'compound: a deposit classification needs a positive amount, got %',
        p_amount_cents using errcode = 'CX211';
    end if;
    if p_holder_id is null or not exists (
      select 1 from public.compound_holder h
       where h.id = p_holder_id and h.account_id = p_account_id
    ) then
      raise exception 'compound: holder % is not on account %', p_holder_id, p_account_id
        using errcode = 'CX205';
    end if;

    insert into public.compound_ledger_entry
      (account_id, holder_id, seq, occurred_on, type, amount_cents, note, created_by)
    values
      (p_account_id, p_holder_id, v_max_seq + 1, v_trade_date, 'deposit',
       p_amount_cents, nullif(p_note, ''), p_actor)
    returning id into v_entry_id;

  elsif p_outcome = 'match' then
    if p_match_entry_id is null or not exists (
      select 1 from public.compound_ledger_entry l
       where l.id = p_match_entry_id and l.account_id = p_account_id
    ) then
      raise exception 'compound: entry % is not on account %', p_match_entry_id, p_account_id
        using errcode = 'CX210';
    end if;
    v_entry_id := p_match_entry_id;

  else -- ignore
    if p_note is null or btrim(p_note) = '' then
      raise exception
        'compound: classifying a capital event as "not a capital event" requires a note'
        using errcode = 'CX209';
    end if;
  end if;

  -- DELIBERATELY AFTER THE WRITE ABOVE (when there is one). A guard that
  -- fires before any statement runs makes "nothing was persisted on failure"
  -- true for the wrong reason; placed here, a forced failure after this
  -- point has a real ledger row to roll back, and the atomicity test proves
  -- it by watching compound_ledger_entry's id sequence, which rollback does
  -- not rewind.
  update public.compound_capital_event_candidate
     set status = case when p_outcome = 'ignore' then 'ignored' else 'classified' end,
         resolved_ledger_entry_id = v_entry_id,
         resolved_at = now(),
         resolved_by = p_actor
   where id = p_candidate_id;

  insert into public.compound_audit (actor, action, entity, entity_id, account_id, prior_state)
  values (p_actor, 'classify_' || p_outcome, 'compound_capital_event_candidate',
          p_candidate_id, p_account_id,
          jsonb_build_object('status', v_status, 'trade_date', v_trade_date, 'note', p_note));

  return jsonb_build_object('ledger_entry_id', v_entry_id);
end;
$$;

-- Functions are granted EXECUTE to PUBLIC by default.
revoke execute on function public.compound_classify_candidate(
  bigint, bigint, text, bigint, bigint, bigint, text, bigint, uuid)
  from public;
grant execute on function public.compound_classify_candidate(
  bigint, bigint, text, bigint, bigint, bigint, text, bigint, uuid)
  to authenticated, service_role;
