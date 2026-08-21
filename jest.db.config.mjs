import base from "./jest.config.mjs";

/** @type {import('jest').Config} */
export default {
  ...base,
  testPathIgnorePatterns: ["/node_modules/"],
  testMatch: ["**/*.db.test.ts"],
  // These suites truncate shared tables. Parallel workers would corrupt each
  // other's fixtures and the failures would read as logic bugs.
  maxWorkers: 1,
  testTimeout: 30_000,
  globalSetup: "<rootDir>/lib/compound/db/testing/global-setup.ts",
};
