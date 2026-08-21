/**
 * Test-only helpers. Never imported by application code.
 *
 * Four of these exist because of specific properties of this schema:
 *
 * - asRole, because RLS does not apply to a table's owner or to any role with
 *   BYPASSRLS. postgres and service_role both have BYPASSRLS, so an RLS test
 *   that runs as either of them passes with RLS switched off entirely. Every
 *   RLS assertion in this repository runs through asRole(c, "authenticated").
 *
 * - resetCompoundTables, because compound_ledger_entry refuses DELETE and
 *   TRUNCATE by trigger, including from its owner. Clearing it is a deliberate
 *   owner-level act and it should look like one.
 *
 * - sequenceConsumed, because sequences are exempt from transaction rollback.
 *   That makes them the only way to observe that rows really were inserted
 *   before a failure rolled them back — which is what separates a genuine
 *   atomicity test from one whose guard fired before anything was written.
 *
 * - expectPgError, because asserting a rejection by error class alone passes
 *   when a different, earlier failure throws the same class. The engine build
 *   shipped exactly that bug.
 */
import { Client, Pool, type PoolClient } from "pg";
import type { Cents } from "../../engine/money";
import type { LedgerEntryType } from "../../engine/replay";
import type { Queryable } from "../types";
import { testDatabaseUrl } from "./env";

// Re-exported so a test file imports its whole vocabulary from one place. The
// definition lives in types.ts.
export type { Queryable };
export type DbRole = "anon" | "authenticated" | "service_role";
export type AppRole = "admin" | "user";

let pool: Pool | null = null;

export function testPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: testDatabaseUrl(), max: 4 });
  return pool;
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function withTestClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await testPool().connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

/**
 * A second, fully independent backend. The concurrency test in Task 8 needs
 * two sessions holding locks at the same time, which one pooled client cannot.
 */
export async function withSeparateSession<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: testDatabaseUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/**
 * Run fn with current_user switched to `role`, auth.uid() resolving to
 * opts.userId, and the app_metadata role claim set to opts.appRole
 * (default "admin", since the manager is an admin under D1).
 *
 * Both settings are transaction-local, so the role is restored on commit or
 * rollback and cannot leak into the next test.
 *
 * The claim shape mirrors a real Supabase JWT, because policies read it with
 * auth.jwt() -> 'app_metadata' ->> 'role'. Reading raw_app_meta_data instead
 * works in a SQL session and does not work inside a policy evaluating a
 * request, which is exactly the sort of difference a harness must not paper
 * over.
 */
export async function asRole<T>(
  c: Queryable,
  role: DbRole,
  opts: { userId?: string | null; appRole?: AppRole | null },
  fn: () => Promise<T>,
): Promise<T> {
  await c.query("begin");
  try {
    const appRole = opts.appRole === undefined ? "admin" : opts.appRole;
    const claims = JSON.stringify({
      sub: opts.userId ?? null,
      role,
      app_metadata: appRole === null ? {} : { role: appRole },
    });
    await c.query("select set_config('request.jwt.claims', $1, true)", [claims]);
    // `role` is a closed TypeScript union, never caller-supplied text. SET does
    // not accept bind parameters, so interpolation is the only option here.
    await c.query(`set local role ${role}`);
    const out = await fn();
    await c.query("commit");
    return out;
  } catch (err) {
    await c.query("rollback");
    throw err;
  }
}

/**
 * Clear every compound_* table. Must run as the owner: the append-only
 * triggers on compound_ledger_entry refuse DELETE and TRUNCATE for everyone,
 * owner included, so they are disabled for the length of this statement and
 * re-enabled immediately.
 *
 * RESTART IDENTITY makes ids and sequence counters deterministic per test,
 * which the sequence ratchets in Task 8 depend on.
 */
export async function resetCompoundTables(c: Queryable): Promise<void> {
  await c.query(`
    alter table public.compound_ledger_entry disable trigger user;
    truncate table
      public.compound_audit,
      public.compound_capital_event_candidate,
      public.compound_reconcile_cursor,
      public.compound_ledger_entry,
      public.compound_holder,
      public.compound_account
      restart identity;
    alter table public.compound_ledger_entry enable trigger user;
  `);
}

/**
 * How many values the table's identity sequence has handed out.
 *
 * A fresh or RESTART IDENTITY'd sequence reports last_value = 1 with
 * is_called = false, meaning nothing consumed. After n nextval calls it
 * reports last_value = n with is_called = true. Normalising the two into one
 * count is what lets a test say "three rows were inserted" about a transaction
 * that rolled back.
 */
export async function sequenceConsumed(
  c: Queryable,
  table: string,
  column: string,
): Promise<number> {
  const named = await c.query<{ seq: string | null }>(
    "select pg_get_serial_sequence($1, $2) as seq",
    [table, column],
  );
  const seqName = named.rows[0]?.seq;
  if (!seqName) throw new Error(`no identity sequence for ${table}.${column}`);
  // seqName is a schema-qualified, already-quoted identifier produced by
  // Postgres itself, not caller input. A sequence name cannot be bound.
  const { rows } = await c.query<{ last_value: string; is_called: boolean }>(
    `select last_value, is_called from ${seqName}`,
  );
  const row = rows[0];
  if (!row) throw new Error(`sequence ${seqName} returned no row`);
  const last = Number(row.last_value);
  return row.is_called ? last : last - 1;
}

/**
 * Insert a user the way a real signup does, plus a fallback.
 *
 * The role goes in raw_user_meta_data, NOT raw_app_meta_data. CopyTraderX's
 * handle_auth_user_insert trigger reads raw_user_meta_data ->> 'role' at
 * signup, creates the public.users row from it, and only then stamps
 * raw_app_meta_data.role itself. Writing raw_app_meta_data directly looks like
 * it works — the value is right there in the row — and produces no
 * public.users row at all, so every RLS policy keyed on manager_user_id fails
 * with a foreign key error that reads like a fixture bug.
 *
 * The public.users insert afterwards is a fallback for a local stack whose
 * trigger is absent. ON CONFLICT DO NOTHING makes it a no-op when the trigger
 * did fire, so the helper is correct either way and a test fixture never
 * depends on a trigger happening to exist. Fictional values only.
 */
export async function seedUser(
  c: Queryable,
  id: string,
  email: string,
  role: AppRole = "admin",
): Promise<void> {
  await c.query(
    `insert into auth.users
       (id, instance_id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated',
             'authenticated', $2, '', now(), now(), now(),
             '{}'::jsonb, jsonb_build_object('role', $3::text))
     on conflict (id) do nothing`,
    [id, email, role],
  );
  await c.query(
    `insert into public.users (id, email, role, must_change_password)
     values ($1, $2, $3, false)
     on conflict (id) do nothing`,
    [id, email, role],
  );
}

/** One account, its manager's uuid, and the holder ids seedTwoAccounts left on it. */
export interface SeededAccount {
  accountId: number;
  managerUserId: string;
  holderIds: number[];
}

/** What seedTwoAccounts hands back — enough to assert against without re-querying. */
export interface TwoAccountSeed {
  accountA: SeededAccount;
  accountB: SeededAccount;
}

/**
 * Two compound_account rows under two distinct manager_user_id values, plus
 * the public.users rows they reference through seedUser.
 *
 * The two accounts differ in holder count on purpose — account A gets a
 * manager and one investor, account B gets a manager alone — so a caller can
 * tell them apart by shape, not only by id. Two accounts that are identical
 * except for their primary key is exactly the fixture shape this project's
 * own lessons-from-the-engine-build table warns about ("one account, one
 * manager" / a filter that already excludes the other rows): a policy or a
 * query that quietly leaked rows across accounts would still look correct
 * against two same-shaped accounts, because there would be nothing to tell
 * the leaked rows apart from the real ones.
 *
 * Fictional mt5 account numbers in the 9_921_0xx range, chosen not to
 * collide with the fixtures already in schema.db.test.ts (9_900_0xx),
 * rls.db.test.ts (9900_10x) or append-only.db.test.ts (9_900_4xx) — relevant
 * only if a caller also seeds its own account in the same test body; every
 * test file's own beforeEach already truncates all six tables first, so
 * there is no collision across files or across runs.
 */
export async function seedTwoAccounts(c: Queryable): Promise<TwoAccountSeed> {
  const managerA = "aaaaaaaa-0000-4000-8000-0000000000a1";
  const managerB = "bbbbbbbb-0000-4000-8000-0000000000b1";

  await seedUser(c, managerA, "seed-two-accounts-a@example.test");
  await seedUser(c, managerB, "seed-two-accounts-b@example.test");

  const accountARow = await c.query<{ id: string }>(
    `insert into public.compound_account
       (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
     values (9921001, 'Seed Account A', 'USD', 4000, '2026-05-01', $1)
     returning id`,
    [managerA],
  );
  const accountAId = Number(accountARow.rows[0]!.id);

  const accountBRow = await c.query<{ id: string }>(
    `insert into public.compound_account
       (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
     values (9921002, 'Seed Account B', 'USD', 3000, '2026-06-15', $1)
     returning id`,
    [managerB],
  );
  const accountBId = Number(accountBRow.rows[0]!.id);

  // Account A: a manager plus one investor — two holders.
  const holdersA = await c.query<{ id: string }>(
    `insert into public.compound_holder
       (account_id, name, is_manager, split_bps, joined_at, status)
     values ($1, 'Seed Manager A', true, 4000, '2026-05-01', 'active'),
            ($1, 'Seed Investor A1', false, 4000, '2026-05-02', 'active')
     returning id`,
    [accountAId],
  );

  // Account B: the manager alone — one holder. The count itself is the
  // difference a test can see, per the doc comment above.
  const holdersB = await c.query<{ id: string }>(
    `insert into public.compound_holder
       (account_id, name, is_manager, split_bps, joined_at, status)
     values ($1, 'Seed Manager B', true, 3000, '2026-06-15', 'active')
     returning id`,
    [accountBId],
  );

  return {
    accountA: {
      accountId: accountAId,
      managerUserId: managerA,
      holderIds: holdersA.rows.map((r) => Number(r.id)),
    },
    accountB: {
      accountId: accountBId,
      managerUserId: managerB,
      holderIds: holdersB.rows.map((r) => Number(r.id)),
    },
  };
}

/** One row for seedLedger. Mirrors compound_ledger_entry's own columns, not engine/replay's shape. */
export interface LedgerSeedEntry {
  /** Caller-controlled. Not generated here — see seedLedger's doc comment. */
  seq: number;
  /** Broker-server date, YYYY-MM-DD. */
  occurredOn: string;
  type: LedgerEntryType;
  amountCents: Cents;
  holderId?: number | null;
  feeSettlement?: "units" | "cash" | null;
  splitBpsApplied?: number | null;
  reversesId?: number | null;
  note?: string | null;
  createdBy?: string | null;
}

/**
 * Append ledger entries for an account, in the order given, and return their
 * ids in that same order.
 *
 * seq is caller-controlled on purpose, not generated here: Plan 4 folds
 * these through engine/replay.ts's fold(), which orders strictly by seq, so
 * a caller that wants a specific replay order needs to be able to say so
 * directly rather than trust an auto-increment to agree with it. This
 * function does not validate contiguity or gaplessness itself — it inserts
 * exactly what it is given, and compound_ledger_entry_account_seq_key (seq
 * unique per account) and compound_ledger_entry_seq_check (seq > 0) are the
 * schema's own word on what a caller can get away with.
 *
 * Entries are inserted one at a time, in array order, so an entry can carry
 * a reversesId pointing at an id this same call already returned earlier in
 * the array — the ordinary shape of a correction a few rows after the entry
 * it reverses.
 *
 * amountCents is passed through as a string, not a bound bigint: node-pg
 * does not turn a JS number into a bigint parameter, and `${amountCents}`
 * on a bigint is exact (no float ever sees the value), the same rule P3
 * applies to every other money-handling line in this project.
 */
export async function seedLedger(
  c: Queryable,
  accountId: number,
  entries: readonly LedgerSeedEntry[],
): Promise<number[]> {
  const ids: number[] = [];
  for (const entry of entries) {
    const { rows } = await c.query<{ id: string }>(
      `insert into public.compound_ledger_entry
         (account_id, holder_id, seq, occurred_on, type, amount_cents,
          fee_settlement, split_bps_applied, note, reverses_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id`,
      [
        accountId,
        entry.holderId ?? null,
        entry.seq,
        entry.occurredOn,
        entry.type,
        `${entry.amountCents}`,
        entry.feeSettlement ?? null,
        entry.splitBpsApplied ?? null,
        entry.note ?? null,
        entry.reversesId ?? null,
        entry.createdBy ?? null,
      ],
    );
    ids.push(Number(rows[0]!.id));
  }
  return ids;
}

/**
 * Assert a query is refused for a specific reason.
 *
 * Both the SQLSTATE and the message must match. Asserting the class alone is
 * how the engine build shipped a test that passed with the guard it covered
 * deleted, because a deeper guard threw the same class first. "relation does
 * not exist" and "permission denied" are both errors; only one of them means
 * the protection worked.
 */
export async function expectPgError(
  p: Promise<unknown>,
  code: string,
  message: RegExp,
): Promise<void> {
  let caught: unknown = null;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  if (caught === null) {
    throw new Error(`expected a Postgres error with code ${code}, but the query succeeded`);
  }
  const err = caught as { code?: string; message?: string };
  expect({ code: err.code, message: err.message }).toEqual({
    code,
    message: expect.stringMatching(message),
  });
}
