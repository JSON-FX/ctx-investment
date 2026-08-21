-- ============================================================================
-- TRUNCATE hardening for the other five compound_* tables, and closing the
-- door on the default ACL for tables created after this one.
-- ============================================================================
--
-- Verified against this running stack (not assumed): every one of the six
-- compound_* tables, not only compound_ledger_entry, holds TRUNCATE for
-- anon, authenticated AND service_role today. None of it came from this
-- project's own migrations — `compound_core_tables` never grants anything,
-- and `compound_rls` only ever ADDS select/insert[/update], it never starts
-- from a clean slate. What is actually on these tables is Task 3's explicit
-- grants layered on top of whatever `pg_default_acl` handed out the moment
-- each table was created (`select relname, relacl from pg_class` shows
-- `anon=Dxtm`, i.e. TRUNCATE + REFERENCES + TRIGGER + MAINTAIN, on every one
-- of the six — `compound_ledger_append_only`, the sibling migration, has the
-- full account of that, including why MAINTAIN doesn't show up in
-- information_schema).
--
-- compound_ledger_entry already got the full treatment (revoke all, regrant
-- exactly select+insert, plus the append-only triggers) in that migration,
-- because it is irreplaceable and gets a trigger too. The other five are not
-- append-only — compound_account, compound_holder,
-- compound_capital_event_candidate and compound_reconcile_cursor all take
-- UPDATE by design — but TRUNCATE is not a thing any of them should allow
-- either, for anyone but the owner: it deletes every row for every manager's
-- account in one statement, and RLS has no opinion on it one way or the
-- other (RLS does not apply to TRUNCATE, full stop — a manager who is only
-- ever allowed to see their own account's rows is not thereby restricted
-- from truncating everyone's). Revoke-all-then-regrant is the same pattern
-- Task 4 uses for the ledger, applied here to reset each table back to
-- exactly what compound_rls intended and nothing the default ACL happened to
-- add on top.
--
-- No trigger here, on purpose. These five tables are not append-only, so a
-- trigger that refuses UPDATE/DELETE/TRUNCATE unconditionally would be wrong
-- for them. The grant is the whole defence on this half of the schema, same
-- as it always was for UPDATE/DELETE — TRUNCATE is simply being brought up
-- to the same standard.
-- ============================================================================

revoke all on public.compound_account
  from public, anon, authenticated, service_role;
grant select, insert, update on public.compound_account to authenticated, service_role;
grant usage, select on sequence public.compound_account_id_seq
  to authenticated, service_role;

revoke all on public.compound_holder
  from public, anon, authenticated, service_role;
grant select, insert, update on public.compound_holder to authenticated, service_role;
grant usage, select on sequence public.compound_holder_id_seq
  to authenticated, service_role;

revoke all on public.compound_capital_event_candidate
  from public, anon, authenticated, service_role;
grant select, insert, update on public.compound_capital_event_candidate
  to authenticated, service_role;
grant usage, select on sequence public.compound_capital_event_candidate_id_seq
  to authenticated, service_role;

-- No identity sequence: the primary key is account_id itself, referencing
-- compound_account, not a bigserial.
revoke all on public.compound_reconcile_cursor
  from public, anon, authenticated, service_role;
grant select, insert, update on public.compound_reconcile_cursor
  to authenticated, service_role;

-- Append-only by grant, same as the ledger (no update/delete) — but no
-- trigger. Unlike the ledger, nothing in this plan calls compound_audit
-- irreplaceable enough to refuse its own owner; Task 3's grant-only defence
-- for this table was a deliberate choice, not an oversight, and extending it
-- to a trigger is out of this task's scope.
revoke all on public.compound_audit
  from public, anon, authenticated, service_role;
grant select, insert on public.compound_audit to authenticated, service_role;
grant usage, select on sequence public.compound_audit_id_seq
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The default ACL itself. Revoking on today's six tables fixes today; it
-- does nothing about the next `create table` this project's migrations run
-- as `postgres` (confirmed the owner of every table in this schema, and the
-- role every migration in this repository has run as). Without this, the
-- exact same TRUNCATE grant reappears, unrevoked, the moment a Task 5+ (or a
-- CopyTraderX) migration adds a new table to the public schema — silently,
-- since nothing about creating a table calls out what it was just handed.
--
-- Scoped narrowly on purpose:
--   - `for role postgres` — the one role that actually owns every table this
--     default has ever applied to here (confirmed: `postgres` is not a
--     member of `supabase_admin`, so it could not alter that role's separate
--     default-privileges entry even if this project wanted it to — and nothing
--     in this schema has ever been created by supabase_admin, so that entry
--     is not this project's problem to fix).
--   - `in schema public` — not database-wide in the sense of every schema;
--     just the one this project's tables live in.
--   - `truncate[, maintain]` only — not references or trigger. Neither of
--     those lets a role touch a row's data or bypass RLS on a read; revoking
--     them would be tidying, not closing a hole, and the point here is the
--     hole.
--
-- This changes the default for every FUTURE table postgres creates in the
-- public schema of this database — including any future CopyTraderX table,
-- not only compound_*, since they share the schema (decision D2). That is
-- the intended effect, not a side effect: neither PostgREST nor any
-- SECURITY DEFINER function in this project has ever used TRUNCATE or
-- MAINTAIN, on any table, and a narrower default costs nothing a real code
-- path relies on. It is reversible per table with an explicit grant if a
-- future table genuinely needs one of these.
--
-- MAINTAIN is PostgreSQL 17. Guarded by server_version_num so this migration
-- does not fail outright on an older Postgres — the six tables above are
-- already clean either way; this block is only about what happens next.
-- ----------------------------------------------------------------------------
do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute
      'alter default privileges for role postgres in schema public '
      'revoke truncate, maintain on tables from anon, authenticated, service_role';
  else
    execute
      'alter default privileges for role postgres in schema public '
      'revoke truncate on tables from anon, authenticated, service_role';
  end if;
end;
$$;
