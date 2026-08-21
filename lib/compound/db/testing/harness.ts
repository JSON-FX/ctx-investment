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
