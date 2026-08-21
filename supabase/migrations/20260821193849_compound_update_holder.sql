-- ============================================================================
-- Edit a holder's identity and terms: name, email, split_bps.
-- ============================================================================
--
-- Everything else about a holder is either owned elsewhere or not stored at
-- all: status is set only by compound_commit_payout on a full exit (decision
-- D-M — never by a manager directly), and units/cost_basis are not columns
-- at all — both derived by replaying the ledger (section 6.1). Only name,
-- email and split_bps are ever written here.
--
-- The manager's split_bps is pinned to 0, matching compound_create_account:
-- quote() forces splitBpsApplied to 0 whenever isManager, so a stored nonzero
-- value on the manager's own row would be a number the product never applies
-- — exactly the "second truth" this schema avoids everywhere else. CX304
-- refuses that before it can be written, rather than silently storing a
-- number nobody reads.
--
-- Changing split_bps does NOT touch history. compound_ledger_entry is
-- INSERT/SELECT only (compound_ledger_append_only) and this function never
-- references it — every payout or exit already posted carries its own
-- split_bps_applied, frozen at the seq it was written (replay.ts refuses to
-- fold a payout with none, precisely so a later change here cannot reach
-- backwards). This function can only ever change what a FUTURE quote sees.
--
-- The audit row carries prior_state — name, email and split_bps as they read
-- immediately before this write — so a rename is traceable to who changed it
-- and what it said before, matching compound_classify_candidate's own
-- before-value audit shape (status/trade_date/note at that function's
-- equivalent point).
--
-- SECURITY INVOKER, matching every other writer in this schema.
--
-- Custom SQLSTATEs:
--   CX001  no such account                    (reused, Task 5's code)
--   CX301  no such holder on this account
--   CX302  a holder needs a name
--   CX303  split must be 0..100 (percent, i.e. 0..10000 basis points)
--   CX304  the manager's split cannot be set to anything but 0
-- ============================================================================

create or replace function public.compound_update_holder(
  p_account_id bigint,
  p_holder_id  bigint,
  p_name       text,
  p_email      text,
  p_split_bps  int,
  p_actor      uuid
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_is_manager   boolean;
  v_prior_name   text;
  v_prior_email  text;
  v_prior_split  int;
begin
  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'compound: a holder needs a name' using errcode = 'CX302';
  end if;
  if p_split_bps is null or p_split_bps < 0 or p_split_bps > 10000 then
    raise exception 'compound: split must be an integer 0..10000 basis points, got %',
      p_split_bps using errcode = 'CX303';
  end if;

  if not exists (select 1 from public.compound_account a where a.id = p_account_id) then
    raise exception 'compound: no account %', p_account_id using errcode = 'CX001';
  end if;

  -- Row lock: two concurrent edits of the SAME holder must not both read the
  -- same "before" values and both write an audit row claiming to be the
  -- change from that state.
  select h.is_manager, h.name, h.email, h.split_bps
    into v_is_manager, v_prior_name, v_prior_email, v_prior_split
    from public.compound_holder h
   where h.id = p_holder_id and h.account_id = p_account_id
     for update;

  -- name is NOT NULL on compound_holder (compound_core_tables), so a null
  -- here can only mean the row lock above matched nothing — the same idiom
  -- compound_classify_candidate uses for its own "no such row" check.
  if v_prior_name is null then
    raise exception 'compound: holder % is not on account %', p_holder_id, p_account_id
      using errcode = 'CX301';
  end if;

  if v_is_manager and p_split_bps <> 0 then
    raise exception
      'compound: the manager''s split is fixed at 0, got %', p_split_bps
      using errcode = 'CX304';
  end if;

  update public.compound_holder
     set name = btrim(p_name),
         email = nullif(p_email, ''),
         split_bps = p_split_bps
   where id = p_holder_id;

  insert into public.compound_audit (actor, action, entity, entity_id, account_id, prior_state)
  values (p_actor, 'update_holder', 'compound_holder', p_holder_id, p_account_id,
          jsonb_build_object('name', v_prior_name, 'email', v_prior_email,
                              'split_bps', v_prior_split));
end;
$$;

-- Functions are granted EXECUTE to PUBLIC by default; every sibling writer in
-- this schema revokes that and grants explicitly.
revoke execute on function public.compound_update_holder(
  bigint, bigint, text, text, int, uuid
) from public;
grant execute on function public.compound_update_holder(
  bigint, bigint, text, text, int, uuid
) to authenticated, service_role;
