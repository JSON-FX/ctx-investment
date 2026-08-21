-- ============================================================================
-- Add a holder to an account.
-- ============================================================================
--
-- No ledger entry. A holder is identity and terms; a holder with no deposit
-- holds no units and is worth nothing, which is exactly right — joining and
-- funding are separate events and the ledger records the second one.
-- compound_holder itself stores no balance columns (section 6.1) — units and
-- basis are derived by folding the ledger, so a brand-new holder needs no
-- special-cased "zero" row here. Their seed simply carries zero units the
-- first time engine/replay.ts's fold() builds it, the same as any holder
-- before their first deposit.
--
-- is_manager is forced FALSE — this function offers no parameter for it.
-- replay.ts resolves the fee-receiving manager with find(h => h.isManager)
-- and would silently pick whichever row came back first if there were two.
-- compound_holder_one_manager_per_account (compound_core_tables) is the
-- database's own backstop against a second manager arriving by some other
-- route; this function simply never offers the door. The manager is created
-- with the account, by compound_create_account, and cannot be added later.
--
-- SECURITY INVOKER, matching every other writer in this schema. A DEFINER
-- function owned by postgres would carry the owner's implicit privileges,
-- including UPDATE on compound_ledger_entry, and would undo the append-only
-- grant that migration relies on.
--
-- Custom SQLSTATEs:
--   CX001  no such account
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

-- Functions are granted EXECUTE to PUBLIC by default; every sibling writer in
-- this schema revokes that and grants explicitly (compound_create_account,
-- compound_commit_reading_plan). Matched here rather than assumed.
revoke execute on function public.compound_add_holder(
  bigint, text, text, int, date, uuid
) from public;
grant execute on function public.compound_add_holder(
  bigint, text, text, int, date, uuid
) to authenticated, service_role;
