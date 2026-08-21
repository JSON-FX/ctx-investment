// Pin the test runner's timezone to something other than UTC.
//
// reconcile/date-key.ts's utcDateKey exists specifically to read the UTC
// calendar day rather than the local one — a wrong day invents or hides a
// capital event (see the design spec, §5.3). If a future edit swapped in a
// local-time read (e.g. `getFullYear`/`getMonth`/`getDate` instead of
// `toISOString`), the existing boundary-case tests would only catch it on a
// runner whose local TZ differs from UTC. Most CI runners default to UTC, so
// on one of those the mutation would be silently invisible — the whole test
// file passes even though the function is now wrong. Asia/Manila is fixed at
// UTC+08:00 with no DST transitions (confirmed: the Philippines has not
// observed DST since 1954), so this is stable year-round and never
// coincides with UTC, which is what makes the assertion discriminate
// everywhere, not just on whichever machine happens to run it.
//
// Do not "simplify" this back to UTC or remove it — that reintroduces the
// exact blind spot this comment describes. It stays at module scope so it is
// set before either project below is constructed.
//
// This must be a DEFAULT, not an unconditional override. An unconditional
// `process.env.TZ = "Asia/Manila"` here would silently clobber a
// shell-supplied TZ (e.g. `TZ=Pacific/Kiritimati npx jest`), which defeats
// the one way anyone can actually verify a timezone-independence claim by
// varying the runner's zone. Whenever the shell leaves TZ unset — every CI
// runner and most local runs — this still lands on Asia/Manila, so the
// discriminating power described above is unchanged by default.
if (!process.env.TZ) process.env.TZ = "Asia/Manila";

/** @type {import('jest').Config} */
const shared = {
  preset: "ts-jest",
  moduleNameMapper: { "^@/(.*)$": "<rootDir>/$1" },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      { tsconfig: { target: "ES2022", module: "CommonJS", jsx: "react-jsx" } },
    ],
  },
};

export default {
  projects: [
    {
      ...shared,
      displayName: "unit",
      testEnvironment: "node",
      roots: ["<rootDir>/lib"],
      testPathIgnorePatterns: [
        "/node_modules/",
        "\\.db\\.test\\.ts$",
        "<rootDir>/lib/compound/ui/",
      ],
    },
    {
      ...shared,
      displayName: "ui",
      testEnvironment: "jsdom",
      roots: ["<rootDir>/lib/compound/ui"],
      testPathIgnorePatterns: ["/node_modules/", "\\.db\\.test\\.ts$"],
      setupFilesAfterEnv: ["<rootDir>/jest.setup.ui.ts"],
    },
  ],
};
