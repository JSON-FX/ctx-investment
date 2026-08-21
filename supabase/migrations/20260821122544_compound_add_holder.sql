-- ============================================================================
-- Add a holder to an account.
-- ============================================================================
--
-- BOOTSTRAPPED FOR TASK 13: this migration is plan 4's Task 12 deliverable
-- (docs/superpowers/plans/2026-08-21-compound-desk.md, ~line 7813), needed
-- only so Task 13's write-payout.db.test.ts can build a funded test account.
-- `.worktrees/invest` (feat/desk-invest) had no commits at the time Task 13
-- was built. Verbatim transcription of the plan's reference SQL. Reconcile
-- with whatever Task 12 actually ships once feat/desk-invest merges.
--
-- No ledger entry. A holder is identity and terms; a holder with no deposit
-- holds no units and is worth nothing, which is exactly right — joining and
-- funding are separate events and the ledger records the second one.
--
-- is_manager is forced FALSE. Plan 3's P8 puts a one-manager-per-account
-- partial unique index on this table because replay.ts resolves the
-- fee-receiving manager with find(h => h.isManager) and would silently pick
-- whichever row came back first if there were two. The manager is created with
-- the account and cannot be added later, so this function does not offer it.
--
-- Custom SQLSTATEs:
--   CX102  attempted to add a second manager
-- ============================================================================

create or replace function public.compound_add_holder(
  p_account_id bigint,
  p_name       text,
  p_email      text,
  p_split_bps  int,
  p_joined_at  date,
  p_actor      uuid
) returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_holder_id bigint;
begin
  if not exists (select 1 from public.compound_account a where a.id = p_account_id) then
    raise exception 'compound: no account %', p_account_id using errcode = 'CX001';
  end if;

  insert into public.compound_holder
    (account_id, name, email, is_manager, split_bps, joined_at, status)
  values
    (p_account_id, p_name, nullif(p_email, ''), false, p_split_bps, p_joined_at, 'active')
  returning id into v_holder_id;

  insert into public.compound_audit (actor, action, entity, entity_id, account_id, prior_state)
  values (p_actor, 'add_holder', 'compound_holder', v_holder_id, p_account_id, null);

  return v_holder_id;
end;
$$;
