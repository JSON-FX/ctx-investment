-- ============================================================================
-- Row-level security. Design spec section 9.
-- ============================================================================
--
-- Every policy is `gate AND key`:
--   gate: (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
--   key : ownership resolved through compound_account.manager_user_id
--
-- The gate is CopyTraderX's own admin idiom, used verbatim. Note that reading
-- raw_app_meta_data instead works in a direct SQL session and does NOT work
-- inside a policy evaluating a request — the role has to come from the JWT.
--
-- The two are ANDed. An `or is_admin()` bypass arm would make RLS a no-op for
-- the only role that uses this product, since the manager IS an admin (D1),
-- and would make every isolation test unfalsifiable. Ownership decides which
-- account's rows you see; the gate decides whether you see Compound at all.
--
-- D1 is single-tenant. There is no investor role to write a policy against:
-- public.users.role is check (role in ('admin','user')). Investor access,
-- when it lands in v2, keys on compound_holder.user_id = auth.uid() — data,
-- not a claim. Adding it later is additive and needs no constraint change.
--
-- On grants: on this Supabase version ALTER DEFAULT PRIVILEGES grants only
-- REFERENCES, TRIGGER and TRUNCATE to anon/authenticated/service_role, so a
-- new table starts with no DML privileges for anyone but its owner. RLS bypass
-- and table grants are independent layers: service_role has BYPASSRLS and
-- still cannot read a table it has no SELECT grant on. Every grant below is
-- required, not decoration.
-- ============================================================================

create or replace function public.compound_is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin';
$$;

revoke execute on function public.compound_is_admin() from public;
grant execute on function public.compound_is_admin() to authenticated, service_role;

-- Resolves "does the caller manage this account?" once, rather than making
-- every child policy re-enter compound_account's own policy.
--
-- SECURITY DEFINER for that reason alone. search_path is pinned empty and
-- every name is schema-qualified, so the definer's privileges cannot be
-- redirected at a different table by a caller's search_path.
create or replace function public.compound_manages_account(p_account_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.compound_account a
     where a.id = p_account_id
       and a.manager_user_id = (select auth.uid())
  );
$$;

revoke execute on function public.compound_manages_account(bigint) from public;
grant execute on function public.compound_manages_account(bigint)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- compound_account
-- ---------------------------------------------------------------------------
alter table public.compound_account enable row level security;

-- (select auth.uid()) rather than a bare auth.uid(): the subselect is
-- evaluated once per statement instead of once per row.
create policy compound_account_select on public.compound_account
  for select to authenticated
  using (public.compound_is_admin() and manager_user_id = (select auth.uid()));

create policy compound_account_insert on public.compound_account
  for insert to authenticated
  with check (public.compound_is_admin() and manager_user_id = (select auth.uid()));

create policy compound_account_update on public.compound_account
  for update to authenticated
  using (public.compound_is_admin() and manager_user_id = (select auth.uid()))
  with check (public.compound_is_admin() and manager_user_id = (select auth.uid()));

-- No delete policy, and no DELETE grant below. An account with a ledger behind
-- it is not a thing to delete.

grant select, insert, update on public.compound_account to authenticated, service_role;
grant usage, select on sequence public.compound_account_id_seq
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- compound_holder
-- ---------------------------------------------------------------------------
alter table public.compound_holder enable row level security;

create policy compound_holder_select on public.compound_holder
  for select to authenticated
  using (public.compound_is_admin() and public.compound_manages_account(account_id));

create policy compound_holder_insert on public.compound_holder
  for insert to authenticated
  with check (public.compound_is_admin() and public.compound_manages_account(account_id));

create policy compound_holder_update on public.compound_holder
  for update to authenticated
  using (public.compound_is_admin() and public.compound_manages_account(account_id))
  with check (public.compound_is_admin() and public.compound_manages_account(account_id));

grant select, insert, update on public.compound_holder to authenticated, service_role;
grant usage, select on sequence public.compound_holder_id_seq
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- compound_ledger_entry — SELECT and INSERT only, in the policies and in the
-- grants. The next migration takes UPDATE, DELETE and TRUNCATE away from
-- everyone including the owner. Section 3.5 invariant 5.
-- ---------------------------------------------------------------------------
alter table public.compound_ledger_entry enable row level security;

create policy compound_ledger_entry_select on public.compound_ledger_entry
  for select to authenticated
  using (public.compound_is_admin() and public.compound_manages_account(account_id));

create policy compound_ledger_entry_insert on public.compound_ledger_entry
  for insert to authenticated
  with check (public.compound_is_admin() and public.compound_manages_account(account_id));

grant select, insert on public.compound_ledger_entry to authenticated, service_role;
grant usage, select on sequence public.compound_ledger_entry_id_seq
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- compound_capital_event_candidate
-- ---------------------------------------------------------------------------
alter table public.compound_capital_event_candidate enable row level security;

create policy compound_capital_event_candidate_select
  on public.compound_capital_event_candidate
  for select to authenticated
  using (public.compound_is_admin() and public.compound_manages_account(account_id));

create policy compound_capital_event_candidate_insert
  on public.compound_capital_event_candidate
  for insert to authenticated
  with check (public.compound_is_admin() and public.compound_manages_account(account_id));

-- Classifying a candidate is an update, so this one needs UPDATE.
create policy compound_capital_event_candidate_update
  on public.compound_capital_event_candidate
  for update to authenticated
  using (public.compound_is_admin() and public.compound_manages_account(account_id))
  with check (public.compound_is_admin() and public.compound_manages_account(account_id));

grant select, insert, update on public.compound_capital_event_candidate
  to authenticated, service_role;
grant usage, select on sequence public.compound_capital_event_candidate_id_seq
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- compound_reconcile_cursor
-- ---------------------------------------------------------------------------
alter table public.compound_reconcile_cursor enable row level security;

create policy compound_reconcile_cursor_select on public.compound_reconcile_cursor
  for select to authenticated
  using (public.compound_is_admin() and public.compound_manages_account(account_id));

create policy compound_reconcile_cursor_insert on public.compound_reconcile_cursor
  for insert to authenticated
  with check (public.compound_is_admin() and public.compound_manages_account(account_id));

create policy compound_reconcile_cursor_update on public.compound_reconcile_cursor
  for update to authenticated
  using (public.compound_is_admin() and public.compound_manages_account(account_id))
  with check (public.compound_is_admin() and public.compound_manages_account(account_id));

grant select, insert, update on public.compound_reconcile_cursor
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- compound_audit — append-only by grant (no UPDATE, no DELETE).
--
-- account_id may be null for an action that precedes any account. The actor
-- arm covers those rows; the account arm covers the rest. `compound_manages_
-- account(null)` is false, so a null account_id can only ever be reached
-- through the actor arm.
-- ---------------------------------------------------------------------------
alter table public.compound_audit enable row level security;

create policy compound_audit_select on public.compound_audit
  for select to authenticated
  using (
    public.compound_is_admin()
    and (
      actor = (select auth.uid())
      or public.compound_manages_account(account_id)
    )
  );

create policy compound_audit_insert on public.compound_audit
  for insert to authenticated
  with check (
    public.compound_is_admin()
    and (
      actor = (select auth.uid())
      or public.compound_manages_account(account_id)
    )
  );

grant select, insert on public.compound_audit to authenticated, service_role;
grant usage, select on sequence public.compound_audit_id_seq
  to authenticated, service_role;
