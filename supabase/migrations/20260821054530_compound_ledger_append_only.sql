-- ============================================================================
-- The ledger is append-only. Design spec section 9 and invariant 5 of 3.5.
-- ============================================================================
--
-- Two layers, because neither one alone is enough:
--
--   1. GRANTS. Section 9 asks for exactly this: SELECT and INSERT, nothing
--      else, to anyone. On THIS Supabase version the default privileges grant
--      no UPDATE to begin with, so the revoke changes nothing locally for
--      UPDATE — but an older project carrying `ALTER DEFAULT PRIVILEGES ...
--      GRANT ALL` would hand UPDATE to service_role the moment the table is
--      created, and there the revoke is the whole defence. It is written
--      explicitly and not assumed.
--
--      TRUNCATE is revoked too, and this part is NOT hypothetical: verified
--      against this running stack, `anon`, `authenticated` and `service_role`
--      all hold TRUNCATE today (default-ACL, not this project's doing — see
--      the sibling migration `compound_truncate_hardening` for the other five
--      tables and the default-privileges fix). Worse, `TRUNCATE` alone looks
--      refused for `authenticated` (`0A000`) — but only by accident, because
--      `compound_capital_event_candidate.resolved_ledger_entry_id` still
--      references this table. `TRUNCATE ... CASCADE` walks straight around
--      that and succeeds, for both `authenticated` and `anon`. `revoke all`
--      below closes the real gap, not the accidental one.
--
--      `revoke all` rather than naming privileges one at a time also catches
--      `MAINTAIN` (PostgreSQL 17), which the same default ACL hands out and
--      which `information_schema.role_table_grants` does not surface at all
--      — checked directly against `pg_class.relacl` and `has_table_privilege`,
--      because the information_schema view's blind spot means a test written
--      against it cannot see this privilege leak either. The structural test
--      below checks the raw ACL for that reason.
--
--   2. TRIGGERS. Table grants do not apply to a table's owner, and these
--      migrations run as the owner. A BEFORE trigger does apply to the owner,
--      and it applies to TRUNCATE ... CASCADE exactly the way it applies to a
--      plain TRUNCATE — CASCADE does not skip a table's own BEFORE TRUNCATE
--      trigger, it only pulls in more tables, each firing its own. That is
--      the difference between "the application cannot rewrite history" and
--      "history cannot be rewritten".
--
--      Note also what a trigger is not: row-level security. RLS does not
--      apply to TRUNCATE at all — the policies from the compound_rls
--      migration have no opinion on this statement, refused or not, for any
--      role, including the account's own manager. Only the grant and the
--      trigger below stand between TRUNCATE and this table.
--
--      All three triggers are FOR EACH STATEMENT, not FOR EACH ROW — this is
--      a deviation from a plan snippet that used FOR EACH ROW for UPDATE and
--      DELETE, caught by testing the exact case the plan itself calls out
--      ("an UPDATE that matches no rows, so the guard is not row-count
--      dependent"). Verified directly: a FOR EACH ROW trigger fires once per
--      row actually touched, so `update ... where seq = 9999` against a
--      table that has rows but none with that seq fires it ZERO times and
--      the statement trivially succeeds with rowCount 0 — the guard never
--      runs. A FOR EACH STATEMENT trigger fires exactly once per statement,
--      before any row is scanned, regardless of how many rows would have
--      matched, including zero, including on a table with no rows at all.
--      That is what "not row-count dependent" actually requires, and it is
--      also cheaper: one invocation per statement instead of one per row,
--      which matters nothing here since every invocation raises, but is the
--      more honest default for a trigger that never inspects NEW or OLD.
--
-- To correct a mistake, insert a reversing entry pointing at reverses_id.
-- engine/replay.ts voids both the original and the reversal when it folds.
-- ============================================================================

revoke all on public.compound_ledger_entry
  from public, anon, authenticated, service_role;

grant select, insert on public.compound_ledger_entry to authenticated, service_role;
grant usage, select on sequence public.compound_ledger_entry_id_seq
  to authenticated, service_role;

create or replace function public.compound_ledger_entry_is_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'compound_ledger_entry is append-only: % refused. Correct a mistake with a '
    'reversing entry (reverses_id), never by editing history.', tg_op
    using errcode = 'CX010';
end;
$$;

create trigger compound_ledger_entry_no_update
  before update on public.compound_ledger_entry
  for each statement execute function public.compound_ledger_entry_is_append_only();

create trigger compound_ledger_entry_no_delete
  before delete on public.compound_ledger_entry
  for each statement execute function public.compound_ledger_entry_is_append_only();

-- A BEFORE TRUNCATE trigger must be FOR EACH STATEMENT; there are no rows to
-- iterate. This is also what refuses `TRUNCATE ... CASCADE` — the cascade
-- widens which tables are truncated, it does not exempt any of them from
-- their own BEFORE TRUNCATE trigger, and this trigger aborts the whole
-- statement (every table it would have touched) before any of it happens.
create trigger compound_ledger_entry_no_truncate
  before truncate on public.compound_ledger_entry
  for each statement execute function public.compound_ledger_entry_is_append_only();
