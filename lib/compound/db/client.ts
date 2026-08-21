/**
 * The only connection Compound opens.
 *
 * pg rather than @supabase/supabase-js. PostgREST serialises bigint and
 * numeric as JSON numbers, so 9007199254740993 arrives as 9007199254740992 and
 * every cent figure becomes a float — which spec section 4 forbids outright.
 * pg returns int8 as a string, which BigInt() parses exactly. The writer also
 * needs a real row lock, and its concurrency test needs two sessions; neither
 * is available over PostgREST.
 *
 * Every borrowed connection switches to service_role. Without that the
 * application runs as postgres, which owns these tables and carries BYPASSRLS
 * — and a table owner's implicit privileges make every grant in this schema
 * decorative at runtime. Under service_role, the append-only grant on
 * compound_ledger_entry actually binds.
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

export async function withDb<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
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
      // Discard rather than return a connection whose role or transaction
      // state we can no longer vouch for. A leaked service_role would be
      // harmless; a leaked open transaction would not.
      c.release(true);
    } else {
      await c.query("reset role");
      c.release();
    }
  }
}

export async function withDbTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withDb(async (c) => {
    await c.query("begin");
    try {
      const out = await fn(c);
      await c.query("commit");
      return out;
    } catch (err) {
      await c.query("rollback");
      throw err;
    }
  });
}
