import base from "./jest.config.mjs";

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
