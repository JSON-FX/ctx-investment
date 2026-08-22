import base from "./jest.config.mjs";

// Point the PRODUCTION pool at the TEST database for the duration of this run.
//
// Some integration suites exercise lib/compound/db/client.ts's withDb() rather
// than the harness's own connection, because the thing under test IS the
// production path. withDb reads COMPOUND_DATABASE_URL, and nothing in this
// repo loads .env into Jest — so those suites failed outright with
// "COMPOUND_DATABASE_URL is not set" unless the developer happened to export
// it, and passed against whatever they had exported when they did.
//
// Assigning it here rather than defaulting it is deliberate, and is the safety
// half: these suites truncate shared tables. A developer with
// COMPOUND_DATABASE_URL pointing at a real database in their shell would
// otherwise have run them against it. This overrides that, every time.
//
// KNOWN COLLISION, and why it is not fixed here. These suites truncate
// compound_* and the harness runs `supabase db reset`, which — verified
// empirically, not assumed — recreates the ENTIRE local Postgres instance,
// not just the postgres database. A second database on the same instance
// does not survive it, so there is no in-instance way to keep a demo
// alongside the tests. Real isolation needs a second Supabase project on
// different ports. Until then `pnpm reseed` restores the demo after a run.
//
// Precedence mirrors lib/compound/db/testing/env.ts: an explicit
// COMPOUND_TEST_DATABASE_URL wins, otherwise the local Supabase stack from
// supabase/config.toml. 127.0.0.1 rather than localhost because Docker here
// resolves localhost to ::1 first and Postgres publishes on IPv4 only.
const TEST_DB_URL =
  process.env.COMPOUND_TEST_DATABASE_URL?.trim() ||
  "postgresql://postgres:postgres@127.0.0.1:54622/postgres";
process.env.COMPOUND_DATABASE_URL = TEST_DB_URL;

// Task 5 found this override inert. `base` (jest.config.mjs) defines
// `projects`, and Jest's project mode reads testMatch/testPathIgnorePatterns
// from EACH PROJECT's own config, not from sibling keys one level up — the
// `testPathIgnorePatterns`/`testMatch` set here at the top level were never
// consulted. Every project in `base.projects` carries its own
// testPathIgnorePatterns that explicitly excludes "\\.db\\.test\\.ts$", so
// `jest --config jest.db.config.mjs` was silently re-running the same 30
// offline suites `pnpm test` runs and reporting them green — no
// *.db.test.ts file, in this file or any other, was ever actually executed
// by `pnpm test:db`. Confirmed with `--listTests` and `--showConfig` before
// this fix, and confirmed again after it, against the same command.
//
// The fix has to reach inside each project, not sit beside it — mapping over
// base.projects and overriding testMatch/testPathIgnorePatterns per project
// is the only place Jest actually reads them in this mode.
const DB_TEST_MATCH = ["**/*.db.test.ts"];
const DB_TEST_IGNORE = ["/node_modules/"];

/** @type {import('jest').Config} */
export default {
  ...base,
  projects: base.projects.map((project) => ({
    ...project,
    testMatch: DB_TEST_MATCH,
    testPathIgnorePatterns: DB_TEST_IGNORE,
  })),
  // These suites truncate shared tables. Parallel workers would corrupt each
  // other's fixtures and the failures would read as logic bugs.
  maxWorkers: 1,
  testTimeout: 30_000,
  globalSetup: "<rootDir>/lib/compound/db/testing/global-setup.ts",
};
