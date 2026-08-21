/**
 * Where the integration tests connect.
 *
 * The default is the local Supabase stack defined in supabase/config.toml
 * (db.port = 54622). It is a local-only credential — postgres/postgres on the
 * loopback — so it is safe in a public repository, and hard-coding it means a
 * fresh clone can run `pnpm test:db` without setting anything up.
 *
 * 127.0.0.1 rather than localhost: Docker on this machine resolves localhost
 * to ::1 first, and the Postgres container publishes on IPv4 only.
 */
export const LOCAL_SUPABASE_DB_URL =
  "postgresql://postgres:postgres@127.0.0.1:54622/postgres";

export function testDatabaseUrl(): string {
  const override = process.env.COMPOUND_TEST_DATABASE_URL;
  if (override && override.trim() !== "") return override;
  return LOCAL_SUPABASE_DB_URL;
}
