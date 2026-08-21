/**
 * Read-only pre-flight for applying Compound's migrations to a live database.
 *
 * Same checks as preflight.sql, runnable without psql — this project already
 * depends on `pg`. It writes nothing: no CREATE, no ALTER, no INSERT, no
 * DELETE. Every statement below is a SELECT.
 *
 *   COMPOUND_LIVE_URL=... node docs/live-migration/preflight.mjs
 *
 * Read from the environment rather than argv so the connection string does
 * not land in shell history.
 *
 * Read every verdict. Anything that is not OK is a stop.
 */
import pg from "pg";

const url = process.env.COMPOUND_LIVE_URL ?? process.argv[2];
if (!url) {
  console.error("usage: COMPOUND_LIVE_URL=<connection-string> node docs/live-migration/preflight.mjs");
  console.error("(argv is accepted too, but the environment keeps it out of shell history)");
  process.exit(2);
}

const c = new pg.Client({ connectionString: url });
await c.connect();

let stops = 0;
const say = (label, verdict, detail = "") => {
  if (/^STOP/.test(verdict)) stops += 1;
  console.log(`${verdict.padEnd(7)} ${label}${detail ? "\n         " + detail : ""}`);
};

const one = async (sql, params = []) => (await c.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await c.query(sql, params)).rows;

// 1 — server version
{
  const r = await one(`select current_setting('server_version') v,
                              current_setting('server_version_num')::int n`);
  say("PostgreSQL " + r.v, "OK",
    r.n >= 170000 ? "MAINTAIN exists; the hardening's PG17 branch will run"
                  : "pre-17; the hardening revokes TRUNCATE only");
}

// 2 — public.users(id uuid)
{
  const r = await one(`select exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='users'
      and column_name='id' and data_type='uuid') ok`);
  say("public.users(id uuid) exists", r.ok ? "OK" : "STOP",
    r.ok ? "five compound foreign keys point here, not at auth.users"
         : "compound_core_tables references public.users(id) and will fail");
}

// 3 — role constraint, for information
{
  const rows = await all(`select pg_get_constraintdef(oid) def from pg_constraint
    where conrelid = to_regclass('public.users') and contype='c'
      and pg_get_constraintdef(oid) ilike '%role%'`);
  say("public.users role constraint", "INFO",
    (rows[0]?.def ?? "(none found)") + "\n         Compound adds no role and does not widen this.");
}

// 4 — clean compound_ namespace
{
  // relkind r/v/m only — an index or sequence named compound_* is a
  // consequence of a table existing, not an independent collision, and
  // listing them buries the finding that matters.
  const rows = await all(`select c.relname from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname like 'compound%'
      and c.relkind in ('r','v','m')
    union all
    select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'compound%'`);
  say("compound_* namespace is clear", rows.length === 0 ? "OK" : "STOP",
    rows.length === 0 ? "nothing to collide with"
                      : "already present: " + rows.map((r) => r.relname).join(", "));
}

// 5 — the CopyTraderX tables Compound reads
for (const t of ["deals","account_snapshots_daily","account_snapshots_current","orders","positions"]) {
  const r = await one(`select to_regclass($1) is not null ok`, ["public." + t]);
  say(`reads public.${t}`, r.ok ? "OK" : "STOP", r.ok ? "" : "Compound reads this table");
}

// 6 — current TRUNCATE exposure on an existing CopyTraderX table
{
  const rows = await all(`select grantee, privilege_type from information_schema.role_table_grants
    where table_schema='public' and table_name='deals'
      and privilege_type in ('TRUNCATE','DELETE') order by grantee, privilege_type`);
  const trunc = rows.filter((r) => r.privilege_type === "TRUNCATE").map((r) => r.grantee);
  say("TRUNCATE exposure on public.deals", "INFO",
    trunc.length ? `held by: ${trunc.join(", ")} — the hole the hardening closes exists here too`
                 : "no role holds TRUNCATE on deals");
}

// 7 — existing default privileges, what migration 5 changes FROM
{
  const rows = await all(`select defaclrole::regrole::text grantor, defaclacl::text[] acl
    from pg_default_acl where defaclnamespace='public'::regnamespace and defaclobjtype='r'`);
  say("default privileges in schema public", "INFO",
    rows.length ? rows.map((r) => `${r.grantor}: ${r.acl.join(" ")}`).join("\n         ")
                : "(none set)");
}

// 8 — does anything actually rely on TRUNCATE?
{
  const rows = await all(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosrc ~* '\\mtruncate\\M'`);
  say("functions using TRUNCATE", rows.length === 0 ? "OK" : "REVIEW",
    rows.length === 0 ? "nothing relies on it; the narrowed default costs no real code path"
                      : "would be affected: " + rows.map((r) => r.proname).join(", "));
}

await c.end();
console.log(`\n${stops === 0 ? "No stops." : stops + " STOP(s) — do not apply."}`);
process.exit(stops === 0 ? 0 : 1);
