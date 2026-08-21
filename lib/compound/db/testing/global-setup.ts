import { Client } from "pg";
import { testDatabaseUrl } from "./env";

/** Tables the CopyTraderX fixture migration must have created. */
const REQUIRED_UPSTREAM = [
  "account_snapshots_current",
  "account_snapshots_daily",
  "deals",
  "licenses",
  "users",
];

export default async function globalSetup(): Promise<void> {
  const url = testDatabaseUrl();
  const client = new Client({ connectionString: url });

  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach Postgres at ${url}.\n` +
        `Start the local stack first:  supabase start\n` +
        `Then re-run:                  pnpm test:db\n` +
        `These suites do not skip themselves — a green run must mean the ` +
        `assertions actually ran.\n` +
        `Underlying error: ${String(err)}`,
    );
  }

  try {
    const { rows } = await client.query<{ tablename: string }>(
      `select tablename from pg_tables
        where schemaname = 'public' and tablename = any($1::text[])`,
      [REQUIRED_UPSTREAM],
    );
    const found = new Set(rows.map((r) => r.tablename));
    const missing = REQUIRED_UPSTREAM.filter((t) => !found.has(t));
    if (missing.length > 0) {
      throw new Error(
        `The database at ${url} is missing CopyTraderX fixture tables: ` +
          `${missing.join(", ")}.\n` +
          `Apply the migrations:  supabase db reset`,
      );
    }
  } finally {
    await client.end();
  }
}
