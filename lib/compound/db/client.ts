/**
 * The only connections Compound opens.
 *
 * pg rather than @supabase/supabase-js. PostgREST serialises bigint and
 * numeric as JSON numbers, so 9007199254740993 arrives as 9007199254740992 and
 * every cent figure becomes a float — which spec section 4 forbids outright.
 * pg returns int8 as a string, which BigInt() parses exactly. The writer also
 * needs a real row lock, and its concurrency test needs two sessions; neither
 * is available over PostgREST.
 *
 * TWO helpers, not one, because compound_* and CopyTraderX's own tables need
 * opposite things from this connection (see D-F, docs/superpowers/plans/
 * 2026-08-21-compound-desk.md):
 *
 *   withAuthenticatedDb   every compound_* read and write. Runs as
 *                         `authenticated`, with the signed-in user's own JWT
 *                         claims, so the 16 policies in compound_rls.sql
 *                         actually evaluate. This is now the real boundary
 *                         between one manager's rows and another's —
 *                         requireAccount/requireManager (load/session.ts,
 *                         load/account.ts) are defence-in-depth on top of it,
 *                         not instead of it.
 *
 *   withElevatedCopyTraderXRead   the five CopyTraderX-owned source tables
 *                         (deals, account_snapshots_daily/current, orders,
 *                         positions) plus users and licenses. Every one of
 *                         them is RLS-enabled with zero policies for anon or
 *                         authenticated — deny-all — and neither role holds
 *                         so much as a SELECT grant on any of them (see
 *                         supabase/migrations/20260821004302_copytraderx_
 *                         fixture_tables.sql and .../20260821120000_
 *                         copytraderx_orders_positions.sql). There is no
 *                         claims-and-role dance this connection could do
 *                         instead: the only role with a grant at all is
 *                         service_role, so reading them elevated is not a
 *                         shortcut, it is the only route that exists. Kept
 *                         narrow and named for exactly that reason — see its
 *                         own doc comment for the rule about what it must
 *                         never be used for.
 *
 * Without either helper switching away from the pool's own login role, the
 * application runs as postgres, which owns every one of these tables and
 * carries BYPASSRLS — a table owner's implicit privileges make every grant
 * and every policy in this schema decorative at runtime.
 */
import { Pool, type PoolClient } from "pg";

let pool: Pool | null = null;

export function databaseUrl(): string {
  const url = process.env.COMPOUND_DATABASE_URL;
  if (!url || url.trim() === "") {
    throw new Error(
      "COMPOUND_DATABASE_URL is not set. Compound connects to Postgres directly; " +
        "see .env.example.",
    );
  }
  return url;
}

export function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: databaseUrl(), max: 10 });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Every compound_* read and write, run AS the signed-in manager.
 *
 * Always transactional, and that is the mechanism, not a courtesy. `SET
 * ROLE` and a session-level set_config() are connection-scoped: a pooled
 * connection handed back to the pool with either still set would leak this
 * request's identity into whichever request the pool serves next. `SET
 * LOCAL ROLE` and `set_config(..., true)` are transaction-scoped instead —
 * both are unwound automatically at COMMIT or ROLLBACK, by Postgres itself,
 * before the connection is ever released. That makes "always inside a
 * transaction" the actual reset guarantee, rather than a `reset role` call
 * this function could fail to reach on some exit path. See client.db.test.ts's
 * "does not leak one caller's identity into the next checkout" for the
 * probe, and db/testing/harness.ts's asRole, which this mirrors exactly —
 * asRole is how every RLS assertion in rls.db.test.ts is proven, and this is
 * the same claims-then-role sequence, wrapped around a pooled checkout
 * instead of a borrowed test client.
 *
 * The cost: every read now pays for a round trip it did not before (begin +
 * two settings + commit, instead of one query). For an admin desk at this
 * project's scale that cost is real but not one worth engineering around —
 * see the report for the number this was actually measured at.
 *
 * appRole is always "admin", not a parameter: requireManager() (load/
 * session.ts) is the only path that resolves a session at all, and it
 * redirects away anyone whose claim is not "admin" before this function is
 * ever reachable. There is no caller of this function acting for a
 * non-admin identity for that to be a parameter of.
 */
export async function withAuthenticatedDb<T>(
  userId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await getPool().connect();
  let broken = false;
  try {
    await c.query("begin");
    const claims = JSON.stringify({
      sub: userId,
      role: "authenticated",
      app_metadata: { role: "admin" },
    });
    await c.query("select set_config('request.jwt.claims', $1, true)", [claims]);
    await c.query("set local role authenticated");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (err) {
    broken = true;
    try {
      await c.query("rollback");
    } catch {
      // The connection may already be unusable — c.release(true) below is
      // what actually protects the next checkout, not this rollback
      // succeeding. Swallowing here only avoids masking the original error
      // with a second one from a connection that is already broken.
    }
    throw err;
  } finally {
    // A broken connection is discarded rather than released: release()
    // would hand it back to the pool for reuse, and this function cannot
    // vouch for a connection's role or transaction state after an error it
    // could not itself unwind cleanly. A clean commit or rollback needs no
    // such care — ROLLBACK, like COMMIT, already clears every LOCAL setting
    // before this line runs, so the plain release() below is returning a
    // connection with nothing of this request's identity still attached.
    c.release(broken);
  }
}

/**
 * The narrow exception: reading the CopyTraderX-owned source tables —
 * deals, account_snapshots_daily, account_snapshots_current, orders,
 * positions — plus users and licenses, the two smaller tables the
 * copytraderx-license app owns. Compound reads all seven and writes to none
 * of them.
 *
 * Every one of them is RLS-enabled with zero policies for anon or
 * authenticated, and grants SELECT to service_role alone (see the two
 * migrations named in this module's own doc comment). That is not a gap to
 * route around: it is deliberate, on tables this codebase does not own, and
 * it means there is no claims-and-role dance available here the way there is
 * for compound_* — `authenticated`, even with a real admin's own claims, has
 * no grant on any of these seven tables at all. service_role is therefore
 * not a shortcut past RLS on this path, it is the only role with a seat at
 * the table.
 *
 * RULES, both load-bearing:
 *
 *   1. NEVER for a compound_* table. Every one of those has the real policies
 *      compound_rls.sql defines, and service_role carries BYPASSRLS — using
 *      this connection for compound_account, compound_ledger_entry or any of
 *      the other four would reopen the exact gap D-F records and this file
 *      exists to close everywhere except here.
 *
 *   2. NEVER for a write. Nothing this codebase does to these seven tables is
 *      a write — Compound only ever reads them — and this function's name
 *      says "Read" so a future write attempt reads as wrong on sight, not
 *      just in a code review comment. There is no separate enforcement of
 *      this beyond the name and this doc comment: service_role's grants on
 *      these tables are SELECT-only in every migration that touches them
 *      (see the two migrations named above), so a write attempt fails at the
 *      database regardless — but that failure should never be reachable in
 *      the first place.
 *
 * Every call site is listed, with why it is here and not on
 * withAuthenticatedDb, in the report this task produced
 * (.superpowers/rls-connection-report.md).
 */
export async function withElevatedCopyTraderXRead<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  let broken = false;
  try {
    await c.query("set role service_role");
    return await fn(c);
  } catch (err) {
    broken = true;
    throw err;
  } finally {
    if (broken) {
      // Discard rather than return a connection whose role we can no longer
      // vouch for. A leaked service_role would let the next checkout read
      // these seven tables when it should not have to — narrow as this path
      // is, that is still a real leak, not a harmless one.
      c.release(true);
    } else {
      await c.query("reset role");
      c.release();
    }
  }
}
