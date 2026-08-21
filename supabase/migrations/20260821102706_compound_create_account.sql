-- ============================================================================
-- Create an account and its manager holder, together or not at all.
-- ============================================================================
--
-- replay.ts resolves the fee-receiving manager with find(h => h.isManager). An
-- account with no manager holder cannot settle a fee and fold() throws when one
-- crystallises — at render time, on a screen, long after the account was made.
-- Creating the two rows in one function makes that state unreachable.
--
-- The manager's split_bps is 0. quote() forces splitBpsApplied to 0 when
-- isManager because the manager never charges themselves; storing 0 says the
-- same thing in the row rather than leaving a number that is never applied.
--
-- SECURITY INVOKER, matching compound_commit_reading_plan. A definer function
-- owned by postgres would carry the owner's implicit privileges and could
-- UPDATE compound_ledger_entry, undoing the append-only guarantee.
--
-- Custom SQLSTATEs:
--   CX101  that MT5 account already has a Compound account
-- ============================================================================

create or replace function public.compound_create_account(
  p_mt5_account        bigint,
  p_label              text,
  p_broker             text,
  p_currency           text,
  p_default_split_bps  int,
  p_inception_date     date,
  p_manager_user_id    uuid,
  p_manager_name       text,
  p_broker_offset_hours int
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_account_id bigint;
  v_holder_id  bigint;
begin
  if exists (select 1 from public.compound_account a where a.mt5_account = p_mt5_account) then
    raise exception 'compound: MT5 account % already has a Compound account', p_mt5_account
      using errcode = 'CX101';
  end if;

  insert into public.compound_account
    (mt5_account, label, broker, currency, default_split_bps,
     inception_date, manager_user_id, broker_offset_hours)
  values
    (p_mt5_account, p_label, nullif(p_broker, ''), p_currency, p_default_split_bps,
     p_inception_date, p_manager_user_id, p_broker_offset_hours)
  returning id into v_account_id;

  insert into public.compound_holder
    (account_id, name, user_id, is_manager, split_bps, joined_at, status)
  values
    (v_account_id, p_manager_name, p_manager_user_id, true, 0, p_inception_date, 'active')
  returning id into v_holder_id;

  insert into public.compound_audit (actor, action, entity, entity_id, account_id, prior_state)
  values (p_manager_user_id, 'create_account', 'compound_account', v_account_id, v_account_id, null);

  return jsonb_build_object('account_id', v_account_id, 'manager_holder_id', v_holder_id);
end;
$$;

-- Functions are granted EXECUTE to PUBLIC by default. compound_commit_reading_plan
-- (the prior writer) revokes that and grants explicitly; this one was missing
-- from the plan's own draft of this migration and is added here to match —
-- caught by comparing against that sibling function rather than assumed.
revoke execute on function public.compound_create_account(
  bigint, text, text, text, int, date, uuid, text, int
) from public;
grant execute on function public.compound_create_account(
  bigint, text, text, text, int, date, uuid, text, int
) to authenticated, service_role;
