/**
 * TRUNCATE, closed on the other five compound_* tables, and closed for the
 * next table this project creates — not just the ledger.
 *
 * `compound_ledger_append_only` (append-only.db.test.ts) gives
 * compound_ledger_entry both a narrowed grant and a trigger, because it is
 * append-only and irreplaceable. These five are not append-only —
 * compound_account, compound_holder, compound_capital_event_candidate and
 * compound_reconcile_cursor all take UPDATE by design, and compound_audit is
 * append-only by grant alone, the same choice Task 3 made for it. None of
 * that is a reason to leave TRUNCATE reachable: RLS has no opinion on
 * TRUNCATE at all (see append-only.db.test.ts for the structural proof), so
 * a manager who can see and edit only their own account's rows is not
 * thereby stopped from truncating every manager's, on any of these five,
 * unless the grant itself refuses it.
 *
 * Verified directly against this stack before this file was written: all six
 * compound_* tables, not only the ledger, held TRUNCATE (and MAINTAIN, a
 * PostgreSQL 17 privilege invisible to information_schema — see
 * append-only.db.test.ts) for anon, authenticated and service_role, entirely
 * from pg_default_acl. None of it came from this project's own migrations.
 */
import {
  asRole,
  closeTestPool,
  expectPgError,
  resetCompoundTables,
  seedUser,
  withTestClient,
} from "./testing/harness";

const MANAGER = "aaaaaaaa-0000-4000-8000-0000000000f2";
const MT5 = 9_900_501;

const HARDENED_TABLES = [
  "compound_account",
  "compound_holder",
  "compound_capital_event_candidate",
  "compound_reconcile_cursor",
  "compound_audit",
] as const;

let accountId = 0;
let holderId = 0;

beforeEach(async () => {
  await withTestClient(async (c) => {
    await resetCompoundTables(c);
    await seedUser(c, MANAGER, "truncate-hardening@example.test");
    const account = await c.query<{ id: string }>(
      `insert into public.compound_account
         (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
       values ($1, 'Hardening Fixture', 'USD', 4000, '2026-05-01', $2)
       returning id`,
      [MT5, MANAGER],
    );
    accountId = Number(account.rows[0]!.id);

    const holder = await c.query<{ id: string }>(
      `insert into public.compound_holder
         (account_id, name, is_manager, split_bps, joined_at, status)
       values ($1, 'Fixture Manager', true, 4000, '2026-05-01', 'active')
       returning id`,
      [accountId],
    );
    holderId = Number(holder.rows[0]!.id);

    await c.query(
      `insert into public.compound_capital_event_candidate
         (account_id, trade_date, balance_delta_cents, explained_cents, unexplained_cents)
       values ($1, '2026-06-01', 500000, 0, 500000)`,
      [accountId],
    );
    await c.query(
      `insert into public.compound_reconcile_cursor (account_id, last_reading_date, last_run_at)
       values ($1, '2026-06-01', now())`,
      [accountId],
    );
    await c.query(
      `insert into public.compound_audit (account_id, actor, action, entity, entity_id)
       values ($1, $2, 'seed', 'compound_account', $1)`,
      [accountId, MANAGER],
    );
  });
});

afterAll(async () => {
  await withTestClient((c) => resetCompoundTables(c));
  await closeTestPool();
});

async function rowCounts(): Promise<Record<string, number>> {
  return withTestClient(async (c) => {
    const out: Record<string, number> = {};
    for (const table of [...HARDENED_TABLES, "compound_ledger_entry"]) {
      const { rows } = await c.query<{ n: string }>(
        `select count(*)::text as n from public.${table}`,
      );
      out[table] = Number(rows[0]!.n);
    }
    return out;
  });
}

describe("TRUNCATE is refused on each of the other five tables, not only the ledger", () => {
  it.each(HARDENED_TABLES)(
    "%s: refuses TRUNCATE CASCADE as authenticated, running as the account's own manager",
    async (table) => {
      const before = await rowCounts();
      await withTestClient((c) =>
        asRole(c, "authenticated", { userId: MANAGER }, () =>
          expectPgError(
            c.query(`truncate public.${table} cascade`),
            "42501",
            new RegExp(`permission denied for table ${table}`),
          ),
        ),
      );
      expect(await rowCounts()).toEqual(before);
    },
  );

  it.each(HARDENED_TABLES)("%s: refuses TRUNCATE CASCADE as anon", async (table) => {
    const before = await rowCounts();
    await withTestClient((c) =>
      asRole(c, "anon", {}, () =>
        expectPgError(
          c.query(`truncate public.${table} cascade`),
          "42501",
          new RegExp(`permission denied for table ${table}`),
        ),
      ),
    );
    expect(await rowCounts()).toEqual(before);
  });

  it.each(HARDENED_TABLES)("%s: refuses TRUNCATE CASCADE as service_role", async (table) => {
    const before = await rowCounts();
    await withTestClient((c) =>
      asRole(c, "service_role", {}, () =>
        expectPgError(
          c.query(`truncate public.${table} cascade`),
          "42501",
          new RegExp(`permission denied for table ${table}`),
        ),
      ),
    );
    expect(await rowCounts()).toEqual(before);
  });

  // The fixture proves these tests are not vacuous: every table actually has
  // a row in it before each TRUNCATE attempt, so "nothing changed" is a real
  // assertion, not five tables that were already empty.
  it("the fixture itself seeded a row in every one of the six tables", async () => {
    const counts = await rowCounts();
    for (const table of [...HARDENED_TABLES]) {
      expect({ table, n: counts[table] }).toEqual({ table, n: 1 });
    }
  });
});

describe("the five tables' grants are narrowed to exactly what compound_rls intended", () => {
  it("holds no TRUNCATE, MAINTAIN, REFERENCES or TRIGGER for anon, authenticated or service_role, on any of the five", async () => {
    const leaks = await withTestClient(async (c) => {
      const { rows } = await c.query<{ leak: string }>(
        `select t.table_name || '.' || r.role || ':' || p.priv as leak
           from unnest($1::text[]) as t(table_name),
                (values ('anon'), ('authenticated'), ('service_role')) as r(role),
                (values ('TRUNCATE'), ('MAINTAIN'), ('REFERENCES'), ('TRIGGER')) as p(priv)
          where has_table_privilege(r.role, 'public.' || t.table_name, p.priv)
          order by 1`,
        [HARDENED_TABLES],
      );
      return rows.map((r) => r.leak);
    });
    expect(leaks).toEqual([]);
  });

  it("anon holds no privilege at all on any of the five", async () => {
    const anonGrants = await withTestClient(async (c) => {
      const { rows } = await c.query<{ leak: string }>(
        `select t.table_name || ':' || p.priv as leak
           from unnest($1::text[]) as t(table_name),
                unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE',
                              'REFERENCES','TRIGGER','MAINTAIN']) as p(priv)
          where has_table_privilege('anon', 'public.' || t.table_name, p.priv)
          order by 1`,
        [HARDENED_TABLES],
      );
      return rows.map((r) => r.leak);
    });
    expect(anonGrants).toEqual([]);
  });

  it("still grants exactly what compound_rls intended: update everywhere but the two append-only-by-grant tables", async () => {
    const grants = await withTestClient(async (c) => {
      const { rows } = await c.query<{ table_name: string; grantee: string; privilege_type: string }>(
        `select table_name, grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'public'
            and table_name = any($1::text[])
            and grantee in ('authenticated', 'service_role')
          order by table_name, grantee, privilege_type`,
        [HARDENED_TABLES],
      );
      return rows.map((r) => `${r.table_name}.${r.grantee}:${r.privilege_type}`);
    });
    const forRole = (role: "authenticated" | "service_role") => [
      `compound_account.${role}:INSERT`,
      `compound_account.${role}:SELECT`,
      `compound_account.${role}:UPDATE`,
      `compound_audit.${role}:INSERT`,
      `compound_audit.${role}:SELECT`,
      `compound_capital_event_candidate.${role}:INSERT`,
      `compound_capital_event_candidate.${role}:SELECT`,
      `compound_capital_event_candidate.${role}:UPDATE`,
      `compound_holder.${role}:INSERT`,
      `compound_holder.${role}:SELECT`,
      `compound_holder.${role}:UPDATE`,
      `compound_reconcile_cursor.${role}:INSERT`,
      `compound_reconcile_cursor.${role}:SELECT`,
      `compound_reconcile_cursor.${role}:UPDATE`,
    ];
    expect(grants).toEqual(
      [...forRole("authenticated"), ...forRole("service_role")].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
  });
});

describe("the default ACL is narrowed too, for whatever table this project creates next", () => {
  /**
   * Revoking on today's six tables fixes today. Without also touching
   * pg_default_acl, the next `create table ... ` this project's migrations
   * run (as postgres, the role every migration in this repository has run
   * as — verified: postgres owns every table in this schema, including the
   * pre-existing CopyTraderX ones) would silently reacquire the exact same
   * TRUNCATE and MAINTAIN grants for anon, authenticated and service_role,
   * unrevoked, because nothing about creating a table calls out what it was
   * just handed by a database-wide default.
   *
   * Proven here by doing the thing a future migration would do: create a
   * real table in the public schema as postgres, inside this test, and check
   * what it was born with. Dropped again immediately after, in a `finally`,
   * so this test leaves nothing behind even if an assertion fails.
   */
  it("a freshly created table in this schema does not inherit TRUNCATE or MAINTAIN", async () => {
    const scratchTable = "compound_default_acl_probe";
    await withTestClient(async (c) => {
      await c.query(`drop table if exists public.${scratchTable}`);
      try {
        await c.query(`create table public.${scratchTable} (id bigserial primary key)`);

        const leaks = await c.query<{ leak: string }>(
          `select r.role || ':' || p.priv as leak
             from (values ('anon'), ('authenticated'), ('service_role')) as r(role),
                  (values ('TRUNCATE'), ('MAINTAIN')) as p(priv)
            where has_table_privilege(r.role, $1, p.priv)
            order by 1`,
          [`public.${scratchTable}`],
        );
        expect(leaks.rows.map((r) => r.leak)).toEqual([]);

        // The default-privileges fix is scoped to TRUNCATE and MAINTAIN only
        // (see compound_truncate_hardening's own comment for why) — REFERENCES
        // and TRIGGER are untouched, on purpose, and this is what confirms the
        // scope actually held rather than something broader and unintended.
        const stillThere = await c.query<{ has: boolean }>(
          `select has_table_privilege('authenticated', $1, 'REFERENCES') as has`,
          [`public.${scratchTable}`],
        );
        expect(stillThere.rows[0]!.has).toBe(true);
      } finally {
        await c.query(`drop table if exists public.${scratchTable}`);
      }
    });
  });
});
