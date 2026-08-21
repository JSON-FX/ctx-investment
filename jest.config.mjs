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
// exact blind spot this comment describes.
process.env.TZ = "Asia/Manila";

/** @type {import('jest').Config} */
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/lib"],
  moduleNameMapper: { "^@/(.*)$": "<rootDir>/$1" },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { target: "ES2022", module: "CommonJS" } }],
  },
};
