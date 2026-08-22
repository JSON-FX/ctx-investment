-- ============================================================================
-- Fix: compound_create_account's CX101 duplicate check goes RLS-blind for a
-- cross-manager collision, once the app actually connects as `authenticated`
-- (this task, fix/connect-as-authenticated — see D-F).
-- ============================================================================
--
-- compound_create_account is SECURITY INVOKER (deliberately — see its own
-- migration's header). Its CX101 guard is
--
--   if exists (select 1 from public.compound_account a where a.mt5_account = p_mt5_account)
--
-- Every other writer's own "does this row exist" guard checks by the
-- account's own id (p_account_id) — a row the caller already owns, because
-- every real call site resolves it through requireAccount first, and
-- compound_account_select's policy lets an owner see their own row
-- regardless. This is the one guard in the whole write surface that is not
-- shaped that way: mt5_account is not scoped to the caller at all, by
-- design — it exists specifically to catch ANY manager, not just this one,
-- already having registered that broker account.
--
-- Run this SELECT as `authenticated` and compound_account_select's policy
-- (manager_user_id = auth.uid()) filters it to the caller's own rows before
-- EXISTS ever sees it. A second manager registering an mt5_account someone
-- else already claimed then finds no match, CX101 never fires, and the
-- INSERT reaches compound_account_mt5_account_key's raw UNIQUE constraint
-- instead — a 23505 unique_violation, not the friendly CX101 message
-- present/errors.ts already knows how to render. Confirmed by writing
-- write-account.db.test.ts's "a different manager" case and watching it
-- fail exactly that way before this migration, not assumed.
--
-- Fix, mirroring compound_manages_account's own pattern one migration
-- earlier: a narrow SECURITY DEFINER function that answers exactly one
-- yes/no question with elevated privilege and leaks nothing else — not
-- which manager owns the colliding mt5_account, not any other column, only
-- whether the number is taken at all. compound_create_account's own
-- SECURITY INVOKER stays exactly as it was; only this one lookup borrows
-- visibility, the same way compound_manages_account already lets every
-- other writer resolve "do I manage this account" without a bespoke policy
-- on every child table.
-- ============================================================================

create or replace function public.compound_mt5_account_taken(p_mt5_account bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.compound_account a where a.mt5_account = p_mt5_account
  );
$$;

revoke execute on function public.compound_mt5_account_taken(bigint) from public;
grant execute on function public.compound_mt5_account_taken(bigint)
  to authenticated, service_role;

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
  if public.compound_mt5_account_taken(p_mt5_account) then
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

-- compound_create_account's own EXECUTE grant already covers authenticated
-- and service_role (20260821004302... no — 20260821102706_compound_create_
-- account.sql) and `create or replace function` does not reset it, but
-- restated here anyway: relying on a grant made by a migration this one is
-- editing the body of, without re-asserting it, is the kind of implicit
-- dependency this project's own lessons table warns about.
revoke execute on function public.compound_create_account(
  bigint, text, text, text, int, date, uuid, text, int
) from public;
grant execute on function public.compound_create_account(
  bigint, text, text, text, int, date, uuid, text, int
) to authenticated, service_role;
