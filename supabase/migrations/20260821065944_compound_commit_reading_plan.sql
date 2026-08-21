-- ============================================================================
-- Commit a reading plan. One transaction, cursor included.
-- ============================================================================
--
-- reconcile/interlock.ts returns a plan: readings to post, sometimes a capital
-- event candidate, and where the cursor should end up. All three must land
-- together or none of them must. Readings without the cursor get re-posted on
-- the next run; the cursor without the readings makes NAV skip days silently.
--
-- SECURITY INVOKER, deliberately. A SECURITY DEFINER function owned by
-- postgres would run with the owner's implicit privileges and could therefore
-- UPDATE compound_ledger_entry, quietly undoing the append-only grant that
-- section 9 asks for. As invoker it can only do what service_role can do,
-- which is SELECT and INSERT.
--
-- seq is assigned here, server-side, per section 6.2. The row lock on
-- compound_account is what makes two concurrent runs get disjoint numbers
-- instead of colliding on the unique (account_id, seq) constraint.
--
-- Money crosses the boundary as JSON *strings*. JSON.stringify throws on a
-- BigInt, and a JSON number above 2^53 is not the number you sent.
--
-- Custom SQLSTATEs so callers and tests can tell the refusals apart:
--   CX001  no such account
--   CX002  a reading is dated on or after an unclassified capital event
--   CX003  a reading is dated on or before the current cursor
--   CX004  the cursor does not match what was posted
--   CX005  readings are not in ascending date order
-- ============================================================================

create or replace function public.compound_commit_reading_plan(
  p_account_id  bigint,
  p_readings    jsonb,
  p_candidate   jsonb,
  p_cursor_date date,
  p_actor       uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_locked          bigint;
  v_prev_cursor     date;
  v_next_seq        bigint;
  v_reading         jsonb;
  v_occurred_on     date;
  v_previous_on     date := null;
  v_last_reading_on date := null;
  v_seqs            bigint[] := '{}';
  v_candidate_id    bigint := null;
  v_candidate_date  date := null;
begin
  -- Serialise concurrent commits for this account. Without it, two callers
  -- both read the same max(seq) and race to insert it, and the unique
  -- constraint turns a queue into an error for one of them.
  select a.id into v_locked
    from public.compound_account a
   where a.id = p_account_id
     for update;

  if v_locked is null then
    raise exception 'compound: no account %', p_account_id using errcode = 'CX001';
  end if;

  select c.last_reading_date into v_prev_cursor
    from public.compound_reconcile_cursor c
   where c.account_id = p_account_id;

  if p_candidate is not null then
    v_candidate_date := (p_candidate ->> 'trade_date')::date;
  end if;

  select coalesce(max(l.seq), 0) + 1 into v_next_seq
    from public.compound_ledger_entry l
   where l.account_id = p_account_id;

  -- The candidate first. ON CONFLICT DO NOTHING makes a repeated run against
  -- an unresolved event a no-op rather than a pile of duplicate review items.
  if p_candidate is not null then
    insert into public.compound_capital_event_candidate
      (account_id, trade_date, balance_delta_cents, explained_cents, unexplained_cents)
    values (
      p_account_id,
      v_candidate_date,
      (p_candidate ->> 'balance_delta_cents')::bigint,
      (p_candidate ->> 'explained_cents')::bigint,
      (p_candidate ->> 'unexplained_cents')::bigint
    )
    on conflict (account_id, trade_date) do nothing
    returning id into v_candidate_id;

    if v_candidate_id is null then
      select k.id into v_candidate_id
        from public.compound_capital_event_candidate k
       where k.account_id = p_account_id
         and k.trade_date = v_candidate_date;
    end if;
  end if;

  for v_reading in
    select value from jsonb_array_elements(coalesce(p_readings, '[]'::jsonb))
  loop
    v_occurred_on := (v_reading ->> 'occurred_on')::date;

    if v_prev_cursor is not null and v_occurred_on <= v_prev_cursor then
      raise exception
        'compound: reading % is not after the cursor %', v_occurred_on, v_prev_cursor
        using errcode = 'CX003';
    end if;

    if v_previous_on is not null and v_occurred_on <= v_previous_on then
      raise exception
        'compound: readings must ascend, % follows %', v_occurred_on, v_previous_on
        using errcode = 'CX005';
    end if;

    -- The interlock, restated at the persistence boundary. planReadings
    -- already guarantees this; a second refusal here costs one comparison and
    -- means NAV cannot cross an unclassified capital event even if a caller
    -- hand-builds a plan.
    if v_candidate_date is not null and v_occurred_on >= v_candidate_date then
      raise exception
        'compound: reading % is on or after unclassified capital event %',
        v_occurred_on, v_candidate_date
        using errcode = 'CX002';
    end if;

    insert into public.compound_ledger_entry
      (account_id, holder_id, seq, occurred_on, type, amount_cents,
       fee_settlement, split_bps_applied, note, reverses_id, created_by)
    values (
      p_account_id, null, v_next_seq, v_occurred_on, 'equity_reading',
      (v_reading ->> 'equity_cents')::bigint, null, null, null, null, p_actor
    );

    v_seqs            := v_seqs || v_next_seq;
    v_next_seq        := v_next_seq + 1;
    v_previous_on     := v_occurred_on;
    v_last_reading_on := v_occurred_on;
  end loop;

  -- With no readings the cursor does not move; only last_run_at does. That
  -- makes a repeat run against an unresolved candidate a clean no-op whether
  -- the caller passes null or the existing date.
  insert into public.compound_reconcile_cursor (account_id, last_reading_date, last_run_at)
  values (p_account_id, coalesce(v_last_reading_on, v_prev_cursor), now())
  on conflict (account_id) do update
    set last_reading_date = excluded.last_reading_date,
        last_run_at       = excluded.last_run_at;

  -- DELIBERATELY THE LAST STATEMENT. A guard that fires before any write makes
  -- "nothing was persisted" true for the wrong reason, and an atomicity test
  -- built on it passes even when the caller has split this into three round
  -- trips. Placed here, the rollback has real rows to undo — and the test
  -- proves it by watching the id sequence, which rollback does not rewind.
  if v_last_reading_on is null then
    if p_cursor_date is not null and p_cursor_date is distinct from v_prev_cursor then
      raise exception
        'compound: cursor moved to % with no readings posted', p_cursor_date
        using errcode = 'CX004';
    end if;
  elsif p_cursor_date is distinct from v_last_reading_on then
    raise exception
      'compound: cursor % does not match the last reading %',
      p_cursor_date, v_last_reading_on
      using errcode = 'CX004';
  end if;

  return jsonb_build_object(
    'seqs',         to_jsonb(v_seqs::text[]),
    'candidate_id', v_candidate_id::text,
    'cursor_date',  to_char(coalesce(v_last_reading_on, v_prev_cursor), 'YYYY-MM-DD')
  );
end;
$$;

-- Functions are granted EXECUTE to PUBLIC by default.
revoke execute on function public.compound_commit_reading_plan(bigint, jsonb, jsonb, date, uuid)
  from public;
grant execute on function public.compound_commit_reading_plan(bigint, jsonb, jsonb, date, uuid)
  to authenticated, service_role;
