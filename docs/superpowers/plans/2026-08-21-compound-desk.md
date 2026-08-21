# Compound Investor Desk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deployment shell at `app/page.tsx` with the real desk — five read surfaces and five money flows, each of which shows the complete arithmetic before it commits anything, rendered from `PoolState` and `quote()` so that no figure on any screen is computed twice.

**Architecture:** Four layers, each testable without the one above it. `lib/compound/present/` is pure derivation and formatting — it turns `PoolState`, `Quote` and `LedgerEntry[]` into the exact strings and shapes a screen needs, and imports neither React nor `db/`. `lib/compound/ui/` is the statement kit — presentational React components that take engine types and render figures, importing no data layer. `lib/compound/load/` is the request-scoped server loader — session, account resolution and cached reads over plan 3's `db/`. `app/` is routes only: every page resolves an account, calls a loader, and hands the result to the kit. Money flows are two-step server-rendered sheets — enter the amount, read the receipt, confirm — and every receipt is produced by folding the proposed ledger entry, so the preview *is* what the commit will write.

**Tech Stack:** Next.js 16 (App Router, React 19 Server Components, Server Actions), TypeScript 5 strict, Jest 29 + ts-jest with a jsdom project, `@testing-library/react`, `pg` via plan 3's `lib/compound/db/`, Supabase Auth via `@supabase/ssr`, pnpm 10, Node 23.

**Spec:** [`docs/superpowers/specs/2026-08-21-compound-investor-desk-design.md`](../specs/2026-08-21-compound-investor-desk-design.md)

---

## Scope note — read before starting

**This is one plan and it is too big for one sitting. It is written in two phases with a hard checkpoint, and it is designed to be split.**

| Phase | Tasks | Ends at |
|---|---|---|
| **A — the shell and the read-only desk** | 1–10 | Every read surface in spec §7 renders real figures from the real database. Nothing writes. |
| **B — the money flows** | 11–15 | Five sheets that each show complete arithmetic before commit, and the writers behind them. |

**If the executor wants two plans, split after Task 10.** Phase A is independently mergeable and independently valuable — it is a working, correct, read-only desk, which is already more than the shell it replaces. Phase B cannot start before it, because every sheet renders the same kit and the same presentation layer.

Do not split anywhere else. Tasks 1–4 build one test harness and one vocabulary that everything after them uses; Tasks 11–15 share one action seam.

## Prerequisites — this plan cannot start until these are merged

- [ ] **`feat/accounting-engine`** — `lib/compound/engine/`. Already merged. Every figure on every screen comes from `fold`, `quote`, `allocateValues` or `navTimes1e4`.
- [ ] **`feat/reconciler`** — `lib/compound/reconcile/`. Already merged. Task 14 renders `planReadings`'s `halt` variant; Task 11's refresh action drives it.
- [ ] **Plan 3, `feat/persistence`, in full** — Tasks 2, 4, 5, 6, 7 and 8. This plan calls `getAccountById`, `listAccountsForManager`, `getHolderSeeds`, `getLedgerEntries`, `getReconcileCursor`, `listCandidates`, `getDailySnapshots`, `getClosedDeals`, `getLiveSnapshot`, `commitReadingPlan`, `withDb` and `withDbTransaction`, and it adds new `plpgsql` writers alongside `compound_commit_reading_plan`. **Phase A needs Tasks 5–7. Phase B needs Task 8's file as the pattern for its own writers.**

Plan 5 (`docs/superpowers/plans/2026-08-21-compound-journal.md`) builds `/a/[id]/journal`, `/a/[id]/calendar` and `/a/[id]/performance` inside the layout this plan defines. It is **not** a prerequisite — Task 8's sub-nav links to those three routes, and until plan 5 lands they 404. That is the agreed sequencing, not an oversight.

## Where this plan stops

It does not build the investor portal (spec §12, deferred to v2), partial capital withdrawal (P6), payout PDFs (P7), scheduled payouts (P8), or multi-currency. It adds no `investor` role — spec §9 forbids one. It reads `orders` and `positions` from nowhere: plan 5 owns those tables, their fixtures and their readers, by agreement.

---

## Agreements with plan 5 — settled, do not renegotiate

These were exchanged directly with plan 5's author and both plans are written against them.

| # | Agreement |
|---|---|
| A1 | **`app/a/[id]/layout.tsx` is this plan's.** It owns the masthead, the account switcher, the sub-nav, `params.id` → account resolution and `notFound()`. Plan 5's pages render only their own `<section>` content. |
| A2 | **Sub-nav, six entries, this order: Desk · Journal · Calendar · Performance · Ledger · Review.** There is no `Holders` entry — spec §7 has no holder index route, and the desk's holder table is the index. |
| A3 | **Each page loads its own data.** No `PoolState` context provider. Sharing is `React.cache()` on the loaders, nothing more. |
| A4 | **`requireAccount(idParam)` in `lib/compound/load/account.ts`** is the single account resolver both plans call. |
| A5 | **`brokerOffsetHours` is a nullable column on `compound_account`**, added by this plan's Task 5. Null means "not configured". |
| A6 | **`capitalMarks(entries)` and `loadInterlock(accountId)` are this plan's**, consumed by plan 5's `/performance`. |
| A7 | **`InterlockBanner` and the live/committed labelling are this plan's components.** Plan 5 imports them rather than re-phrasing the same state. |
| A8 | **No new `:root` custom properties, by either plan.** The green ownership ramp is a pure function, not tokens. |
| A9 | **Class names this plan claims** in `app/globals.css`: `.kpi`, `.kpi-item`, `.receipt`, `.receipt-line`, `.receipt-total`, `.sheet`, `.sheet-scrim`, `.queue`, `.queue-item`, `.chip`, `.btn`, `.btn-primary`, `.btn-danger`, `.hairline`, `.switcher`, `.subnav`, `.banner-halt`, `.field`, `.field-error`, `.split-note`. Plan 5 claims `.cal`, `.curve`, `.hist`, `.filters`. |
| A10 | **Orders and positions are plan 5's**, including their fixture tables and their readers. This plan adds neither. |

---

## Decisions this plan makes that the spec did not settle

Each is a visible choice. Fold them back into the spec after this plan merges.

| # | Decision | Why |
|---|---|---|
| **D-A** | **A holder's value has two legitimate answers and both appear in the product.** The desk and holder tables show `allocateValues` — largest-remainder, so the column sums to equity **exactly** (invariant 2). The payout receipt shows `quote().valueCents` — floored, because that is what actually settles. On this plan's fixture the same holder reads **$12,630.61** on the table and **$12,630.60** on the receipt. Neither is wrong. The holder statement page reconciles the two in words. | Spec §4 says valuation is allocated and operations are floored, and never says what happens when both appear on adjacent screens. Unifying them would be a real bug in either direction: using `allocateValues` in a payout lets a holder extract a cent the pool does not have; using `valueOfUnits` on the table makes the column sum two cents short of equity. |
| **D-B** | **Money flows are routes, not intercepted overlays.** Each sheet is a plain route under `/a/[id]/actions/…` styled as a modal card over a scrim. No parallel routes, no `(.)` interception, no client-side dialog state. | Every figure stays server-rendered, the back button works, a half-completed flow is a URL you can reopen, and there is nothing to hydrate. Intercepting routes buy a visual nicety and cost a class of hydration bug in a product whose whole claim is that its numbers are right. |
| **D-C** | **Every sheet is two steps: enter, then read the receipt, then confirm.** Step 2 is server-rendered from the engine. There is no live-updating preview. | "Shows complete arithmetic before it commits" becomes structural rather than a thing someone remembers to do. It also keeps every bigint on the server. |
| **D-D** | **A receipt is produced by folding the proposed entry.** `previewEntry()` returns `fold(existing ++ [proposed])`. The receipt renders `before` and `after` from that. | The preview and the commit cannot disagree, because the preview is the commit's reducer run on the same input. A hand-written "what will happen" calculation is a second truth. |
| **D-E** | **The ledger page derives each row by folding the prefix**, not by an incremental running total. | Same reason. `fold(entries.slice(0, i+1))` is O(n²) at a few thousand rows, which the spec's own scale note makes irrelevant, and it is the only way the ledger page cannot drift from the desk. |
| **D-F** | **`requireManager()` enforces spec §9's AND gate in application code.** Plan 3's P4 connects as `service_role`, which carries `BYPASSRLS`. RLS is therefore defence-in-depth for other clients and **not** what protects these pages. | Shipping pages that rely on a policy the connection bypasses would be the twelfth unfalsifiable safety net in this project. The gate is: signed in, `app_metadata.role = 'admin'`, **and** `account.managerUserId === user.id`. |
| **D-G** | **`broker_offset_hours` is nullable and reconciliation refuses when it is null.** | `dedupeDeals` at offset 0 is a no-op. Reconciling undeduped inflates `explained` and can hide a real capital event — plan 3's own words. A visible refusal beats a silently wrong answer. |
| **D-H** | **A sign-in page is in scope.** Minimal: email and password against Supabase Auth, no sign-up, no reset. | Without it every route redirects to a 404 and nothing in this plan is executable end to end. |
| **D-I** | **Account creation is in scope and creates the manager holder in the same transaction.** | `fold` throws `"a fee crystallised but no manager holder was seeded"` if there is none, and plan 3's P8 adds a one-manager-per-account unique index. An account without its manager holder is a broken account. |
| **D-J** | **Classification offers three outcomes: Deposit, Match an existing entry, and Not a capital event.** Partial withdrawals are out of scope (spec §12, P6) and the queue says so. | `compound_capital_event_candidate.resolved_ledger_entry_id` exists precisely so a candidate can be tied to a payout that was already recorded before the broker withdrawal showed up. |
| **D-K** | **Unit counts are displayed truncated, at 4dp.** This answers the question the engine's carried-forward note left open. | `formatUnits` truncates. Rounding a unit count up would print a holding larger than the holder owns, which contradicts the engine's floor bias on every operation that moves value. 4dp because 2dp hides differences that matter on a small pool and 10dp is unreadable. |

---

## Global Constraints

Values below are copied from the spec, not paraphrased.

- **Tokens are exactly spec §8's list, and no page adds a custom property.** (§8.1)
  ```css
  --paper: #E7EAEF;  --card: #FFFFFF;
  --ink: #0F1B2D;    --ink-2: #4A5768;   --ink-3: #8A96A6;
  --rule: #D2D8E0;   --rule-soft: #E6EAEF;
  --gain: #0B6B45;   --loss: #A32A2B;
  --own: #14532D;    --own-2: #D6E9DE;
  --fee: #F59E0B;    --fee-ink: #B45309;  --fee-bg: #FEF6E4;
  ```
- **Three meanings, three hues, none overloaded.** Green ramp means *the pool, divided* — ownership rail and share bars only. Gain/loss green and red mean *P/L direction*. Amber means *the fee*, and nothing else. (§8.2)
- **`--fee` (`#F59E0B`) is structural only — fills, chips, marks. It is 2.15:1 on white and may never carry text.** Fee text uses `--fee-ink` (`#B45309`, 5.02:1). (§8.1, §8.2)
- **The ownership rail uses `--own` (9.11:1), not `--gain`.** Reusing the gain green would make green mean both "profitable" and "yours" on the same screen. Additional holders take progressively lighter tints of the same green. (§8.2)
- **Type:** Instrument Serif for the brand mark and sheet headings; Inter for labels, body and controls; **IBM Plex Mono with `font-variant-numeric: tabular-nums` for every figure in the product.** Columns of money must not shift width between renders. (§8.3)
- **Accessibility floor:** body and figure text ≥ 4.5:1, large display ≥ 3:1; colour is never the sole carrier of meaning — the rail is labelled and P/L carries a sign; visible focus rings; `prefers-reduced-motion` respected; verified at 375 / 768 / 1024 / 1440. (§8.4)
- **Money:** integer minor units (cents) as `bigint`. **Units:** `bigint` scaled 1e-10. **Splits:** basis points, integer; 40% is `4000`. **NAV:** never stored, computed from an `(equityCents, units)` pair, rounded to 4dp **at the presentation boundary only**. (§4)
- **No floating point in any money or unit calculation, anywhere, including presentation.** `number` is permitted for basis points, array indices, percentages already reduced to integers, and CSS lengths.
- **No `bigint` crosses the server/client boundary.** Server Components own every engine type. If a Client Component ever needs a money value it receives the integer cents as a **decimal string** and reconstructs with `BigInt()` — never a preformatted display string as its source of truth, because sorting and summing a formatted string is where this goes wrong.
- **`lib/compound/present/` imports no React, no `next`, and no `db/`.** Enforced by a test in Task 2.
- **`lib/compound/ui/` imports no `db/`, no `pg`, and no `next/headers`.** It renders what it is handed. Enforced by a test in Task 4.
- **Every ledger read orders by `seq`.** `seq`, not `occurred_on`, defines replay order. (§6.2)
- **Committed versus live.** The desk displays live equity from `account_snapshots_current`, and every live figure is labelled `Live · not yet posted` with its `pushed_at`. **A payout never settles against a drifting intraday figure** — it writes an equity reading capturing the exact equity used, then the payout entry, in one transaction. (§5.2)
- **The interlock is visible.** When a pending candidate exists, every account surface carries the frozen-figures banner. NAV never crosses an unclassified capital event. (§5.3)
- **Ledger entry types:** exactly `('deposit','payout','exit','equity_reading','adjustment')`. No `fee` type, no `payout_mode`. (§6, §6.1)
- **`compound_ledger_entry` is INSERT and SELECT only.** No screen offers an edit or a delete. A correction is a reversing entry. (§9, §3.5)
- **Single-tenant (D1), multi-account (D5).** The manager is an `admin`. No route may assume there is one account.
- **The repository is public (§10).** No project ref, no real account number, no broker name, no real holder name, no key, in any tracked file. Every fixture uses fictional values.
- **TypeScript** `strict: true`, `target: "ES2022"`, `noUncheckedIndexedAccess: true`.
- **Gates:** `pnpm typecheck`, `pnpm test`, `pnpm test:db`, `pnpm build`. Do **not** add ESLint; `eslint-config-next` is broken against ESLint 9 in the sibling project.

---

## Lessons carried in — UI testing has its own unfalsifiable assertions

The engine build shipped **nine assertions that could not fail**; plan 3 catalogued the database versions of the same disease. This is the UI catalogue. Every row is a shape to refuse, not a shape to be careful with.

| Shape | What it looks like here | Why it hides |
|---|---|---|
| **Snapshot test** | `expect(container).toMatchSnapshot()` | Proves the output did not change. A receipt that has shown the wrong fee since the day it was written passes forever, and the diff that would have caught it gets committed as "updated snapshot". **No snapshot tests in this plan.** |
| **Renders without throwing** | `expect(() => render(<Desk …/>)).not.toThrow()` | Says nothing about what it rendered. A component that returns `<div/>` passes. |
| **Mock asserted against itself** | `jest.mock("@/lib/compound/db/compound"); expect(getLedgerEntries).toHaveBeenCalledWith(7)` | Tests the mock. **No test in this plan mocks the data layer.** Components take engine types directly; loaders are covered by plan 3's integration suite. |
| **Text presence without value** | `expect(screen.getByText(/fee/i)).toBeInTheDocument()` | The label is hard-coded in the component. It is there whatever the number says. **Assert the figure, by its label.** |
| **Round fixture** | Equity $1,000 across 500 units, NAV exactly $2.00 | `$2.00` divides `UNIT_SCALE` evenly for *every* whole-cent input, so floor equals ceil and allocated equals floored. Correct and incorrect implementations agree. **This plan's fixture is $55,743.91 across 40,222.4547963043 units — NAV 1.3858… — where they disagree by a cent.** |
| **Regex that matches anything** | `expect(html).toMatch(/\d/)` | Every rendered page contains a digit. |
| **Asserting on markup instead of on meaning** | `expect(html).toContain('<td class="num">')` | Passes when the number inside is wrong and fails when the class name is refactored. Exactly backwards. |

Three rules, applied in every task below.

1. **Prove the test bites.** Every task ends with a step that changes one operator, one rounding direction, or one token, and confirms the right test — and ideally only that test — goes red. Where a probe cannot make a test go red, the step says so out loud rather than pretending.
2. **Assert figures, by their label.** `within(row("Ada Lovelace")).getByLabelText("Value now")` reading `"$12,630.61"`. Not the presence of a heading, not a count of rows.
3. **Pick awkward numbers.** Every fixture in this plan was computed by running the real engine, and the values are transcribed from that run. Where a figure looks strange — a one-cent gap, a 999,998 ppm share total — that is the point of the fixture.

---

## The canonical fixture

Defined once in Task 2, imported by every test in Tasks 2 through 15. **Computed by running `fold` and `quote` against the merged engine; the figures below are transcribed from that run, not calculated by hand.**

Three holders, awkward denominators throughout:

| seq | date | type | holder | amount | equity after | units after | NAV after |
|---|---|---|---|---|---|---|---|
| 1 | 2026-03-02 | deposit | Manager | $25,000.00 | $25,000.00 | 25,000.0000 | 1.0000 |
| 2 | 2026-04-30 | equity_reading | — | $27,431.19 | $27,431.19 | 25,000.0000 | 1.0972 |
| 3 | 2026-05-04 | deposit | Ada | $10,000.00 | $37,431.19 | 34,113.7132 | 1.0972 |
| 4 | 2026-06-30 | equity_reading | — | $41,883.07 | $41,883.07 | 34,113.7132 | 1.2277 |
| 5 | 2026-07-06 | deposit | Grace | $7,500.00 | $49,383.07 | 40,222.4547 | 1.2277 |
| 6 | 2026-08-14 | equity_reading | — | $55,743.91 | $55,743.91 | 40,222.4547 | 1.3858 |

Terms: Manager `splitBps 0` `isManager true`; Ada `splitBps 4000`; **Grace `splitBps 3700`** — a non-default split, so a component that hard-codes 40% fails.

Final state:

| Holder | Units | Capital in | Value (allocated) | Value (floored) | Share | P/L | Fee on full exit |
|---|---|---|---|---|---|---|---|
| Manager | 25,000.0000 | $25,000.00 | $34,647.26 | $34,647.25 | 62.1543% | +$9,647.26 | $0.00 |
| Ada | 9,113.7132 | $10,000.00 | **$12,630.61** | **$12,630.60** | 22.6583% | +$2,630.61 | $1,052.24 |
| Grace | 6,108.7415 | $7,500.00 | $8,466.04 | $8,466.04 | 15.1874% | +$966.04 | $357.43 |
| **Σ** | 40,222.4547 | | **$55,743.91** = equity | $55,743.89 | 999,998 ppm | | $1,409.67 |

Three properties of this fixture that a round one does not have, and that this plan tests directly:

- **Allocated and floored differ by a cent** for two of three holders, and the floored column is **two cents short of equity**. That is why `allocateValues` exists and why D-A is a decision rather than an accident.
- **Floored shares sum to 999,998 ppm, not 1,000,000.** A rail built from floored percentages does not fill its container. Task 3's `allocateShares` fixes it by largest remainder and Task 4's rail test asserts the segments sum to exactly 100%.
- **NAV is 1.3858…, non-terminating.** Floor and ceil disagree on every issuance and redemption in it.

---

# Phase A — the shell and the read-only desk

### Task 1: A component-test harness, and tokens that are checked rather than trusted

Two things nothing else can proceed without: a Jest project that can render React, and a stylesheet whose accessibility claims are assertions rather than comments.

Spec §8 states four contrast ratios as facts. This task turns them into tests. Running them found a defect the spec did not: **`--ink-3` (`#8A96A6`) is 3.00:1 on `--card` and 2.49:1 on `--paper`**, and the current `globals.css` uses it for every eyebrow, column header and secondary label. §8.4 requires body text at ≥ 4.5:1. That is a real failure of the spec's own floor, in shipped code.

> **Decision D-L: `--ink-3` may not carry text below 24px.** Every small label moves to `--ink-2` (7.36:1 on card, 6.10:1 on paper). `--ink-3` survives for rules, dividers, decorative separators and large display text, where 3:1 is the floor and it passes. The alternative — keeping light grey labels by changing the token to `#5F6B7C` (5.41:1 card, 4.49:1 paper) — is a **spec change**, not a plan change, and would need §8.1 edited. This plan takes the non-spec-changing option and the test enforces it.

**Files:**
- Modify: `package.json`
- Modify: `jest.config.mjs`
- Modify: `tsconfig.json`
- Create: `jest.setup.ui.ts`
- Modify: `app/globals.css`
- Create: `lib/compound/ui/tokens.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a `ui` Jest project running under jsdom over `lib/compound/ui/**`; the complete token set and utility classes in `app/globals.css`; `pnpm test` covering both projects

- [ ] **Step 1: Add the component-test dependencies**

```bash
pnpm add -D jest-environment-jsdom@^29.7.0 @testing-library/react@^16.1.0 @testing-library/dom@^10.4.0 @testing-library/jest-dom@^6.6.3
```

Four, and no more. No `user-event` — nothing in this plan has client-side interaction to simulate; every flow is a server-rendered form. No `next/jest` — it pulls in the SWC transform and this repo's `ts-jest` setup already works.

- [ ] **Step 2: Rewrite `jest.config.mjs` as two projects**

Three facts already in this file must survive the rewrite. **Read the current file before editing it, and carry all three forward.**

1. **The timezone pin.** `jest.config.mjs` on `main` opens with `process.env.TZ = "Asia/Manila"` and a comment saying not to remove it. `reconcile/date-key.ts`'s `utcDateKey` exists to read the UTC calendar day rather than the local one, and a mutation to local-time reads is invisible on a runner whose local zone *is* UTC — which most CI runners are. Dropping the pin would silently disarm the whole date-key suite. **Keep it, keep the comment, and keep it at module scope so it runs before either project starts.**
2. Plan 3 left this file ignoring `*.db.test.ts`, with the integration suite in `jest.db.config.mjs`.
3. `moduleNameMapper` and the `ts-jest` transform are unchanged; the transform gains `jsx: "react-jsx"` so `.tsx` compiles.

`lib/compound/ui/**` moves to a jsdom project; everything else in `lib/` stays on node.

```javascript
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
process.env.TZ = "Asia/Manila";

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
```

Note for plan 5: its components live under `lib/compound/ui/journal|calendar|performance/` and will therefore run in the `ui` project. They use `renderToStaticMarkup`, which works unchanged under jsdom. Nothing needs a third project.

- [ ] **Step 3: Create `jest.setup.ui.ts`**

```typescript
import "@testing-library/jest-dom";
```

- [ ] **Step 4: Extend `tsconfig.json`'s `include` to reach `.tsx` under `lib/`**

The current `include` lists `lib/**/*.ts` only, so every component in `lib/compound/ui/` would be invisible to `tsc --noEmit` and the typecheck gate would pass on code it never read. Change the array to:

```json
"include": [
  "lib/**/*.ts",
  "lib/**/*.tsx",
  "app/**/*.ts",
  "app/**/*.tsx",
  "*.ts",
  "next-env.d.ts",
  ".next/types/**/*.ts",
  ".next/dev/types/**/*.ts"
]
```

- [ ] **Step 5: Write the token guard test first**

Create `lib/compound/ui/tokens.test.ts`. It reads the real stylesheet — not a copy of the values — so it fails when someone edits `globals.css`, which is the whole point.

```typescript
/**
 * Spec section 8 states four contrast ratios as facts. Here they are as
 * assertions, computed from the stylesheet rather than from a transcription.
 *
 * Two of these look backwards and are not:
 *
 *   - --fee is asserted to be BELOW 4.5:1. It is a structural colour: fills,
 *     chips and marks. If someone darkens it so it can carry text, this test
 *     goes red and forces the question "what is amber for?" to be answered in
 *     the spec rather than in a hurry.
 *   - --ink-3 is asserted to be below 4.5:1 AND to appear in no `color:`
 *     declaration. It is 3.00:1 on white. Section 8.4 puts body text at 4.5:1.
 *     Both facts are true, so the only safe rule is that it never carries small
 *     text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(join(__dirname, "../../../app/globals.css"), "utf8");

function token(name: string): string {
  const m = new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6})`).exec(CSS);
  if (!m) throw new Error(`token --${name} is not defined in app/globals.css`);
  return m[1]!.toLowerCase();
}

export function luminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const CARD = "#ffffff";
const PAPER = "#e7eaef";

describe("the tokens are exactly spec section 8.1", () => {
  const expected: Record<string, string> = {
    paper: "#e7eaef", card: "#ffffff",
    ink: "#0f1b2d", "ink-2": "#4a5768", "ink-3": "#8a96a6",
    rule: "#d2d8e0", "rule-soft": "#e6eaef",
    gain: "#0b6b45", loss: "#a32a2b",
    own: "#14532d", "own-2": "#d6e9de",
    fee: "#f59e0b", "fee-ink": "#b45309", "fee-bg": "#fef6e4",
  };
  for (const [name, hex] of Object.entries(expected)) {
    it(`--${name} is ${hex}`, () => expect(token(name)).toBe(hex));
  }
});

describe("figure and body colours clear the 4.5:1 floor on both grounds", () => {
  it.each([
    ["gain", 6.56], ["loss", 7.18], ["own", 9.11], ["fee-ink", 5.02],
    ["ink", 17.28], ["ink-2", 7.36],
  ])("--%s is %f:1 on --card", (name, ratio) => {
    expect(contrast(token(name), CARD)).toBeCloseTo(ratio, 2);
    expect(contrast(token(name), CARD)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([["gain"], ["loss"], ["own"], ["fee-ink"], ["ink"], ["ink-2"]])(
    "--%s also clears 4.5:1 on --paper",
    (name) => expect(contrast(token(name), PAPER)).toBeGreaterThanOrEqual(4.5),
  );
});

describe("amber is structural, and the stylesheet does not forget it", () => {
  it("--fee is 2.15:1 on white and therefore cannot carry text", () => {
    expect(contrast(token("fee"), CARD)).toBeCloseTo(2.15, 2);
    expect(contrast(token("fee"), CARD)).toBeLessThan(4.5);
  });

  it("no rule sets `color` to var(--fee)", () => {
    const offenders = CSS.split("\n").filter((l) => /(^|[^-])color\s*:\s*var\(--fee\)/.test(l));
    expect(offenders).toEqual([]);
  });

  it("--ink on --fee is 8.05:1, so amber may back dark text", () => {
    expect(contrast(token("ink"), token("fee"))).toBeCloseTo(8.05, 2);
  });

  it("--fee-ink on --fee-bg is 4.67:1, so the fee chip is legible", () => {
    expect(contrast(token("fee-ink"), token("fee-bg"))).toBeCloseTo(4.67, 2);
  });
});

describe("--ink-3 never carries small text (decision D-L)", () => {
  it("is 3.00:1 on --card, which is below the body floor", () => {
    expect(contrast(token("ink-3"), CARD)).toBeCloseTo(3.0, 2);
  });

  it("no rule sets `color` to var(--ink-3)", () => {
    const offenders = CSS.split("\n").filter((l) =>
      /(^|[^-])color\s*:\s*var\(--ink-3\)/.test(l),
    );
    expect(offenders).toEqual([]);
  });
});

describe("every figure is monospaced and tabular (section 8.3)", () => {
  it(".num sets both the family and tabular-nums", () => {
    const rule = /\.num\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    expect(rule).toMatch(/font-family:\s*var\(--mono\)/);
    expect(rule).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});

describe("reduced motion is respected (section 8.4)", () => {
  it("the stylesheet carries a prefers-reduced-motion block", () => {
    expect(CSS).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});

describe("focus is visible (section 8.4)", () => {
  it("a :focus-visible rule sets an outline", () => {
    expect(CSS).toMatch(/:focus-visible\s*\{[^}]*outline:/);
  });
});
```

**How these bite.** Change `--gain` to `#2E9E6B` and the ratio assertion fails. Delete the `prefers-reduced-motion` block and one test fails. Write `color: var(--fee)` anywhere and the amber test names the line. Revert an eyebrow to `--ink-3` and D-L's test names it. None of them can pass on an empty stylesheet — `token()` throws.

- [ ] **Step 6: Rewrite `app/globals.css`**

Keeps every token at its spec value. Moves every small label from `--ink-3` to `--ink-2`. Adds the classes A9 claims. Replaces the shell's `.equity`/`.navbox`/`.leg` with the kit's names.

```css
/* Design tokens, spec section 8.1. Statement direction: paper ground, green
   ownership ramp, amber reserved for the fee.

   Two rules this file obeys and lib/compound/ui/tokens.test.ts enforces:
     - `color: var(--fee)` never appears. Amber is 2.15:1 on white. Fee TEXT is
       --fee-ink at 5.02:1. Amber fills, chips and marks; it never sets type.
     - `color: var(--ink-3)` never appears. It is 3.00:1 on white and section
       8.4 puts body text at 4.5:1. Secondary labels are --ink-2 at 7.36:1.
       --ink-3 survives for rules and decoration. */
:root {
  --paper: #e7eaef;
  --card: #ffffff;
  --ink: #0f1b2d;
  --ink-2: #4a5768;
  --ink-3: #8a96a6;
  --rule: #d2d8e0;
  --rule-soft: #e6eaef;

  --gain: #0b6b45;
  --loss: #a32a2b;

  --own: #14532d;
  --own-2: #d6e9de;

  --fee: #f59e0b;
  --fee-ink: #b45309;
  --fee-bg: #fef6e4;

  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --serif: "Instrument Serif", Georgia, serif;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  padding: 0 0 64px;
}

:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
  border-radius: 2px;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

/* Every figure in the product. Section 8.3. */
.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.pos { color: var(--gain); }
.neg { color: var(--loss); }
.fee { color: var(--fee-ink); }
.muted { color: var(--ink-2); }

.wrap { max-width: 1120px; margin: 0 auto; padding: 0 20px; }
.hairline { border: 0; border-top: 1px solid var(--rule); margin: 16px 0; }

/* Masthead, switcher, sub-nav */
.mast {
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; padding: 22px 0 14px; flex-wrap: wrap;
}
.mark { font-family: var(--serif); font-size: 27px; line-height: 1; }
.sub {
  font-size: 10px; text-transform: uppercase; letter-spacing: .18em;
  color: var(--ink-2); border-left: 1px solid var(--rule);
  padding-left: 10px; margin-left: 10px;
}
.switcher { position: relative; font-family: var(--mono); font-size: 12px; }
.switcher > summary {
  list-style: none; cursor: pointer; background: var(--card);
  border: 1px solid var(--rule); border-radius: 3px; padding: 7px 12px;
  color: var(--ink); display: flex; align-items: center; gap: 8px;
}
.switcher > summary::-webkit-details-marker { display: none; }
.switcher > div {
  position: absolute; right: 0; top: calc(100% + 4px); z-index: 20;
  min-width: 260px; background: var(--card); border: 1px solid var(--rule);
  border-radius: 3px; padding: 4px;
}
.switcher a {
  display: block; padding: 8px 10px; color: var(--ink);
  text-decoration: none; border-radius: 2px;
}
.switcher a:hover, .switcher a[aria-current="true"] { background: var(--paper); }

.subnav {
  display: flex; gap: 2px; border-bottom: 1px solid var(--rule);
  margin-bottom: 14px; overflow-x: auto;
}
.subnav a {
  padding: 9px 14px; font-size: 12.5px; color: var(--ink-2);
  text-decoration: none; border-bottom: 2px solid transparent; white-space: nowrap;
}
.subnav a[aria-current="page"] { color: var(--ink); border-bottom-color: var(--ink); font-weight: 600; }

/* Panels */
.panel {
  background: var(--card); border: 1px solid var(--rule); border-radius: 3px;
  padding: 20px; margin-bottom: 12px;
}
.panel.flush { padding: 0; overflow: hidden; }
.eyebrow {
  font-size: 10px; text-transform: uppercase; letter-spacing: .16em;
  color: var(--ink-2); font-weight: 600;
}

/* Statement head */
.erow {
  display: flex; align-items: flex-end; justify-content: space-between;
  gap: 24px; flex-wrap: wrap; margin-top: 8px;
}
.equity {
  font-family: var(--mono); font-weight: 500;
  font-size: clamp(32px, 6vw, 48px); letter-spacing: -.035em; line-height: 1;
}
.equity .cents { color: var(--ink-2); }

/* KPI strip */
.kpi {
  display: grid; gap: 1px; background: var(--rule-soft);
  grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
  border: 1px solid var(--rule); border-radius: 3px; overflow: hidden;
  margin-bottom: 12px;
}
.kpi-item { background: var(--card); padding: 14px 16px; }
.kpi-item .k {
  display: block; font-size: 9.5px; text-transform: uppercase;
  letter-spacing: .14em; color: var(--ink-2); font-weight: 600; margin-bottom: 4px;
}
.kpi-item .v { display: block; font-family: var(--mono); font-size: 18px; }
.kpi-item.is-fee { background: var(--fee-bg); }
.kpi-item.is-fee .v { color: var(--fee-ink); }

/* Ownership rail. Green means the pool, divided. Never gain, never "yours". */
.rail {
  display: flex; height: 32px; border: 1px solid var(--ink);
  border-radius: 2px; overflow: hidden; margin-top: 18px;
}
.seg { border-right: 1px solid var(--ink); }
.seg:last-child { border-right: none; }
.seg.hatched {
  background-image: repeating-linear-gradient(
    45deg, rgba(15, 27, 45, .22) 0 3px, transparent 3px 7px
  );
}
.leg { display: flex; gap: 18px; margin-top: 9px; font-size: 11.5px; color: var(--ink-2); flex-wrap: wrap; }
.leg i { width: 9px; height: 9px; border: 1px solid var(--ink); display: inline-block; margin-right: 7px; }
.leg b { font-family: var(--mono); font-weight: 500; color: var(--ink); }

/* Tables */
.scroller { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; background: var(--card); }
caption { text-align: left; padding: 14px 16px 0; }
th {
  font-size: 9.5px; text-transform: uppercase; letter-spacing: .13em;
  color: var(--ink-2); font-weight: 600; text-align: right;
  padding: 10px 16px; border-bottom: 1px solid var(--rule); white-space: nowrap;
}
td {
  padding: 12px 16px; border-bottom: 1px solid var(--rule-soft);
  text-align: right; white-space: nowrap; font-size: 13px;
}
th:first-child, td:first-child { text-align: left; }
tr.own td { background: var(--fee-bg); }
tr.closed td { color: var(--ink-2); }
tr.voided td { color: var(--ink-2); text-decoration: line-through; }
tfoot td { background: #fbfcfd; border-top: 1px solid var(--ink); border-bottom: none; font-weight: 600; }

.tag, .chip {
  display: inline-block; font-size: 9px; text-transform: uppercase;
  letter-spacing: .1em; font-weight: 600; padding: 2px 6px;
  border: 1px solid var(--ink); border-radius: 2px; margin-left: 6px;
  color: var(--ink);
}
.tag { background: var(--fee); }
.chip { background: transparent; border-color: var(--rule); color: var(--ink-2); }
.chip.is-live { border-color: var(--gain); color: var(--gain); }
.chip.is-fee { background: var(--fee-bg); border-color: var(--fee-ink); color: var(--fee-ink); }

/* Banners */
.banner {
  background: var(--fee-bg); border: 1px solid #e8c77a; border-radius: 3px;
  padding: 11px 14px; font-size: 12.5px; color: var(--fee-ink); margin-bottom: 12px;
}
.banner-halt {
  background: var(--card); border: 1px solid var(--loss); border-left-width: 4px;
  border-radius: 3px; padding: 12px 15px; margin-bottom: 12px; color: var(--ink);
}
.banner-halt strong { color: var(--loss); }

/* Sheets — the money flows. Routes, not overlays (decision D-B). */
.sheet-scrim { background: var(--paper); min-height: 100vh; padding: 28px 20px 64px; }
.sheet {
  max-width: 640px; margin: 0 auto; background: var(--card);
  border: 1px solid var(--rule); border-radius: 3px; padding: 24px;
}
.sheet h1 { font-family: var(--serif); font-size: 28px; font-weight: 400; margin: 0 0 4px; }
.sheet .lede { color: var(--ink-2); font-size: 13px; margin: 0 0 18px; }

/* Receipts — the arithmetic, before it commits. */
.receipt { border-top: 1px solid var(--ink); margin-top: 16px; }
.receipt-line {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 16px; padding: 9px 0; border-bottom: 1px solid var(--rule-soft);
}
.receipt-line .l { font-size: 13px; color: var(--ink); }
.receipt-line .l small { display: block; color: var(--ink-2); font-size: 11px; }
.receipt-line .r { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 14px; }
.receipt-line.is-fee { background: var(--fee-bg); padding-left: 10px; padding-right: 10px; }
.receipt-line.is-fee .r { color: var(--fee-ink); }
.receipt-total { border-top: 1px solid var(--ink); border-bottom: none; padding-top: 14px; }
.receipt-total .l { font-weight: 600; }
.receipt-total .r { font-size: 24px; }
.split-note { font-size: 11.5px; color: var(--ink-2); margin-top: 10px; line-height: 1.6; }

/* Review queue */
.queue { display: grid; gap: 12px; }
.queue-item {
  background: var(--card); border: 1px solid var(--rule);
  border-left: 4px solid var(--fee); border-radius: 3px; padding: 18px 20px;
}

/* Forms */
.field { display: block; margin-bottom: 14px; }
.field > span {
  display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .14em;
  color: var(--ink-2); font-weight: 600; margin-bottom: 5px;
}
.field input, .field select, .field textarea {
  width: 100%; font-family: var(--mono); font-size: 14px; color: var(--ink);
  background: var(--card); border: 1px solid var(--rule); border-radius: 3px;
  padding: 9px 11px;
}
.field-error {
  border-left: 4px solid var(--loss); background: var(--card);
  border: 1px solid var(--loss); border-left-width: 4px; border-radius: 3px;
  padding: 11px 14px; margin-bottom: 14px; font-size: 12.5px;
}
.field-error strong { color: var(--loss); }

.btn {
  display: inline-block; font-family: var(--sans); font-size: 13px; font-weight: 500;
  padding: 9px 16px; border: 1px solid var(--ink); border-radius: 3px;
  background: var(--card); color: var(--ink); cursor: pointer; text-decoration: none;
}
.btn[aria-disabled="true"], .btn:disabled {
  border-color: var(--rule); color: var(--ink-2); cursor: not-allowed; background: var(--paper);
}
.btn-primary { background: var(--ink); color: var(--card); }
.btn-danger { border-color: var(--loss); color: var(--loss); }
.actions { display: flex; gap: 10px; align-items: center; margin-top: 20px; flex-wrap: wrap; }

.foot { padding: 18px 0; font-size: 11.5px; color: var(--ink-2); line-height: 1.6; }
.ok { color: var(--gain); font-weight: 600; }
```

- [ ] **Step 7: Run the gates**

```bash
pnpm typecheck && pnpm test
```

Expected: two projects report, `unit` runs the engine and reconcile suites unchanged, `ui` runs `tokens.test.ts` and it passes.

Then confirm the timezone pin survived:

```bash
node -e 'import("./jest.config.mjs").then(() => console.log(process.env.TZ))'
```

Expected: `Asia/Manila`. If it prints `undefined`, the pin was dropped in the rewrite and `lib/compound/reconcile/date-key.test.ts` is now passing for the wrong reason on a UTC runner.

- [ ] **Step 8: Prove the tests bite**

Do all four, one at a time, reverting each:

1. Change `--gain` to `#2e9e6b` → the `--gain is 6.56:1` test fails and no other.
2. Add `color: var(--fee);` to `.chip.is-fee` → the amber `color` test fails and names the line.
3. Change `.eyebrow`'s colour back to `var(--ink-3)` → D-L's test fails.
4. Delete the `@media (prefers-reduced-motion: reduce)` block → the reduced-motion test fails.
5. Delete `process.env.TZ = "Asia/Manila"` → **nothing goes red on this machine**, because the developer machine is already on Asia/Manila. That is the point of naming it: the pin's absence is invisible exactly where you would look for it. Verify it the other way instead — `TZ=UTC pnpm test` with the pin deleted, and confirm `date-key.test.ts` still passes, which is what proves the pin was doing work.

If any of the first four leaves the suite green, the test is not reading what it claims to read. Fix it before continuing.

---

### Task 2: `present/format.ts` — every figure that reaches a screen

The presentation boundary. Spec §4 says NAV is rounded to 4dp **here and nowhere else**; this is that place. Nothing in this module performs money arithmetic — it formats what the engine already computed.

**Files:**
- Create: `lib/compound/present/format.ts`
- Create: `lib/compound/present/fixture.ts`
- Test: `lib/compound/present/format.test.ts`
- Test: `lib/compound/present/purity.test.ts`

**Interfaces:**
- Consumes: `Cents`, `Units`, `formatCents`, `formatUnits`, `UNIT_SCALE` from `@/lib/compound/engine/money`; `PoolTotals`, `navTimes1e4` from `@/lib/compound/engine/nav`
- Produces:
  - `formatMoney(c: Cents, opts?: { currency?: string; sign?: "auto" | "always" }): string`
  - `splitMoney(c: Cents, currency?: string): { whole: string; cents: string }`
  - `formatUnitsDp(u: Units, dp?: number): string`
  - `formatNav(t: PoolTotals): string`
  - `formatSinceInception(t: PoolTotals): string`
  - `formatPpm(ppm: number): string`
  - `formatSplit(splitBps: number): string`
  - `formatSplitWords(splitBps: number, holderName: string): string`
  - `formatDate(isoDate: string): string`
  - `formatUtcStamp(iso: string): string`
  - `signOf(c: Cents): "pos" | "neg" | "zero"`

- [ ] **Step 1: Create `lib/compound/present/format.ts`**

```typescript
/**
 * The presentation boundary. Spec section 4: "Where a NAV figure must be
 * displayed it is computed and rounded to 4dp at the presentation boundary
 * only." This module is that boundary and nothing downstream of it does
 * arithmetic.
 *
 * Two rules hold throughout:
 *
 *   1. No floating point. Group separators, sign handling and decimal
 *      placement are all string operations on the exact integer the engine
 *      produced. A money value never becomes a Number on its way to a screen.
 *   2. Unit counts TRUNCATE, they do not round. formatUnits already truncates,
 *      and rounding up would print a holding larger than the holder owns —
 *      which contradicts the floor bias every value-moving operation in the
 *      engine uses. Four decimal places: two hides differences that matter on
 *      a small pool, ten is unreadable.
 */
import {
  formatCents,
  formatUnits,
  type Cents,
  type Units,
} from "@/lib/compound/engine/money";
import { navTimes1e4, type PoolTotals } from "@/lib/compound/engine/nav";

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

function symbolFor(currency: string): string {
  return SYMBOLS[currency] ?? `${currency} `;
}

/** Inserts thousands separators into a run of digits. String work, never math. */
function group(digits: string): string {
  let out = "";
  for (let i = digits.length; i > 0; i -= 3) {
    out = digits.slice(Math.max(0, i - 3), i) + (out === "" ? "" : ",") + out;
  }
  return out;
}

/**
 * Splits a money figure into its major and minor parts so the statement head
 * can render the cents smaller. Returns the parts, never a concatenation, so
 * a caller cannot accidentally style them as one run.
 */
export function splitMoney(c: Cents, currency = "USD"): { whole: string; cents: string } {
  const raw = formatCents(c);                       // "-55743.91"
  const negative = raw.startsWith("-");
  const [whole = "0", cents = "00"] = (negative ? raw.slice(1) : raw).split(".");
  return {
    whole: `${negative ? "-" : ""}${symbolFor(currency)}${group(whole)}`,
    cents,
  };
}

/**
 * `sign: "always"` prefixes a non-negative figure with "+". Use it for P/L and
 * for nothing else — a balance with a plus sign reads as a change.
 */
export function formatMoney(
  c: Cents,
  opts: { currency?: string; sign?: "auto" | "always" } = {},
): string {
  const { whole, cents } = splitMoney(c, opts.currency ?? "USD");
  const plus = opts.sign === "always" && c >= 0n ? "+" : "";
  return `${plus}${whole}.${cents}`;
}

export function formatUnitsDp(u: Units, dp = 4): string {
  const raw = formatUnits(u, dp);                   // truncates, by design
  const negative = raw.startsWith("-");
  const [whole = "0", frac] = (negative ? raw.slice(1) : raw).split(".");
  return `${negative ? "-" : ""}${group(whole)}${frac === undefined ? "" : `.${frac}`}`;
}

/** NAV per unit, 4dp, truncated. navTimes1e4 is NAV x 10^4. */
export function formatNav(t: PoolTotals): string {
  const n = navTimes1e4(t);
  return `${group((n / 10_000n).toString())}.${(n % 10_000n).toString().padStart(4, "0")}`;
}

/** Growth since inception: (NAV - 1) x 100, two decimals, always signed. */
export function formatSinceInception(t: PoolTotals): string {
  const bp = navTimes1e4(t) - 10_000n;              // basis points
  const negative = bp < 0n;
  const abs = negative ? -bp : bp;
  return `${negative ? "-" : "+"}${group((abs / 100n).toString())}.${(abs % 100n)
    .toString()
    .padStart(2, "0")}%`;
}

/** A share expressed in parts per million, rendered at 2dp. */
export function formatPpm(ppm: number): string {
  if (!Number.isInteger(ppm) || ppm < 0 || ppm > 1_000_000) {
    throw new RangeError(`ppm must be an integer 0..1000000, got ${ppm}`);
  }
  const hundredths = Math.round(ppm / 100);         // exact: ppm is an integer
  return `${Math.trunc(hundredths / 100)}.${(hundredths % 100).toString().padStart(2, "0")}%`;
}

/** "60 / 40" — investor first, manager second, matching how terms are spoken. */
export function formatSplit(splitBps: number): string {
  if (!Number.isInteger(splitBps) || splitBps < 0 || splitBps > 10_000) {
    throw new RangeError(`splitBps must be an integer 0..10000, got ${splitBps}`);
  }
  const pct = (bps: number) =>
    bps % 100 === 0 ? `${bps / 100}` : (bps / 100).toFixed(2);
  return `${pct(10_000 - splitBps)} / ${pct(splitBps)}`;
}

/** The same terms in a sentence, for a sheet that must be read rather than scanned. */
export function formatSplitWords(splitBps: number, holderName: string): string {
  const investor = formatSplit(splitBps).split(" / ")[0]!;
  const manager = formatSplit(splitBps).split(" / ")[1]!;
  return (
    `${holderName} keeps ${investor}% of profit and you keep ${manager}%. ` +
    `The fee is charged only when ${holderName} withdraws, and only on profit ` +
    `above what ${holderName} has put in.`
  );
}

/** YYYY-MM-DD to "14 Aug 2026". No Date object: the input is a broker-server
 *  date string and constructing a Date from it resolves it in the local zone. */
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export function formatDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new RangeError(`not a YYYY-MM-DD date: ${JSON.stringify(isoDate)}`);
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** An ISO 8601 UTC timestamp to "18 Aug 2026, 09:14 UTC". Parsed, not
 *  constructed: `new Date(iso).getHours()` renders in the reader's zone, and a
 *  pushed_at that moves with the reader is a support ticket waiting to happen. */
export function formatUtcStamp(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) throw new RangeError(`not an ISO 8601 timestamp: ${JSON.stringify(iso)}`);
  return `${formatDate(`${m[1]}-${m[2]}-${m[3]}`)}, ${m[4]}:${m[5]} UTC`;
}

export function signOf(c: Cents): "pos" | "neg" | "zero" {
  return c > 0n ? "pos" : c < 0n ? "neg" : "zero";
}
```

- [ ] **Step 2: Create the canonical fixture, `lib/compound/present/fixture.ts`**

Every figure in the comments below was produced by running the merged engine over this ledger. Do not adjust an amount for legibility — the awkwardness is load-bearing.

```typescript
/**
 * The fixture every test in plans 4 renders against. Fictional names, fictional
 * amounts, deliberately awkward denominators.
 *
 * Final state, from fold():
 *   equity  55743.91      units 40222.4547963043      NAV 1.3858...
 *   Manager  25000.0000u  basis 25000.00  alloc 34647.26  floor 34647.25  62.1543%
 *   Ada       9113.7132u  basis 10000.00  alloc 12630.61  floor 12630.60  22.6583%
 *   Grace     6108.7415u  basis  7500.00  alloc  8466.04  floor  8466.04  15.1874%
 *
 * Three properties a round fixture does not have:
 *   - allocated and floored value differ by a cent for two of three holders,
 *     and the floored column is two cents short of equity;
 *   - floored shares sum to 999998 ppm, not 1000000;
 *   - NAV does not terminate, so floor and ceil disagree on every issuance.
 *
 * Grace's split is 3700, not the 4000 default, so a component that hard-codes
 * 40 percent fails against her row.
 */
import { centsFromDecimal } from "@/lib/compound/engine/money";
import type { HolderSeed, LedgerEntry } from "@/lib/compound/engine/replay";

export const MANAGER_ID = 1;
export const ADA_ID = 2;
export const GRACE_ID = 3;

export const HOLDER_NAMES: Record<number, string> = {
  [MANAGER_ID]: "J. Marsh",
  [ADA_ID]: "Ada Lovelace",
  [GRACE_ID]: "Grace Hopper",
};

export const SEEDS: HolderSeed[] = [
  { holderId: MANAGER_ID, isManager: true, splitBps: 0 },
  { holderId: ADA_ID, isManager: false, splitBps: 4000 },
  { holderId: GRACE_ID, isManager: false, splitBps: 3700 },
];

function entry(
  id: number,
  seq: number,
  holderId: number | null,
  occurredOn: string,
  type: LedgerEntry["type"],
  amount: string,
  feeSettlement: LedgerEntry["feeSettlement"] = null,
  splitBpsApplied: number | null = null,
): LedgerEntry {
  return {
    id, seq, holderId, occurredOn, type,
    amountCents: centsFromDecimal(amount),
    feeSettlement, splitBpsApplied, reversesId: null,
  };
}

export const LEDGER: LedgerEntry[] = [
  entry(1, 1, MANAGER_ID, "2026-03-02", "deposit", "25000.00"),
  entry(2, 2, null, "2026-04-30", "equity_reading", "27431.19"),
  entry(3, 3, ADA_ID, "2026-05-04", "deposit", "10000.00"),
  entry(4, 4, null, "2026-06-30", "equity_reading", "41883.07"),
  entry(5, 5, GRACE_ID, "2026-07-06", "deposit", "7500.00"),
  entry(6, 6, null, "2026-08-14", "equity_reading", "55743.91"),
];

/** The same account after a reading that puts everyone under water.
 *  Recovery figures: Manager 1312.71, Ada 1364.84, Grace 1712.02. */
export const LEDGER_UNDERWATER: LedgerEntry[] = [
  ...LEDGER,
  entry(7, 7, null, "2026-08-18", "equity_reading", "38110.44"),
];

/** Live figures from account_snapshots_current, ahead of the last reading. */
export const LIVE = {
  balanceCents: centsFromDecimal("55805.00"),
  equityCents: centsFromDecimal("55930.00"),
  floatingPnlCents: centsFromDecimal("125.00"),
  pushedAt: "2026-08-18T09:14:22.000Z",
};
```

- [ ] **Step 3: Write the format tests**

Create `lib/compound/present/format.test.ts`:

```typescript
import { centsFromDecimal, unitsFromDecimal } from "@/lib/compound/engine/money";
import { fold, totalsOf } from "@/lib/compound/engine/replay";
import { LEDGER, SEEDS } from "./fixture";
import {
  formatDate, formatMoney, formatNav, formatPpm, formatSinceInception,
  formatSplit, formatSplitWords, formatUnitsDp, formatUtcStamp, signOf, splitMoney,
} from "./format";

const TOTALS = totalsOf(fold(LEDGER, SEEDS));

describe("formatMoney", () => {
  it("groups thousands and keeps both cents", () => {
    expect(formatMoney(centsFromDecimal("55743.91"))).toBe("$55,743.91");
  });

  it("groups millions", () => {
    expect(formatMoney(centsFromDecimal("1234567.08"))).toBe("$1,234,567.08");
  });

  it("keeps a trailing zero in the cents", () => {
    // "1000.50" -> 100050 cents. A Number round trip renders "1000.5".
    expect(formatMoney(centsFromDecimal("1000.50"))).toBe("$1,000.50");
  });

  it("puts the minus outside the symbol", () => {
    expect(formatMoney(centsFromDecimal("-1364.84"))).toBe("-$1,364.84");
  });

  it("signs a positive figure only when asked", () => {
    expect(formatMoney(centsFromDecimal("2630.61"))).toBe("$2,630.61");
    expect(formatMoney(centsFromDecimal("2630.61"), { sign: "always" })).toBe("+$2,630.61");
  });

  it("signs zero as positive under sign:always, because zero P/L is not a loss", () => {
    expect(formatMoney(0n, { sign: "always" })).toBe("+$0.00");
  });

  it("renders a sub-dollar figure without losing the leading zero", () => {
    expect(formatMoney(centsFromDecimal("0.07"))).toBe("$0.07");
  });

  it("uses the account currency symbol", () => {
    expect(formatMoney(centsFromDecimal("12.34"), { currency: "EUR" })).toBe("€12.34");
  });

  it("falls back to the code for a currency it has no symbol for", () => {
    expect(formatMoney(centsFromDecimal("12.34"), { currency: "PHP" })).toBe("PHP 12.34");
  });

  it("survives a figure past Number.MAX_SAFE_INTEGER", () => {
    // 9007199254740993 cents. As a double this is 9007199254740992.
    expect(formatMoney(9_007_199_254_740_993n)).toBe("$90,071,992,547,409.93");
  });
});

describe("splitMoney", () => {
  it("separates the major and minor parts", () => {
    expect(splitMoney(centsFromDecimal("55743.91"))).toEqual({ whole: "$55,743", cents: "91" });
  });

  it("keeps the sign with the major part", () => {
    expect(splitMoney(centsFromDecimal("-8.05"))).toEqual({ whole: "-$8", cents: "05" });
  });
});

describe("formatUnitsDp", () => {
  it("truncates rather than rounds, at 4dp (decision D-K)", () => {
    // 9113.71329... truncates to .7132. Rounding would give .7133.
    const ada = fold(LEDGER, SEEDS).holders.find((h) => h.holderId === 2)!;
    expect(formatUnitsDp(ada.units)).toBe("9,113.7132");
  });

  it("groups thousands", () => {
    expect(formatUnitsDp(unitsFromDecimal("40222.4547963043"))).toBe("40,222.4547");
  });

  it("keeps ten places when asked", () => {
    expect(formatUnitsDp(unitsFromDecimal("40222.4547963043"), 10)).toBe("40,222.4547963043");
  });

  it("renders zero units without a stray separator", () => {
    expect(formatUnitsDp(0n)).toBe("0.0000");
  });
});

describe("formatNav", () => {
  it("is 1.3858 on the fixture, truncated at 4dp", () => {
    expect(formatNav(TOTALS)).toBe("1.3858");
  });

  it("is 1.0000 at genesis", () => {
    expect(formatNav({ equityCents: 0n, units: 0n })).toBe("1.0000");
  });

  it("pads a NAV whose fraction has leading zeros", () => {
    // equity 1000.50 across 1000 units is NAV 1.0005. Without padStart the
    // fraction renders as "5" and the figure reads 1.5.
    expect(formatNav({
      equityCents: centsFromDecimal("1000.50"),
      units: unitsFromDecimal("1000"),
    })).toBe("1.0005");
  });
});

describe("formatSinceInception", () => {
  it("is +38.58% on the fixture", () => {
    expect(formatSinceInception(TOTALS)).toBe("+38.58%");
  });

  it("is +0.00% at genesis, not an empty string", () => {
    expect(formatSinceInception({ equityCents: 0n, units: 0n })).toBe("+0.00%");
  });

  it("signs a loss", () => {
    // 0.9474 NAV -> -5.26%
    expect(formatSinceInception({
      equityCents: centsFromDecimal("38110.44"),
      units: unitsFromDecimal("40222.4547963043"),
    })).toBe("-5.26%");
  });
});

describe("formatPpm", () => {
  it("renders a share at 2dp", () => {
    expect(formatPpm(621_543)).toBe("62.15%");
  });

  it("renders a whole hundred percent", () => {
    expect(formatPpm(1_000_000)).toBe("100.00%");
  });

  it("pads a small share", () => {
    expect(formatPpm(407)).toBe("0.04%");
  });

  it("refuses a share outside 0..1000000", () => {
    expect(() => formatPpm(1_000_001)).toThrow(/ppm must be an integer/);
  });
});

describe("formatSplit", () => {
  it("renders the default as 60 / 40", () => {
    expect(formatSplit(4000)).toBe("60 / 40");
  });

  it("renders Grace's 3700 as 63 / 37, not 60 / 40", () => {
    expect(formatSplit(3700)).toBe("63 / 37");
  });

  it("keeps two decimals for a split that is not a whole percent", () => {
    expect(formatSplit(3750)).toBe("62.50 / 37.50");
  });

  it("refuses a split outside 0..10000", () => {
    expect(() => formatSplit(10_001)).toThrow(/splitBps must be an integer/);
  });
});

describe("formatSplitWords", () => {
  it("names the holder, both percentages, and when the fee applies", () => {
    const words = formatSplitWords(3700, "Grace Hopper");
    expect(words).toContain("Grace Hopper keeps 63% of profit and you keep 37%");
    expect(words).toContain("only when Grace Hopper withdraws");
    expect(words).toContain("only on profit above what Grace Hopper has put in");
  });
});

describe("formatDate", () => {
  it("renders a broker-server date without constructing a Date", () => {
    expect(formatDate("2026-08-14")).toBe("14 Aug 2026");
  });

  it("does not shift the day west of UTC", () => {
    // A Date built from "2026-01-01" is midnight UTC, which is 31 Dec locally
    // anywhere west of Greenwich. This function never builds one.
    expect(formatDate("2026-01-01")).toBe("1 Jan 2026");
  });

  it("refuses a timestamp", () => {
    expect(() => formatDate("2026-08-14T00:00:00Z")).toThrow(/not a YYYY-MM-DD date/);
  });
});

describe("formatUtcStamp", () => {
  it("renders the UTC wall clock, whatever zone the reader is in", () => {
    expect(formatUtcStamp("2026-08-18T09:14:22.000Z")).toBe("18 Aug 2026, 09:14 UTC");
  });

  it("does not shift a stamp near midnight", () => {
    // new Date("2026-01-01T00:30:00Z") is 31 Dec locally west of Greenwich.
    expect(formatUtcStamp("2026-01-01T00:30:00.000Z")).toBe("1 Jan 2026, 00:30 UTC");
  });

  it("refuses a bare date", () => {
    expect(() => formatUtcStamp("2026-08-18")).toThrow(/not an ISO 8601 timestamp/);
  });
});

describe("signOf", () => {
  it("distinguishes zero from positive", () => {
    expect(signOf(0n)).toBe("zero");
    expect(signOf(1n)).toBe("pos");
    expect(signOf(-1n)).toBe("neg");
  });
});
```

**How these bite.** Delete the `padStart(2, "0")` in `splitMoney` and `$1,000.50` becomes `$1,000.5` — one test, named. Swap `formatUnits`'s truncation for rounding and Ada's `9,113.7132` becomes `9,113.7133`. Convert any figure to `Number` on the way through and the `MAX_SAFE_INTEGER` test fails. Hard-code the default split and Grace's row fails. Build a `Date` in `formatDate` and the `2026-01-01` test fails on any machine west of UTC — including CI, if it runs in a non-UTC zone, which is the point.

- [ ] **Step 4: Write the purity guard**

Create `lib/compound/present/purity.test.ts`:

```typescript
/**
 * present/ is pure. It formats and derives; it renders nothing and reads
 * nothing. Keeping React out of it is what lets every arithmetic test in this
 * plan run in the fast node project rather than under jsdom, and keeping db/
 * out of it is what lets those tests run with no database at all.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = __dirname;
const FORBIDDEN: [RegExp, string][] = [
  [/from\s+["']react/, "react"],
  [/from\s+["']next/, "next"],
  [/from\s+["']@\/lib\/compound\/db/, "the db layer"],
  [/from\s+["']pg["']/, "pg"],
  [/\bMath\.random\b/, "Math.random"],
  [/\bDate\.now\b/, "Date.now"],
  [/\bnew Date\b/, "new Date"],
];

function sources(): string[] {
  return readdirSync(DIR)
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith(".test.ts"))
    .map((f) => join(DIR, f));
}

describe("present/ purity", () => {
  it("has sources to check", () => {
    expect(sources().length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN)("imports nothing matching %s (%s)", (pattern, label) => {
    const offenders = sources().filter((f) => pattern.test(readFileSync(f, "utf8")));
    expect({ label, offenders }).toEqual({ label, offenders: [] });
  });

  it("contains no floating-point literal in a money or unit expression", () => {
    // A decimal literal in this module is either a percentage divisor or a
    // bug. The engine has none at all; present/ is allowed /100 and /10000 in
    // formatSplit, and nothing else.
    const offenders: string[] = [];
    for (const f of sources()) {
      for (const [i, line] of readFileSync(f, "utf8").split("\n").entries()) {
        if (/\b\d+\.\d+\b/.test(line) && !/toFixed|@|\/\//.test(line)) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

**How this bites.** Add `import { useMemo } from "react"` to `format.ts` and the react case names the file. Replace `formatDate`'s regex parse with `new Date(isoDate)` and the `new Date` case fires — which is the second line of defence behind the `2026-01-01` test.

- [ ] **Step 5: Run the gates and prove one probe**

```bash
pnpm typecheck && pnpm test
```

Then temporarily change `formatUnitsDp`'s default `dp` from `4` to `2` and confirm exactly the two `formatUnitsDp` truncation tests fail — not the whole file. Revert.

---

### Task 3: `present/rail.ts` and `present/derive.ts` — shares, the green ramp, and everything derived from a ledger

Two modules, one task, because they share one fixture and one discipline. `rail.ts` answers "who owns how much of this pool, and what colour is that". `derive.ts` answers "what does this ledger look like step by step, and what would this proposed entry do".

The load-bearing idea is D-D: **a preview is `fold(existing ++ [proposed])`.** The receipt a manager confirms is produced by the same reducer that will process the entry, so the two cannot disagree.

**Files:**
- Create: `lib/compound/present/rail.ts`
- Create: `lib/compound/present/derive.ts`
- Test: `lib/compound/present/rail.test.ts`
- Test: `lib/compound/present/derive.test.ts`

**Interfaces:**
- Consumes: `Cents`, `Units` from `@/lib/compound/engine/money`; `PoolTotals`, `allocateValues`, `navTimes1e4` from `@/lib/compound/engine/nav`; `LedgerEntry`, `LedgerEntryType`, `HolderSeed`, `HolderState`, `PoolState`, `fold`, `totalsOf` from `@/lib/compound/engine/replay`; `quote`, `Quote` from `@/lib/compound/engine/quote`
- Produces:
  - `allocateShares(holderUnits: readonly Units[], totalUnits: Units): number[]`
  - `railTint(index: number, count: number): string`
  - `railIsHatched(index: number, count: number): boolean`
  - `railSegments(state: PoolState, names: Record<number, string>): RailSegment[]`
  - `interface RailSegment { holderId; label; ppm; tint; hatched; isManager }`
  - `interface LedgerStep { entry; voided; before; after; unitsDelta; holderUnitsDelta; equityDelta }`
  - `ledgerSteps(entries: readonly LedgerEntry[], seeds: readonly HolderSeed[]): LedgerStep[]`
  - `interface CapitalMark { occurredOn; type; amountCents; direction }`
  - `capitalMarks(entries: readonly LedgerEntry[], seeds: readonly HolderSeed[]): CapitalMark[]`
  - `interface ProposedEntry { holderId; occurredOn; type; amountCents; feeSettlement; splitBpsApplied }`
  - `interface Fingerprint { accountId; seq; equityCents; units }`
  - `fingerprintOf(accountId: number, state: PoolState): Fingerprint`
  - `assertNavDidNotFall(type: LedgerEntryType, beforeX1e4: bigint, afterX1e4: bigint): void`
  - `previewEntry(input: PreviewInput): Preview`
  - `interface DeskRow { holderId; name; isManager; status; units; ppm; basisCents; valueCents; profitCents; splitBps; feeIfExitCents }`
  - `deskFigures(state: PoolState, names: Record<number, string>): DeskFigures`

- [ ] **Step 1: Create `lib/compound/present/rail.ts`**

```typescript
/**
 * The ownership rail. Green means THE POOL, DIVIDED — darkest first — and it
 * means neither "yours" nor "gain", both of which are carried by other hues.
 * Spec section 8.2.
 *
 * The ramp interpolates --own (#14532D, 9.11:1 on white) to --own-2 (#D6E9DE)
 * in integer sRGB. Teal and emerald were rejected in the spec because they sit
 * at 1.20:1 against --gain and separate by hue alone; only a markedly darker
 * green separates by lightness, which is what a colourblind reader has.
 *
 * The ramp is a FUNCTION, not a set of tokens. Spec section 8.1 defines two
 * green values and says additional holders take progressively lighter tints of
 * the same green; inventing a custom property per holder would not scale and
 * would put presentation decisions in a stylesheet that cannot count holders.
 *
 * Beyond six holders the ramp cycles and every repeated tint is hatched, so no
 * two adjacent segments are the same fill. The legend always labels every
 * segment: section 8.4 forbids colour as the sole carrier of meaning, so the
 * ramp is a convenience, never the information.
 */
import type { Units } from "@/lib/compound/engine/money";
import type { PoolState } from "@/lib/compound/engine/replay";

const OWN = [0x14, 0x53, 0x2d] as const;
const OWN_2 = [0xd6, 0xe9, 0xde] as const;

/** Six solid tints. Past that the ramp repeats with a hatch. */
export const RAIL_MAX_SOLID = 6;

const PPM = 1_000_000n;

/**
 * Shares in parts per million, allocated by largest remainder so they sum to
 * exactly 1,000,000.
 *
 * Flooring each share independently is short by up to one ppm per holder. On
 * this project's fixture the floors sum to 999,998 — so a rail built from them
 * leaves a two-ppm gap at the end and does not fill its container. The same
 * argument allocateValues makes about cents, made about percentages.
 *
 * This allocates a REPORTING quantity and never moves value, so the
 * conservative floor/ceil rule that governs issuance and redemption does not
 * apply. Ties break by holder order, matching allocateValues.
 */
export function allocateShares(holderUnits: readonly Units[], totalUnits: Units): number[] {
  if (holderUnits.length === 0) return [];
  if (totalUnits <= 0n) return holderUnits.map(() => 0);

  const sum = holderUnits.reduce((s, u) => s + u, 0n);
  if (sum !== totalUnits) {
    throw new RangeError(`holder units ${sum} do not sum to pool units ${totalUnits}`);
  }

  const floors = holderUnits.map((u) => (u * PPM) / totalUnits);
  const remainders = holderUnits.map((u, i) => u * PPM - floors[i]! * totalUnits);
  let short = PPM - floors.reduce((s, p) => s + p, 0n);

  const order = remainders
    .map((r, i) => [r, i] as const)
    .sort((a, b) => (a[0] !== b[0] ? (a[0] > b[0] ? -1 : 1) : a[1] - b[1]));

  const out = [...floors];
  for (let k = 0; short > 0n && k < order.length; k += 1, short -= 1n) {
    const idx = order[k]![1];
    out[idx] = out[idx]! + 1n;
  }
  return out.map((p) => Number(p));
}

/** Integer interpolation. No float touches a colour channel. */
function rampAt(position: number, steps: number): string {
  if (steps <= 1 || position <= 0) return "#14532d";
  const span = steps - 1;
  const k = Math.min(position, span);
  const channel = (i: 0 | 1 | 2) =>
    Math.trunc((OWN[i] * (span - k) + OWN_2[i] * k + Math.trunc(span / 2)) / span);
  return `#${[0, 1, 2].map((i) => channel(i as 0 | 1 | 2).toString(16).padStart(2, "0")).join("")}`;
}

/** Index 0 is always --own. The manager is always index 0. */
export function railTint(index: number, count: number): string {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`bad index ${index}`);
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`bad count ${count}`);
  const solid = Math.min(count, RAIL_MAX_SOLID);
  return rampAt(index % solid, solid);
}

export function railIsHatched(index: number, count: number): boolean {
  return index >= Math.min(count, RAIL_MAX_SOLID);
}

export interface RailSegment {
  holderId: number;
  label: string;
  /** Parts per million. The segments sum to exactly 1,000,000. */
  ppm: number;
  tint: string;
  hatched: boolean;
  isManager: boolean;
}

/**
 * The manager first, then investors by descending stake, then by holder id.
 * Darkest first is the spec's phrasing and the manager is always darkest.
 * Holders with no units are omitted: a zero-width segment is invisible and its
 * legend entry says nothing a reader can use.
 */
export function railSegments(state: PoolState, names: Record<number, string>): RailSegment[] {
  const held = state.holders.filter((h) => h.units > 0n);
  const ordered = [...held].sort((a, b) => {
    if (a.isManager !== b.isManager) return a.isManager ? -1 : 1;
    if (a.units !== b.units) return a.units > b.units ? -1 : 1;
    return a.holderId - b.holderId;
  });

  const shares = allocateShares(
    ordered.map((h) => h.units),
    ordered.reduce((s, h) => s + h.units, 0n),
  );

  return ordered.map((h, i) => ({
    holderId: h.holderId,
    label: names[h.holderId] ?? `Holder #${h.holderId}`,
    ppm: shares[i]!,
    tint: railTint(i, ordered.length),
    hatched: railIsHatched(i, ordered.length),
    isManager: h.isManager,
  }));
}
```

- [ ] **Step 2: Write `lib/compound/present/rail.test.ts`**

```typescript
import { unitsFromDecimal } from "@/lib/compound/engine/money";
import { fold } from "@/lib/compound/engine/replay";
import { HOLDER_NAMES, LEDGER, SEEDS } from "./fixture";
import {
  RAIL_MAX_SOLID, allocateShares, railIsHatched, railSegments, railTint,
} from "./rail";

const STATE = fold(LEDGER, SEEDS);

function luminance(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("allocateShares", () => {
  it("sums to exactly 1,000,000 ppm where flooring sums to 999,998", () => {
    const shares = allocateShares(STATE.holders.map((h) => h.units), STATE.units);
    const floors = STATE.holders.map((h) => Number((h.units * 1_000_000n) / STATE.units));
    expect(floors.reduce((a, b) => a + b, 0)).toBe(999_998);   // the gap being fixed
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1_000_000);
  });

  it("awards the two spare ppm to the two largest remainders", () => {
    // Remainders rank Grace > Ada > Manager, so Grace and Ada each gain one.
    expect(allocateShares(STATE.holders.map((h) => h.units), STATE.units))
      .toEqual([621_543, 226_583, 151_874]);
  });

  it("gives a sole holder the entire pool", () => {
    expect(allocateShares([unitsFromDecimal("7")], unitsFromDecimal("7"))).toEqual([1_000_000]);
  });

  it("returns zeros for an empty pool rather than dividing by zero", () => {
    expect(allocateShares([0n, 0n], 0n)).toEqual([0, 0]);
  });

  it("refuses units that do not sum to the pool", () => {
    expect(() => allocateShares([unitsFromDecimal("1")], unitsFromDecimal("2")))
      .toThrow(/do not sum to pool units/);
  });

  it("splits three equal holders 333334 / 333333 / 333333, summing to a million", () => {
    const u = unitsFromDecimal("1");
    const shares = allocateShares([u, u, u], u * 3n);
    expect(shares).toEqual([333_334, 333_333, 333_333]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1_000_000);
  });
});

describe("railTint", () => {
  it("puts --own at index 0 for every pool size", () => {
    for (let n = 1; n <= 9; n += 1) expect(railTint(0, n)).toBe("#14532d");
  });

  it("ends a full ramp at --own-2", () => {
    expect(railTint(2, 3)).toBe("#d6e9de");
    expect(railTint(5, 6)).toBe("#d6e9de");
  });

  it("produces the documented ramp for six holders", () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => railTint(i, 6)))
      .toEqual(["#14532d", "#3b7150", "#628f74", "#88ad97", "#afcbbb", "#d6e9de"]);
  });

  it("gets lighter monotonically, for every pool size up to the solid limit", () => {
    for (let n = 2; n <= RAIL_MAX_SOLID; n += 1) {
      const lums = [...Array(n)].map((_, i) => luminance(railTint(i, n)));
      for (let i = 1; i < n; i += 1) expect(lums[i]!).toBeGreaterThan(lums[i - 1]!);
    }
  });

  it("separates adjacent segments by lightness, not by hue alone", () => {
    // 1.371 is the tightest pair, at n=6. Below about 1.35 the boundary stops
    // reading as a boundary in greyscale.
    for (let n = 2; n <= RAIL_MAX_SOLID; n += 1) {
      for (let i = 1; i < n; i += 1) {
        expect(contrast(railTint(i, n), railTint(i - 1, n))).toBeGreaterThanOrEqual(1.35);
      }
    }
  });

  it("cycles past six and hatches every repeat", () => {
    expect(railTint(6, 8)).toBe(railTint(0, 8));
    expect(railIsHatched(5, 8)).toBe(false);
    expect(railIsHatched(6, 8)).toBe(true);
  });

  it("never hatches inside the solid run", () => {
    for (let n = 1; n <= RAIL_MAX_SOLID; n += 1) {
      for (let i = 0; i < n; i += 1) expect(railIsHatched(i, n)).toBe(false);
    }
  });

  it("refuses a negative index", () => {
    expect(() => railTint(-1, 3)).toThrow(/bad index/);
  });
});

describe("railSegments", () => {
  const segs = railSegments(STATE, HOLDER_NAMES);

  it("puts the manager first, at the darkest tint", () => {
    expect(segs[0]!.label).toBe("J. Marsh");
    expect(segs[0]!.isManager).toBe(true);
    expect(segs[0]!.tint).toBe("#14532d");
  });

  it("orders investors by descending stake", () => {
    expect(segs.map((s) => s.label)).toEqual(["J. Marsh", "Ada Lovelace", "Grace Hopper"]);
  });

  it("fills the rail exactly", () => {
    expect(segs.reduce((a, s) => a + s.ppm, 0)).toBe(1_000_000);
  });

  it("labels every segment, so colour is never the sole carrier", () => {
    for (const s of segs) expect(s.label.length).toBeGreaterThan(0);
  });

  it("omits a holder with no units", () => {
    const withGhost = {
      ...STATE,
      holders: [...STATE.holders, {
        holderId: 9, isManager: false, splitBps: 4000,
        units: 0n, basisCents: 0n, status: "closed" as const,
      }],
    };
    expect(railSegments(withGhost, HOLDER_NAMES).map((s) => s.holderId)).toEqual([1, 2, 3]);
  });

  it("names an unnamed holder rather than rendering undefined", () => {
    expect(railSegments(STATE, {})[0]!.label).toBe("Holder #1");
  });
});
```

**How these bite.** Replace `allocateShares`'s largest-remainder loop with a plain floor and the 1,000,000 assertion fails while the 999,998 assertion still passes — which is the pair that makes the failure legible. Change the ramp's endpoint from `--own-2` to `--gain` and the monotonic-lightness test fails, because `--gain` is darker than three of the tints. Sort investors ascending and the order test names it. Drop the `units > 0n` filter and the ghost-holder test fails.

- [ ] **Step 3: Create `lib/compound/present/derive.ts`**

```typescript
/**
 * Everything a screen needs that is derived from a ledger rather than
 * formatted from a figure.
 *
 * The rule this module exists to enforce (decision D-D): A PREVIEW IS A FOLD.
 * previewEntry appends the proposed entry to the real ledger and replays. The
 * receipt a manager reads is therefore produced by the same reducer that will
 * process the entry when they confirm it, and the two cannot drift. A
 * hand-written "here is what will happen" calculation is a second truth, and
 * this product's whole claim is that it has one.
 *
 * ledgerSteps folds every prefix rather than keeping a running total, for the
 * same reason (decision D-E). It is O(n^2) at a few thousand entries, which
 * spec section D7 explicitly says is irrelevant at this scale, and it is the
 * only construction under which the ledger page cannot disagree with the desk.
 */
import type { Cents, Units } from "@/lib/compound/engine/money";
import { allocateValues, navTimes1e4, type PoolTotals } from "@/lib/compound/engine/nav";
import { quote, type Quote } from "@/lib/compound/engine/quote";
import {
  fold, totalsOf,
  type HolderSeed, type LedgerEntry, type LedgerEntryType, type PoolState,
} from "@/lib/compound/engine/replay";
import { allocateShares } from "./rail";

/** fold's voiding rule, restated: a reversal voids both entries. */
function voidedIds(entries: readonly LedgerEntry[]): Set<number> {
  const voided = new Set<number>();
  for (const e of entries) {
    if (e.reversesId !== null) {
      voided.add(e.reversesId);
      voided.add(e.id);
    }
  }
  return voided;
}

function bySeq(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => a.seq - b.seq);
}

export interface LedgerStep {
  entry: LedgerEntry;
  /** True when this entry, or the entry that reverses it, is a reversal. */
  voided: boolean;
  before: PoolState;
  after: PoolState;
  /** Signed. Pool units issued or redeemed by this entry. */
  unitsDelta: Units;
  /** Signed, for the entry's own holder. Null for readings and adjustments. */
  holderUnitsDelta: Units | null;
  /** Signed. Cash that entered or left the account. */
  equityDelta: Cents;
}

export function ledgerSteps(
  entries: readonly LedgerEntry[],
  seeds: readonly HolderSeed[],
): LedgerStep[] {
  const ordered = bySeq(entries);
  const voided = voidedIds(ordered);
  const empty = fold([], seeds);

  const steps: LedgerStep[] = [];
  let before = empty;
  for (let i = 0; i < ordered.length; i += 1) {
    const entry = ordered[i]!;
    const after = fold(ordered.slice(0, i + 1), seeds);
    const holderUnitsOf = (s: PoolState) =>
      entry.holderId === null
        ? null
        : (s.holders.find((h) => h.holderId === entry.holderId)?.units ?? 0n);
    const hb = holderUnitsOf(before);
    const ha = holderUnitsOf(after);
    steps.push({
      entry,
      voided: voided.has(entry.id),
      before,
      after,
      unitsDelta: after.units - before.units,
      holderUnitsDelta: hb === null || ha === null ? null : ha - hb,
      equityDelta: after.equityCents - before.equityCents,
    });
    before = after;
  }
  return steps;
}

export interface CapitalMark {
  /** YYYY-MM-DD, broker-server date. */
  occurredOn: string;
  type: "deposit" | "payout" | "exit";
  /** Always positive. The cash that actually moved. */
  amountCents: Cents;
  direction: "in" | "out";
}

/**
 * Capital events for an equity curve. Spec R4.
 *
 * The amount is taken from the EQUITY DELTA, not from entry.amountCents. For a
 * deposit the two agree. For a payout they do not: replay.ts recomputes the
 * payout from quote() and never reads amountCents, so the ledger's figure is
 * the amount that was requested and the equity delta is the amount that left.
 * Marking the requested figure would put a mark of the wrong height on the
 * curve, which is exactly the class of error R4 exists to prevent.
 *
 * Voided entries are excluded, so a reversed deposit leaves no phantom step.
 */
export function capitalMarks(
  entries: readonly LedgerEntry[],
  seeds: readonly HolderSeed[],
): CapitalMark[] {
  const out: CapitalMark[] = [];
  for (const step of ledgerSteps(entries, seeds)) {
    if (step.voided) continue;
    const t = step.entry.type;
    if (t !== "deposit" && t !== "payout" && t !== "exit") continue;
    const delta = step.equityDelta;
    if (delta === 0n) continue;
    out.push({
      occurredOn: step.entry.occurredOn,
      type: t,
      amountCents: delta < 0n ? -delta : delta,
      direction: delta > 0n ? "in" : "out",
    });
  }
  return out;
}

export interface ProposedEntry {
  holderId: number | null;
  occurredOn: string;
  type: LedgerEntryType;
  amountCents: Cents;
  feeSettlement: "units" | "cash" | null;
  splitBpsApplied: number | null;
}

/**
 * What the preview was computed against. Carried through the sheet as strings
 * and checked at commit time, so a receipt can never be confirmed against a
 * pool that moved after it was rendered.
 */
export interface Fingerprint {
  accountId: number;
  seq: number;
  /** Decimal string. bigint does not survive JSON or a form field. */
  equityCents: string;
  units: string;
}

export function fingerprintOf(accountId: number, state: PoolState): Fingerprint {
  return {
    accountId,
    seq: state.seq,
    equityCents: state.equityCents.toString(),
    units: state.units.toString(),
  };
}

/**
 * Spec section 3.5, invariant 3, at the presentation boundary.
 *
 * "Only an equity reading may move NAV downward. Every other operation leaves
 * NAV equal or very slightly higher, by at most the rounding residual."
 *
 * An adjustment is a correction to equity and is exempt for the same reason a
 * reading is: it restates what the account is worth. A deposit, payout or exit
 * that lowers NAV means a holder extracted more than they were owed, and a
 * receipt must never be able to render one.
 */
export function assertNavDidNotFall(
  type: LedgerEntryType,
  beforeX1e4: bigint,
  afterX1e4: bigint,
): void {
  if (type === "equity_reading" || type === "adjustment") return;
  if (afterX1e4 < beforeX1e4) {
    throw new Error(
      `${type} would move NAV down from ${beforeX1e4} to ${afterX1e4} (x1e4). ` +
        `Only an equity reading may lower NAV; a fall here means value left the pool.`,
    );
  }
}

export interface PreviewInput {
  accountId: number;
  entries: readonly LedgerEntry[];
  seeds: readonly HolderSeed[];
  proposed: ProposedEntry;
}

export interface Preview {
  before: PoolState;
  after: PoolState;
  navBeforeX1e4: bigint;
  navAfterX1e4: bigint;
  /** after - before. Non-negative for every type assertNavDidNotFall guards. */
  navResidualX1e4: bigint;
  equityDelta: Cents;
  unitsDelta: Units;
  /** Aligned to before.holders / after.holders, which fold keeps in seed order. */
  sharesBefore: number[];
  sharesAfter: number[];
  valuesBefore: Cents[];
  valuesAfter: Cents[];
  fingerprint: Fingerprint;
}

export function previewEntry(input: PreviewInput): Preview {
  const { accountId, entries, seeds, proposed } = input;
  const ordered = bySeq(entries);
  const before = fold(ordered, seeds);

  const nextSeq = (ordered[ordered.length - 1]?.seq ?? 0) + 1;
  const nextId = ordered.reduce((m, e) => (e.id > m ? e.id : m), 0) + 1;
  const after = fold(
    [...ordered, { ...proposed, id: nextId, seq: nextSeq, reversesId: null }],
    seeds,
  );

  const navBeforeX1e4 = navTimes1e4(totalsOf(before));
  const navAfterX1e4 = navTimes1e4(totalsOf(after));
  assertNavDidNotFall(proposed.type, navBeforeX1e4, navAfterX1e4);

  return {
    before,
    after,
    navBeforeX1e4,
    navAfterX1e4,
    navResidualX1e4: navAfterX1e4 - navBeforeX1e4,
    equityDelta: after.equityCents - before.equityCents,
    unitsDelta: after.units - before.units,
    sharesBefore: allocateShares(before.holders.map((h) => h.units), before.units),
    sharesAfter: allocateShares(after.holders.map((h) => h.units), after.units),
    valuesBefore: allocateValues(totalsOf(before), before.holders.map((h) => h.units)),
    valuesAfter: allocateValues(totalsOf(after), after.holders.map((h) => h.units)),
    fingerprint: fingerprintOf(accountId, before),
  };
}

export interface DeskRow {
  holderId: number;
  name: string;
  isManager: boolean;
  status: "active" | "closed";
  units: Units;
  /** Parts per million. The rows sum to 1,000,000. */
  ppm: number;
  basisCents: Cents;
  /** ALLOCATED, per decision D-A. The column sums to equity exactly. */
  valueCents: Cents;
  profitCents: Cents;
  splitBps: number;
  /** What the manager would earn if this holder exited today. Zero for the manager. */
  feeIfExitCents: Cents;
}

export interface DeskFigures {
  totals: PoolTotals;
  navX1e4: bigint;
  rows: DeskRow[];
  /** Active non-manager holders only. */
  investorBasisCents: Cents;
  investorValueCents: Cents;
  investorProfitCents: Cents;
  /** Sum of every holder's fee on a full exit today. The accrued, uncrystallised fee. */
  feeIfAllExitCents: Cents;
  managerValueCents: Cents;
  holderCount: number;
}

/**
 * Every figure on the desk, in one pass.
 *
 * valueCents is allocated (largest remainder) so the column sums to equity
 * exactly — invariant 2. feeIfExitCents comes from quote(), which values the
 * holding by FLOORING. The two can differ by a cent for the same holder, and
 * both are correct: see decision D-A. Do not "reconcile" them here.
 */
export function deskFigures(state: PoolState, names: Record<number, string>): DeskFigures {
  const totals = totalsOf(state);
  const values = allocateValues(totals, state.holders.map((h) => h.units));
  const shares = allocateShares(state.holders.map((h) => h.units), state.units);

  const rows: DeskRow[] = state.holders.map((h, i) => {
    const q: Quote = quote({
      totals,
      holderUnits: h.units,
      basisCents: h.basisCents,
      splitBps: h.splitBps,
      isManager: h.isManager,
      mode: "exit",
    });
    return {
      holderId: h.holderId,
      name: names[h.holderId] ?? `Holder #${h.holderId}`,
      isManager: h.isManager,
      status: h.status,
      units: h.units,
      ppm: shares[i]!,
      basisCents: h.basisCents,
      valueCents: values[i]!,
      profitCents: values[i]! - h.basisCents,
      splitBps: h.splitBps,
      feeIfExitCents: q.feeCents,
    };
  });

  const investors = rows.filter((r) => !r.isManager && r.status === "active");
  return {
    totals,
    navX1e4: navTimes1e4(totals),
    rows,
    investorBasisCents: investors.reduce((s, r) => s + r.basisCents, 0n),
    investorValueCents: investors.reduce((s, r) => s + r.valueCents, 0n),
    investorProfitCents: investors.reduce((s, r) => s + r.profitCents, 0n),
    feeIfAllExitCents: rows.reduce((s, r) => s + r.feeIfExitCents, 0n),
    managerValueCents: rows.filter((r) => r.isManager).reduce((s, r) => s + r.valueCents, 0n),
    holderCount: rows.filter((r) => r.units > 0n).length,
  };
}
```

- [ ] **Step 4: Write `lib/compound/present/derive.test.ts`**

```typescript
import { centsFromDecimal, unitsFromDecimal } from "@/lib/compound/engine/money";
import { fold, type LedgerEntry } from "@/lib/compound/engine/replay";
import { ADA_ID, GRACE_ID, HOLDER_NAMES, LEDGER, MANAGER_ID, SEEDS } from "./fixture";
import {
  assertNavDidNotFall, capitalMarks, deskFigures, fingerprintOf, ledgerSteps, previewEntry,
} from "./derive";

const c = centsFromDecimal;
const u = unitsFromDecimal;

describe("ledgerSteps", () => {
  const steps = ledgerSteps(LEDGER, SEEDS);

  it("produces one step per entry", () => {
    expect(steps).toHaveLength(6);
  });

  it("carries the running equity, units and NAV of every prefix", () => {
    expect(steps.map((s) => s.after.equityCents.toString())).toEqual([
      "2500000", "2743119", "3743119", "4188307", "4938307", "5574391",
    ]);
    expect(steps.map((s) => s.after.units)).toEqual([
      u("25000"), u("25000"), u("34113.7132"), u("34113.7132"),
      u("40222.4547963043"), u("40222.4547963043"),
    ]);
  });

  it("ends where fold(all) ends — the ledger page cannot drift from the desk", () => {
    expect(steps[steps.length - 1]!.after).toEqual(fold(LEDGER, SEEDS));
  });

  it("chains: each step's before is the previous step's after", () => {
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]!.before).toEqual(steps[i - 1]!.after);
    }
  });

  it("reports units issued only on the entries that issue them", () => {
    expect(steps.map((s) => s.unitsDelta > 0n)).toEqual([true, false, true, false, true, false]);
  });

  it("reports the holder's own unit change, and null for a reading", () => {
    expect(steps[0]!.holderUnitsDelta).toBe(u("25000"));
    expect(steps[1]!.holderUnitsDelta).toBeNull();
  });

  it("orders by seq, not by array position", () => {
    const shuffled = [LEDGER[3]!, LEDGER[0]!, LEDGER[5]!, LEDGER[2]!, LEDGER[4]!, LEDGER[1]!];
    expect(ledgerSteps(shuffled, SEEDS).map((s) => s.entry.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("marks both sides of a reversal as voided", () => {
    const reversal: LedgerEntry = {
      id: 7, seq: 7, holderId: GRACE_ID, occurredOn: "2026-08-20",
      type: "deposit", amountCents: c("-7500.00"), feeSettlement: null,
      splitBpsApplied: null, reversesId: 5,
    };
    const withReversal = ledgerSteps([...LEDGER, reversal], SEEDS);
    expect(withReversal.filter((s) => s.voided).map((s) => s.entry.id)).toEqual([5, 7]);
  });
});

describe("capitalMarks", () => {
  it("marks each deposit once, in date order, as money in", () => {
    expect(capitalMarks(LEDGER, SEEDS)).toEqual([
      { occurredOn: "2026-03-02", type: "deposit", amountCents: c("25000.00"), direction: "in" },
      { occurredOn: "2026-05-04", type: "deposit", amountCents: c("10000.00"), direction: "in" },
      { occurredOn: "2026-07-06", type: "deposit", amountCents: c("7500.00"), direction: "in" },
    ]);
  });

  it("marks a readings-only ledger with nothing", () => {
    expect(capitalMarks(LEDGER.filter((e) => e.type === "equity_reading"), SEEDS)).toEqual([]);
  });

  it("marks a payout with the cash that LEFT, not the amount that was requested", () => {
    // Ada's profit payout: amountCents on the entry is the requested 2630.60.
    // The cash that left is toHolderCents, 1578.36 — the fee stayed in the
    // pool as units. Reading amountCents would put a mark of the wrong height
    // on the equity curve.
    const payout: LedgerEntry = {
      id: 7, seq: 7, holderId: ADA_ID, occurredOn: "2026-08-18", type: "payout",
      amountCents: c("2630.60"), feeSettlement: "units", splitBpsApplied: 4000,
      reversesId: null,
    };
    expect(capitalMarks([...LEDGER, payout], SEEDS).at(-1)).toEqual({
      occurredOn: "2026-08-18", type: "payout",
      amountCents: c("1578.36"), direction: "out",
    });
  });

  it("leaves no phantom step where a deposit was reversed", () => {
    const reversal: LedgerEntry = {
      id: 7, seq: 7, holderId: GRACE_ID, occurredOn: "2026-08-20",
      type: "deposit", amountCents: c("-7500.00"), feeSettlement: null,
      splitBpsApplied: null, reversesId: 5,
    };
    const marks = capitalMarks([...LEDGER, reversal], SEEDS);
    expect(marks.map((m) => m.occurredOn)).toEqual(["2026-03-02", "2026-05-04"]);
  });
});

describe("assertNavDidNotFall", () => {
  it("permits a reading to lower NAV", () => {
    expect(() => assertNavDidNotFall("equity_reading", 13_858n, 9_474n)).not.toThrow();
  });

  it("permits an adjustment to lower NAV", () => {
    expect(() => assertNavDidNotFall("adjustment", 13_858n, 13_857n)).not.toThrow();
  });

  it("refuses a deposit that lowers NAV, naming both figures", () => {
    expect(() => assertNavDidNotFall("deposit", 13_858n, 13_857n))
      .toThrow(/deposit would move NAV down from 13858 to 13857/);
  });

  it("refuses a payout that lowers NAV", () => {
    expect(() => assertNavDidNotFall("payout", 13_858n, 13_857n)).toThrow(/NAV down/);
  });

  it("permits NAV rising by a rounding residual", () => {
    expect(() => assertNavDidNotFall("deposit", 13_858n, 13_859n)).not.toThrow();
  });

  it("permits NAV unchanged", () => {
    expect(() => assertNavDidNotFall("exit", 13_858n, 13_858n)).not.toThrow();
  });
});

describe("previewEntry — a deposit", () => {
  const p = previewEntry({
    accountId: 7,
    entries: LEDGER,
    seeds: SEEDS,
    proposed: {
      holderId: ADA_ID, occurredOn: "2026-08-18", type: "deposit",
      amountCents: c("4250.00"), feeSettlement: null, splitBpsApplied: null,
    },
  });

  it("is exactly fold(existing ++ proposed)", () => {
    expect(p.after).toEqual(fold([...LEDGER, {
      id: 7, seq: 7, holderId: ADA_ID, occurredOn: "2026-08-18", type: "deposit",
      amountCents: c("4250.00"), feeSettlement: null, splitBpsApplied: null, reversesId: null,
    }], SEEDS));
  });

  it("issues the floor of the units the deposit buys", () => {
    // 4250.00 at NAV 1.3858... is 3066.6207821498... units. Ceil would be
    // 3066.6207821499 and would lower NAV, which assertNavDidNotFall forbids.
    expect(p.unitsDelta).toBe(u("3066.6207821498"));
  });

  it("adds exactly the deposit to equity", () => {
    expect(p.equityDelta).toBe(c("4250.00"));
  });

  it("leaves NAV where it was", () => {
    expect(p.navBeforeX1e4).toBe(13_858n);
    expect(p.navAfterX1e4).toBe(13_858n);
    expect(p.navResidualX1e4).toBe(0n);
  });

  it("dilutes shares and leaves the other holders' values alone", () => {
    expect(p.sharesBefore).toEqual([621_543, 226_583, 151_874]);
    expect(p.sharesAfter).toEqual([577_513, 281_372, 141_115]);
    expect(p.valuesBefore).toEqual([c("34647.26"), c("12630.61"), c("8466.04")]);
    expect(p.valuesAfter).toEqual([c("34647.26"), c("16880.61"), c("8466.04")]);
  });

  it("keeps both share rows summing to a full pool", () => {
    expect(p.sharesBefore.reduce((a, b) => a + b, 0)).toBe(1_000_000);
    expect(p.sharesAfter.reduce((a, b) => a + b, 0)).toBe(1_000_000);
  });

  it("fingerprints the state the preview was computed against", () => {
    expect(p.fingerprint).toEqual({
      accountId: 7, seq: 6, equityCents: "5574391", units: "402224547963043",
    });
  });
});

describe("previewEntry — a profit payout with the fee retained as units", () => {
  const p = previewEntry({
    accountId: 7,
    entries: LEDGER,
    seeds: SEEDS,
    proposed: {
      holderId: ADA_ID, occurredOn: "2026-08-18", type: "payout",
      amountCents: c("2630.60"), feeSettlement: "units", splitBpsApplied: 4000,
    },
  });

  it("takes only the cash the holder receives out of the account", () => {
    expect(p.equityDelta).toBe(c("-1578.36"));
  });

  it("nets units: Ada surrenders 1898.13, the manager is issued 759.2520121904", () => {
    expect(p.unitsDelta).toBe(u("759.2520121904") - u("1898.1300304762"));
  });

  it("leaves NAV where it was — the settlement is NAV-neutral", () => {
    expect(p.navAfterX1e4).toBe(p.navBeforeX1e4);
  });

  it("returns Ada to her cost basis, which is what a high-water mark means", () => {
    const ada = p.after.holders.findIndex((h) => h.holderId === ADA_ID);
    expect(p.after.holders[ada]!.basisCents).toBe(c("10000.00"));
    expect(p.valuesAfter[ada]).toBe(c("10000.01")); // allocated; floored is 10000.00
  });

  it("raises the manager's cost basis by the fee they took as units", () => {
    const mgr = p.after.holders.find((h) => h.holderId === MANAGER_ID)!;
    expect(mgr.basisCents).toBe(c("26052.24"));  // 25000.00 + 1052.24
  });
});

describe("previewEntry — the same payout settled in cash", () => {
  const p = previewEntry({
    accountId: 7,
    entries: LEDGER,
    seeds: SEEDS,
    proposed: {
      holderId: ADA_ID, occurredOn: "2026-08-18", type: "payout",
      amountCents: c("2630.60"), feeSettlement: "cash", splitBpsApplied: 4000,
    },
  });

  it("takes the holder's cash AND the fee out of the account", () => {
    expect(p.equityDelta).toBe(c("-2630.60"));
  });

  it("issues the manager no units", () => {
    expect(p.after.holders.find((h) => h.holderId === MANAGER_ID)!.units).toBe(u("25000"));
  });

  it("still leaves NAV where it was", () => {
    expect(p.navAfterX1e4).toBe(p.navBeforeX1e4);
  });
});

describe("deskFigures", () => {
  const d = deskFigures(fold(LEDGER, SEEDS), HOLDER_NAMES);

  it("values holders by allocation, so the column sums to equity exactly", () => {
    expect(d.rows.map((r) => r.valueCents))
      .toEqual([c("34647.26"), c("12630.61"), c("8466.04")]);
    expect(d.rows.reduce((s, r) => s + r.valueCents, 0n)).toBe(c("55743.91"));
  });

  it("does not reconcile the allocated value with the floored one", () => {
    // Ada reads 12630.61 here and 12630.60 on her payout receipt. Decision
    // D-A. If this ever becomes equal, one of the two is now wrong.
    const ada = d.rows.find((r) => r.holderId === ADA_ID)!;
    expect(ada.valueCents).toBe(c("12630.61"));
  });

  it("measures profit against cost basis", () => {
    expect(d.rows.map((r) => r.profitCents))
      .toEqual([c("9647.26"), c("2630.61"), c("966.04")]);
  });

  it("charges the manager no fee on their own holding", () => {
    expect(d.rows.find((r) => r.isManager)!.feeIfExitCents).toBe(0n);
  });

  it("applies each holder's own split, not the default", () => {
    // Grace is 3700, not 4000. 966.04 x 37% floors to 357.43; at 40% it would
    // be 386.41, so a hard-coded default fails here and only here.
    expect(d.rows.find((r) => r.holderId === GRACE_ID)!.feeIfExitCents).toBe(c("357.43"));
    expect(d.rows.find((r) => r.holderId === ADA_ID)!.feeIfExitCents).toBe(c("1052.24"));
  });

  it("totals the accrued fee across every holder", () => {
    expect(d.feeIfAllExitCents).toBe(c("1409.67"));  // 1052.24 + 357.43
  });

  it("totals investor capital, value and profit, excluding the manager", () => {
    expect(d.investorBasisCents).toBe(c("17500.00"));
    expect(d.investorValueCents).toBe(c("21096.65"));
    expect(d.investorProfitCents).toBe(c("3596.65"));
  });

  it("reports the manager's own value separately", () => {
    expect(d.managerValueCents).toBe(c("34647.26"));
  });

  it("counts only holders who hold something", () => {
    expect(d.holderCount).toBe(3);
  });

  it("carries NAV as an integer, for the presentation layer to format", () => {
    expect(d.navX1e4).toBe(13_858n);
  });
});

describe("deskFigures — everyone under water", () => {
  const d = deskFigures(
    fold([...LEDGER, {
      id: 7, seq: 7, holderId: null, occurredOn: "2026-08-18",
      type: "equity_reading", amountCents: c("38110.44"),
      feeSettlement: null, splitBpsApplied: null, reversesId: null,
    }], SEEDS),
    HOLDER_NAMES,
  );

  it("charges no fee at all", () => {
    expect(d.feeIfAllExitCents).toBe(0n);
    expect(d.rows.every((r) => r.feeIfExitCents === 0n)).toBe(true);
  });

  it("reports negative profit for every holder", () => {
    expect(d.rows.map((r) => r.profitCents))
      .toEqual([c("-1312.71"), c("-1364.84"), c("-1712.02")]);
  });

  it("still sums holder value to equity exactly", () => {
    expect(d.rows.reduce((s, r) => s + r.valueCents, 0n)).toBe(c("38110.44"));
  });
});

describe("fingerprintOf", () => {
  it("carries bigints as decimal strings, because a form field is text", () => {
    const f = fingerprintOf(3, fold(LEDGER, SEEDS));
    expect(f).toEqual({ accountId: 3, seq: 6, equityCents: "5574391", units: "402224547963043" });
    expect(typeof f.units).toBe("string");
  });
});
```

**How these bite.**

| Change | What goes red |
|---|---|
| `capitalMarks` reads `entry.amountCents` instead of the equity delta | the payout mark test — 2630.60 where 1578.36 is right |
| `capitalMarks` drops the voided filter | the phantom-step test |
| `ledgerSteps` keeps a running total instead of folding each prefix | nothing immediately, which is why the `ends where fold(all) ends` and `chains` assertions exist — they are what catches the drift the first time an entry type is added |
| `ledgerSteps` iterates the array instead of sorting by seq | the shuffled-order test |
| `deskFigures` uses `allocateValues` for the fee too | Ada's fee moves off 1052.24 |
| `deskFigures` uses `h.splitBps` from the account default | Grace's 357.43 becomes 386.41 |
| `previewEntry` drops `assertNavDidNotFall` | nothing on this fixture — which is why `assertNavDidNotFall` has its own six direct tests rather than relying on being reached |
| `unitsForDeposit` switched to ceil in the engine | `previewEntry` throws and four tests fail at once, which is the cross-module alarm working |

- [ ] **Step 5: Run the gates and prove three probes**

```bash
pnpm typecheck && pnpm test
```

Then, one at a time, reverting each:

1. In `capitalMarks`, change `const delta = step.equityDelta` to `const delta = step.entry.amountCents`. Expect exactly the payout-mark test to fail. The three deposit marks still pass, because for a deposit the two agree — which is precisely why the fixture needs a payout in it.
2. In `deskFigures`, replace `splitBps: h.splitBps` with `splitBps: 4000`. Expect exactly the Grace fee test and the `feeIfAllExitCents` total to fail.
3. In `allocateShares`, delete the largest-remainder loop and return the floors. Expect the two share-sum assertions in `derive.test.ts` and three in `rail.test.ts` to fail.

---

### Task 4: `lib/compound/ui/` — the statement kit

The components that put figures on a screen. They take engine types and return markup; they read nothing and fetch nothing. That is what makes the arithmetic on screen testable by handing a component a known `PoolState` and reading the cells back.

**Every value in the kit carries an accessible name**, either through real table semantics (`<th scope="col">` and `<th scope="row">`) or through `aria-labelledby` pointing at its own label. This is not test scaffolding that happens to help a screen reader — it is the screen-reader affordance that happens to make the tests possible. Tests locate a figure the way a reader does.

**Files:**
- Create: `lib/compound/ui/primitives.tsx`
- Create: `lib/compound/ui/banner.tsx`
- Create: `lib/compound/ui/rail.tsx`
- Create: `lib/compound/ui/statement.tsx`
- Create: `lib/compound/ui/holder-table.tsx`
- Create: `lib/compound/ui/receipt.tsx`
- Create: `lib/compound/ui/sheet.tsx`
- Create: `lib/compound/ui/routes.ts`
- Test: `lib/compound/ui/purity.test.ts`
- Test: `lib/compound/ui/holder-table.test.tsx`
- Test: `lib/compound/ui/statement.test.tsx`
- Test: `lib/compound/ui/rail.test.tsx`
- Test: `lib/compound/ui/routes.test.ts`

**Interfaces:**
- Consumes: everything from `@/lib/compound/present/format`, `@/lib/compound/present/rail`, `@/lib/compound/present/derive`; `Cents`, `Units` from `@/lib/compound/engine/money`; `PoolTotals` from `@/lib/compound/engine/nav`
- Produces:
  - `primitives.tsx`: `Panel`, `Eyebrow`, `Money`, `DeltaMoney`, `FeeMoney`, `UnitCount`, `Share`, `Tag`, `Chip`, `EmptyState`, `LabelledFigure`
  - `banner.tsx`: `InterlockBanner`, `LiveChip`, `Notice`
  - `rail.tsx`: `OwnershipRail`
  - `statement.tsx`: `StatementHead`, `KpiStrip`, `type KpiItem`
  - `holder-table.tsx`: `HolderTable`
  - `receipt.tsx`: `Receipt`, `ReceiptLine`, `ReceiptTotal`
  - `sheet.tsx`: `Sheet`, `SheetActions`, `Field`, `FieldError`
  - `routes.ts`: `deskHref`, `ledgerHref`, `reviewHref`, `holderHref`, `journalHref`, `calendarHref`, `performanceHref`, `SUBNAV`, `activeNavKey`

- [ ] **Step 1: Create `lib/compound/ui/routes.ts`**

```typescript
/**
 * Every route in the account shell, in one place, so plan 5's three surfaces
 * and this plan's five appear in the same nav without either side hard-coding
 * the other's paths.
 *
 * Order is agreed with plan 5: Desk, then the three trading surfaces, then the
 * two accounting ones. There is no Holders entry — spec section 7 has no
 * holder index route and the desk's holder table is the index.
 */
export const deskHref = (accountId: number) => `/a/${accountId}`;
export const ledgerHref = (accountId: number) => `/a/${accountId}/ledger`;
export const reviewHref = (accountId: number) => `/a/${accountId}/review`;
export const holderHref = (accountId: number, holderId: number) =>
  `/a/${accountId}/holders/${holderId}`;
export const journalHref = (accountId: number) => `/a/${accountId}/journal`;
export const calendarHref = (accountId: number) => `/a/${accountId}/calendar`;
export const performanceHref = (accountId: number) => `/a/${accountId}/performance`;

export const readingHref = (accountId: number) => `/a/${accountId}/actions/reading`;
export const investorHref = (accountId: number) => `/a/${accountId}/actions/investor`;
export const capitalHref = (accountId: number) => `/a/${accountId}/actions/capital`;
export const payoutHref = (accountId: number, holderId: number) =>
  `/a/${accountId}/actions/payout/${holderId}`;
export const classifyHref = (accountId: number, candidateId: number) =>
  `/a/${accountId}/review/${candidateId}`;

export interface NavEntry {
  key: string;
  label: string;
  href: (accountId: number) => string;
  /** Only Review carries one. */
  badge?: "pending";
}

export const SUBNAV: NavEntry[] = [
  { key: "desk", label: "Desk", href: deskHref },
  { key: "journal", label: "Journal", href: journalHref },
  { key: "calendar", label: "Calendar", href: calendarHref },
  { key: "performance", label: "Performance", href: performanceHref },
  { key: "ledger", label: "Ledger", href: ledgerHref },
  { key: "review", label: "Review", href: reviewHref, badge: "pending" },
];

/**
 * Which nav entry a pathname belongs to.
 *
 * Longest match wins, so /a/7/ledger is "ledger" and not "desk". A holder
 * statement and an action sheet both belong to "desk", because that is where
 * the reader came from and where Back should feel like it leads.
 */
export function activeNavKey(pathname: string, accountId: number): string {
  const base = `/a/${accountId}`;
  if (!pathname.startsWith(base)) return "";
  const rest = pathname.slice(base.length).replace(/^\//, "");
  const first = rest.split("/")[0] ?? "";
  if (first === "") return "desk";
  if (first === "holders" || first === "actions") return "desk";
  return SUBNAV.some((n) => n.key === first) ? first : "";
}
```

- [ ] **Step 2: Create `lib/compound/ui/primitives.tsx`**

```tsx
/**
 * The smallest pieces. Three money components rather than one with a `tone`
 * prop, because spec section 8.2 gives three colours three meanings and a
 * single component with a switch invites a fourth.
 *
 *   Money       plain figure, --ink
 *   DeltaMoney  P/L direction, --gain or --loss, always signed
 *   FeeMoney    the fee, --fee-ink
 *
 * Amber never sets type: --fee is 2.15:1 on white. FeeMoney uses --fee-ink at
 * 5.02:1. The amber itself appears as fills and chips only.
 */
import type { ReactNode } from "react";
import type { Cents, Units } from "@/lib/compound/engine/money";
import {
  formatMoney, formatPpm, formatUnitsDp, signOf,
} from "@/lib/compound/present/format";

let seq = 0;
/** Stable within a render pass; only ever used to tie a label to its value. */
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export function Panel({ children, flush = false }: { children: ReactNode; flush?: boolean }) {
  return <section className={flush ? "panel flush" : "panel"}>{children}</section>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="eyebrow">{children}</span>;
}

export function Money({ cents, currency = "USD" }: { cents: Cents; currency?: string }) {
  return <span className="num">{formatMoney(cents, { currency })}</span>;
}

export function DeltaMoney({ cents, currency = "USD" }: { cents: Cents; currency?: string }) {
  const sign = signOf(cents);
  return (
    <span className={`num ${sign === "neg" ? "neg" : sign === "pos" ? "pos" : ""}`.trim()}>
      {formatMoney(cents, { currency, sign: "always" })}
    </span>
  );
}

export function FeeMoney({
  cents, currency = "USD", zeroAs = "figure",
}: { cents: Cents; currency?: string; zeroAs?: "figure" | "dash" }) {
  if (cents === 0n && zeroAs === "dash") return <span className="num">—</span>;
  return <span className="num fee">{formatMoney(cents, { currency })}</span>;
}

export function UnitCount({ units, dp = 4 }: { units: Units; dp?: number }) {
  return (
    <span className="num">
      {formatUnitsDp(units, dp)}
      <span className="muted"> units</span>
    </span>
  );
}

export function Share({ ppm }: { ppm: number }) {
  return <span className="num">{formatPpm(ppm)}</span>;
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>;
}

export function Chip({ children, tone }: { children: ReactNode; tone?: "live" | "fee" }) {
  return (
    <span className={`chip${tone ? ` is-${tone}` : ""}`}>{children}</span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div style={{ padding: "36px 20px", textAlign: "center" }}>
      <p style={{ margin: "0 0 6px", fontFamily: "var(--serif)", fontSize: 20 }}>{title}</p>
      {children ? <p className="muted" style={{ margin: 0, fontSize: 13 }}>{children}</p> : null}
    </div>
  );
}

/**
 * A label and its figure, tied by aria-labelledby.
 *
 * aria-labelledby NAMES the value element without replacing its contents, so a
 * screen reader announces "Fee if everyone paid out today, $1,409.67" and a
 * test can ask for the figure by the label a reader would use. aria-label
 * would suppress the number, which is the opposite of what is wanted.
 */
export function LabelledFigure({
  label, children, className = "", labelClassName = "k", valueClassName = "v num",
}: {
  label: string;
  children: ReactNode;
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
}) {
  const id = nextId("lf");
  return (
    <div className={className}>
      <span className={labelClassName} id={id}>{label}</span>
      <span className={valueClassName} aria-labelledby={id}>{children}</span>
    </div>
  );
}
```

- [ ] **Step 3: Create `lib/compound/ui/banner.tsx`**

The two states spec §5.2 and §5.3 describe, and the wording plan 5 imports rather than re-phrasing.

```tsx
/**
 * Two states that look similar and are not, and conflating them is the bug.
 *
 * LiveChip — the figure beside it is intraday, from account_snapshots_current,
 * and no reading has been posted for it. NAV is fine; the number is simply not
 * committed. Spec section 5.2.
 *
 * InterlockBanner — the reconciler found a balance move that closed trades do
 * not explain, so readings have STOPPED. Every figure on the account is as of
 * the frozen date and will stay there until the event is classified. Spec
 * section 5.3. This is not a staleness warning; it is a refusal to guess.
 */
import type { ReactNode } from "react";
import { formatDate, formatUtcStamp } from "@/lib/compound/present/format";
import { Chip } from "./primitives";

export function LiveChip({ pushedAt }: { pushedAt: string }) {
  return (
    <Chip tone="live">
      <span>Live · not yet posted</span>
      <span className="muted"> · {formatUtcStamp(pushedAt)}</span>
    </Chip>
  );
}

export function InterlockBanner({
  frozenAt, candidateDate, reviewHref,
}: { frozenAt: string | null; candidateDate: string; reviewHref: string }) {
  return (
    <div className="banner-halt" role="status">
      <strong>Figures frozen at {frozenAt === null ? "inception" : formatDate(frozenAt)}.</strong>{" "}
      An unexplained balance move on {formatDate(candidateDate)} is waiting to be classified.
      NAV will not advance past {frozenAt === null ? "inception" : formatDate(frozenAt)} until
      it is. <a href={reviewHref}>Review it</a>.
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="banner" role="status">{children}</div>;
}
```

- [ ] **Step 4: Create `lib/compound/ui/rail.tsx`**

```tsx
/**
 * The ownership rail. Green means the pool, divided — darkest first.
 *
 * Widths come from allocateShares, which sums to exactly 1,000,000 ppm, so the
 * segments fill the rail exactly. Flooring each share leaves a visible gap: on
 * this project's fixture the floors sum to 999,998.
 *
 * The percentage string is built with integer arithmetic. ppm / 10000 as a
 * float is fine for a CSS length, but there is no reason to introduce one.
 */
import type { RailSegment } from "@/lib/compound/present/rail";
import { formatPpm } from "@/lib/compound/present/format";

function widthPercent(ppm: number): string {
  return `${Math.trunc(ppm / 10_000)}.${(ppm % 10_000).toString().padStart(4, "0")}%`;
}

export function OwnershipRail({ segments }: { segments: RailSegment[] }) {
  if (segments.length === 0) return null;
  return (
    <>
      <div className="rail" role="img" aria-label="Ownership by holder">
        {segments.map((s) => (
          <div
            key={s.holderId}
            className={s.hatched ? "seg hatched" : "seg"}
            style={{ width: widthPercent(s.ppm), background: s.tint }}
          />
        ))}
      </div>
      <ul className="leg" aria-label="Ownership legend">
        {segments.map((s) => (
          <li key={s.holderId}>
            <i style={{ background: s.tint }} aria-hidden="true" />
            {s.label}
            {s.isManager ? " (manager)" : ""} <b>{formatPpm(s.ppm)}</b>
          </li>
        ))}
      </ul>
    </>
  );
}
```

- [ ] **Step 5: Create `lib/compound/ui/statement.tsx`**

```tsx
/**
 * The statement head and the KPI strip.
 *
 * The head shows the COMMITTED equity — the figure from the last posted
 * reading — as the large number, and the live figure beside it under a label
 * that says it is not posted. Spec section 5.2 keeps the two apart because a
 * payout may never settle against a drifting intraday figure, and a screen
 * that shows only one of them cannot make that distinction visible.
 */
import type { Cents } from "@/lib/compound/engine/money";
import type { PoolTotals } from "@/lib/compound/engine/nav";
import {
  formatDate, formatNav, formatSinceInception, formatUnitsDp, splitMoney,
} from "@/lib/compound/present/format";
import { LiveChip } from "./banner";
import { DeltaMoney, Eyebrow, LabelledFigure } from "./primitives";

export interface LiveFigures {
  equityCents: Cents;
  floatingPnlCents: Cents;
  pushedAt: string;
}

export function StatementHead({
  totals, currency, asOf, entryCount, holderCount, live,
}: {
  totals: PoolTotals;
  currency: string;
  asOf: string | null;
  entryCount: number;
  holderCount: number;
  live: LiveFigures | null;
}) {
  const { whole, cents } = splitMoney(totals.equityCents, currency);
  const navUp = totals.units === 0n || formatSinceInception(totals).startsWith("+");
  return (
    <>
      <Eyebrow>
        Account equity · derived from {entryCount} ledger{" "}
        {entryCount === 1 ? "entry" : "entries"} ·{" "}
        {asOf === null ? "no reading posted yet" : `as of ${formatDate(asOf)}`}
      </Eyebrow>
      <div className="erow">
        <p className="equity num" aria-label="Account equity" style={{ margin: "8px 0 0" }}>
          {whole}
          <span className="cents">.{cents}</span>
        </p>
        <div className="navbox" style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <LabelledFigure label="NAV / unit">{formatNav(totals)}</LabelledFigure>
          <LabelledFigure label="Since inception">
            <span className={navUp ? "pos" : "neg"}>{formatSinceInception(totals)}</span>
          </LabelledFigure>
          <LabelledFigure label="Units issued">{formatUnitsDp(totals.units)}</LabelledFigure>
          <LabelledFigure label="Holders">{holderCount}</LabelledFigure>
        </div>
      </div>
      {live === null ? null : (
        <p style={{ margin: "14px 0 0", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <LiveChip pushedAt={live.pushedAt} />
          <LabelledFigure
            label="Live equity"
            className=""
            labelClassName="eyebrow"
            valueClassName="num"
          >
            {splitMoney(live.equityCents, currency).whole}.
            {splitMoney(live.equityCents, currency).cents}
          </LabelledFigure>
          <LabelledFigure
            label="Floating P/L"
            className=""
            labelClassName="eyebrow"
            valueClassName="num"
          >
            <DeltaMoney cents={live.floatingPnlCents} currency={currency} />
          </LabelledFigure>
        </p>
      )}
    </>
  );
}

export interface KpiItem {
  key: string;
  label: string;
  value: React.ReactNode;
  /** `fee` paints the tile amber. Reserved for the fee, per spec section 8.2. */
  tone?: "fee";
}

export function KpiStrip({ items }: { items: KpiItem[] }) {
  return (
    <div className="kpi">
      {items.map((i) => (
        <LabelledFigure
          key={i.key}
          label={i.label}
          className={i.tone === "fee" ? "kpi-item is-fee" : "kpi-item"}
        >
          {i.value}
        </LabelledFigure>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Create `lib/compound/ui/holder-table.tsx`**

```tsx
/**
 * The holder table. Every figure here is ALLOCATED (decision D-A): the value
 * column sums to account equity exactly, because invariant 2 says it does.
 *
 * A holder's payout receipt shows a floored value that can be one cent lower.
 * That is correct on both screens and the holder statement page explains it in
 * words. Do not make them agree here.
 *
 * Real table semantics throughout: scope="col" on headers, scope="row" on the
 * holder name. That is how a screen reader associates $12,630.61 with "Ada
 * Lovelace, Value now", and it is how the tests find it too.
 */
import type { DeskFigures } from "@/lib/compound/present/derive";
import { formatSplit, formatUnitsDp } from "@/lib/compound/present/format";
import { DeltaMoney, FeeMoney, Money, Share, Tag } from "./primitives";
import { holderHref, payoutHref } from "./routes";

export function HolderTable({
  accountId, figures, currency, showActions = true,
}: {
  accountId: number;
  figures: DeskFigures;
  currency: string;
  showActions?: boolean;
}) {
  const investorProfit = figures.investorValueCents - figures.investorBasisCents;
  return (
    <div className="scroller">
      <table>
        <caption className="eyebrow">Holders</caption>
        <thead>
          <tr>
            <th scope="col">Holder</th>
            <th scope="col">Capital in</th>
            <th scope="col">Units</th>
            <th scope="col">Share</th>
            <th scope="col">Value now</th>
            <th scope="col">P/L</th>
            <th scope="col">Split</th>
            <th scope="col">Fee if paid out</th>
            {showActions ? <th scope="col">&nbsp;</th> : null}
          </tr>
        </thead>
        <tbody>
          {figures.rows.map((r) => (
            <tr
              key={r.holderId}
              className={r.isManager ? "own" : r.status === "closed" ? "closed" : ""}
            >
              <th scope="row" style={{ fontWeight: 400 }}>
                <a href={holderHref(accountId, r.holderId)}>{r.name}</a>
                {r.isManager ? <Tag>Manager</Tag> : null}
                {r.status === "closed" ? <Tag>Closed</Tag> : null}
              </th>
              <td><Money cents={r.basisCents} currency={currency} /></td>
              <td className="num">{r.units === 0n ? "—" : formatUnitsDp(r.units)}</td>
              <td><Share ppm={r.ppm} /></td>
              <td><Money cents={r.valueCents} currency={currency} /></td>
              <td><DeltaMoney cents={r.profitCents} currency={currency} /></td>
              <td className="num">{r.isManager ? "—" : formatSplit(r.splitBps)}</td>
              <td><FeeMoney cents={r.feeIfExitCents} currency={currency} zeroAs="dash" /></td>
              {showActions ? (
                <td>
                  {r.status === "active" && r.units > 0n ? (
                    <a className="btn" href={payoutHref(accountId, r.holderId)}>Pay out</a>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" style={{ fontWeight: 600 }}>Investors, active</th>
            <td><Money cents={figures.investorBasisCents} currency={currency} /></td>
            <td />
            <td />
            <td><Money cents={figures.investorValueCents} currency={currency} /></td>
            <td><DeltaMoney cents={investorProfit} currency={currency} /></td>
            <td />
            <td><FeeMoney cents={figures.feeIfAllExitCents} currency={currency} /></td>
            {showActions ? <td /> : null}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
```

- [ ] **Step 7: Create `lib/compound/ui/receipt.tsx`**

The component the whole product turns on. See Task 13 for the payout receipt's exact wording; this is the frame it renders in.

```tsx
/**
 * A receipt: label on the left, figure on the right, one line per fact, and a
 * total that is visually distinct from every line above it.
 *
 * Every line carries a sub-label slot. The payout receipt uses it to say what
 * an accounting term means in plain words — "What Ada has put in" with "her
 * high-water mark: profit is measured against this" underneath — because the
 * person who reads this back in a dispute is not an accountant.
 */
import type { ReactNode } from "react";

export function Receipt({ children, label }: { children: ReactNode; label: string }) {
  return (
    <dl className="receipt" aria-label={label}>
      {children}
    </dl>
  );
}

export function ReceiptLine({
  label, hint, children, tone,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  /** `fee` paints the line amber. Reserved for the fee. */
  tone?: "fee";
}) {
  const id = `rl-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  return (
    <div className={tone === "fee" ? "receipt-line is-fee" : "receipt-line"}>
      <dt className="l" id={id}>
        {label}
        {hint ? <small>{hint}</small> : null}
      </dt>
      <dd className="r" aria-labelledby={id} style={{ margin: 0 }}>{children}</dd>
    </div>
  );
}

export function ReceiptTotal({
  label, hint, children,
}: { label: string; hint?: ReactNode; children: ReactNode }) {
  const id = `rt-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  return (
    <div className="receipt-line receipt-total">
      <dt className="l" id={id}>
        {label}
        {hint ? <small>{hint}</small> : null}
      </dt>
      <dd className="r" aria-labelledby={id} style={{ margin: 0 }}>{children}</dd>
    </div>
  );
}
```

- [ ] **Step 8: Create `lib/compound/ui/sheet.tsx`**

```tsx
/**
 * The frame every money flow renders in. A route, not an overlay (decision
 * D-B): no parallel routes, no interception, no client state. A half-finished
 * flow is a URL that can be reopened, and the back button does what it looks
 * like it does.
 */
import type { ReactNode } from "react";

export function Sheet({
  title, lede, children, backHref, backLabel = "Cancel",
}: {
  title: string;
  lede?: ReactNode;
  children: ReactNode;
  backHref: string;
  backLabel?: string;
}) {
  return (
    <div className="sheet-scrim">
      <div className="sheet">
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
        {children}
        <p style={{ marginTop: 22, marginBottom: 0 }}>
          <a href={backHref}>{backLabel}</a>
        </p>
      </div>
    </div>
  );
}

export function SheetActions({ children }: { children: ReactNode }) {
  return <div className="actions">{children}</div>;
}

export function Field({
  name, label, hint, children,
}: { name: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field" htmlFor={name}>
      <span>{label}</span>
      {children}
      {hint ? <small className="muted" style={{ display: "block", marginTop: 4 }}>{hint}</small> : null}
    </label>
  );
}

export function FieldError({ children }: { children: ReactNode }) {
  return (
    <div className="field-error" role="alert">
      <strong>Nothing was committed.</strong> {children}
    </div>
  );
}
```

- [ ] **Step 9: Write `lib/compound/ui/purity.test.ts`**

```typescript
/**
 * ui/ renders. It does not read.
 *
 * If a component can reach the database, then testing what it renders means
 * standing up a database, which means the arithmetic tests get slow and then
 * get skipped. Every component in here takes engine types as props and the
 * route decides where they came from.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIR = __dirname;
const FORBIDDEN: [RegExp, string][] = [
  [/from\s+["']@\/lib\/compound\/db/, "the db layer"],
  [/from\s+["']@\/lib\/compound\/load/, "the loaders"],
  [/from\s+["']pg["']/, "pg"],
  [/from\s+["']next\/headers["']/, "next/headers"],
  [/from\s+["']@supabase/, "supabase"],
  [/\bnew Date\b/, "new Date"],
  [/\bDate\.now\b/, "Date.now"],
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...sources(full)); continue; }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

describe("ui/ purity", () => {
  it("has sources to check", () => {
    expect(sources(DIR).length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN)("imports nothing matching %s (%s)", (pattern, label) => {
    const offenders = sources(DIR).filter((f) => pattern.test(readFileSync(f, "utf8")));
    expect({ label, offenders }).toEqual({ label, offenders: [] });
  });

  it("declares no client component that takes a bigint prop", () => {
    // A bigint does not survive the server/client boundary and a formatted
    // string is not a value. If a component ever needs "use client", its
    // money props must be decimal strings.
    const offenders = sources(DIR)
      .map((f) => [f, readFileSync(f, "utf8")] as const)
      .filter(([, src]) => /^["']use client["']/m.test(src))
      .filter(([, src]) => /:\s*(Cents|Units|bigint)\b/.test(src))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 10: Write `lib/compound/ui/holder-table.test.tsx`**

This is the shape every component test in this plan follows: a known `PoolState` in, figures out, located the way a reader locates them.

```tsx
import { render, screen, within } from "@testing-library/react";
import { fold } from "@/lib/compound/engine/replay";
import { deskFigures } from "@/lib/compound/present/derive";
import { ADA_ID, GRACE_ID, HOLDER_NAMES, LEDGER, SEEDS } from "@/lib/compound/present/fixture";
import { HolderTable } from "./holder-table";

const FIGURES = deskFigures(fold(LEDGER, SEEDS), HOLDER_NAMES);

function cells(holderName: string): string[] {
  const row = screen.getByRole("row", { name: new RegExp(holderName) });
  return [
    ...within(row).getAllByRole("rowheader"),
    ...within(row).getAllByRole("cell"),
  ].map((c) => c.textContent ?? "");
}

beforeEach(() => {
  render(<HolderTable accountId={7} figures={FIGURES} currency="USD" />);
});

describe("HolderTable — the figures", () => {
  it("renders Ada's row exactly", () => {
    expect(cells("Ada Lovelace")).toEqual([
      "Ada Lovelace",
      "$10,000.00",
      "9,113.7132",
      "22.66%",
      "$12,630.61",
      "+$2,630.61",
      "60 / 40",
      "$1,052.24",
      "Pay out",
    ]);
  });

  it("renders Grace's row with her own 63 / 37 split and the fee it produces", () => {
    // Grace is 3700 bps. At the 4000 default her fee would read $386.41.
    const c = cells("Grace Hopper");
    expect(c[6]).toBe("63 / 37");
    expect(c[7]).toBe("$357.43");
  });

  it("shows the manager no split and no fee", () => {
    const c = cells("J. Marsh");
    expect(c[6]).toBe("—");
    expect(c[7]).toBe("—");
  });

  it("totals investors, excluding the manager", () => {
    const foot = screen.getByRole("row", { name: /Investors, active/ });
    const c = [
      ...within(foot).getAllByRole("rowheader"),
      ...within(foot).getAllByRole("cell"),
    ].map((x) => x.textContent ?? "");
    expect(c[1]).toBe("$17,500.00");   // capital in
    expect(c[4]).toBe("$21,096.65");   // value now
    expect(c[5]).toBe("+$3,596.65");   // P/L
    expect(c[7]).toBe("$1,409.67");    // fee if all paid out
  });

  it("sums the value column to account equity, to the cent", () => {
    const values = ["J. Marsh", "Ada Lovelace", "Grace Hopper"]
      .map((n) => cells(n)[4]!)
      .map((s) => BigInt(s.replace(/[^0-9]/g, "")));
    expect(values.reduce((a, b) => a + b, 0n)).toBe(5_574_391n);
  });

  it("sums the share column to 100.00 percent", () => {
    const shares = ["J. Marsh", "Ada Lovelace", "Grace Hopper"]
      .map((n) => Number(cells(n)[3]!.replace("%", "")));
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 2);
  });

  it("marks the manager's row and only the manager's row", () => {
    expect(within(screen.getByRole("row", { name: /J. Marsh/ })).getByText("Manager"))
      .toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Ada Lovelace/ })).queryByText("Manager"))
      .toBeNull();
  });

  it("links each holder to their statement and offers a payout", () => {
    const row = screen.getByRole("row", { name: /Ada Lovelace/ });
    expect(within(row).getByRole("link", { name: "Ada Lovelace" }))
      .toHaveAttribute("href", `/a/7/holders/${ADA_ID}`);
    expect(within(row).getByRole("link", { name: "Pay out" }))
      .toHaveAttribute("href", `/a/7/actions/payout/${ADA_ID}`);
  });

  it("gives every column a header, so a figure is never orphaned", () => {
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Holder", "Capital in", "Units", "Share", "Value now",
      "P/L", "Split", "Fee if paid out", " ",
    ]);
  });
});

describe("HolderTable — a pool under water", () => {
  it("shows every P/L negative and every fee as a dash", () => {
    const under = deskFigures(
      fold([...LEDGER, {
        id: 7, seq: 7, holderId: null, occurredOn: "2026-08-18",
        type: "equity_reading" as const, amountCents: 3_811_044n,
        feeSettlement: null, splitBpsApplied: null, reversesId: null,
      }], SEEDS),
      HOLDER_NAMES,
    );
    render(<HolderTable accountId={7} figures={under} currency="USD" />);
    const rows = screen.getAllByRole("row", { name: /Hopper/ });
    const c = [
      ...within(rows[rows.length - 1]!).getAllByRole("rowheader"),
      ...within(rows[rows.length - 1]!).getAllByRole("cell"),
    ].map((x) => x.textContent ?? "");
    expect(c[5]).toBe("-$1,712.02");
    expect(c[7]).toBe("—");
  });
});

describe("HolderTable — currency", () => {
  it("uses the account's symbol, not a hard-coded dollar", () => {
    render(<HolderTable accountId={7} figures={FIGURES} currency="EUR" />);
    expect(screen.getAllByRole("row", { name: /Ada Lovelace/ }).at(-1)!.textContent)
      .toContain("€12,630.61");
  });
});
```

**How these bite.** This is the block the brief calls the point of the exercise, so each assertion's failure mode is named:

| Change | What goes red |
|---|---|
| swap `valueCents` for a floored value | Ada's row reads `$12,630.60`; the equity-sum test reads `5,574,389n` |
| hard-code the split at 4000 | Grace's split and fee cells |
| charge the manager a fee | the manager's `—` becomes a figure |
| include the manager in the investor totals | all four footer figures |
| use floored shares instead of allocated | the share column sums to 99.99 |
| drop `scope="row"` from the holder name | every `getByRole("row", { name: … })` stops finding its row — the accessibility regression and the test failure are the same event |
| render `Money` where `DeltaMoney` belongs | the `+` disappears from the P/L cells and three tests fail |
| hard-code `$` | the EUR test |

- [ ] **Step 11: Write `lib/compound/ui/statement.test.tsx` and `rail.test.tsx`**

```tsx
// lib/compound/ui/statement.test.tsx
import { render, screen } from "@testing-library/react";
import { fold, totalsOf } from "@/lib/compound/engine/replay";
import { deskFigures } from "@/lib/compound/present/derive";
import { HOLDER_NAMES, LEDGER, LIVE, SEEDS } from "@/lib/compound/present/fixture";
import { Money, FeeMoney, DeltaMoney } from "./primitives";
import { KpiStrip, StatementHead } from "./statement";

const STATE = fold(LEDGER, SEEDS);
const FIGURES = deskFigures(STATE, HOLDER_NAMES);

describe("StatementHead", () => {
  beforeEach(() => {
    render(
      <StatementHead
        totals={totalsOf(STATE)}
        currency="USD"
        asOf={STATE.lastReadingOn}
        entryCount={LEDGER.length}
        holderCount={FIGURES.holderCount}
        live={LIVE}
      />,
    );
  });

  it("shows the committed equity as the headline figure", () => {
    expect(screen.getByLabelText("Account equity").textContent).toBe("$55,743.91");
  });

  it("shows NAV per unit at four places", () => {
    expect(screen.getByLabelText("NAV / unit").textContent).toBe("1.3858");
  });

  it("shows growth since inception, signed", () => {
    expect(screen.getByLabelText("Since inception").textContent).toBe("+38.58%");
  });

  it("shows units issued and the holder count", () => {
    expect(screen.getByLabelText("Units issued").textContent).toBe("40,222.4547");
    expect(screen.getByLabelText("Holders").textContent).toBe("3");
  });

  it("says how many ledger entries the figure came from and as of when", () => {
    expect(screen.getByText(/derived from 6 ledger entries · as of 14 Aug 2026/))
      .toBeInTheDocument();
  });

  it("labels the live figure as not posted, and keeps it apart from equity", () => {
    // 55,930.00 is the live equity. It must never appear as the headline.
    expect(screen.getByLabelText("Account equity").textContent).not.toContain("55,930");
    expect(screen.getByLabelText("Live equity").textContent).toBe("$55,930.00");
    expect(screen.getByText(/Live · not yet posted/)).toBeInTheDocument();
    expect(screen.getByText(/18 Aug 2026, 09:14 UTC/)).toBeInTheDocument();
  });

  it("shows floating P/L with a sign", () => {
    expect(screen.getByLabelText("Floating P/L").textContent).toBe("+$125.00");
  });
});

describe("StatementHead — before any reading is posted", () => {
  it("says so rather than printing a date", () => {
    const empty = fold([], SEEDS);
    render(
      <StatementHead
        totals={totalsOf(empty)} currency="USD" asOf={null}
        entryCount={0} holderCount={0} live={null}
      />,
    );
    expect(screen.getByText(/derived from 0 ledger entries · no reading posted yet/))
      .toBeInTheDocument();
    expect(screen.getByLabelText("NAV / unit").textContent).toBe("1.0000");
  });
});

describe("KpiStrip", () => {
  it("labels each figure so it can be read without its neighbours", () => {
    render(
      <KpiStrip
        items={[
          { key: "in", label: "Investor capital in", value: <Money cents={FIGURES.investorBasisCents} /> },
          { key: "val", label: "Investor value now", value: <Money cents={FIGURES.investorValueCents} /> },
          { key: "pl", label: "Investor P/L", value: <DeltaMoney cents={FIGURES.investorProfitCents} /> },
          { key: "fee", label: "Fee if everyone paid out today", tone: "fee",
            value: <FeeMoney cents={FIGURES.feeIfAllExitCents} /> },
        ]}
      />,
    );
    expect(screen.getByLabelText("Investor capital in").textContent).toBe("$17,500.00");
    expect(screen.getByLabelText("Investor value now").textContent).toBe("$21,096.65");
    expect(screen.getByLabelText("Investor P/L").textContent).toBe("+$3,596.65");
    expect(screen.getByLabelText("Fee if everyone paid out today").textContent).toBe("$1,409.67");
  });

  it("paints only the fee tile amber", () => {
    const { container } = render(
      <KpiStrip items={[
        { key: "a", label: "Investor capital in", value: <Money cents={1n} /> },
        { key: "b", label: "Fee if everyone paid out today", tone: "fee", value: <FeeMoney cents={1n} /> },
      ]} />,
    );
    expect(container.querySelectorAll(".kpi-item.is-fee")).toHaveLength(1);
  });
});
```

```tsx
// lib/compound/ui/rail.test.tsx
import { render, screen } from "@testing-library/react";
import { fold } from "@/lib/compound/engine/replay";
import { railSegments } from "@/lib/compound/present/rail";
import { HOLDER_NAMES, LEDGER, SEEDS } from "@/lib/compound/present/fixture";
import { OwnershipRail } from "./rail";

const SEGMENTS = railSegments(fold(LEDGER, SEEDS), HOLDER_NAMES);

describe("OwnershipRail", () => {
  it("fills the rail exactly — the widths sum to 100 percent", () => {
    const { container } = render(<OwnershipRail segments={SEGMENTS} />);
    const widths = [...container.querySelectorAll<HTMLElement>(".seg")]
      .map((s) => Number(s.style.width.replace("%", "")));
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 4);
  });

  it("gives the manager the darkest segment", () => {
    const { container } = render(<OwnershipRail segments={SEGMENTS} />);
    const first = container.querySelector<HTMLElement>(".seg")!;
    expect(first.style.background).toBe("rgb(20, 83, 45)");   // #14532d
  });

  it("labels every segment with a name and a percentage", () => {
    render(<OwnershipRail segments={SEGMENTS} />);
    const items = screen.getByRole("list", { name: "Ownership legend" });
    expect(items.textContent).toContain("J. Marsh (manager)");
    expect(items.textContent).toContain("62.15%");
    expect(items.textContent).toContain("Ada Lovelace");
    expect(items.textContent).toContain("22.66%");
    expect(items.textContent).toContain("Grace Hopper");
    expect(items.textContent).toContain("15.19%");
  });

  it("names the rail for a screen reader rather than leaving a bare div", () => {
    render(<OwnershipRail segments={SEGMENTS} />);
    expect(screen.getByRole("img", { name: "Ownership by holder" })).toBeInTheDocument();
  });

  it("renders nothing at all when no one holds units", () => {
    const { container } = render(<OwnershipRail segments={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 12: Write `lib/compound/ui/routes.test.ts`**

```typescript
import { SUBNAV, activeNavKey, deskHref, holderHref, payoutHref } from "./routes";

describe("SUBNAV", () => {
  it("carries the six agreed entries in the agreed order", () => {
    expect(SUBNAV.map((n) => n.key))
      .toEqual(["desk", "journal", "calendar", "performance", "ledger", "review"]);
  });

  it("has no Holders entry — the desk table is the index", () => {
    expect(SUBNAV.some((n) => n.key === "holders")).toBe(false);
  });

  it("badges Review and nothing else", () => {
    expect(SUBNAV.filter((n) => n.badge).map((n) => n.key)).toEqual(["review"]);
  });

  it("builds every href from the account id", () => {
    expect(SUBNAV.map((n) => n.href(7))).toEqual([
      "/a/7", "/a/7/journal", "/a/7/calendar", "/a/7/performance", "/a/7/ledger", "/a/7/review",
    ]);
  });
});

describe("activeNavKey", () => {
  it.each([
    ["/a/7", "desk"],
    ["/a/7/", "desk"],
    ["/a/7/ledger", "ledger"],
    ["/a/7/review", "review"],
    ["/a/7/review/12", "review"],
    ["/a/7/journal", "journal"],
    ["/a/7/holders/2", "desk"],
    ["/a/7/actions/payout/2", "desk"],
  ])("maps %s to %s", (path, key) => {
    expect(activeNavKey(path, 7)).toBe(key);
  });

  it("does not match another account's path", () => {
    expect(activeNavKey("/a/8/ledger", 7)).toBe("");
  });

  it("does not match a prefix collision", () => {
    // /a/71 starts with /a/7. A naive startsWith on the id alone gets this
    // wrong and highlights the wrong tab on every page of account 71.
    expect(activeNavKey("/a/71/ledger", 7)).toBe("");
  });

  it("returns empty for an unknown segment rather than guessing", () => {
    expect(activeNavKey("/a/7/settings", 7)).toBe("");
  });
});

describe("href builders", () => {
  it("builds the routes the sheets and tables link to", () => {
    expect(deskHref(7)).toBe("/a/7");
    expect(holderHref(7, 2)).toBe("/a/7/holders/2");
    expect(payoutHref(7, 2)).toBe("/a/7/actions/payout/2");
  });
});
```

> **The prefix-collision test fails against the implementation in Step 1.** `"/a/71/ledger".startsWith("/a/7")` is `true`, so `activeNavKey` returns `"ledger"` for account 7. Fix it before moving on: compare the segment, not the prefix.
>
> ```typescript
> export function activeNavKey(pathname: string, accountId: number): string {
>   const parts = pathname.split("/").filter((p) => p !== "");
>   if (parts[0] !== "a" || parts[1] !== String(accountId)) return "";
>   const first = parts[2] ?? "";
>   if (first === "") return "desk";
>   if (first === "holders" || first === "actions") return "desk";
>   return SUBNAV.some((n) => n.key === first) ? first : "";
> }
> ```

- [ ] **Step 13: Run the gates and prove three probes**

```bash
pnpm typecheck && pnpm test
```

Then, one at a time, reverting each:

1. In `deskFigures`, change `valueCents: values[i]!` to the floored value from `quote`. Expect Ada's row assertion and the equity-sum assertion in `holder-table.test.tsx` to fail, and nothing else.
2. In `HolderTable`, change `<th scope="row">` to `<td>`. Expect every `getByRole("row", { name: … })` lookup to fail. This is the test suite noticing an accessibility regression, which is the only kind of a11y check worth having.
3. In `StatementHead`, render `live.equityCents` as the headline. Expect the "must never appear as the headline" assertion to fail. That assertion exists because showing a live figure where a committed one belongs is spec §5.2's exact failure.

---

### Task 5: The gate, the loaders, and the broker offset

Everything between a URL and a `PoolState`. Three concerns, one task, because none of them is testable without the others: the session gate decides who is asking, the account resolver decides what they may see, and the loaders fetch it once per request.

**The gate matters more than it looks.** Plan 3's decision P4 makes every pooled connection run as `service_role`, which carries `BYPASSRLS`. The RLS policies plan 3 wrote are real and are defence in depth for any other client, but **they are not what protects these pages**. Shipping routes that lean on a policy the connection bypasses would be the twelfth unfalsifiable safety net in this project. Spec §9's AND gate is therefore implemented here, in application code, and tested here.

**Files:**
- Create: `supabase/migrations/<generated>_compound_account_broker_offset.sql`
- Modify: `lib/compound/db/compound.ts`
- Create: `lib/compound/db/holders.ts`
- Create: `lib/compound/db/users.ts`
- Create: `lib/compound/load/supabase.ts`
- Create: `lib/compound/load/session.ts`
- Create: `lib/compound/load/account.ts`
- Create: `lib/compound/load/ledger.ts`
- Create: `lib/compound/load/interlock.ts`
- Create: `middleware.ts`
- Create: `app/sign-in/page.tsx`
- Modify: `.env.example`
- Test: `lib/compound/db/holders.db.test.ts`
- Test: `lib/compound/load/gate.db.test.ts`

**Interfaces:**
- Consumes: `getAccountById`, `listAccountsForManager`, `getHolderSeeds`, `getLedgerEntries`, `getReconcileCursor`, `listCandidates` from `@/lib/compound/db/compound`; `getLiveSnapshot` from `@/lib/compound/db/copytraderx`; `withDb` from `@/lib/compound/db/client`; `fold` from `@/lib/compound/engine/replay`
- Produces:
  - `interface SessionUser { id: string; email: string | null }`
  - `requireManager(): Promise<SessionUser>`
  - `interface ResolvedAccount { id; mt5Account; label; broker; currency; defaultSplitBps; inceptionDate; managerUserId; brokerOffsetHours }`
  - `requireAccount(idParam: string): Promise<ResolvedAccount>`
  - `listManagerAccounts(): Promise<ResolvedAccount[]>`
  - `interface HolderRow { id; accountId; name; email; userId; isManager; splitBps; joinedAt; status }`
  - `listHolders(c: Queryable, accountId: number): Promise<HolderRow[]>`
  - `loadLedger(accountId: number): Promise<LedgerEntry[]>`
  - `loadSeeds(accountId: number): Promise<HolderSeed[]>`
  - `loadHolderNames(accountId: number): Promise<Record<number, string>>`
  - `loadPoolState(accountId: number): Promise<PoolState>`
  - `loadLive(mt5Account: number): Promise<LiveFigures | null>`
  - `interface InterlockState { frozenAt; pendingCandidateDate; pendingCount }`
  - `loadInterlock(accountId: number): Promise<InterlockState>`

> **Decision D-M, closing plan 3's carried-forward gap.** `compound_holder.status` is stored *and* derived. **No screen reads the stored column** — `fold` decides a holder's status, and `HolderRow.status` exists only so the database is not misleading to someone reading it directly. Task 13's exit writer updates the column inside the same transaction as the exit entry, and its integration test asserts the stored value and `fold`'s value agree. Plan 3 could not write that test because none of its fixtures had a payout; this plan's do.

- [ ] **Step 1: Add the broker offset column**

```bash
supabase migration new compound_account_broker_offset
```

```sql
-- ============================================================================
-- The broker's UTC offset, per account.
-- ============================================================================
--
-- reconcile/dedupe.ts groups duplicate deals on (symbol, side, volume, profit,
-- swap) and keeps the lowest ticket where close times differ by exactly the
-- broker's offset. The offset is a property of the broker's server, so it
-- belongs on the account and not in configuration.
--
-- NULLABLE, and with NO DEFAULT, deliberately. A default of 0 would mean "no
-- shift", and dedupe at a zero shift is a no-op — so a brand-new account would
-- silently run with duplicate-deal protection disabled and nobody would know.
-- Null means NOT CONFIGURED, and the application refuses to reconcile until it
-- is set. Reconciling undeduplicated inflates the explained figure and can hide
-- a real capital event, which is the most expensive failure this product has.
--
-- Range is 1..14, MATCHING dedupeDeals' own MIN_OFFSET_HOURS..MAX_OFFSET_HOURS.
-- The column holds the MAGNITUDE of the broker server's UTC offset, because
-- that is all dedupeDeals uses: it looks for pairs whose close times differ by
-- exactly that many hours, in either direction.
--
-- The range deliberately excludes 0. dedupeDeals throws a RangeError on 0, so a
-- column that permitted it would store a value the engine refuses, and the
-- failure would surface as a crash inside a reconcile run rather than as a
-- refused edit. A broker genuinely running on UTC is therefore not supported;
-- see the note below the migration for what that would take.
-- ============================================================================

alter table public.compound_account
  add column broker_offset_hours int;

alter table public.compound_account
  add constraint compound_account_broker_offset_hours_range
  check (broker_offset_hours is null or broker_offset_hours between 1 and 14);

comment on column public.compound_account.broker_offset_hours is
  'Magnitude of the broker server UTC offset, in hours, 1..14. NULL means not '
  'configured, and disables reconciliation rather than running the duplicate-deal '
  'guard as a no-op. Matches dedupeDeals MIN_OFFSET_HOURS..MAX_OFFSET_HOURS.';
```

> **A limitation, stated rather than discovered later.** `dedupe.ts` sets `MIN_OFFSET_HOURS = 1`, so an account whose broker runs on UTC exactly cannot be reconciled: there is no legal value to store. That is correct as far as it goes — at a zero offset the duplicate class this guard exists for cannot arise, so dedupe would be a no-op — but the product's answer is currently "you cannot configure this account" rather than "no dedupe is needed here". Fixing it means widening `MIN_OFFSET_HOURS` to `0` in the reconciler and letting `dedupeDeals` return everything untouched, which is a reconciler change and does not belong in this plan. **Carried forward, not fixed here.** No broker in use has a zero offset.

- [ ] **Step 2: Carry the column through plan 3's account reader**

Edit `lib/compound/db/compound.ts`. Four edits, all mechanical:

```typescript
// 1. the interface
export interface CompoundAccount {
  id: number;
  mt5Account: number;
  label: string;
  broker: string | null;
  currency: string;
  defaultSplitBps: number;
  /** YYYY-MM-DD. */
  inceptionDate: string;
  /** public.users id. */
  managerUserId: string;
  /** Broker server UTC offset. Null means not configured; see the migration. */
  brokerOffsetHours: number | null;
}

// 2. the column list
const ACCOUNT_COLUMNS = `
  id,
  mt5_account,
  label,
  broker,
  currency,
  default_split_bps,
  ${dateKeyExpr("inception_date")} as inception_date,
  manager_user_id,
  broker_offset_hours
`;

// 3. the row type
interface AccountRow {
  id: string;
  mt5_account: string;
  label: string;
  broker: string | null;
  currency: string;
  default_split_bps: number;
  inception_date: string;
  manager_user_id: string;
  broker_offset_hours: number | null;
}

// 4. the mapper gains one line
//    brokerOffsetHours: r.broker_offset_hours,
```

- [ ] **Step 3: Create `lib/compound/db/holders.ts`**

Plan 3 reads holder *seeds* — the three fields `fold` needs. Screens need names and terms too.

```typescript
/**
 * Holder identity and terms.
 *
 * getHolderSeeds (plan 3) returns what fold needs and nothing else, on purpose:
 * it must not be able to disagree with the engine. This reader returns what a
 * SCREEN needs — names, contact, joined date, the stored status.
 *
 * The stored status is returned and never used to decide anything. fold derives
 * a holder's status from the ledger, and a stored column that can drift from a
 * derived one is exactly the second truth D7 exists to avoid. See decision D-M.
 */
import type { Queryable } from "./types";
import { dateKeyExpr, toId } from "./sql";

export interface HolderRow {
  id: number;
  accountId: number;
  name: string;
  email: string | null;
  /** public.users id, set when portal access lands in v2. */
  userId: string | null;
  isManager: boolean;
  splitBps: number;
  /** YYYY-MM-DD, or null. */
  joinedAt: string | null;
  /** STORED. Never read to decide anything — fold decides. See decision D-M. */
  status: "active" | "closed";
}

interface Row {
  id: string;
  account_id: string;
  name: string;
  email: string | null;
  user_id: string | null;
  is_manager: boolean;
  split_bps: number;
  joined_at: string | null;
  status: string;
}

export async function listHolders(c: Queryable, accountId: number): Promise<HolderRow[]> {
  const { rows } = await c.query<Row>(
    `select id, account_id, name, email, user_id, is_manager, split_bps,
            ${dateKeyExpr("joined_at")} as joined_at, status
       from public.compound_holder
      where account_id = $1
      order by is_manager desc, id asc`,
    [accountId],
  );
  return rows.map((r) => {
    if (r.status !== "active" && r.status !== "closed") {
      throw new Error(`compound_holder.status is ${JSON.stringify(r.status)} for holder ${r.id}`);
    }
    return {
      id: toId(r.id, "compound_holder.id"),
      accountId: toId(r.account_id, "compound_holder.account_id"),
      name: r.name,
      email: r.email,
      userId: r.user_id,
      isManager: r.is_manager,
      splitBps: r.split_bps,
      joinedAt: r.joined_at,
      status: r.status,
    };
  });
}
```

- [ ] **Step 4: Create `lib/compound/db/users.ts`**

```typescript
/**
 * The application-level role, read once per request as a cross-check on the
 * JWT claim.
 *
 * Spec section 9's policies read the claim, so the claim is authoritative. This
 * reader exists to catch the one misconfiguration that is otherwise silent: a
 * user whose JWT says admin and whose public.users row does not, or the
 * reverse. Under D1 there is one admin and the two can only disagree by
 * accident — which is exactly when you want to hear about it.
 */
import type { Queryable } from "./types";

export async function getUserRole(c: Queryable, userId: string): Promise<string | null> {
  const { rows } = await c.query<{ role: string }>(
    `select role from public.users where id = $1`,
    [userId],
  );
  return rows[0]?.role ?? null;
}
```

- [ ] **Step 5: Create `lib/compound/load/supabase.ts` and `middleware.ts`**

```bash
pnpm add @supabase/ssr@^0.5.2 @supabase/supabase-js@^2.47.0
```

```typescript
// lib/compound/load/supabase.ts
/**
 * The Supabase Auth client. Auth only — Compound reads and writes its data
 * over pg (plan 3, decision P2), because PostgREST serialises bigint as a JSON
 * number and every cent figure would become a float.
 */
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function authClient() {
  const store = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set. See .env.example.",
    );
  }
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        // A Server Component cannot set a cookie. middleware.ts refreshes the
        // session, so this is a no-op on the read path rather than a crash.
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          /* called from a Server Component render; middleware handles refresh */
        }
      },
    },
  });
}
```

```typescript
// middleware.ts
/**
 * Refreshes the Supabase session cookie on every request, because a Server
 * Component cannot write one. Without this, a session expires mid-visit and
 * the desk bounces to sign-in with no explanation.
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });

  // getUser, not getSession: getSession trusts the cookie, getUser validates
  // the token with the Auth server. A forged cookie must not reach a page.
  await supabase.auth.getUser();
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
```

- [ ] **Step 6: Create `lib/compound/load/session.ts` — spec §9's AND gate**

```typescript
/**
 * Who is asking, and may they use this product at all.
 *
 * Spec section 9: "The admin claim is an AND gate, not an OR bypass." Every
 * compound_* policy requires the admin claim AND a manager_user_id match. This
 * module is the first half. requireAccount is the second.
 *
 * WHY THIS IS IN APPLICATION CODE. Plan 3's decision P4 runs every pooled
 * connection as service_role, which has BYPASSRLS. The policies plan 3 wrote
 * are real and protect any other client of the database, and they do NOT run
 * for these pages. A gate that relies on them would pass every test whether it
 * was right or not, which is the defect class this project has now hit eleven
 * times.
 *
 * getUser, not getSession: getSession decodes the cookie and believes it;
 * getUser validates the token against the Auth server.
 */
import { cache } from "react";
import { redirect } from "next/navigation";
import { withDb } from "@/lib/compound/db/client";
import { getUserRole } from "@/lib/compound/db/users";
import { authClient } from "./supabase";

export interface SessionUser {
  id: string;
  email: string | null;
}

export const requireManager = cache(async (): Promise<SessionUser> => {
  const supabase = await authClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) redirect("/sign-in");

  const claim = (data.user.app_metadata as { role?: unknown } | null)?.role;
  const claimed = typeof claim === "string" ? claim : null;
  const stored = await withDb((c) => getUserRole(c, data.user!.id));

  // The claim is authoritative because the policies read it. The stored role
  // is read to catch the one misconfiguration that is otherwise silent.
  if (claimed !== null && stored !== null && claimed !== stored) {
    throw new Error(
      `Role mismatch for ${data.user.id}: JWT app_metadata.role is ${claimed}, ` +
        `public.users.role is ${stored}. Compound will not run against a directory ` +
        `whose two role sources disagree.`,
    );
  }
  if ((claimed ?? stored) !== "admin") redirect("/sign-in?denied=1");

  return { id: data.user.id, email: data.user.email ?? null };
});
```

- [ ] **Step 7: Create `lib/compound/load/account.ts` — the second half of the gate**

```typescript
/**
 * Resolving a route parameter to an account the signed-in manager owns.
 *
 * notFound() rather than a 403 for an account someone does not own: a 403
 * confirms the account exists, and under D5 there will be more than one
 * manager's account in this database eventually.
 *
 * Wrapped in cache() so the layout and the page inside it resolve the same
 * account with one query. Plan 5's three surfaces call this too.
 */
import { cache } from "react";
import { notFound } from "next/navigation";
import { withDb } from "@/lib/compound/db/client";
import { getAccountById, listAccountsForManager } from "@/lib/compound/db/compound";
import { requireManager } from "./session";

export interface ResolvedAccount {
  id: number;
  mt5Account: number;
  label: string;
  broker: string | null;
  currency: string;
  defaultSplitBps: number;
  inceptionDate: string;
  managerUserId: string;
  /** Null means not configured. Reconciliation refuses while it is null. */
  brokerOffsetHours: number | null;
}

export const listManagerAccounts = cache(async (): Promise<ResolvedAccount[]> => {
  const user = await requireManager();
  return withDb((c) => listAccountsForManager(c, user.id));
});

export const requireAccount = cache(async (idParam: string): Promise<ResolvedAccount> => {
  const user = await requireManager();

  // Reject anything that is not a plain positive integer before it reaches
  // SQL. "7abc" parses to 7 under parseInt and would resolve someone's account.
  if (!/^[1-9][0-9]{0,17}$/.test(idParam)) notFound();
  const id = Number(idParam);

  const account = await withDb((c) => getAccountById(c, id));
  if (account === null) notFound();
  if (account.managerUserId !== user.id) notFound();
  return account;
});
```

- [ ] **Step 8: Create `lib/compound/load/ledger.ts` and `lib/compound/load/interlock.ts`**

```typescript
// lib/compound/load/ledger.ts
/**
 * Request-scoped reads. Each is cache()d, so the layout, the page and any
 * component that needs the same data pay for one query between them.
 *
 * There is no PoolState context provider, by agreement with plan 5: two of its
 * three surfaces need no ledger at all, and a provider would make them pay for
 * a replay they do not use.
 */
import { cache } from "react";
import { withDb } from "@/lib/compound/db/client";
import { getHolderSeeds, getLedgerEntries } from "@/lib/compound/db/compound";
import { listHolders } from "@/lib/compound/db/holders";
import { getLiveSnapshot } from "@/lib/compound/db/copytraderx";
import { fold, type HolderSeed, type LedgerEntry, type PoolState } from "@/lib/compound/engine/replay";
import type { LiveFigures } from "@/lib/compound/ui/statement";

export const loadLedger = cache(
  async (accountId: number): Promise<LedgerEntry[]> =>
    withDb((c) => getLedgerEntries(c, accountId)),
);

export const loadSeeds = cache(
  async (accountId: number): Promise<HolderSeed[]> =>
    withDb((c) => getHolderSeeds(c, accountId)),
);

export const loadHolderNames = cache(async (accountId: number): Promise<Record<number, string>> => {
  const holders = await withDb((c) => listHolders(c, accountId));
  return Object.fromEntries(holders.map((h) => [h.id, h.name]));
});

export const loadPoolState = cache(async (accountId: number): Promise<PoolState> => {
  const [entries, seeds] = await Promise.all([loadLedger(accountId), loadSeeds(accountId)]);
  return fold(entries, seeds);
});

export const loadLive = cache(async (mt5Account: number): Promise<LiveFigures | null> => {
  const snap = await withDb((c) => getLiveSnapshot(c, mt5Account));
  return snap === null
    ? null
    : {
        equityCents: snap.equityCents,
        floatingPnlCents: snap.floatingPnlCents,
        pushedAt: snap.pushedAt,
      };
});
```

```typescript
// lib/compound/load/interlock.ts
/**
 * One loader for one question: has the reconciler stopped, and where?
 *
 * The sub-nav badge, the frozen-figures banner and plan 5's /performance
 * notice all need this. Two loaders would be two answers.
 */
import { cache } from "react";
import { withDb } from "@/lib/compound/db/client";
import { getReconcileCursor, listCandidates } from "@/lib/compound/db/compound";

export interface InterlockState {
  /** compound_reconcile_cursor.last_reading_date. Null before the first run. */
  frozenAt: string | null;
  /** The earliest pending candidate's trade date, or null when nothing is pending. */
  pendingCandidateDate: string | null;
  pendingCount: number;
}

export const loadInterlock = cache(async (accountId: number): Promise<InterlockState> => {
  const [cursor, pending] = await withDb(async (c) => [
    await getReconcileCursor(c, accountId),
    await listCandidates(c, accountId, "pending"),
  ] as const);

  const earliest = [...pending].sort((a, b) =>
    a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0,
  )[0];

  return {
    frozenAt: cursor.lastReadingDate,
    pendingCandidateDate: earliest?.tradeDate ?? null,
    pendingCount: pending.length,
  };
});
```

- [ ] **Step 9: Create the sign-in page**

```tsx
// app/sign-in/page.tsx
/**
 * Email and password against Supabase Auth. No sign-up, no reset, no magic
 * link: single-tenant, one operator (D1), and the directory is CopyTraderX's,
 * which already has its own account management.
 */
import { redirect } from "next/navigation";
import { authClient } from "@/lib/compound/load/supabase";
import { Field, FieldError, Sheet, SheetActions } from "@/lib/compound/ui/sheet";

export const dynamic = "force-dynamic";

async function signIn(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const supabase = await authClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect(`/sign-in?error=${encodeURIComponent(error.message)}`);
  redirect("/");
}

export default async function SignInPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; denied?: string }> }) {
  const { error, denied } = await searchParams;
  return (
    <Sheet
      title="Compound"
      lede="Fund administration for pooled MetaTrader accounts."
      backHref="/sign-in"
      backLabel=""
    >
      {denied ? (
        <FieldError>
          That account is signed in but is not an administrator. Compound adds no
          roles of its own; access is the existing admin claim.
        </FieldError>
      ) : null}
      {error ? <FieldError>{error}</FieldError> : null}
      <form action={signIn}>
        <Field name="email" label="Email">
          <input id="email" name="email" type="email" autoComplete="username" required />
        </Field>
        <Field name="password" label="Password">
          <input
            id="password" name="password" type="password"
            autoComplete="current-password" required
          />
        </Field>
        <SheetActions>
          <button className="btn btn-primary" type="submit">Sign in</button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
```

- [ ] **Step 10: Extend `.env.example`**

```bash
# Supabase — fill locally, never commit real values. The repository is public.
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=

# Compound connects to Postgres directly; see plan 3, decision P2.
COMPOUND_DATABASE_URL=
COMPOUND_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54622/postgres
```

- [ ] **Step 11: Write `lib/compound/db/holders.db.test.ts`**

```typescript
/**
 * Integration. Runs under jest.db.config.mjs against the local stack.
 * Follows plan 3's harness conventions: two accounts, two managers, unfiltered
 * selects, and every rejection matched on message as well as class.
 */
import { withDbTransaction } from "@/lib/compound/db/client";
import { listHolders } from "@/lib/compound/db/holders";
import { seedTwoAccounts } from "@/lib/compound/db/test-harness";

describe("listHolders", () => {
  it("returns only the requested account's holders", async () => {
    await withDbTransaction(async (c) => {
      const { mine, theirs } = await seedTwoAccounts(c);
      const rows = await listHolders(c, mine.accountId);
      expect(rows.map((r) => r.accountId)).toEqual([mine.accountId, mine.accountId]);
      expect(rows.some((r) => r.accountId === theirs.accountId)).toBe(false);
      throw new Error("rollback");
    }).catch((e) => { if (e.message !== "rollback") throw e; });
  });

  it("puts the manager first", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const rows = await listHolders(c, mine.accountId);
      expect(rows[0]!.isManager).toBe(true);
      expect(rows[0]!.splitBps).toBe(0);
      throw new Error("rollback");
    }).catch((e) => { if (e.message !== "rollback") throw e; });
  });

  it("carries the holder's own split, not the account default", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);   // investor seeded at 3700
      expect(listHolders(c, mine.accountId).then((r) => r[1]!.splitBps)).resolves.toBe(3700);
      throw new Error("rollback");
    }).catch((e) => { if (e.message !== "rollback") throw e; });
  });

  it("refuses a status the type does not allow, rather than casting it", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      // The CHECK constraint stops this at the database, which is the point:
      // the reader's throw is a second line of defence, not the first.
      await expect(
        c.query(`update public.compound_holder set status = 'paused' where account_id = $1`,
          [mine.accountId]),
      ).rejects.toThrow(/compound_holder_status_check|violates check constraint/);
      throw new Error("rollback");
    }).catch((e) => { if (e.message !== "rollback") throw e; });
  });

  it("returns an empty array for an account with no holders, not null", async () => {
    await withDbTransaction(async (c) => {
      expect(await listHolders(c, 2_147_483_646)).toEqual([]);
      throw new Error("rollback");
    }).catch((e) => { if (e.message !== "rollback") throw e; });
  });
});
```

> **`seedTwoAccounts` is plan 3's harness helper (its Task 1).** If plan 3 named it differently, use whatever it produced — do not write a second seeder. If it produced no two-account seeder at all, that is a genuine prerequisite gap: stop and add one to the harness rather than seeding inline here, because every RLS and isolation test in both plans depends on the same one.

- [ ] **Step 12: Write `lib/compound/load/gate.db.test.ts`**

The gate is the one thing in this plan that is worth an integration test of its own, and it is exactly the shape that goes unfalsifiable if written carelessly.

```typescript
/**
 * The AND gate, tested with TWO managers and TWO accounts.
 *
 * A one-manager test passes with the gate deleted: the only account in the
 * database is yours, so "I can see my account" is true either way. Every case
 * below asserts that the OTHER manager's account is not reachable.
 *
 * requireAccount calls requireManager, which reads a Supabase session that does
 * not exist in a Jest process. The gate's ownership half is therefore tested
 * through a seam: resolveOwnedAccount(userId, idParam) carries the logic and
 * requireAccount is the four-line wrapper that supplies userId from the
 * session. If the wrapper is where the bug lands, the smoke test in Task 15
 * catches it — this test covers the half that has branches in it.
 */
import { withDbTransaction } from "@/lib/compound/db/client";
import { getAccountById } from "@/lib/compound/db/compound";
import { seedTwoAccounts } from "@/lib/compound/db/test-harness";
import { resolveOwnedAccount } from "@/lib/compound/load/account";

describe("resolveOwnedAccount", () => {
  it("returns an account its manager owns", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const acct = await resolveOwnedAccount(c, mine.managerUserId, String(mine.accountId));
      expect(acct?.id).toBe(mine.accountId);
      throw new Error("rollback");
    }).catch((e) => { if (e.message !== "rollback") throw e; });
  });

  it("refuses another manager's account, even though it exists", async () => {
    await withDbTransaction(async (c) => {
      const { mine, theirs } = await seedTwoAccounts(c);
      // It really is there — otherwise this test proves nothing.
      expect(await getAccountById(c, theirs.accountId)).not.toBeNull();
      expect(await resolveOwnedAccount(c, mine.managerUserId, String(theirs.accountId)))
        .toBeNull();
      throw new Error("rollback");
    }).catch((e) => { if (e.message !== "rollback") throw e; });
  });

  it("refuses an id that is not a plain positive integer", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      for (const bad of [`${mine.accountId}abc`, "0", "-1", "1.5", " 1", "01", ""]) {
        expect(await resolveOwnedAccount(c, mine.managerUserId, bad)).toBeNull();
      }
      throw new Error("rollback");
    }).catch((e) => { if (e.message !== "rollback") throw e; });
  });

  it("refuses an account that does not exist", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      expect(await resolveOwnedAccount(c, mine.managerUserId, "2147483646")).toBeNull();
      throw new Error("rollback");
    }).catch((e) => { if (e.message !== "rollback") throw e; });
  });

  it("carries the broker offset through, null when it is not configured", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      expect((await resolveOwnedAccount(c, mine.managerUserId, String(mine.accountId)))!
        .brokerOffsetHours).toBeNull();
      await c.query(
        `update public.compound_account set broker_offset_hours = 3 where id = $1`,
        [mine.accountId],
      );
      expect((await resolveOwnedAccount(c, mine.managerUserId, String(mine.accountId)))!
        .brokerOffsetHours).toBe(3);
      throw new Error("rollback");
    }).catch((e) => { if (e.message !== "rollback") throw e; });
  });

  it("refuses every offset dedupeDeals would throw on", async () => {
    // 1..14 here matches MIN_OFFSET_HOURS..MAX_OFFSET_HOURS in dedupe.ts. If
    // the column let 0 or 15 through, the failure would surface as a crash
    // inside a reconcile run instead of as a refused edit.
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      for (const bad of [0, 15, -3]) {
        await expect(
          c.query(`update public.compound_account set broker_offset_hours = $2 where id = $1`,
            [mine.accountId, bad]),
        ).rejects.toThrow(/compound_account_broker_offset_hours_range/);
      }
      throw new Error("rollback");
    }).catch((e) => { if (e.message !== "rollback") throw e; });
  });
});
```

Extract the seam into `lib/compound/load/account.ts`:

```typescript
/** The ownership half of spec section 9's AND gate, as a pure-ish function of
 *  (connection, user, parameter) so it can be tested with two managers. */
export async function resolveOwnedAccount(
  c: Queryable,
  managerUserId: string,
  idParam: string,
): Promise<ResolvedAccount | null> {
  if (!/^[1-9][0-9]{0,17}$/.test(idParam)) return null;
  const account = await getAccountById(c, Number(idParam));
  if (account === null) return null;
  if (account.managerUserId !== managerUserId) return null;
  return account;
}

export const requireAccount = cache(async (idParam: string): Promise<ResolvedAccount> => {
  const user = await requireManager();
  const account = await withDb((c) => resolveOwnedAccount(c, user.id, idParam));
  if (account === null) notFound();
  return account;
});
```

- [ ] **Step 13: Run the gates and prove two probes**

```bash
supabase db reset && pnpm typecheck && pnpm test && pnpm test:db
```

Then, one at a time, reverting each:

1. Delete the `account.managerUserId !== managerUserId` check in `resolveOwnedAccount`. Expect the "refuses another manager's account" test to fail. If it still passes, the fixture has only one account and the test is worthless — fix the fixture, not the assertion.
2. Change the id pattern to `/^\d+$/`. Expect the `"0"` and `"01"` cases to fail. (`"7abc"` still fails, because `Number("7abc")` is `NaN` and no account has that id — which is why the test lists several bad forms rather than one.)

---

### Task 6: `/` — the account list, and creating the first account

The route spec §7 calls "account list, or redirect when there is one", plus the flow that makes an empty database usable.

**Account creation is in scope (decision D-I) and it creates the manager's holder in the same transaction.** `fold` throws `"a fee crystallised but no manager holder was seeded"` if there is none, and plan 3's P8 adds a one-manager-per-account partial unique index. An account without its manager holder is not a partly-built account; it is a broken one.

**Files:**
- Create: `supabase/migrations/<generated>_compound_create_account.sql`
- Create: `lib/compound/db/write-account.ts`
- Create: `lib/compound/ui/account-list.tsx`
- Modify: `app/page.tsx` — replaces the deployment shell
- Create: `app/accounts/new/page.tsx`
- Test: `lib/compound/db/write-account.db.test.ts`
- Test: `lib/compound/ui/account-list.test.tsx`

**Interfaces:**
- Consumes: `listManagerAccounts`, `requireManager` from `@/lib/compound/load/*`; `withDb` from `@/lib/compound/db/client`; `getDailySnapshots`, `getLiveSnapshot`, `getAccountOwnerUserId` from `@/lib/compound/db/copytraderx`
- Produces:
  - `public.compound_create_account(...) returns jsonb`
  - `interface CreateAccountInput { mt5Account; label; broker; currency; defaultSplitBps; inceptionDate; managerUserId; managerName; brokerOffsetHours }`
  - `createAccount(c: Queryable, input: CreateAccountInput): Promise<{ accountId: number; managerHolderId: number }>`
  - `AccountList` component

- [ ] **Step 1: Generate the migration**

```bash
supabase migration new compound_create_account
```

```sql
-- ============================================================================
-- Create an account and its manager holder, together or not at all.
-- ============================================================================
--
-- replay.ts resolves the fee-receiving manager with find(h => h.isManager). An
-- account with no manager holder cannot settle a fee and fold() throws when one
-- crystallises — at render time, on a screen, long after the account was made.
-- Creating the two rows in one function makes that state unreachable.
--
-- The manager's split_bps is 0. quote() forces splitBpsApplied to 0 when
-- isManager because the manager never charges themselves; storing 0 says the
-- same thing in the row rather than leaving a number that is never applied.
--
-- SECURITY INVOKER, matching compound_commit_reading_plan. A definer function
-- owned by postgres would carry the owner's implicit privileges and could
-- UPDATE compound_ledger_entry, undoing the append-only guarantee.
--
-- Custom SQLSTATEs:
--   CX101  that MT5 account already has a Compound account
-- ============================================================================

create or replace function public.compound_create_account(
  p_mt5_account        bigint,
  p_label              text,
  p_broker             text,
  p_currency           text,
  p_default_split_bps  int,
  p_inception_date     date,
  p_manager_user_id    uuid,
  p_manager_name       text,
  p_broker_offset_hours int
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_account_id bigint;
  v_holder_id  bigint;
begin
  if exists (select 1 from public.compound_account a where a.mt5_account = p_mt5_account) then
    raise exception 'compound: MT5 account % already has a Compound account', p_mt5_account
      using errcode = 'CX101';
  end if;

  insert into public.compound_account
    (mt5_account, label, broker, currency, default_split_bps,
     inception_date, manager_user_id, broker_offset_hours)
  values
    (p_mt5_account, p_label, nullif(p_broker, ''), p_currency, p_default_split_bps,
     p_inception_date, p_manager_user_id, p_broker_offset_hours)
  returning id into v_account_id;

  insert into public.compound_holder
    (account_id, name, user_id, is_manager, split_bps, joined_at, status)
  values
    (v_account_id, p_manager_name, p_manager_user_id, true, 0, p_inception_date, 'active')
  returning id into v_holder_id;

  insert into public.compound_audit (actor, action, entity, entity_id, account_id, prior_state)
  values (p_manager_user_id, 'create_account', 'compound_account', v_account_id, v_account_id, null);

  return jsonb_build_object('account_id', v_account_id, 'manager_holder_id', v_holder_id);
end;
$$;
```

- [ ] **Step 2: Create `lib/compound/db/write-account.ts`**

```typescript
/**
 * The account writer. One call, one transaction, two rows.
 */
import type { Queryable } from "./types";
import { toId } from "./sql";

export interface CreateAccountInput {
  mt5Account: number;
  label: string;
  broker: string | null;
  currency: string;
  defaultSplitBps: number;
  /** YYYY-MM-DD. */
  inceptionDate: string;
  managerUserId: string;
  managerName: string;
  /** Null means not configured; reconciliation refuses while it is. */
  brokerOffsetHours: number | null;
}

export async function createAccount(
  c: Queryable,
  input: CreateAccountInput,
): Promise<{ accountId: number; managerHolderId: number }> {
  if (!Number.isInteger(input.defaultSplitBps) ||
      input.defaultSplitBps < 0 || input.defaultSplitBps > 10_000) {
    throw new RangeError(`defaultSplitBps must be an integer 0..10000, got ${input.defaultSplitBps}`);
  }
  const { rows } = await c.query<{ result: { account_id: string; manager_holder_id: string } }>(
    `select public.compound_create_account($1,$2,$3,$4,$5,$6::date,$7::uuid,$8,$9) as result`,
    [
      input.mt5Account, input.label, input.broker ?? "", input.currency,
      input.defaultSplitBps, input.inceptionDate, input.managerUserId,
      input.managerName, input.brokerOffsetHours,
    ],
  );
  const r = rows[0]!.result;
  return {
    accountId: toId(r.account_id, "compound_create_account.account_id"),
    managerHolderId: toId(r.manager_holder_id, "compound_create_account.manager_holder_id"),
  };
}
```

- [ ] **Step 3: Create `lib/compound/ui/account-list.tsx`**

```tsx
/**
 * The account list. Deliberately thin: it lists accounts, it does not value
 * them. Valuing every account on this page means replaying every ledger in the
 * database to render a screen the manager passes through in half a second.
 *
 * The MT5 account number is MASKED to its last four digits. The repository is
 * public and screenshots of this page will end up in issues; the full number is
 * on the desk, one click away, where the context is already private.
 */
import type { ResolvedAccount } from "@/lib/compound/load/account";
import { formatDate, formatSplit } from "@/lib/compound/present/format";
import { Chip, EmptyState, Panel } from "./primitives";
import { deskHref } from "./routes";

export function maskMt5(account: number): string {
  const s = String(account);
  return s.length <= 4 ? s : `••••${s.slice(-4)}`;
}

export function AccountList({ accounts }: { accounts: ResolvedAccount[] }) {
  if (accounts.length === 0) {
    return (
      <Panel>
        <EmptyState title="No accounts yet">
          Compound reads an MT5 account that CopyTraderX is already pushing.
          Add one to start.
        </EmptyState>
        <p style={{ textAlign: "center", margin: 0 }}>
          <a className="btn btn-primary" href="/accounts/new">Add an account</a>
        </p>
      </Panel>
    );
  }

  return (
    <Panel flush>
      <div className="scroller">
        <table>
          <caption className="eyebrow">Accounts</caption>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">MT5</th>
              <th scope="col">Broker</th>
              <th scope="col">Currency</th>
              <th scope="col">Default split</th>
              <th scope="col">Inception</th>
              <th scope="col">Reconciliation</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  <a href={deskHref(a.id)}>{a.label}</a>
                </th>
                <td className="num">{maskMt5(a.mt5Account)}</td>
                <td>{a.broker ?? "—"}</td>
                <td className="num">{a.currency}</td>
                <td className="num">{formatSplit(a.defaultSplitBps)}</td>
                <td className="num">{formatDate(a.inceptionDate)}</td>
                <td>
                  {a.brokerOffsetHours === null
                    ? <Chip tone="fee">Broker offset not set</Chip>
                    : <span className="num">±{a.brokerOffsetHours}h</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
```

- [ ] **Step 4: Replace `app/page.tsx`**

The deployment shell goes here. Everything it demonstrated — the engine computes, the container runs — is now demonstrated by the desk itself, against real data.

```tsx
/**
 * Spec section 7: "account list, or redirect when there is only one".
 *
 * The redirect is unconditional on a single account, including for a manager
 * who has just created it. Under D1 there is one operator with one account,
 * and a list of one is a click they should not have to make.
 */
import { redirect } from "next/navigation";
import { listManagerAccounts } from "@/lib/compound/load/account";
import { AccountList } from "@/lib/compound/ui/account-list";
import { deskHref } from "@/lib/compound/ui/routes";

export const dynamic = "force-dynamic";

export default async function Page() {
  const accounts = await listManagerAccounts();
  if (accounts.length === 1) redirect(deskHref(accounts[0]!.id));

  return (
    <div className="wrap">
      <header className="mast">
        <div>
          <span className="mark">Compound</span>
          <span className="sub">Investor Desk</span>
        </div>
        {accounts.length > 0 ? (
          <a className="btn" href="/accounts/new">Add an account</a>
        ) : null}
      </header>
      <AccountList accounts={accounts} />
    </div>
  );
}
```

- [ ] **Step 5: Create `app/accounts/new/page.tsx`**

Two steps, per D-C: enter, then confirm against what CopyTraderX actually has for that MT5 account.

```tsx
/**
 * Creating an account. Two steps, like every other flow in this product.
 *
 * Step two does one thing beyond echoing the form back: it says what
 * CopyTraderX has for that MT5 account. A typo in an eight-digit account number
 * produces an account that reads a table with nothing in it, and the desk then
 * shows a correct-looking empty statement forever. Naming the snapshot count
 * before commit turns a silent typo into a visible one.
 *
 * It is a WARNING and not a refusal. A brand-new account may legitimately have
 * pushed nothing yet.
 */
import { redirect } from "next/navigation";
import { withDb } from "@/lib/compound/db/client";
import { getAccountOwnerUserId, getDailySnapshots, getLiveSnapshot } from "@/lib/compound/db/copytraderx";
import { createAccount } from "@/lib/compound/db/write-account";
import { requireManager } from "@/lib/compound/load/session";
import { formatMoney, formatSplit, formatUtcStamp } from "@/lib/compound/present/format";
import { Notice } from "@/lib/compound/ui/banner";
import { Receipt, ReceiptLine } from "@/lib/compound/ui/receipt";
import { Field, FieldError, Sheet, SheetActions } from "@/lib/compound/ui/sheet";
import { deskHref } from "@/lib/compound/ui/routes";
import { maskMt5 } from "@/lib/compound/ui/account-list";

export const dynamic = "force-dynamic";

interface Params {
  step?: string; mt5?: string; label?: string; broker?: string; currency?: string;
  split?: string; inception?: string; managerName?: string; offset?: string; error?: string;
}

async function commit(formData: FormData) {
  "use server";
  const user = await requireManager();
  const offsetRaw = String(formData.get("offset") ?? "").trim();
  try {
    const { accountId } = await withDb((c) =>
      createAccount(c, {
        mt5Account: Number(formData.get("mt5")),
        label: String(formData.get("label")),
        broker: String(formData.get("broker") ?? "") || null,
        currency: String(formData.get("currency") ?? "USD"),
        defaultSplitBps: Math.round(Number(formData.get("split")) * 100),
        inceptionDate: String(formData.get("inception")),
        managerUserId: user.id,
        managerName: String(formData.get("managerName")),
        brokerOffsetHours: offsetRaw === "" ? null : Number(offsetRaw),
      }),
    );
    redirect(deskHref(accountId));
  } catch (e) {
    if (e instanceof Error && "digest" in e) throw e;   // a redirect, not a failure
    const code = (e as { code?: string }).code;
    const message =
      code === "CX101"
        ? "That MT5 account already has a Compound account."
        : (e as Error).message;
    redirect(`/accounts/new?error=${encodeURIComponent(message)}`);
  }
}

export default async function NewAccountPage({
  searchParams,
}: { searchParams: Promise<Params> }) {
  const p = await searchParams;

  if (p.step !== "confirm") {
    return (
      <Sheet title="Add an account" backHref="/" lede="Compound reads an MT5 account CopyTraderX is already pushing. It never writes to it and never places a trade.">
        {p.error ? <FieldError>{p.error}</FieldError> : null}
        <form method="get">
          <input type="hidden" name="step" value="confirm" />
          <Field name="label" label="Account name">
            <input id="label" name="label" required defaultValue={p.label} />
          </Field>
          <Field name="mt5" label="MT5 account number">
            <input id="mt5" name="mt5" inputMode="numeric" pattern="[0-9]+" required defaultValue={p.mt5} />
          </Field>
          <Field name="managerName" label="Your name, as it appears on statements">
            <input id="managerName" name="managerName" required defaultValue={p.managerName} />
          </Field>
          <Field name="broker" label="Broker" hint="Optional.">
            <input id="broker" name="broker" defaultValue={p.broker} />
          </Field>
          <Field name="currency" label="Currency">
            <input id="currency" name="currency" defaultValue={p.currency ?? "USD"} required />
          </Field>
          <Field name="split" label="Default manager split, percent" hint="60 / 40 is written as 40 here. Each investor can override it.">
            <input id="split" name="split" inputMode="decimal" defaultValue={p.split ?? "40"} required />
          </Field>
          <Field name="inception" label="Inception date">
            <input id="inception" name="inception" type="date" required defaultValue={p.inception} />
          </Field>
          <Field
            name="offset"
            label="Broker server UTC offset, hours (1–14)"
            hint="Leave blank if you do not know it. Reconciliation stays switched off until it is set, because the duplicate-deal guard needs it and running it at a zero offset does nothing."
          >
            <input id="offset" name="offset" inputMode="numeric" defaultValue={p.offset} />
          </Field>
          <SheetActions>
            <button className="btn btn-primary" type="submit">Review</button>
          </SheetActions>
        </form>
      </Sheet>
    );
  }

  const mt5 = Number(p.mt5);
  const [snapshots, live, ownerUserId] = await withDb(async (c) => [
    await getDailySnapshots(c, mt5),
    await getLiveSnapshot(c, mt5),
    await getAccountOwnerUserId(c, mt5),
  ] as const);

  return (
    <Sheet title="Add an account" backHref="/accounts/new" backLabel="Back">
      {snapshots.length === 0 ? (
        <Notice>
          <strong>CopyTraderX has no daily snapshots for {maskMt5(mt5)}.</strong> Check the
          account number. If it is right, the EA has not pushed yet and the desk will be
          empty until it does.
        </Notice>
      ) : null}
      {ownerUserId === null ? (
        <Notice>
          <strong>No licence is registered against {maskMt5(mt5)}.</strong> That is not a
          blocker, but it usually means the account number is wrong.
        </Notice>
      ) : null}

      <Receipt label="Account to be created">
        <ReceiptLine label="Account name">{p.label}</ReceiptLine>
        <ReceiptLine label="MT5 account">
          <span className="num">{maskMt5(mt5)}</span>
        </ReceiptLine>
        <ReceiptLine label="Broker">{p.broker || "—"}</ReceiptLine>
        <ReceiptLine label="Currency"><span className="num">{p.currency}</span></ReceiptLine>
        <ReceiptLine
          label="Default split"
          hint="Investor keeps the first figure; you keep the second."
        >
          <span className="num">{formatSplit(Math.round(Number(p.split) * 100))}</span>
        </ReceiptLine>
        <ReceiptLine label="Inception"><span className="num">{p.inception}</span></ReceiptLine>
        <ReceiptLine
          label="Broker UTC offset"
          hint={p.offset ? undefined : "Not set — reconciliation stays off."}
        >
          <span className="num">{p.offset ? `±${p.offset}h` : "—"}</span>
        </ReceiptLine>
        <ReceiptLine label="Daily snapshots CopyTraderX has">
          <span className="num">{snapshots.length}</span>
        </ReceiptLine>
        {live === null ? null : (
          <ReceiptLine label="Live equity" hint={`pushed ${formatUtcStamp(live.pushedAt)}`}>
            <span className="num">{formatMoney(live.equityCents, { currency: p.currency })}</span>
          </ReceiptLine>
        )}
        <ReceiptLine label="Manager holder" hint="Created with the account. You cannot have an account without one.">
          {p.managerName}
        </ReceiptLine>
      </Receipt>

      <form action={commit}>
        {(["mt5", "label", "broker", "currency", "split", "inception", "managerName", "offset"] as const)
          .map((k) => <input key={k} type="hidden" name={k} value={p[k] ?? ""} />)}
        <SheetActions>
          <button className="btn btn-primary" type="submit">Create account</button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
```

- [ ] **Step 6: Write `lib/compound/db/write-account.db.test.ts`**

```typescript
import { withDbTransaction } from "@/lib/compound/db/client";
import { getAccountById } from "@/lib/compound/db/compound";
import { listHolders } from "@/lib/compound/db/holders";
import { createAccount } from "@/lib/compound/db/write-account";
import { MANAGER_USER_ID, OTHER_MANAGER_USER_ID } from "@/lib/compound/db/test-harness";

function input(over: Partial<Parameters<typeof createAccount>[1]> = {}) {
  return {
    mt5Account: 90_000_777,
    label: "Test account",
    broker: "Fictional Markets",
    currency: "USD",
    defaultSplitBps: 4000,
    inceptionDate: "2026-03-02",
    managerUserId: MANAGER_USER_ID,
    managerName: "J. Marsh",
    brokerOffsetHours: 3,
    ...over,
  };
}
const rollback = (e: Error) => { if (e.message !== "rollback") throw e; };

describe("createAccount", () => {
  it("creates the account and its manager holder together", async () => {
    await withDbTransaction(async (c) => {
      const { accountId, managerHolderId } = await createAccount(c, input());
      const account = await getAccountById(c, accountId);
      expect(account!.mt5Account).toBe(90_000_777);
      expect(account!.brokerOffsetHours).toBe(3);

      const holders = await listHolders(c, accountId);
      expect(holders).toHaveLength(1);
      expect(holders[0]!.id).toBe(managerHolderId);
      expect(holders[0]!.isManager).toBe(true);
      expect(holders[0]!.splitBps).toBe(0);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("stores a null offset when none is given, rather than zero", async () => {
    await withDbTransaction(async (c) => {
      const { accountId } = await createAccount(c, input({ brokerOffsetHours: null }));
      expect((await getAccountById(c, accountId))!.brokerOffsetHours).toBeNull();
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("refuses a second account on the same MT5 number, with CX101", async () => {
    await withDbTransaction(async (c) => {
      await createAccount(c, input());
      await expect(createAccount(c, input({ managerUserId: OTHER_MANAGER_USER_ID })))
        .rejects.toThrow(/already has a Compound account/);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("leaves no orphan account behind when the holder insert fails", async () => {
    await withDbTransaction(async (c) => {
      // A name past the column's limit fails the SECOND insert. If the function
      // were two client calls the account row would survive; as one function
      // body it does not. Counting before and after is what proves it.
      const before = await c.query<{ n: string }>(
        `select count(*) as n from public.compound_account where mt5_account = $1`,
        [90_000_778],
      );
      await expect(
        createAccount(c, input({ mt5Account: 90_000_778, managerName: "x".repeat(100_000) })),
      ).rejects.toThrow();
      const after = await c.query<{ n: string }>(
        `select count(*) as n from public.compound_account where mt5_account = $1`,
        [90_000_778],
      );
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("refuses a split outside 0..10000 before it reaches SQL", async () => {
    await withDbTransaction(async (c) => {
      await expect(createAccount(c, input({ defaultSplitBps: 10_001 })))
        .rejects.toThrow(/defaultSplitBps must be an integer/);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("writes an audit row naming the actor", async () => {
    await withDbTransaction(async (c) => {
      const { accountId } = await createAccount(c, input());
      const { rows } = await c.query<{ actor: string; action: string; entity_id: string }>(
        `select actor, action, entity_id from public.compound_audit
          where entity = 'compound_account' and entity_id = $1`,
        [accountId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe(MANAGER_USER_ID);
      expect(rows[0]!.action).toBe("create_account");
      throw new Error("rollback");
    }).catch(rollback);
  });
});
```

> **The orphan test depends on `compound_holder.name` having a length limit.** If plan 3 typed it as bare `text`, a 100,000-character name inserts fine and the test passes for the wrong reason. Check the DDL first. If there is no limit, force the second insert to fail another way — a `null` manager name against the `not null` — and say in a comment which constraint the test is leaning on. **Do not leave an atomicity test whose failure fires before the first insert.** That is plan 3's own warning, and it applies here.

- [ ] **Step 7: Write `lib/compound/ui/account-list.test.tsx`**

```tsx
import { render, screen, within } from "@testing-library/react";
import type { ResolvedAccount } from "@/lib/compound/load/account";
import { AccountList, maskMt5 } from "./account-list";

const ACCOUNTS: ResolvedAccount[] = [
  {
    id: 7, mt5Account: 90_000_001, label: "Pooled — live", broker: "Fictional Markets",
    currency: "USD", defaultSplitBps: 4000, inceptionDate: "2026-03-02",
    managerUserId: "00000000-0000-0000-0000-000000000001", brokerOffsetHours: 3,
  },
  {
    id: 8, mt5Account: 90_000_002, label: "Pooled — second", broker: null,
    currency: "EUR", defaultSplitBps: 3700, inceptionDate: "2026-06-01",
    managerUserId: "00000000-0000-0000-0000-000000000001", brokerOffsetHours: null,
  },
];

describe("maskMt5", () => {
  it("shows only the last four digits", () => {
    expect(maskMt5(90_000_001)).toBe("••••0001");
  });

  it("leaves a short number alone rather than masking it to nothing", () => {
    expect(maskMt5(42)).toBe("42");
  });
});

describe("AccountList", () => {
  beforeEach(() => render(<AccountList accounts={ACCOUNTS} />));

  it("links each account to its desk", () => {
    expect(screen.getByRole("link", { name: "Pooled — live" })).toHaveAttribute("href", "/a/7");
    expect(screen.getByRole("link", { name: "Pooled — second" })).toHaveAttribute("href", "/a/8");
  });

  it("never renders a full MT5 account number", () => {
    expect(screen.queryByText(/90000001/)).toBeNull();
    expect(screen.getByText("••••0001")).toBeInTheDocument();
  });

  it("shows each account's own default split", () => {
    const row = screen.getByRole("row", { name: /Pooled — second/ });
    expect(within(row).getByText("63 / 37")).toBeInTheDocument();
  });

  it("flags an account whose broker offset is not configured", () => {
    expect(within(screen.getByRole("row", { name: /Pooled — second/ }))
      .getByText("Broker offset not set")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Pooled — live/ }))
      .queryByText("Broker offset not set")).toBeNull();
  });

  it("shows a configured offset with its sign", () => {
    expect(within(screen.getByRole("row", { name: /Pooled — live/ }))
      .getByText("±3h")).toBeInTheDocument();
  });

  it("renders a dash where a broker is unknown, not the word null", () => {
    const row = screen.getByRole("row", { name: /Pooled — second/ });
    expect(within(row).getByText("—")).toBeInTheDocument();
    expect(row.textContent).not.toContain("null");
  });
});

describe("AccountList — empty", () => {
  it("offers the way out instead of an empty table", () => {
    render(<AccountList accounts={[]} />);
    expect(screen.getByText("No accounts yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add an account" }))
      .toHaveAttribute("href", "/accounts/new");
    expect(screen.queryByRole("table")).toBeNull();
  });
});
```

- [ ] **Step 8: Run the gates and prove two probes**

```bash
supabase db reset && pnpm typecheck && pnpm test && pnpm test:db && pnpm build
```

Then, reverting each:

1. In `compound_create_account`, delete the `compound_holder` insert. Expect the first `write-account.db.test.ts` case to fail on `toHaveLength(1)`. This is the only test that stops an account being created without the holder `fold` needs.
2. In `maskMt5`, return `String(account)`. Expect "never renders a full MT5 account number" to fail. That assertion exists because the repository is public and this page appears in screenshots.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "$(cat <<'MSG'
feat(desk): account list, account creation, and the manager holder that comes with it

Replaces the deployment shell at app/page.tsx. compound_create_account writes
the account and its manager holder in one function body, because replay.ts
cannot settle a fee without one and an account missing it fails at render time.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 7: `app/a/[id]/layout.tsx` — the shell every account surface renders inside

Agreement A1: this layout is plan 4's, and plan 5's three surfaces render inside it. It owns the masthead, the account switcher, the sub-nav and the frozen-figures banner. It deliberately does **not** fold the ledger — two of plan 5's three pages need no ledger at all, and a layout that replays one makes them pay for it on every navigation.

**Files:**
- Create: `lib/compound/ui/masthead.tsx`
- Create: `app/a/[id]/layout.tsx`
- Create: `app/a/[id]/subnav.tsx`
- Create: `app/a/[id]/not-found.tsx`
- Test: `lib/compound/ui/masthead.test.tsx`

**Interfaces:**
- Consumes: `requireAccount`, `listManagerAccounts` from `@/lib/compound/load/account`; `loadInterlock` from `@/lib/compound/load/interlock`; `SUBNAV`, `activeNavKey` from `@/lib/compound/ui/routes`
- Produces:
  - `Masthead` component
  - `AccountSwitcher` component
  - `SubNav` client component
  - the `/a/[id]` layout

- [ ] **Step 1: Create `lib/compound/ui/masthead.tsx`**

```tsx
/**
 * The masthead and the account switcher.
 *
 * The switcher is a <details> element. No client component, no state, no
 * hydration — it opens and closes because that is what <details> does, and it
 * is keyboard-operable and screen-reader-announced without any work.
 *
 * The MT5 number is masked here for the same reason it is masked in the account
 * list: this is the strip that appears in every screenshot of the product.
 */
import type { ResolvedAccount } from "@/lib/compound/load/account";
import { maskMt5 } from "./account-list";

export function AccountSwitcher({
  current, accounts,
}: { current: ResolvedAccount; accounts: ResolvedAccount[] }) {
  const others = accounts.filter((a) => a.id !== current.id);
  const summary = (
    <>
      <span className="dot" aria-hidden="true" />
      {current.label}
      <span className="muted"> · {maskMt5(current.mt5Account)}</span>
      {current.currency === "USD" ? null : <span className="muted"> · {current.currency}</span>}
    </>
  );

  if (others.length === 0 && accounts.length <= 1) {
    return <p className="switcher" style={{ margin: 0 }}><span>{summary}</span></p>;
  }

  return (
    <details className="switcher">
      <summary aria-label={`Account: ${current.label}. Switch account.`}>
        {summary}
        <span aria-hidden="true">▾</span>
      </summary>
      <div>
        {accounts.map((a) => (
          <a key={a.id} href={`/a/${a.id}`} aria-current={a.id === current.id ? "true" : undefined}>
            {a.label}
            <span className="muted"> · {maskMt5(a.mt5Account)}</span>
          </a>
        ))}
        <a href="/accounts/new">+ Add an account</a>
      </div>
    </details>
  );
}

export function Masthead({
  current, accounts,
}: { current: ResolvedAccount; accounts: ResolvedAccount[] }) {
  return (
    <header className="mast">
      <div>
        <a href="/" style={{ color: "inherit", textDecoration: "none" }}>
          <span className="mark">Compound</span>
        </a>
        <span className="sub">Investor Desk</span>
      </div>
      <AccountSwitcher current={current} accounts={accounts} />
    </header>
  );
}
```

Add the `.dot` rule back to `app/globals.css`, which Task 1's rewrite dropped along with the shell that used it:

```css
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--gain); flex: none; }
```

- [ ] **Step 2: Create `app/a/[id]/subnav.tsx`**

The only client component in this plan. It reads the pathname and nothing else, and it takes two numbers — never a `bigint`, never a money value.

```tsx
"use client";

/**
 * The sub-nav. A client component because a layout is not told which child
 * route rendered, and usePathname is the only way to know which tab is
 * current.
 *
 * It takes two numbers. Nothing money-shaped crosses this boundary — see the
 * global constraint on bigint. The logic worth testing lives in
 * activeNavKey(), which is pure and tested in lib/compound/ui/routes.test.ts;
 * what remains here is a map over a constant.
 */
import { usePathname } from "next/navigation";
import { SUBNAV, activeNavKey } from "@/lib/compound/ui/routes";

export function SubNav({
  accountId, pendingCount,
}: { accountId: number; pendingCount: number }) {
  const active = activeNavKey(usePathname() ?? "", accountId);
  return (
    <nav className="subnav" aria-label="Account sections">
      {SUBNAV.map((n) => (
        <a
          key={n.key}
          href={n.href(accountId)}
          aria-current={n.key === active ? "page" : undefined}
        >
          {n.label}
          {n.badge === "pending" && pendingCount > 0 ? (
            <span className="chip is-fee" aria-label={`${pendingCount} awaiting review`}>
              {pendingCount}
            </span>
          ) : null}
        </a>
      ))}
    </nav>
  );
}
```

- [ ] **Step 3: Create `app/a/[id]/layout.tsx`**

```tsx
/**
 * The account shell. Agreement A1 with plan 5: this layout owns the masthead,
 * the switcher, the sub-nav and the frozen-figures banner; plan 5's /journal,
 * /calendar and /performance render inside it as page content only.
 *
 * It loads three things and no more: the account, the manager's other accounts
 * for the switcher, and the interlock state for the badge and the banner. It
 * does NOT load or fold the ledger. Two of plan 5's three surfaces need no
 * ledger, and a layout that replays one taxes every navigation for a figure
 * most pages will not render.
 *
 * The banner is here rather than on each page for a reason worth stating: when
 * the reconciler has stopped, EVERY figure on the account is as of the frozen
 * date. A banner that appeared on the desk and not on /performance would be
 * telling the truth in one place and implying its opposite in another.
 */
import type { ReactNode } from "react";
import { listManagerAccounts, requireAccount } from "@/lib/compound/load/account";
import { loadInterlock } from "@/lib/compound/load/interlock";
import { InterlockBanner } from "@/lib/compound/ui/banner";
import { Masthead } from "@/lib/compound/ui/masthead";
import { reviewHref } from "@/lib/compound/ui/routes";
import { SubNav } from "./subnav";

export const dynamic = "force-dynamic";

export default async function AccountLayout({
  children, params,
}: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = await requireAccount(id);
  const [accounts, interlock] = await Promise.all([
    listManagerAccounts(),
    loadInterlock(account.id),
  ]);

  return (
    <div className="wrap">
      <Masthead current={account} accounts={accounts} />
      <SubNav accountId={account.id} pendingCount={interlock.pendingCount} />
      {interlock.pendingCandidateDate === null ? null : (
        <InterlockBanner
          frozenAt={interlock.frozenAt}
          candidateDate={interlock.pendingCandidateDate}
          reviewHref={reviewHref(account.id)}
        />
      )}
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Create `app/a/[id]/not-found.tsx`**

```tsx
/**
 * What requireAccount's notFound() renders. It says the same thing for an
 * account that does not exist and for one belonging to another manager,
 * deliberately: a distinct message for the second confirms the account exists,
 * which is the thing the gate is refusing to confirm.
 */
export default function AccountNotFound() {
  return (
    <div className="wrap">
      <header className="mast">
        <div>
          <a href="/" style={{ color: "inherit", textDecoration: "none" }}>
            <span className="mark">Compound</span>
          </a>
          <span className="sub">Investor Desk</span>
        </div>
      </header>
      <section className="panel">
        <p style={{ fontFamily: "var(--serif)", fontSize: 20, margin: "0 0 6px" }}>
          No such account
        </p>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          That account does not exist, or it is not one of yours.{" "}
          <a href="/">Back to your accounts</a>.
        </p>
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Write `lib/compound/ui/masthead.test.tsx`**

```tsx
import { render, screen, within } from "@testing-library/react";
import type { ResolvedAccount } from "@/lib/compound/load/account";
import { AccountSwitcher, Masthead } from "./masthead";

const A: ResolvedAccount = {
  id: 7, mt5Account: 90_000_001, label: "Pooled — live", broker: "Fictional Markets",
  currency: "USD", defaultSplitBps: 4000, inceptionDate: "2026-03-02",
  managerUserId: "u1", brokerOffsetHours: 3,
};
const B: ResolvedAccount = { ...A, id: 8, mt5Account: 90_000_002, label: "Pooled — second", currency: "EUR" };

describe("AccountSwitcher — one account", () => {
  it("shows the account without offering a menu there is nothing in", () => {
    render(<AccountSwitcher current={A} accounts={[A]} />);
    expect(screen.getByText("Pooled — live")).toBeInTheDocument();
    expect(screen.queryByRole("group")).toBeNull();          // <details> has role group
  });
});

describe("AccountSwitcher — several accounts", () => {
  beforeEach(() => render(<AccountSwitcher current={A} accounts={[A, B]} />));

  it("names the current account in the control's accessible name", () => {
    expect(screen.getByLabelText("Account: Pooled — live. Switch account."))
      .toBeInTheDocument();
  });

  it("lists every account, current one included, and marks the current one", () => {
    const menu = screen.getByRole("group");
    expect(within(menu).getByRole("link", { name: /Pooled — live/ }))
      .toHaveAttribute("aria-current", "true");
    expect(within(menu).getByRole("link", { name: /Pooled — second/ }))
      .not.toHaveAttribute("aria-current");
  });

  it("links each entry to its desk", () => {
    expect(screen.getByRole("link", { name: /Pooled — second/ }))
      .toHaveAttribute("href", "/a/8");
  });

  it("offers a way to add another", () => {
    expect(screen.getByRole("link", { name: "+ Add an account" }))
      .toHaveAttribute("href", "/accounts/new");
  });

  it("masks the MT5 number in the strip that appears in every screenshot", () => {
    expect(screen.queryByText(/90000001/)).toBeNull();
    expect(screen.getAllByText(/••••0001/).length).toBeGreaterThan(0);
  });

  it("names a non-default currency in the summary", () => {
    render(<AccountSwitcher current={B} accounts={[A, B]} />);
    expect(screen.getByLabelText(/Account: Pooled — second/).textContent).toContain("EUR");
  });
});

describe("Masthead", () => {
  it("puts the brand mark in the display face and links it home", () => {
    const { container } = render(<Masthead current={A} accounts={[A]} />);
    expect(screen.getByText("Compound").closest("a")).toHaveAttribute("href", "/");
    expect(container.querySelector(".mark")?.textContent).toBe("Compound");
  });
});
```

- [ ] **Step 6: Run the gates and prove two probes**

```bash
supabase db reset && pnpm typecheck && pnpm test && pnpm build
```

Then, reverting each:

1. In the layout, render `<InterlockBanner>` unconditionally. Nothing in the unit suite goes red — which is the point of naming it here. Confirm it manually instead: with no pending candidate, the desk must carry no banner. Task 15's smoke pass covers it, and this step is the note that it is not covered before then.
2. In `subnav.tsx`, replace `activeNavKey(...)` with `pathname.includes(n.key)`. `routes.test.ts` still passes, because the pure function is unchanged — but `/a/7/review/12` now marks both Review and, on an account whose label contains "desk", nothing at all. This is the argument for keeping the branching in the pure module: the probe that cannot go red is the code that should not have branches.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "$(cat <<'MSG'
feat(desk): the account shell — masthead, switcher, sub-nav, interlock banner

The layout every account surface renders inside, including plan 5's three.
Loads the account, the switcher list and the interlock state, and deliberately
does not fold the ledger: two of plan 5's surfaces do not need one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 8: `/a/[id]` — the desk

Spec §7's headline surface: statement head, unit rail, KPI strip, holder table.

> **The convention every route from here follows, and the reason the tests in this plan can exist.**
>
> **A route is a loader plus a sync component.** The page resolves the account, awaits the loaders, and renders one synchronous component that takes engine types as props. That component lives in `lib/compound/ui/` and is where every test points.
>
> `@testing-library/react` cannot render an async Server Component, so a page with branches in it is a page with untestable branches. Keeping the page to *resolve, load, render* means the only thing not covered by a component test is a four-line function with no conditionals — and Task 15's smoke pass covers that.
>
> This applies to Tasks 8 through 14 without further comment.

**Files:**
- Create: `lib/compound/ui/desk.tsx`
- Create: `app/a/[id]/page.tsx`
- Test: `lib/compound/ui/desk.test.tsx`

**Interfaces:**
- Consumes: `deskFigures` from `@/lib/compound/present/derive`; `railSegments` from `@/lib/compound/present/rail`; `loadPoolState`, `loadHolderNames`, `loadLive`, `loadLedger` from `@/lib/compound/load/ledger`; every component from `@/lib/compound/ui/*`
- Produces: `Desk` component; the `/a/[id]` route

- [ ] **Step 1: Create `lib/compound/ui/desk.tsx`**

```tsx
/**
 * The desk. Everything on it is derived from one PoolState.
 *
 * Two figures on this page are the same quantity measured two ways and they
 * are meant to stay apart:
 *
 *   Account equity   the COMMITTED figure, from the last posted reading.
 *   Live equity      account_snapshots_current, intraday, not posted.
 *
 * Spec section 5.2 keeps them apart because a payout may never settle against
 * a drifting intraday figure. The headline is always the committed one.
 *
 * The KPI strip carries exactly one amber tile — "Fee if everyone paid out
 * today" — and it is the only amber on the page apart from the manager's row.
 * Spec section 8.2: amber means the fee and nothing else.
 */
import type { PoolState } from "@/lib/compound/engine/replay";
import { totalsOf } from "@/lib/compound/engine/replay";
import type { DeskFigures } from "@/lib/compound/present/derive";
import type { RailSegment } from "@/lib/compound/present/rail";
import { HolderTable } from "./holder-table";
import { OwnershipRail } from "./rail";
import { DeltaMoney, EmptyState, Eyebrow, FeeMoney, Money, Panel } from "./primitives";
import { KpiStrip, StatementHead, type LiveFigures } from "./statement";

export function Desk({
  accountId, state, figures, segments, currency, entryCount, live, actions,
}: {
  accountId: number;
  state: PoolState;
  figures: DeskFigures;
  segments: RailSegment[];
  currency: string;
  entryCount: number;
  live: LiveFigures | null;
  /** Phase B fills this. Absent in Phase A, and the desk is complete without it. */
  actions?: React.ReactNode;
}) {
  if (entryCount === 0) {
    return (
      <Panel>
        <EmptyState title="Nothing posted yet">
          This account has no ledger entries. Post an equity reading or add capital
          to start, and every figure on this page will be derived from what you post.
        </EmptyState>
        {actions ? <div className="actions" style={{ justifyContent: "center" }}>{actions}</div> : null}
      </Panel>
    );
  }

  return (
    <>
      <Panel>
        <StatementHead
          totals={totalsOf(state)}
          currency={currency}
          asOf={state.lastReadingOn}
          entryCount={entryCount}
          holderCount={figures.holderCount}
          live={live}
        />
        <OwnershipRail segments={segments} />
        {actions ? <div className="actions">{actions}</div> : null}
      </Panel>

      <KpiStrip
        items={[
          {
            key: "capital",
            label: "Investor capital in",
            value: <Money cents={figures.investorBasisCents} currency={currency} />,
          },
          {
            key: "value",
            label: "Investor value now",
            value: <Money cents={figures.investorValueCents} currency={currency} />,
          },
          {
            key: "pl",
            label: "Investor P/L",
            value: <DeltaMoney cents={figures.investorProfitCents} currency={currency} />,
          },
          {
            key: "yours",
            label: "Your holding",
            value: <Money cents={figures.managerValueCents} currency={currency} />,
          },
          {
            key: "fee",
            label: "Fee if everyone paid out today",
            tone: "fee",
            value: <FeeMoney cents={figures.feeIfAllExitCents} currency={currency} />,
          },
        ]}
      />

      <Panel flush>
        <HolderTable
          accountId={accountId}
          figures={figures}
          currency={currency}
          showActions={actions !== undefined}
        />
      </Panel>

      <p className="foot">
        Every figure on this page is derived by replaying {entryCount} ledger{" "}
        {entryCount === 1 ? "entry" : "entries"}. Nothing is stored. Money is integer
        cents, units are integers scaled 1e-10, and no floating point is used anywhere
        in the accounting.
      </p>
    </>
  );
}
```

- [ ] **Step 2: Create `app/a/[id]/page.tsx`**

```tsx
import { requireAccount } from "@/lib/compound/load/account";
import { loadHolderNames, loadLedger, loadLive, loadPoolState } from "@/lib/compound/load/ledger";
import { deskFigures } from "@/lib/compound/present/derive";
import { railSegments } from "@/lib/compound/present/rail";
import { Desk } from "@/lib/compound/ui/desk";

export const dynamic = "force-dynamic";

export default async function DeskPage({ params }: { params: Promise<{ id: string }> }) {
  const account = await requireAccount((await params).id);
  const [state, names, live, entries] = await Promise.all([
    loadPoolState(account.id),
    loadHolderNames(account.id),
    loadLive(account.mt5Account),
    loadLedger(account.id),
  ]);

  return (
    <Desk
      accountId={account.id}
      state={state}
      figures={deskFigures(state, names)}
      segments={railSegments(state, names)}
      currency={account.currency}
      entryCount={entries.length}
      live={live}
    />
  );
}
```

- [ ] **Step 3: Write `lib/compound/ui/desk.test.tsx`**

```tsx
import { render, screen, within } from "@testing-library/react";
import { fold } from "@/lib/compound/engine/replay";
import { deskFigures } from "@/lib/compound/present/derive";
import { railSegments } from "@/lib/compound/present/rail";
import { HOLDER_NAMES, LEDGER, LIVE, SEEDS } from "@/lib/compound/present/fixture";
import { Desk } from "./desk";

const STATE = fold(LEDGER, SEEDS);
const NAMES = HOLDER_NAMES;

function renderDesk(over: Partial<Parameters<typeof Desk>[0]> = {}) {
  const state = over.state ?? STATE;
  return render(
    <Desk
      accountId={7}
      state={state}
      figures={over.figures ?? deskFigures(state, NAMES)}
      segments={over.segments ?? railSegments(state, NAMES)}
      currency={over.currency ?? "USD"}
      entryCount={over.entryCount ?? LEDGER.length}
      live={over.live === undefined ? LIVE : over.live}
      actions={over.actions}
    />,
  );
}

describe("Desk — the statement head", () => {
  beforeEach(() => renderDesk());

  it("headlines the committed equity, not the live figure", () => {
    expect(screen.getByLabelText("Account equity").textContent).toBe("$55,743.91");
    expect(screen.getByLabelText("Live equity").textContent).toBe("$55,930.00");
  });

  it("shows NAV, growth, units and the holder count", () => {
    expect(screen.getByLabelText("NAV / unit").textContent).toBe("1.3858");
    expect(screen.getByLabelText("Since inception").textContent).toBe("+38.58%");
    expect(screen.getByLabelText("Units issued").textContent).toBe("40,222.4547");
    expect(screen.getByLabelText("Holders").textContent).toBe("3");
  });
});

describe("Desk — the KPI strip", () => {
  beforeEach(() => renderDesk());

  it("reads back every headline figure", () => {
    expect(screen.getByLabelText("Investor capital in").textContent).toBe("$17,500.00");
    expect(screen.getByLabelText("Investor value now").textContent).toBe("$21,096.65");
    expect(screen.getByLabelText("Investor P/L").textContent).toBe("+$3,596.65");
    expect(screen.getByLabelText("Your holding").textContent).toBe("$34,647.26");
    expect(screen.getByLabelText("Fee if everyone paid out today").textContent).toBe("$1,409.67");
  });

  it("separates the manager's holding from the investors' totals", () => {
    // 34,647.26 + 21,096.65 = 55,743.91. If the manager leaked into the
    // investor totals, "Investor value now" would read the equity figure.
    const investors = BigInt(screen.getByLabelText("Investor value now").textContent!.replace(/\D/g, ""));
    const yours = BigInt(screen.getByLabelText("Your holding").textContent!.replace(/\D/g, ""));
    expect(investors + yours).toBe(5_574_391n);
  });

  it("carries exactly one amber tile, and it is the fee", () => {
    const amber = document.querySelectorAll(".kpi-item.is-fee");
    expect(amber).toHaveLength(1);
    expect(amber[0]!.textContent).toContain("Fee if everyone paid out today");
  });
});

describe("Desk — the ownership rail", () => {
  beforeEach(() => renderDesk());

  it("shows the manager darkest and first", () => {
    const segs = document.querySelectorAll<HTMLElement>(".seg");
    expect(segs[0]!.style.background).toBe("rgb(20, 83, 45)");
  });

  it("labels every segment with a name and a share", () => {
    const legend = screen.getByRole("list", { name: "Ownership legend" });
    expect(legend.textContent).toContain("J. Marsh (manager)");
    expect(legend.textContent).toContain("62.15%");
  });
});

describe("Desk — the holder table", () => {
  it("agrees with the KPI strip on Ada's value", () => {
    renderDesk();
    const row = screen.getByRole("row", { name: /Ada Lovelace/ });
    expect(within(row).getAllByRole("cell")[3]!.textContent).toBe("$12,630.61");
  });

  it("offers no payout link in Phase A, where nothing can be committed", () => {
    renderDesk();
    expect(screen.queryByRole("link", { name: "Pay out" })).toBeNull();
  });

  it("offers one once actions are wired", () => {
    renderDesk({ actions: <a className="btn" href="/a/7/actions/reading">Post a reading</a> });
    expect(screen.getAllByRole("link", { name: "Pay out" }).length).toBeGreaterThan(0);
  });
});

describe("Desk — an account under water", () => {
  const underwater = fold([...LEDGER, {
    id: 7, seq: 7, holderId: null, occurredOn: "2026-08-18",
    type: "equity_reading" as const, amountCents: 3_811_044n,
    feeSettlement: null, splitBpsApplied: null, reversesId: null,
  }], SEEDS);

  beforeEach(() => renderDesk({ state: underwater, entryCount: 7, live: null }));

  it("shows the accrued fee as zero, because no one is above their mark", () => {
    expect(screen.getByLabelText("Fee if everyone paid out today").textContent).toBe("$0.00");
  });

  it("shows investor P/L negative, with a minus sign and not only a colour", () => {
    // Spec 8.4: colour is never the sole carrier. The sign is the carrier.
    expect(screen.getByLabelText("Investor P/L").textContent).toBe("-$3,076.86");
  });

  it("shows growth since inception as negative", () => {
    expect(screen.getByLabelText("Since inception").textContent).toBe("-5.26%");
  });

  it("omits the live block entirely when nothing has been pushed", () => {
    expect(screen.queryByLabelText("Live equity")).toBeNull();
    expect(screen.queryByText(/Live · not yet posted/)).toBeNull();
  });
});

describe("Desk — a new account", () => {
  it("says what to do instead of rendering a statement of zeroes", () => {
    renderDesk({ state: fold([], SEEDS), entryCount: 0, live: null });
    expect(screen.getByText("Nothing posted yet")).toBeInTheDocument();
    expect(screen.queryByLabelText("Account equity")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("Desk — currency", () => {
  it("renders every figure in the account's currency", () => {
    renderDesk({ currency: "EUR" });
    expect(screen.getByLabelText("Account equity").textContent).toBe("€55,743.91");
    expect(screen.getByLabelText("Fee if everyone paid out today").textContent).toBe("€1,409.67");
  });
});
```

**How these bite.**

| Change | What goes red |
|---|---|
| headline `live.equityCents` instead of committed equity | "headlines the committed equity" — `$55,930.00` where `$55,743.91` belongs, which is spec §5.2's exact failure |
| include the manager in `investorValueCents` | the KPI readback and the sum-to-equity assertion |
| add a second `tone: "fee"` tile | "carries exactly one amber tile" |
| render the empty account as a statement of zeroes | "says what to do instead", and `Account equity` reading `$0.00` |
| drop the `sign: "always"` on investor P/L | the underwater minus-sign assertion — the one that keeps colour from being the sole carrier |
| show the payout link before Phase B exists | "offers no payout link in Phase A" |

Note what is deliberately **not** tested here: that the desk fetched the right rows. That is `loadPoolState`'s job and plan 3's integration suite covers the readers underneath it. Mocking the loaders and asserting they were called would test the mock.

- [ ] **Step 4: Run the gates and prove two probes**

```bash
supabase db reset && pnpm typecheck && pnpm test && pnpm build
```

Then, reverting each:

1. In `Desk`, pass `live.equityCents` to `StatementHead`'s `totals`. Expect exactly the committed-equity assertion to fail.
2. In `deskFigures`, drop the `!r.isManager` filter from `investors`. Expect four assertions across `desk.test.tsx` and `derive.test.ts` to fail — the strip, the sum, and the two totals.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "$(cat <<'MSG'
feat(desk): the desk — statement head, ownership rail, KPI strip, holder table

Every figure derived from one PoolState. The committed equity is the headline
and the live figure is labelled beside it, per spec 5.2: a payout may never
settle against a drifting intraday number, so the two never share a slot.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 9: `/a/[id]/ledger` — chronological activity

Spec §7: "deposits, payouts, readings (R3)". Every row carries the state the pool was in *after* that entry, derived by folding the prefix (decision D-E).

Two facts the spec insists on and this page is the only place that shows both: **`occurred_on` is a broker-server date and `recorded_at` is UTC** (§4), and they are different facts that both matter in a dispute. Plan 3's `LedgerEntry` carries neither `recorded_at` nor `note`, on purpose — `fold` must not be able to see them. So this task adds a metadata reader alongside, and joins the two in the presenter.

**No reversal control.** Invariant 5 says corrections are reversing entries, and this page renders a voided pair correctly if one exists. Spec §11's coverage list puts E5 outside v1, so nothing here offers a button that creates one. The ledger is append-only and the screen offers no edit and no delete, which is §9's guarantee made visible.

**Files:**
- Create: `lib/compound/db/ledger-meta.ts`
- Create: `lib/compound/ui/ledger-table.tsx`
- Create: `app/a/[id]/ledger/page.tsx`
- Test: `lib/compound/db/ledger-meta.db.test.ts`
- Test: `lib/compound/ui/ledger-table.test.tsx`

**Interfaces:**
- Consumes: `ledgerSteps`, `LedgerStep` from `@/lib/compound/present/derive`; `navTimes1e4`, `totalsOf`
- Produces:
  - `interface LedgerEntryMeta { id: number; recordedAt: string; note: string | null; createdBy: string | null }`
  - `listLedgerMeta(c: Queryable, accountId: number): Promise<LedgerEntryMeta[]>`
  - `LedgerTable` component

- [ ] **Step 1: Create `lib/compound/db/ledger-meta.ts`**

```typescript
/**
 * The columns of compound_ledger_entry that fold() must never see.
 *
 * note, recorded_at and created_by are provenance. They belong on a screen and
 * in a dispute, and they must not reach the reducer: an entry's effect on the
 * pool cannot depend on who typed it or when the row was written. Plan 3's
 * LedgerEntry deliberately omits them, and this reader deliberately returns
 * nothing else — the two shapes cannot be confused for one another.
 *
 * recorded_at is UTC and occurred_on is a broker-server date. Spec section 4
 * keeps both because they answer different questions: what day the broker says
 * it happened, and what moment this office wrote it down.
 */
import type { Queryable } from "./types";
import { toId, utcIsoExpr } from "./sql";

export interface LedgerEntryMeta {
  id: number;
  /** ISO 8601, UTC. */
  recordedAt: string;
  note: string | null;
  /** public.users id, or null for an entry written by a job. */
  createdBy: string | null;
}

export async function listLedgerMeta(
  c: Queryable,
  accountId: number,
): Promise<LedgerEntryMeta[]> {
  const { rows } = await c.query<{
    id: string; recorded_at: string; note: string | null; created_by: string | null;
  }>(
    `select id, ${utcIsoExpr("recorded_at")} as recorded_at, note, created_by
       from public.compound_ledger_entry
      where account_id = $1
      order by seq asc`,
    [accountId],
  );
  return rows.map((r) => ({
    id: toId(r.id, "compound_ledger_entry.id"),
    recordedAt: r.recorded_at,
    note: r.note,
    createdBy: r.created_by,
  }));
}
```

- [ ] **Step 2: Create `lib/compound/ui/ledger-table.tsx`**

```tsx
/**
 * The ledger, one row per entry, with the pool's state after each one.
 *
 * Every "after" figure comes from folding the prefix (decision D-E). It is
 * O(n^2) and it is the only construction under which this page cannot
 * disagree with the desk: the last row's state IS fold(everything), by
 * construction rather than by care.
 *
 * The CASH column is the equity delta, not entry.amountCents. For a deposit the
 * two agree. For a payout they do not — replay.ts recomputes the payout from
 * quote() and never reads amountCents, so the stored figure is what was asked
 * for and the delta is what left the account. A ledger that prints the request
 * where the reader expects the movement is a ledger that will be argued with.
 *
 * A reading moves no cash, so its cash cell is a dash rather than a zero. Zero
 * would claim a movement of nothing happened; a dash says the column does not
 * apply.
 */
import { navTimes1e4 } from "@/lib/compound/engine/nav";
import { totalsOf } from "@/lib/compound/engine/replay";
import type { LedgerEntryMeta } from "@/lib/compound/db/ledger-meta";
import type { LedgerStep } from "@/lib/compound/present/derive";
import {
  formatDate, formatNav, formatUnitsDp, formatUtcStamp,
} from "@/lib/compound/present/format";
import { DeltaMoney, EmptyState, Money } from "./primitives";
import { holderHref } from "./routes";

const TYPE_LABELS: Record<string, string> = {
  deposit: "Deposit",
  payout: "Payout",
  exit: "Exit",
  equity_reading: "Equity reading",
  adjustment: "Adjustment",
};

export function LedgerTable({
  accountId, steps, meta, names, currency,
}: {
  accountId: number;
  steps: LedgerStep[];
  meta: Map<number, LedgerEntryMeta>;
  names: Record<number, string>;
  currency: string;
}) {
  if (steps.length === 0) {
    return (
      <EmptyState title="No entries yet">
        Every deposit, payout and equity reading appears here, in the order it was
        applied. Nothing else moves a figure on this account.
      </EmptyState>
    );
  }

  const voidedBy = new Map<number, number>();
  for (const s of steps) {
    if (s.entry.reversesId !== null) voidedBy.set(s.entry.reversesId, s.entry.id);
  }

  return (
    <div className="scroller">
      <table>
        <caption className="eyebrow">
          Ledger · {steps.length} {steps.length === 1 ? "entry" : "entries"} ·
          append-only, ordered by seq
        </caption>
        <thead>
          <tr>
            <th scope="col">Seq</th>
            <th scope="col">Occurred</th>
            <th scope="col">Type</th>
            <th scope="col">Holder</th>
            <th scope="col">Cash</th>
            <th scope="col">Units</th>
            <th scope="col">Equity after</th>
            <th scope="col">Units after</th>
            <th scope="col">NAV after</th>
            <th scope="col">Recorded</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => {
            const m = meta.get(s.entry.id);
            const holderId = s.entry.holderId;
            const reversedBy = voidedBy.get(s.entry.id);
            return (
              <tr key={s.entry.id} className={s.voided ? "voided" : ""}>
                <th scope="row" className="num" style={{ fontWeight: 400 }}>{s.entry.seq}</th>
                <td className="num">{formatDate(s.entry.occurredOn)}</td>
                <td>
                  {TYPE_LABELS[s.entry.type] ?? s.entry.type}
                  {s.entry.feeSettlement === null ? null : (
                    <span className="muted"> · fee as {s.entry.feeSettlement}</span>
                  )}
                  {s.voided ? (
                    <span className="muted">
                      {" "}· voided{reversedBy === undefined ? "" : ` by #${reversedBy}`}
                    </span>
                  ) : null}
                </td>
                <td>
                  {holderId === null ? "—" : (
                    <a href={holderHref(accountId, holderId)}>
                      {names[holderId] ?? `Holder #${holderId}`}
                    </a>
                  )}
                </td>
                <td>
                  {s.entry.type === "equity_reading" || s.equityDelta === 0n
                    ? <span className="num">—</span>
                    : <DeltaMoney cents={s.equityDelta} currency={currency} />}
                </td>
                <td className="num">
                  {s.unitsDelta === 0n
                    ? "—"
                    : `${s.unitsDelta > 0n ? "+" : "-"}${formatUnitsDp(
                        s.unitsDelta < 0n ? -s.unitsDelta : s.unitsDelta,
                      )}`}
                </td>
                <td><Money cents={s.after.equityCents} currency={currency} /></td>
                <td className="num">{formatUnitsDp(s.after.units)}</td>
                <td className="num">{formatNav(totalsOf(s.after))}</td>
                <td className="num muted">
                  {m === undefined ? "—" : formatUtcStamp(m.recordedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="foot" style={{ padding: "14px 16px" }}>
        The ledger is append-only. There is no edit and no delete on this screen or
        anywhere else, and none is granted in the database. A correction is a
        reversing entry, which voids both itself and the entry it reverses.
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Create `app/a/[id]/ledger/page.tsx`**

```tsx
import { withDb } from "@/lib/compound/db/client";
import { listLedgerMeta } from "@/lib/compound/db/ledger-meta";
import { requireAccount } from "@/lib/compound/load/account";
import { loadHolderNames, loadLedger, loadSeeds } from "@/lib/compound/load/ledger";
import { ledgerSteps } from "@/lib/compound/present/derive";
import { Panel } from "@/lib/compound/ui/primitives";
import { LedgerTable } from "@/lib/compound/ui/ledger-table";

export const dynamic = "force-dynamic";

export default async function LedgerPage({ params }: { params: Promise<{ id: string }> }) {
  const account = await requireAccount((await params).id);
  const [entries, seeds, names, meta] = await Promise.all([
    loadLedger(account.id),
    loadSeeds(account.id),
    loadHolderNames(account.id),
    withDb((c) => listLedgerMeta(c, account.id)),
  ]);

  return (
    <Panel flush>
      <LedgerTable
        accountId={account.id}
        steps={ledgerSteps(entries, seeds)}
        meta={new Map(meta.map((m) => [m.id, m]))}
        names={names}
        currency={account.currency}
      />
    </Panel>
  );
}
```

- [ ] **Step 4: Write `lib/compound/ui/ledger-table.test.tsx`**

```tsx
import { render, screen, within } from "@testing-library/react";
import type { LedgerEntry } from "@/lib/compound/engine/replay";
import type { LedgerEntryMeta } from "@/lib/compound/db/ledger-meta";
import { ledgerSteps } from "@/lib/compound/present/derive";
import { ADA_ID, GRACE_ID, HOLDER_NAMES, LEDGER, SEEDS } from "@/lib/compound/present/fixture";
import { LedgerTable } from "./ledger-table";

const META = new Map<number, LedgerEntryMeta>(
  LEDGER.map((e) => [e.id, {
    id: e.id,
    recordedAt: `2026-08-19T1${e.seq}:05:00.000Z`,
    note: null,
    createdBy: "00000000-0000-0000-0000-000000000001",
  }]),
);

function cellsOf(seq: string): string[] {
  const row = screen.getByRole("row", { name: new RegExp(`^${seq}\\s`) });
  return [
    ...within(row).getAllByRole("rowheader"),
    ...within(row).getAllByRole("cell"),
  ].map((c) => c.textContent ?? "");
}

function renderLedger(entries: readonly LedgerEntry[] = LEDGER, meta = META) {
  return render(
    <LedgerTable
      accountId={7}
      steps={ledgerSteps(entries, SEEDS)}
      meta={meta}
      names={HOLDER_NAMES}
      currency="USD"
    />,
  );
}

describe("LedgerTable — the running state", () => {
  beforeEach(() => renderLedger());

  it("renders the genesis deposit at NAV 1.0000", () => {
    expect(cellsOf("1")).toEqual([
      "1", "2 Mar 2026", "Deposit", "J. Marsh",
      "+$25,000.00", "+25,000.0000",
      "$25,000.00", "25,000.0000", "1.0000",
      "19 Aug 2026, 11:05 UTC",
    ]);
  });

  it("shows a reading moving equity and NAV without moving cash or units", () => {
    const c = cellsOf("2");
    expect(c[2]).toBe("Equity reading");
    expect(c[4]).toBe("—");          // cash: a reading restates, it does not move
    expect(c[5]).toBe("—");          // units
    expect(c[6]).toBe("$27,431.19");
    expect(c[8]).toBe("1.0972");
  });

  it("issues Ada units at the prevailing NAV, leaving NAV alone", () => {
    const c = cellsOf("3");
    expect(c[3]).toBe("Ada Lovelace");
    expect(c[4]).toBe("+$10,000.00");
    expect(c[5]).toBe("+9,113.7132");
    expect(c[8]).toBe("1.0972");     // unchanged from seq 2
  });

  it("ends on the state the desk shows", () => {
    const c = cellsOf("6");
    expect(c[6]).toBe("$55,743.91");
    expect(c[7]).toBe("40,222.4547");
    expect(c[8]).toBe("1.3858");
  });

  it("shows the recorded-at stamp in UTC, distinct from the occurred date", () => {
    const c = cellsOf("1");
    expect(c[1]).toBe("2 Mar 2026");                   // broker-server date
    expect(c[9]).toBe("19 Aug 2026, 11:05 UTC");       // when it was written down
  });
});

describe("LedgerTable — a payout", () => {
  const payout: LedgerEntry = {
    id: 7, seq: 7, holderId: ADA_ID, occurredOn: "2026-08-18", type: "payout",
    amountCents: 263_060n, feeSettlement: "units", splitBpsApplied: 4000, reversesId: null,
  };

  it("shows the cash that LEFT, not the amount that was requested", () => {
    // The entry says 2630.60. 1578.36 left; the fee stayed in as units.
    renderLedger([...LEDGER, payout]);
    const c = cellsOf("7");
    expect(c[4]).toBe("-$1,578.36");
    expect(c[4]).not.toBe("-$2,630.60");
  });

  it("nets the unit movement across the redemption and the fee units", () => {
    renderLedger([...LEDGER, payout]);
    // Ada surrenders 1,898.1300; the manager is issued 759.2520. Net -1,138.8780.
    expect(cellsOf("7")[5]).toBe("-1,138.8780");
  });

  it("says how the fee settled", () => {
    renderLedger([...LEDGER, payout]);
    expect(cellsOf("7")[2]).toContain("fee as units");
  });

  it("leaves NAV where it was", () => {
    renderLedger([...LEDGER, payout]);
    expect(cellsOf("7")[8]).toBe("1.3858");
  });
});

describe("LedgerTable — a reversal", () => {
  const reversal: LedgerEntry = {
    id: 7, seq: 7, holderId: GRACE_ID, occurredOn: "2026-08-20", type: "deposit",
    amountCents: -750_000n, feeSettlement: null, splitBpsApplied: null, reversesId: 5,
  };

  it("strikes both entries and names which one voided which", () => {
    renderLedger([...LEDGER, reversal]);
    expect(cellsOf("5")[2]).toContain("voided by #7");
    expect(cellsOf("7")[2]).toContain("voided");
    expect(screen.getByRole("row", { name: /^5\s/ })).toHaveClass("voided");
  });

  it("shows the state after a voided entry as if it never applied", () => {
    renderLedger([...LEDGER, reversal]);
    // Grace's 7,500 deposit is voided, so equity at seq 5 is still 41,883.07.
    expect(cellsOf("5")[6]).toBe("$41,883.07");
  });
});

describe("LedgerTable — provenance and safety", () => {
  it("offers no edit and no delete", () => {
    renderLedger();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link", { name: /edit|delete|void|reverse/i })).toBeNull();
  });

  it("says the ledger is append-only in words, not only by omission", () => {
    renderLedger();
    expect(screen.getByText(/append-only\. There is no edit and no delete/))
      .toBeInTheDocument();
  });

  it("renders a dash rather than crashing when metadata is missing", () => {
    renderLedger(LEDGER, new Map());
    expect(cellsOf("1")[9]).toBe("—");
  });

  it("says what the page is for when there is nothing on it", () => {
    render(
      <LedgerTable accountId={7} steps={[]} meta={new Map()} names={{}} currency="USD" />,
    );
    expect(screen.getByText("No entries yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
```

**How these bite.** Print `entry.amountCents` in the cash column and the payout test reads `-$2,630.60`. Compute the after-state with a running total instead of a prefix fold and the reversal test's `$41,883.07` becomes `$49,383.07`, because a running total has no way to un-apply an entry it already added. Show `$0.00` instead of `—` for a reading's cash and one assertion names it. Add a reverse button and the append-only test fails.

- [ ] **Step 5: Write `lib/compound/db/ledger-meta.db.test.ts`**

```typescript
import { withDbTransaction } from "@/lib/compound/db/client";
import { listLedgerMeta } from "@/lib/compound/db/ledger-meta";
import { seedTwoAccounts, seedLedger } from "@/lib/compound/db/test-harness";

const rollback = (e: Error) => { if (e.message !== "rollback") throw e; };

describe("listLedgerMeta", () => {
  it("returns entries in seq order, not id order", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      // seedLedger writes ids and seqs that disagree, so an order-by-id bug
      // is visible. If plan 3's harness does not do that, make it.
      const ids = await seedLedger(c, mine.accountId);
      const meta = await listLedgerMeta(c, mine.accountId);
      expect(meta.map((m) => m.id)).toEqual(ids.inSeqOrder);
      expect(meta.map((m) => m.id)).not.toEqual([...ids.inSeqOrder].sort((a, b) => a - b));
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("returns recorded_at as a UTC ISO string, not a Date", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      await seedLedger(c, mine.accountId);
      const [first] = await listLedgerMeta(c, mine.accountId);
      expect(typeof first!.recordedAt).toBe("string");
      expect(first!.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("returns only this account's entries", async () => {
    await withDbTransaction(async (c) => {
      const { mine, theirs } = await seedTwoAccounts(c);
      await seedLedger(c, mine.accountId);
      await seedLedger(c, theirs.accountId);
      const mineMeta = await listLedgerMeta(c, mine.accountId);
      const theirsMeta = await listLedgerMeta(c, theirs.accountId);
      expect(mineMeta.length).toBeGreaterThan(0);
      const overlap = mineMeta.filter((m) => theirsMeta.some((t) => t.id === m.id));
      expect(overlap).toEqual([]);
      throw new Error("rollback");
    }).catch(rollback);
  });
});
```

> **`seedLedger` may not exist in plan 3's harness.** If it does not, add it there rather than here — Tasks 12, 13 and 14's integration tests all need one, and three inline seeders will drift. It must write `id` order and `seq` order that **disagree**, or the seq-ordering assertion above cannot fail.

- [ ] **Step 6: Run the gates and prove two probes**

```bash
supabase db reset && pnpm typecheck && pnpm test && pnpm test:db && pnpm build
```

Then, reverting each:

1. In `LedgerTable`, print `s.entry.amountCents` in the cash column. Expect exactly the payout cash assertion to fail — the six deposit and reading rows still pass, which is why the fixture has a payout in it.
2. In `listLedgerMeta`, change `order by seq asc` to `order by id asc`. Expect the seq-order integration test to fail.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "$(cat <<'MSG'
feat(desk): the ledger page, with the pool's state after every entry

Each row's after-state comes from folding the prefix, so this page cannot
disagree with the desk. The cash column is the equity delta rather than the
stored amount, because replay recomputes a payout and never reads that field.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 10: `/a/[id]/holders/[hid]` — the per-holder statement

The last surface in Phase A, and the one an investor reads. It carries the position, the history, and the figure they will ask about: what they would get if they withdrew today.

**It also resolves decision D-A in words.** A holder's value has two answers — the allocated one on the statement and the floored one that settles — and they can differ by a cent. On the canonical fixture Ada reads **$12,630.61** on the desk and **$12,630.60** on her payout. Both are right. This page is where that is said out loud, so it is never discovered mid-dispute.

**The wording lives in one module.** `present/wording.ts` holds the payout receipt's labels and hints, and both this page and Task 13's receipt import them. Two screens describing the same figure in two different phrasings is how a product ends up arguing with itself.

**Files:**
- Create: `lib/compound/present/wording.ts`
- Create: `lib/compound/present/holder.ts`
- Create: `lib/compound/ui/holder-statement.tsx`
- Create: `app/a/[id]/holders/[hid]/page.tsx`
- Test: `lib/compound/present/holder.test.ts`
- Test: `lib/compound/present/wording.test.ts`
- Test: `lib/compound/ui/holder-statement.test.tsx`

**Interfaces:**
- Consumes: `quote`, `Quote` from `@/lib/compound/engine/quote`; `valueOfUnits`, `allocateValues` from `@/lib/compound/engine/nav`; `LedgerStep`, `ledgerSteps` from `@/lib/compound/present/derive`; `listHolders` from `@/lib/compound/db/holders`
- Produces:
  - `PAYOUT_WORDS` — every label and hint on a payout receipt
  - `interface HolderPosition { holder; ppm; statementValueCents; settlementValueCents; profitCents; recoveryCents; markState; profitQuote; exitQuote }`
  - `holderPosition(state: PoolState, holderId: number): HolderPosition`
  - `interface HolderStatementRow { seq; occurredOn; type; voided; own; unitsDelta; unitsAfter; basisAfter; valueAfter; valueDelta }`
  - `holderStatement(steps: readonly LedgerStep[], holderId: number): HolderStatementRow[]`
  - `HolderStatement` component

- [ ] **Step 1: Create `lib/compound/present/wording.ts`**

Every phrase on a payout receipt, in one place. The brief for this product is explicit that an investor reads these figures back in a dispute, so each accounting term appears with the plain-English sentence that defines it.

```typescript
/**
 * The words on a payout receipt.
 *
 * They live here rather than inside the component because two screens render
 * them: the holder statement's "if you withdrew today" block and the payout
 * sheet itself. A holder who reads "Capital in" on one and "Cost basis" on the
 * other has been given two names for one number, and will reasonably ask which
 * is which at exactly the wrong moment.
 *
 * "Cost basis, their high-water mark" is precise and is jargon. What a
 * non-accountant reads is "what they have put in", with the mechanism stated
 * underneath in a sentence: it rises when they add capital, does not move when
 * they take profit, and resets when they exit. That sentence IS the high-water
 * mark; the term is not needed to explain it, and is kept only as a
 * parenthetical for readers who already know it.
 */
export const PAYOUT_WORDS = {
  unitsHeld: "Units held",
  unitsHeldHint: "Their share of the pool, in units.",

  valueNow: "Value at today's NAV",
  valueNowHint: "Units held, at the NAV this payout settles against.",

  capitalIn: (name: string) => `What ${name} has put in`,
  capitalInHint: (name: string) =>
    `Profit is measured against this. It rises when ${name} adds capital, does not ` +
    `move when ${name} takes profit, and resets to zero on a full exit — which is ` +
    `what a high-water mark is.`,

  profit: "Profit above that",
  profitHint: "Value today, less what has been put in.",

  holderShare: (name: string, pct: string) => `${name}'s share of the profit (${pct}%)`,
  managerFee: (pct: string) => `Your fee (${pct}%)`,
  managerFeeHint: "Charged only on withdrawal, and only on profit. Never on a paper gain.",

  unitsRedeemed: (name: string) => `Units ${name} gives up`,
  unitsKept: (name: string) => `Units ${name} keeps`,
  unitsKeptHint: "And what they are worth immediately after this payout.",

  receives: (name: string) => `${name} receives`,

  feeSettlement: "How your fee settles",
  feeSettlementUnits: "Keep it in the account, as units",
  feeSettlementUnitsHint:
    "The cash stays in the pool and you are issued units for it. Your capital in rises " +
    "by the fee. NAV does not move.",
  feeSettlementCash: "Take it out, as cash",
  feeSettlementCashHint:
    "Equity falls by the fee and no units are issued. NAV does not move.",

  belowMarkTitle: "Below the high-water mark",
  belowMark: (name: string, put: string, worth: string, recovery: string) =>
    `${name} has put in ${put}. The holding is worth ${worth} today. ` +
    `${recovery} of recovery is needed before any profit can be withdrawn.`,
  atMarkTitle: "Exactly at the high-water mark",
  atMark: (name: string) =>
    `${name}'s holding is worth exactly what they have put in. There is no profit to ` +
    `withdraw yet, and no fee would be charged.`,
  exitStillAvailable: (worth: string) =>
    `A full exit is still available, at today's value of ${worth}, with no fee.`,

  profitOnly: "Profit only",
  profitOnlyHint: (name: string) =>
    `${name} takes their profit and keeps their units. What they have put in is unchanged.`,
  exitInFull: "Exit in full",
  exitInFullHint: (name: string) =>
    `${name} surrenders every unit and leaves the pool. What they have put in resets to zero.`,

  statementVsSettlement: (statement: string, settlement: string) =>
    `This statement values the holding at ${statement}, which is its exact share of ` +
    `account equity. A payout settles at ${settlement}, rounded down to the cent so the ` +
    `pool is never short. The difference is at most one cent and it stays in the pool.`,
} as const;
```

- [ ] **Step 2: Create `lib/compound/present/holder.ts`**

```typescript
/**
 * One holder's position and history.
 *
 * markState exists because quote()'s belowHighWaterMark is `profitCents <= 0n`,
 * which reports a holder sitting EXACTLY on their mark as below it. That is
 * defensible inside the engine — zero profit and negative profit both mean no
 * fee — and it is wrong on a screen, where "below the high-water mark, $0.00 of
 * recovery needed" reads as a glitch. Branching on the sign of profitCents here
 * fixes the presentation without touching an engine that 125 tests agree with.
 */
import type { Cents, Units } from "@/lib/compound/engine/money";
import { allocateValues, valueOfUnits } from "@/lib/compound/engine/nav";
import { quote, type Quote } from "@/lib/compound/engine/quote";
import {
  totalsOf, type HolderState, type LedgerEntryType, type PoolState,
} from "@/lib/compound/engine/replay";
import type { LedgerStep } from "./derive";
import { allocateShares } from "./rail";

export interface HolderPosition {
  holder: HolderState;
  ppm: number;
  /** ALLOCATED. Sums with the other holders to equity exactly. */
  statementValueCents: Cents;
  /** FLOORED. What a payout settles at. Can be one cent lower. */
  settlementValueCents: Cents;
  /** Against the SETTLEMENT value, because that is what a fee is charged on. */
  profitCents: Cents;
  /** Positive only when below the mark. Zero otherwise. */
  recoveryCents: Cents;
  markState: "above" | "at" | "below";
  profitQuote: Quote;
  exitQuote: Quote;
}

export function holderPosition(state: PoolState, holderId: number): HolderPosition {
  const index = state.holders.findIndex((h) => h.holderId === holderId);
  if (index === -1) throw new RangeError(`no holder ${holderId} on this account`);
  const holder = state.holders[index]!;
  const totals = totalsOf(state);

  const common = {
    totals,
    holderUnits: holder.units,
    basisCents: holder.basisCents,
    splitBps: holder.splitBps,
    isManager: holder.isManager,
  };
  const profitQuote = quote({ ...common, mode: "profit" });
  const exitQuote = quote({ ...common, mode: "exit" });

  const settlementValueCents = valueOfUnits(totals, holder.units);
  const profitCents = settlementValueCents - holder.basisCents;

  return {
    holder,
    ppm: allocateShares(state.holders.map((h) => h.units), state.units)[index]!,
    statementValueCents: allocateValues(totals, state.holders.map((h) => h.units))[index]!,
    settlementValueCents,
    profitCents,
    recoveryCents: profitCents < 0n ? -profitCents : 0n,
    markState: profitCents > 0n ? "above" : profitCents === 0n ? "at" : "below",
    profitQuote,
    exitQuote,
  };
}

export interface HolderStatementRow {
  seq: number;
  occurredOn: string;
  type: LedgerEntryType;
  voided: boolean;
  /** True when the entry is this holder's own. A reading is nobody's. */
  own: boolean;
  /** Signed. Zero for an entry that does not move this holder's units. */
  unitsDelta: Units;
  unitsAfter: Units;
  basisAfter: Cents;
  /** Allocated, so a row here agrees with the desk on the same date. */
  valueAfter: Cents;
  /** Signed. What this entry did to their value. */
  valueDelta: Cents;
}

/**
 * Every entry on the account, from this holder's point of view.
 *
 * Readings are included even though they are nobody's entry, because a
 * statement that showed only a holder's own deposits could not explain why
 * their value changed between them — which is the single most likely question
 * a statement has to answer.
 */
export function holderStatement(
  steps: readonly LedgerStep[],
  holderId: number,
): HolderStatementRow[] {
  const valueIn = (state: PoolState): Cents => {
    const i = state.holders.findIndex((h) => h.holderId === holderId);
    if (i === -1) return 0n;
    return allocateValues(totalsOf(state), state.holders.map((h) => h.units))[i]!;
  };
  const holderIn = (state: PoolState): HolderState | undefined =>
    state.holders.find((h) => h.holderId === holderId);

  return steps.map((s) => {
    const before = holderIn(s.before);
    const after = holderIn(s.after);
    return {
      seq: s.entry.seq,
      occurredOn: s.entry.occurredOn,
      type: s.entry.type,
      voided: s.voided,
      own: s.entry.holderId === holderId,
      unitsDelta: (after?.units ?? 0n) - (before?.units ?? 0n),
      unitsAfter: after?.units ?? 0n,
      basisAfter: after?.basisCents ?? 0n,
      valueAfter: valueIn(s.after),
      valueDelta: valueIn(s.after) - valueIn(s.before),
    };
  });
}
```

- [ ] **Step 3: Write `lib/compound/present/holder.test.ts` and `wording.test.ts`**

```typescript
// lib/compound/present/holder.test.ts
import { UNIT_SCALE, centsFromDecimal } from "@/lib/compound/engine/money";
import { fold, type PoolState } from "@/lib/compound/engine/replay";
import { ADA_ID, GRACE_ID, LEDGER, LEDGER_UNDERWATER, MANAGER_ID, SEEDS }
  from "./fixture";
import { ledgerSteps } from "./derive";
import { holderPosition, holderStatement } from "./holder";

const c = centsFromDecimal;
const STATE = fold(LEDGER, SEEDS);
const UNDER = fold(LEDGER_UNDERWATER, SEEDS);

describe("holderPosition — above the mark", () => {
  const p = holderPosition(STATE, ADA_ID);

  it("gives the statement value and the settlement value separately", () => {
    expect(p.statementValueCents).toBe(c("12630.61"));   // allocated
    expect(p.settlementValueCents).toBe(c("12630.60"));  // floored
  });

  it("measures profit against the settlement value, because that is what a fee is charged on", () => {
    expect(p.profitCents).toBe(c("2630.60"));
    expect(p.profitCents).not.toBe(c("2630.61"));
  });

  it("reports the mark state as above, and needs no recovery", () => {
    expect(p.markState).toBe("above");
    expect(p.recoveryCents).toBe(0n);
  });

  it("quotes both modes against the same NAV", () => {
    expect(p.profitQuote.feeCents).toBe(c("1052.24"));
    expect(p.profitQuote.toHolderCents).toBe(c("1578.36"));
    expect(p.exitQuote.feeCents).toBe(c("1052.24"));
    expect(p.exitQuote.toHolderCents).toBe(c("11578.36"));
  });

  it("carries the holder's share", () => {
    expect(p.ppm).toBe(226_583);
  });
});

describe("holderPosition — below the mark", () => {
  it("states the recovery for each holder", () => {
    expect(holderPosition(UNDER, MANAGER_ID).recoveryCents).toBe(c("1312.71"));
    expect(holderPosition(UNDER, ADA_ID).recoveryCents).toBe(c("1364.84"));
    expect(holderPosition(UNDER, GRACE_ID).recoveryCents).toBe(c("1712.02"));
  });

  it("charges no fee in either mode", () => {
    const p = holderPosition(UNDER, ADA_ID);
    expect(p.profitQuote.feeCents).toBe(0n);
    expect(p.exitQuote.feeCents).toBe(0n);
  });

  it("still lets a full exit take the whole value", () => {
    expect(holderPosition(UNDER, ADA_ID).exitQuote.toHolderCents).toBe(c("8635.16"));
  });

  it("pays nothing in profit mode", () => {
    expect(holderPosition(UNDER, ADA_ID).profitQuote.toHolderCents).toBe(0n);
  });
});

describe("holderPosition — exactly at the mark", () => {
  // Deliberately tiny and deliberately awkward: 700 cents across 3 units.
  const atMark: PoolState = {
    equityCents: 700n,
    units: 3n * UNIT_SCALE,
    holders: [{
      holderId: 1, isManager: false, splitBps: 4000,
      units: 3n * UNIT_SCALE, basisCents: 700n, status: "active",
    }],
    lastReadingOn: "2026-08-14",
    seq: 1,
  };

  it("says AT the mark, not below it", () => {
    // quote().belowHighWaterMark is `profitCents <= 0n` and reports true here.
    // A screen that rendered that would say "below the high-water mark, $0.00
    // of recovery needed", which reads as a bug to the person it is shown to.
    const p = holderPosition(atMark, 1);
    expect(p.profitCents).toBe(0n);
    expect(p.markState).toBe("at");
    expect(p.recoveryCents).toBe(0n);
    expect(p.profitQuote.belowHighWaterMark).toBe(true);   // the engine's view
  });
});

describe("holderPosition — a one-cent statement/settlement gap", () => {
  // Two holders, 700 cents, 3 units. Floors are 233 and 466, one cent short of
  // 700; largest remainder awards the cent to the second holder.
  const split: PoolState = {
    equityCents: 700n,
    units: 3n * UNIT_SCALE,
    holders: [
      { holderId: 1, isManager: true, splitBps: 0, units: 1n * UNIT_SCALE, basisCents: 200n, status: "active" },
      { holderId: 2, isManager: false, splitBps: 4000, units: 2n * UNIT_SCALE, basisCents: 400n, status: "active" },
    ],
    lastReadingOn: "2026-08-14",
    seq: 1,
  };

  it("gives holder 2 a statement value one cent above their settlement value", () => {
    const p = holderPosition(split, 2);
    expect(p.statementValueCents).toBe(467n);
    expect(p.settlementValueCents).toBe(466n);
  });

  it("leaves holder 1's two figures equal", () => {
    const p = holderPosition(split, 1);
    expect(p.statementValueCents).toBe(233n);
    expect(p.settlementValueCents).toBe(233n);
  });
});

describe("holderPosition — refusals", () => {
  it("refuses a holder who is not on this account", () => {
    expect(() => holderPosition(STATE, 99)).toThrow(/no holder 99 on this account/);
  });
});

describe("holderStatement", () => {
  const rows = holderStatement(ledgerSteps(LEDGER, SEEDS), ADA_ID);

  it("includes every entry, not only Ada's own", () => {
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.own).map((r) => r.seq)).toEqual([3]);
  });

  it("shows Ada holding nothing before her deposit", () => {
    expect(rows[0]!.unitsAfter).toBe(0n);
    expect(rows[0]!.valueAfter).toBe(0n);
  });

  it("issues her units on her deposit and sets her capital in", () => {
    expect(rows[2]!.unitsDelta).toBeGreaterThan(0n);
    expect(rows[2]!.basisAfter).toBe(c("10000.00"));
    expect(rows[2]!.valueAfter).toBe(c("10000.00"));
  });

  it("moves her value on a reading she had no part in", () => {
    // This is why readings are on a holder's statement at all: without seq 4
    // her value jumps between her own entries with nothing to explain it.
    expect(rows[3]!.own).toBe(false);
    expect(rows[3]!.unitsDelta).toBe(0n);
    expect(rows[3]!.valueDelta).toBeGreaterThan(0n);
  });

  it("ends on the figure her statement head shows", () => {
    expect(rows[5]!.valueAfter).toBe(c("12630.61"));
    expect(rows[5]!.unitsAfter).toBe(holderPosition(STATE, ADA_ID).holder.units);
  });

  it("leaves her value unmoved by another holder's deposit", () => {
    // Grace joins at seq 5. Ada's units do not change and neither does her
    // value: a deposit issues units at the prevailing NAV, which is what makes
    // staggered entry safe.
    expect(rows[4]!.unitsDelta).toBe(0n);
    expect(rows[4]!.valueDelta).toBe(0n);
  });
});
```

```typescript
// lib/compound/present/wording.test.ts
import { PAYOUT_WORDS } from "./wording";

describe("PAYOUT_WORDS", () => {
  it("names the holder in every sentence that is about them", () => {
    expect(PAYOUT_WORDS.capitalIn("Ada")).toBe("What Ada has put in");
    expect(PAYOUT_WORDS.receives("Ada")).toBe("Ada receives");
    expect(PAYOUT_WORDS.unitsRedeemed("Ada")).toBe("Units Ada gives up");
  });

  it("explains the high-water mark without requiring the term", () => {
    const hint = PAYOUT_WORDS.capitalInHint("Ada");
    expect(hint).toContain("rises when Ada adds capital");
    expect(hint).toContain("does not move when Ada takes profit");
    expect(hint).toContain("resets to zero on a full exit");
  });

  it("says when a fee is charged, in the fee's own hint", () => {
    expect(PAYOUT_WORDS.managerFeeHint).toContain("only on withdrawal");
    expect(PAYOUT_WORDS.managerFeeHint).toContain("only on profit");
    expect(PAYOUT_WORDS.managerFeeHint).toContain("Never on a paper gain");
  });

  it("states the recovery figure in the below-the-mark sentence", () => {
    expect(PAYOUT_WORDS.belowMark("Ada", "$10,000.00", "$8,635.16", "$1,364.84"))
      .toBe(
        "Ada has put in $10,000.00. The holding is worth $8,635.16 today. " +
        "$1,364.84 of recovery is needed before any profit can be withdrawn.",
      );
  });

  it("keeps exit available in the same breath as refusing profit", () => {
    expect(PAYOUT_WORDS.exitStillAvailable("$8,635.16"))
      .toContain("still available, at today's value of $8,635.16, with no fee");
  });

  it("does not say 'below the mark' when the holder is exactly on it", () => {
    expect(PAYOUT_WORDS.atMark("Ada")).not.toMatch(/below/i);
    expect(PAYOUT_WORDS.atMark("Ada")).toContain("no profit to withdraw yet");
  });

  it("explains both fee settlements as NAV-neutral", () => {
    expect(PAYOUT_WORDS.feeSettlementUnitsHint).toContain("NAV does not move");
    expect(PAYOUT_WORDS.feeSettlementCashHint).toContain("NAV does not move");
    expect(PAYOUT_WORDS.feeSettlementUnitsHint).toContain("capital in rises by the fee");
  });

  it("explains the statement/settlement gap and where the cent goes", () => {
    const s = PAYOUT_WORDS.statementVsSettlement("$12,630.61", "$12,630.60");
    expect(s).toContain("exact share of account equity");
    expect(s).toContain("rounded down to the cent so the pool is never short");
    expect(s).toContain("at most one cent and it stays in the pool");
  });
});
```

**How these bite.** These read like tests of prose, and two of them are load-bearing. `does not say 'below the mark' when the holder is exactly on it` fails the moment someone renders `quote().belowHighWaterMark` directly, which is the engine's carried-forward finding arriving on a screen. `states the recovery figure` fails if the sentence is reworded to omit the number, which is the difference between a refusal a manager can act on and one they cannot.

- [ ] **Step 4: Create `lib/compound/ui/holder-statement.tsx`**

```tsx
/**
 * One holder's statement.
 *
 * The withdraw block is a preview of the payout receipt and imports the same
 * words from PAYOUT_WORDS. In Phase A it has no button; Task 13 adds the link.
 */
import type { HolderRow } from "@/lib/compound/db/holders";
import type { PoolTotals } from "@/lib/compound/engine/nav";
import type { HolderPosition, HolderStatementRow } from "@/lib/compound/present/holder";
import {
  formatDate, formatMoney, formatNav, formatSplit, formatSplitWords, formatUnitsDp,
} from "@/lib/compound/present/format";
import { PAYOUT_WORDS } from "@/lib/compound/present/wording";
import { DeltaMoney, Eyebrow, FeeMoney, LabelledFigure, Money, Panel, Share, Tag }
  from "./primitives";
import { Receipt, ReceiptLine } from "./receipt";

const TYPE_LABELS: Record<string, string> = {
  deposit: "Deposit", payout: "Payout", exit: "Exit",
  equity_reading: "Account revalued", adjustment: "Adjustment",
};

export function HolderStatement({
  holder, position, rows, totals, currency, withdrawAction,
}: {
  holder: HolderRow;
  position: HolderPosition;
  rows: HolderStatementRow[];
  totals: PoolTotals;
  currency: string;
  /** Phase B fills this. */
  withdrawAction?: React.ReactNode;
}) {
  const name = holder.name;
  const money = (c: bigint) => formatMoney(c, { currency });
  const managerPct = formatSplit(holder.splitBps).split(" / ")[1]!;
  const holderPct = formatSplit(holder.splitBps).split(" / ")[0]!;
  const derivedStatus = position.holder.status;

  return (
    <>
      <Panel>
        <Eyebrow>
          Holder statement · joined{" "}
          {holder.joinedAt === null ? "—" : formatDate(holder.joinedAt)}
        </Eyebrow>
        <h1 style={{ fontFamily: "var(--serif)", fontWeight: 400, fontSize: 30, margin: "6px 0 2px" }}>
          {name}
          {holder.isManager ? <Tag>Manager</Tag> : null}
          {derivedStatus === "closed" ? <Tag>Closed</Tag> : null}
        </h1>
        <p className="muted" style={{ margin: "0 0 16px", fontSize: 13 }}>
          {holder.isManager
            ? "You manage this account. No fee is charged on your own holding."
            : formatSplitWords(holder.splitBps, name)}
        </p>

        <div className="kpi">
          <LabelledFigure label="Units held" className="kpi-item">
            {formatUnitsDp(position.holder.units)}
          </LabelledFigure>
          <LabelledFigure label="Share of the pool" className="kpi-item">
            <Share ppm={position.ppm} />
          </LabelledFigure>
          <LabelledFigure label={PAYOUT_WORDS.capitalIn(name)} className="kpi-item">
            <Money cents={position.holder.basisCents} currency={currency} />
          </LabelledFigure>
          <LabelledFigure label="Value on this statement" className="kpi-item">
            <Money cents={position.statementValueCents} currency={currency} />
          </LabelledFigure>
          <LabelledFigure label="Profit above that" className="kpi-item">
            <DeltaMoney cents={position.profitCents} currency={currency} />
          </LabelledFigure>
        </div>

        <p className="split-note">
          {PAYOUT_WORDS.statementVsSettlement(
            money(position.statementValueCents),
            money(position.settlementValueCents),
          )}
        </p>
      </Panel>

      <Panel>
        <Eyebrow>If {name} withdrew today · NAV {formatNav(totals)}</Eyebrow>

        {position.markState === "above" ? (
          <Receipt label={`Withdrawal preview for ${name}`}>
            <ReceiptLine label={PAYOUT_WORDS.valueNow} hint={PAYOUT_WORDS.valueNowHint}>
              <span className="num">{money(position.settlementValueCents)}</span>
            </ReceiptLine>
            <ReceiptLine label={PAYOUT_WORDS.profit} hint={PAYOUT_WORDS.profitHint}>
              <DeltaMoney cents={position.profitCents} currency={currency} />
            </ReceiptLine>
            <ReceiptLine label={PAYOUT_WORDS.holderShare(name, holderPct)}>
              <span className="num">{money(position.profitQuote.toHolderCents)}</span>
            </ReceiptLine>
            <ReceiptLine
              label={PAYOUT_WORDS.managerFee(managerPct)}
              hint={PAYOUT_WORDS.managerFeeHint}
              tone="fee"
            >
              <FeeMoney cents={position.profitQuote.feeCents} currency={currency} />
            </ReceiptLine>
            <ReceiptLine label={`${PAYOUT_WORDS.exitInFull} — ${name} receives`}>
              <span className="num">{money(position.exitQuote.toHolderCents)}</span>
            </ReceiptLine>
          </Receipt>
        ) : (
          <div className="banner-halt" role="status">
            <strong>
              {position.markState === "below"
                ? PAYOUT_WORDS.belowMarkTitle
                : PAYOUT_WORDS.atMarkTitle}
            </strong>
            <p style={{ margin: "6px 0 0" }}>
              {position.markState === "below"
                ? PAYOUT_WORDS.belowMark(
                    name,
                    money(position.holder.basisCents),
                    money(position.settlementValueCents),
                    money(position.recoveryCents),
                  )
                : PAYOUT_WORDS.atMark(name)}
            </p>
            <p style={{ margin: "6px 0 0" }}>
              {PAYOUT_WORDS.exitStillAvailable(money(position.exitQuote.toHolderCents))}
            </p>
          </div>
        )}

        {withdrawAction ? <div className="actions">{withdrawAction}</div> : null}
      </Panel>

      <Panel flush>
        <div className="scroller">
          <table>
            <caption className="eyebrow">{name}&apos;s history</caption>
            <thead>
              <tr>
                <th scope="col">Occurred</th>
                <th scope="col">What happened</th>
                <th scope="col">Units in/out</th>
                <th scope="col">Units after</th>
                <th scope="col">Capital in</th>
                <th scope="col">Value after</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.seq} className={r.voided ? "voided" : r.own ? "own" : ""}>
                  <th scope="row" className="num" style={{ fontWeight: 400 }}>
                    {formatDate(r.occurredOn)}
                  </th>
                  <td>
                    {TYPE_LABELS[r.type] ?? r.type}
                    {r.own ? null : <span className="muted"> · account-wide</span>}
                    {r.voided ? <span className="muted"> · voided</span> : null}
                  </td>
                  <td className="num">
                    {r.unitsDelta === 0n
                      ? "—"
                      : `${r.unitsDelta > 0n ? "+" : "-"}${formatUnitsDp(
                          r.unitsDelta < 0n ? -r.unitsDelta : r.unitsDelta,
                        )}`}
                  </td>
                  <td className="num">{formatUnitsDp(r.unitsAfter)}</td>
                  <td><Money cents={r.basisAfter} currency={currency} /></td>
                  <td><Money cents={r.valueAfter} currency={currency} /></td>
                  <td>
                    {r.valueDelta === 0n
                      ? <span className="num">—</span>
                      : <DeltaMoney cents={r.valueDelta} currency={currency} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
```

- [ ] **Step 5: Create `app/a/[id]/holders/[hid]/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import { withDb } from "@/lib/compound/db/client";
import { listHolders } from "@/lib/compound/db/holders";
import { totalsOf } from "@/lib/compound/engine/replay";
import { requireAccount } from "@/lib/compound/load/account";
import { loadLedger, loadPoolState, loadSeeds } from "@/lib/compound/load/ledger";
import { ledgerSteps } from "@/lib/compound/present/derive";
import { holderPosition, holderStatement } from "@/lib/compound/present/holder";
import { HolderStatement } from "@/lib/compound/ui/holder-statement";

export const dynamic = "force-dynamic";

export default async function HolderPage({
  params,
}: { params: Promise<{ id: string; hid: string }> }) {
  const { id, hid } = await params;
  const account = await requireAccount(id);
  if (!/^[1-9][0-9]{0,17}$/.test(hid)) notFound();
  const holderId = Number(hid);

  const [state, entries, seeds, holders] = await Promise.all([
    loadPoolState(account.id),
    loadLedger(account.id),
    loadSeeds(account.id),
    withDb((c) => listHolders(c, account.id)),
  ]);

  const holder = holders.find((h) => h.id === holderId);
  if (holder === undefined) notFound();

  return (
    <HolderStatement
      holder={holder}
      position={holderPosition(state, holderId)}
      rows={holderStatement(ledgerSteps(entries, seeds), holderId)}
      totals={totalsOf(state)}
      currency={account.currency}
    />
  );
}
```

- [ ] **Step 6: Write `lib/compound/ui/holder-statement.test.tsx`**

```tsx
import { render, screen, within } from "@testing-library/react";
import type { HolderRow } from "@/lib/compound/db/holders";
import { fold, totalsOf } from "@/lib/compound/engine/replay";
import { ledgerSteps } from "@/lib/compound/present/derive";
import { holderPosition, holderStatement } from "@/lib/compound/present/holder";
import { ADA_ID, LEDGER, LEDGER_UNDERWATER, SEEDS } from "@/lib/compound/present/fixture";
import { HolderStatement } from "./holder-statement";

const ADA: HolderRow = {
  id: ADA_ID, accountId: 7, name: "Ada Lovelace", email: "ada@example.com",
  userId: null, isManager: false, splitBps: 4000, joinedAt: "2026-05-04", status: "active",
};

function renderFor(ledger = LEDGER, holder: HolderRow = ADA) {
  const state = fold(ledger, SEEDS);
  return render(
    <HolderStatement
      holder={holder}
      position={holderPosition(state, holder.id)}
      rows={holderStatement(ledgerSteps(ledger, SEEDS), holder.id)}
      totals={totalsOf(state)}
      currency="USD"
    />,
  );
}

describe("HolderStatement — the position", () => {
  beforeEach(() => renderFor());

  it("reads back every headline figure", () => {
    expect(screen.getByLabelText("Units held").textContent).toBe("9,113.7132");
    expect(screen.getByLabelText("Share of the pool").textContent).toBe("22.66%");
    expect(screen.getByLabelText("What Ada Lovelace has put in").textContent).toBe("$10,000.00");
    expect(screen.getByLabelText("Value on this statement").textContent).toBe("$12,630.61");
    expect(screen.getByLabelText("Profit above that").textContent).toBe("+$2,630.60");
  });

  it("states both values and where the cent goes, before anyone has to ask", () => {
    const note = screen.getByText(/This statement values the holding at/);
    expect(note.textContent).toContain("$12,630.61");
    expect(note.textContent).toContain("$12,630.60");
    expect(note.textContent).toContain("so the pool is never short");
  });

  it("states the terms in a sentence, using Ada's own split", () => {
    expect(screen.getByText(/Ada Lovelace keeps 60% of profit and you keep 40%/))
      .toBeInTheDocument();
  });
});

describe("HolderStatement — the withdrawal preview, above the mark", () => {
  beforeEach(() => renderFor());

  it("shows the value it would settle at, not the statement value", () => {
    expect(screen.getByLabelText(/Value at today's NAV/).textContent).toBe("$12,630.60");
  });

  it("splits the profit and names the fee as the fee", () => {
    expect(screen.getByLabelText("Ada Lovelace's share of the profit (60%)").textContent)
      .toBe("$1,578.36");
    expect(screen.getByLabelText("Your fee (40%)").textContent).toBe("$1,052.24");
  });

  it("shows what a full exit would pay", () => {
    expect(screen.getByLabelText(/Exit in full — Ada Lovelace receives/).textContent)
      .toBe("$11,578.36");
  });

  it("puts the fee line in amber and nothing else", () => {
    expect(document.querySelectorAll(".receipt-line.is-fee")).toHaveLength(1);
  });

  it("adds up: the holder's share plus the fee is the profit", () => {
    const share = BigInt(screen.getByLabelText(/share of the profit/).textContent!.replace(/\D/g, ""));
    const fee = BigInt(screen.getByLabelText("Your fee (40%)").textContent!.replace(/\D/g, ""));
    const profit = BigInt(screen.getByLabelText("Profit above that").textContent!.replace(/\D/g, ""));
    expect(share + fee).toBe(profit);
  });
});

describe("HolderStatement — below the mark", () => {
  beforeEach(() => renderFor(LEDGER_UNDERWATER));

  it("says so, and states the recovery figure", () => {
    expect(screen.getByText("Below the high-water mark")).toBeInTheDocument();
    expect(screen.getByText(/\$1,364\.84 of recovery is needed/)).toBeInTheDocument();
  });

  it("keeps the exit available, with no fee, in the same block", () => {
    expect(screen.getByText(/still available, at today's value of \$8,635\.16, with no fee/))
      .toBeInTheDocument();
  });

  it("shows no fee line at all, rather than a fee of zero", () => {
    expect(screen.queryByLabelText(/Your fee/)).toBeNull();
  });

  it("shows profit negative with a sign", () => {
    expect(screen.getByLabelText("Profit above that").textContent).toBe("-$1,364.84");
  });
});

describe("HolderStatement — the history", () => {
  beforeEach(() => renderFor());

  it("shows every entry, marking the ones that are not Ada's", () => {
    const rows = screen.getAllByRole("row").filter((r) => within(r).queryAllByRole("cell").length > 0);
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.textContent?.includes("account-wide"))).toHaveLength(5);
  });

  it("explains a value change she had no part in", () => {
    const revalue = screen.getAllByRole("row", { name: /Account revalued/ });
    expect(revalue.length).toBe(3);
    // 30 Jun 2026: her units do not move, her value does.
    const row = screen.getByRole("row", { name: /30 Jun 2026/ });
    const cells = within(row).getAllByRole("cell").map((c) => c.textContent);
    expect(cells[1]).toBe("—");                       // units in/out
    expect(cells[5]).toMatch(/^\+\$/);                // change is positive
  });

  it("leaves her untouched by Grace's deposit", () => {
    const row = screen.getByRole("row", { name: /6 Jul 2026/ });
    const cells = within(row).getAllByRole("cell").map((c) => c.textContent);
    expect(cells[1]).toBe("—");   // units in/out
    expect(cells[5]).toBe("—");   // change
  });

  it("ends on the value the position block shows", () => {
    const row = screen.getByRole("row", { name: /14 Aug 2026/ });
    expect(within(row).getAllByRole("cell")[4]!.textContent).toBe("$12,630.61");
  });
});

describe("HolderStatement — the manager", () => {
  it("says no fee is charged on their own holding, and shows none", () => {
    renderFor(LEDGER, {
      ...ADA, id: 1, name: "J. Marsh", isManager: true, splitBps: 0, joinedAt: "2026-03-02",
    });
    expect(screen.getByText(/No fee is charged on your own holding/)).toBeInTheDocument();
    expect(screen.getByLabelText("Your fee (0%)").textContent).toBe("$0.00");
  });
});

describe("HolderStatement — Phase A", () => {
  it("previews a withdrawal without offering to make one", () => {
    renderFor();
    expect(screen.queryByRole("link", { name: /Pay out/ })).toBeNull();
  });
});
```

- [ ] **Step 7: Run the gates and prove three probes**

```bash
supabase db reset && pnpm typecheck && pnpm test && pnpm test:db && pnpm build
```

Then, reverting each:

1. In `holderPosition`, compute `profitCents` from `statementValueCents`. Expect the "measures profit against the settlement value" test to fail, and the receipt's share-plus-fee-equals-profit assertion to fail with it — a one-cent break that a round fixture would never have shown.
2. In `HolderStatement`, render `position.profitQuote.belowHighWaterMark` instead of `markState`. Expect the at-the-mark case in `holder.test.ts` to keep passing (it tests the presenter, not the component) and the component to start claiming a holder at the mark is below it. **Add a component case for it** if the probe shows nothing goes red — a gap found by probing is a gap, not a pass.
3. In `holderStatement`, filter to `s.entry.holderId === holderId`. Expect "shows every entry" and "explains a value change she had no part in" to fail. That filter is the obvious optimisation and it is the one that makes a statement unable to explain itself.

- [ ] **Step 8: Commit — this is the end of Phase A**

```bash
pnpm typecheck && pnpm test && pnpm test:db && pnpm build
git add -A && git commit -m "$(cat <<'MSG'
feat(desk): the per-holder statement, and the words a payout uses

Ends phase A. Every read surface in spec section 7 now renders real figures.

The statement states its own rounding: a holding is worth $12,630.61 as its
exact share of equity and settles at $12,630.60 rounded down, and the page says
so rather than leaving it to be discovered in a dispute. PAYOUT_WORDS holds the
wording both this page and the payout receipt use.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

> **Phase A checkpoint.** Stop here if this is being executed as two plans. What exists: sign-in, the account list, account creation, the account shell, the desk, the ledger and the holder statement, all rendering real figures from the real database, with nothing that writes. That is a coherent, mergeable product.

---

# Phase B — the money flows

Five sheets, each of which shows complete arithmetic before it commits, and the writers behind them. Every sheet follows decision D-C — enter, read the receipt, confirm — and every receipt is produced by folding the proposed entry (D-D), so a preview cannot disagree with what the commit writes.

---

### Task 11: The action seam, refreshing readings, and posting one by hand

The plumbing every sheet in Phase B reuses, proved out on the flow that needs no new SQL.

**The freshness contract.** A receipt is rendered against a pool at a known `seq`. Between rendering and confirming, something else may have written to the ledger — the reconciler, another tab, a second window. Confirming a receipt against a pool that has moved would commit arithmetic the manager never saw. Every sheet therefore carries the `Fingerprint` from `previewEntry` through hidden fields, and every commit re-folds and refuses when it does not match.

**The reconciler is the primary way readings advance.** A manual reading is the exception, and it is fenced: it may only be dated after the last snapshot CopyTraderX has, and only when the reconciler has nothing left to post. Without that fence a manual reading dated today moves the cursor past days nobody has reconciled, and any capital event in them is absorbed into NAV — the exact loss §5.3 exists to prevent, arriving through the one door the interlock does not watch.

> **Decision D-O: `toleranceCents` is `0n`.** Spec §6.3 verified that with dedup applied, summed closed-trade P/L reconciles against the balance series to a residual of **exactly zero** across the whole period. A non-zero tolerance is a capital event small enough to hide, permanently. If zero produces false candidates in practice, the manager sees a review item and classifies it "not a capital event" — a visible, cheap, safe failure, where the alternative is a silent, expensive one.

**Files:**
- Create: `lib/compound/present/errors.ts`
- Create: `lib/compound/present/fingerprint.ts`
- Create: `lib/compound/load/reconcile.ts`
- Create: `app/a/[id]/actions/actions.ts`
- Create: `app/a/[id]/actions/reading/page.tsx`
- Create: `lib/compound/ui/reading-sheet.tsx`
- Modify: `lib/compound/ui/desk.tsx` — split `actions` from holder actions
- Modify: `app/a/[id]/page.tsx` — pass the action bar
- Test: `lib/compound/present/errors.test.ts`
- Test: `lib/compound/present/fingerprint.test.ts`
- Test: `lib/compound/ui/reading-sheet.test.tsx`

**Interfaces:**
- Consumes: `planReadings`, `ReadingPlan`, `DroppedDeal` from `@/lib/compound/reconcile/interlock`; `commitReadingPlan` from `@/lib/compound/db/commit-plan`; `getDailySnapshots`, `getClosedDeals` from `@/lib/compound/db/copytraderx`; `previewEntry`, `fingerprintOf` from `@/lib/compound/present/derive`
- Produces:
  - `explainCommitError(e: unknown): string`
  - `fingerprintToFields(f: Fingerprint): Record<string, string>`
  - `fingerprintFromFields(get: (k: string) => string | null): Fingerprint | null`
  - `fingerprintMismatch(shown: Fingerprint, current: Fingerprint): string | null`
  - `type ReconcileOutcome`
  - `planFor(account: ResolvedAccount): Promise<ReconcileOutcome>`
  - `refreshReadings(accountId: number): Promise<void>` — server action
  - `postReading(formData: FormData): Promise<void>` — server action
  - `ReadingSheet` component

- [ ] **Step 1: Create `lib/compound/present/errors.ts`**

```typescript
/**
 * Turning a refusal into a sentence a manager can act on.
 *
 * Every writer in this product raises a custom SQLSTATE rather than letting a
 * constraint name reach a screen. A refusal that says "23514" tells the reader
 * nothing; a refusal that says which rule fired and what to do about it is the
 * difference between a safety mechanism and an obstacle.
 *
 * Codes are allocated in blocks so a stray one is obviously unhandled:
 *   CX0xx  the reading writer        (plan 3)
 *   CX1xx  accounts and holders      (this plan)
 *   CX2xx  capital and payouts       (this plan)
 */
const MESSAGES: Record<string, string> = {
  CX001: "That account no longer exists.",
  CX002:
    "There is an unclassified capital event on or before that date. Classify it in " +
    "Review first — NAV must not cross a capital event nobody has explained.",
  CX003:
    "A reading has already been posted for that date or later. Readings only move " +
    "forward, and a correction is a reversing entry rather than an overwrite.",
  CX004:
    "The reading dates and the new cursor position disagree. Nothing was written. " +
    "Reload and try again.",
  CX005: "Those readings are not in ascending date order.",
  CX101: "That MT5 account already has a Compound account.",
  CX102: "That account already has a manager. There can only be one.",
  CX201:
    "That holder has no units to pay out. Add capital first, or check you picked " +
    "the right holder.",
  CX202:
    "That payout is below the holder's high-water mark, so there is no profit to " +
    "withdraw. A full exit is still available.",
  CX203: "That capital event has already been classified.",
  CX204:
    "The account moved while this was open, so the figures you read are no longer " +
    "the figures that would be written. Nothing was committed. Close this and reopen it.",
};

export function explainCommitError(e: unknown): string {
  const code = typeof e === "object" && e !== null && "code" in e
    ? String((e as { code: unknown }).code)
    : null;
  if (code !== null && code in MESSAGES) return MESSAGES[code]!;
  if (e instanceof RangeError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong and nothing was committed.";
}

/** True for Next's redirect/notFound control-flow throws, which must be re-thrown. */
export function isNextControlFlow(e: unknown): boolean {
  return typeof e === "object" && e !== null && "digest" in e &&
    typeof (e as { digest: unknown }).digest === "string" &&
    /^(NEXT_REDIRECT|NEXT_NOT_FOUND)/.test((e as { digest: string }).digest);
}
```

- [ ] **Step 2: Create `lib/compound/present/fingerprint.ts`**

```typescript
/**
 * The freshness contract.
 *
 * A receipt is arithmetic against a pool at a known seq. Between rendering it
 * and confirming it, the reconciler may have posted readings, or a second tab
 * may have committed a deposit. Confirming then would write arithmetic the
 * manager never read — the figures would be right for a pool that no longer
 * exists.
 *
 * The fingerprint travels through hidden form fields as DECIMAL STRINGS. A
 * bigint does not survive JSON and a form field is text either way; parsing it
 * back with BigInt() is exact where Number() is not.
 */
import type { Fingerprint } from "./derive";

export function fingerprintToFields(f: Fingerprint): Record<string, string> {
  return {
    fpAccountId: String(f.accountId),
    fpSeq: String(f.seq),
    fpEquityCents: f.equityCents,
    fpUnits: f.units,
  };
}

const DECIMAL = /^-?[0-9]+$/;

export function fingerprintFromFields(
  get: (key: string) => string | null,
): Fingerprint | null {
  const accountId = get("fpAccountId");
  const seq = get("fpSeq");
  const equityCents = get("fpEquityCents");
  const units = get("fpUnits");
  if (accountId === null || seq === null || equityCents === null || units === null) return null;
  if (![accountId, seq, equityCents, units].every((v) => DECIMAL.test(v))) return null;
  return {
    accountId: Number(accountId),
    seq: Number(seq),
    equityCents,
    units,
  };
}

/**
 * Null when the receipt is still good; otherwise the sentence to show.
 *
 * All four fields are compared, not just seq. seq alone would miss the case
 * that matters most on a busy account: an entry written and then reversed
 * leaves seq higher and the pool identical, while a reversal of an OLD entry
 * leaves the pool different at a seq the reader might still recognise.
 */
export function fingerprintMismatch(
  shown: Fingerprint,
  current: Fingerprint,
): string | null {
  if (shown.accountId !== current.accountId) {
    return "That receipt belongs to a different account.";
  }
  if (
    shown.seq === current.seq &&
    shown.equityCents === current.equityCents &&
    shown.units === current.units
  ) {
    return null;
  }
  return (
    `The account moved while this was open — it was at entry ${shown.seq} when these ` +
    `figures were worked out and it is at entry ${current.seq} now. Nothing was ` +
    `committed. Close this and reopen it to see the current figures.`
  );
}
```

- [ ] **Step 3: Create `lib/compound/load/reconcile.ts`**

```typescript
/**
 * Running the reconciler for an account.
 *
 * Three outcomes a caller must handle differently, and one that is easy to get
 * wrong:
 *
 *   not-configured  the broker offset is null. dedupeDeals throws below 1, and
 *                   reconciling undeduplicated inflates the explained figure
 *                   and can hide a real capital event. Refuse, visibly.
 *   error           planReadings threw a RangeError. This is a DATA DEFECT, not
 *                   a state to render as a halt banner: two snapshots share a
 *                   trade date, or the window starts after the cursor. A halt
 *                   banner would say "a capital event needs classifying", which
 *                   is not what happened, and the manager would go looking for
 *                   one that does not exist.
 *   plan            idle, advance or halt. Every variant carries droppedDeals.
 */
import { cache } from "react";
import { withDb } from "@/lib/compound/db/client";
import { getReconcileCursor } from "@/lib/compound/db/compound";
import { getClosedDeals, getDailySnapshots } from "@/lib/compound/db/copytraderx";
import { planReadings, type ReadingPlan } from "@/lib/compound/reconcile/interlock";
import type { ResolvedAccount } from "./account";

/** Spec 6.3: with dedup applied the residual is exactly zero. Decision D-O. */
export const TOLERANCE_CENTS = 0n;

export type ReconcileOutcome =
  | { kind: "not-configured" }
  | { kind: "error"; message: string }
  | { kind: "plan"; plan: ReadingPlan; lastSnapshotDate: string | null };

export const planFor = cache(async (account: ResolvedAccount): Promise<ReconcileOutcome> => {
  if (account.brokerOffsetHours === null) return { kind: "not-configured" };

  const [cursor, snapshots, deals] = await withDb(async (c) => {
    const cur = await getReconcileCursor(c, account.id);
    // The window must INCLUDE the cursor date: the first day's balance move is
    // reconciled against the balance at the cursor, and planReadings throws if
    // that row is missing. `WHERE trade_date > cursor` is the natural query and
    // the wrong one.
    const from = cur.lastReadingDate ?? undefined;
    return [
      cur,
      await getDailySnapshots(c, account.mt5Account, { from }),
      await getClosedDeals(c, account.mt5Account, { from }),
    ] as const;
  });

  try {
    return {
      kind: "plan",
      plan: planReadings({
        snapshots,
        deals,
        cursor,
        brokerOffsetHours: account.brokerOffsetHours,
        toleranceCents: TOLERANCE_CENTS,
      }),
      lastSnapshotDate: snapshots.length === 0
        ? null
        : snapshots.reduce((m, s) => (s.tradeDate > m ? s.tradeDate : m), snapshots[0]!.tradeDate),
    };
  } catch (e) {
    if (e instanceof RangeError) return { kind: "error", message: e.message };
    throw e;
  }
});
```

- [ ] **Step 4: Create `app/a/[id]/actions/actions.ts`**

```typescript
"use server";

/**
 * The server actions behind Phase B's sheets.
 *
 * Every one of them: resolve the account through the same gate a page uses,
 * re-derive the current state, check the fingerprint the receipt carried, then
 * write. The re-derivation is the point — a commit never trusts a number that
 * came back from the browser, only the inputs the manager typed.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withDb, withDbTransaction } from "@/lib/compound/db/client";
import { commitReadingPlan } from "@/lib/compound/db/commit-plan";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { requireAccount } from "@/lib/compound/load/account";
import { loadPoolState } from "@/lib/compound/load/ledger";
import { requireManager } from "@/lib/compound/load/session";
import { planFor } from "@/lib/compound/load/reconcile";
import { fingerprintOf } from "@/lib/compound/present/derive";
import { explainCommitError, isNextControlFlow } from "@/lib/compound/present/errors";
import { fingerprintFromFields, fingerprintMismatch } from "@/lib/compound/present/fingerprint";
import { deskHref, readingHref } from "@/lib/compound/ui/routes";

/** Re-derive, compare, and hand back the sentence to show — or null to proceed. */
async function staleness(accountId: number, formData: FormData): Promise<string | null> {
  const shown = fingerprintFromFields((k) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : null;
  });
  if (shown === null) return "That form was incomplete. Nothing was committed.";
  const current = fingerprintOf(accountId, await loadPoolState(accountId));
  return fingerprintMismatch(shown, current);
}

export async function refreshReadings(formData: FormData) {
  const account = await requireAccount(String(formData.get("accountId")));
  const user = await requireManager();
  const back = deskHref(account.id);

  const outcome = await planFor(account);
  if (outcome.kind === "not-configured") {
    redirect(`${back}?error=${encodeURIComponent(
      "The broker UTC offset is not set for this account. Reconciliation stays off " +
      "until it is: without the duplicate-deal guard an inflated explained figure " +
      "can hide a real capital event.",
    )}`);
  }
  if (outcome.kind === "error") {
    redirect(`${back}?error=${encodeURIComponent(outcome.message)}`);
  }

  try {
    const result = await withDbTransaction((c) =>
      commitReadingPlan(c, { accountId: account.id, plan: outcome.plan, actorUserId: user.id }),
    );
    revalidatePath(back, "layout");
    redirect(`${back}?posted=${result.readingsInserted}${
      result.candidateId === null ? "" : `&halted=1`
    }`);
  } catch (e) {
    if (isNextControlFlow(e)) throw e;
    redirect(`${back}?error=${encodeURIComponent(explainCommitError(e))}`);
  }
}

export async function postReading(formData: FormData) {
  const account = await requireAccount(String(formData.get("accountId")));
  const user = await requireManager();
  const back = readingHref(account.id);

  const stale = await staleness(account.id, formData);
  if (stale !== null) redirect(`${back}?error=${encodeURIComponent(stale)}`);

  const occurredOn = String(formData.get("occurredOn"));
  let equityCents: bigint;
  try {
    equityCents = centsFromDecimal(String(formData.get("equity")));
  } catch {
    redirect(`${back}?error=${encodeURIComponent("That is not an amount. Use digits and at most two decimal places.")}`);
    return;
  }
  if (equityCents <= 0n) {
    redirect(`${back}?error=${encodeURIComponent("Equity must be positive. An account at zero needs an adjustment entry, not a reading.")}`);
  }

  try {
    await withDbTransaction((c) =>
      commitReadingPlan(c, {
        accountId: account.id,
        plan: {
          kind: "advance",
          readings: [{ occurredOn, equityCents }],
          newCursorDate: occurredOn,
          // A hand-posted reading deduplicated nothing. The field is required
          // on every variant so this has to be said rather than assumed.
          droppedDeals: [],
        },
        actorUserId: user.id,
      }),
    );
    revalidatePath(deskHref(account.id), "layout");
    redirect(deskHref(account.id));
  } catch (e) {
    if (isNextControlFlow(e)) throw e;
    redirect(`${back}?error=${encodeURIComponent(explainCommitError(e))}`);
  }
}
```

- [ ] **Step 5: Create `lib/compound/ui/reading-sheet.tsx`**

```tsx
/**
 * Posting an equity reading by hand.
 *
 * Fenced, deliberately. A reading moves the reconcile cursor, and a cursor that
 * jumps past days nobody reconciled absorbs any capital event in them into NAV.
 * That is the loss section 5.3 exists to prevent, arriving through the one door
 * the interlock does not watch. So: only when the reconciler has nothing left
 * to post, and only dated after the last snapshot CopyTraderX has.
 *
 * The receipt shows every holder's value before and after, because that is what
 * a reading actually does — it does not move cash and it does not move units,
 * it revalues everyone at once.
 */
import type { Cents } from "@/lib/compound/engine/money";
import type { Preview } from "@/lib/compound/present/derive";
import { formatDate, formatMoney, formatNav } from "@/lib/compound/present/format";
import { fingerprintToFields } from "@/lib/compound/present/fingerprint";
import { totalsOf } from "@/lib/compound/engine/replay";
import { DeltaMoney, Money } from "./primitives";
import { Receipt, ReceiptLine, ReceiptTotal } from "./receipt";
import { Field, FieldError, Sheet, SheetActions } from "./sheet";

export type ReadingGate =
  | { kind: "ready"; earliestDate: string }
  | { kind: "not-configured" }
  | { kind: "error"; message: string }
  | { kind: "unposted"; count: number; through: string }
  | { kind: "halted"; candidateDate: string; reviewHref: string };

export function ReadingSheet({
  accountId, gate, currency, names, preview, form, error, backHref, commitAction,
}: {
  accountId: number;
  gate: ReadingGate;
  currency: string;
  names: Record<number, string>;
  /** Absent on step one. */
  preview: Preview | null;
  form: { occurredOn?: string; equity?: string };
  error?: string;
  backHref: string;
  commitAction: (formData: FormData) => Promise<void>;
}) {
  if (gate.kind !== "ready") {
    return (
      <Sheet title="Post an equity reading" backHref={backHref}>
        <div className="banner-halt" role="status">
          <strong>Not yet.</strong>
          <p style={{ margin: "6px 0 0" }}>
            {gate.kind === "not-configured"
              ? "The broker UTC offset is not set for this account, so nothing has been reconciled. Set it on the account before posting readings by hand."
              : gate.kind === "error"
              ? gate.message
              : gate.kind === "unposted"
              ? `CopyTraderX has ${gate.count} ${gate.count === 1 ? "day" : "days"} up to ${formatDate(gate.through)} that are not posted yet. Refresh readings first: a hand-posted reading moves the cursor past them, and any capital event in those days would be absorbed into NAV without anyone seeing it.`
              : `An unexplained balance move on ${formatDate(gate.candidateDate)} is waiting to be classified. NAV must not cross it.`}
          </p>
          {gate.kind === "halted" ? (
            <p style={{ margin: "6px 0 0" }}><a href={gate.reviewHref}>Review it</a></p>
          ) : null}
        </div>
      </Sheet>
    );
  }

  if (preview === null) {
    return (
      <Sheet
        title="Post an equity reading"
        lede="A reading is what the account was worth on a given day. It moves NAV, and it is the only thing that does."
        backHref={backHref}
      >
        {error ? <FieldError>{error}</FieldError> : null}
        <form method="get">
          <input type="hidden" name="step" value="confirm" />
          <Field
            name="occurredOn"
            label="Date"
            hint={`Broker-server date. Must be after ${formatDate(gate.earliestDate)}, the last day already posted.`}
          >
            <input
              id="occurredOn" name="occurredOn" type="date" required
              min={gate.earliestDate} defaultValue={form.occurredOn}
            />
          </Field>
          <Field name="equity" label={`Account equity, ${currency}`} hint="Equity, not balance. A holder's value includes their share of open positions.">
            <input id="equity" name="equity" inputMode="decimal" required defaultValue={form.equity} />
          </Field>
          <SheetActions>
            <button className="btn btn-primary" type="submit">Review</button>
          </SheetActions>
        </form>
      </Sheet>
    );
  }

  const fields = fingerprintToFields(preview.fingerprint);
  const change = (i: number): Cents => preview.valuesAfter[i]! - preview.valuesBefore[i]!;

  return (
    <Sheet title="Post an equity reading" backHref={backHref} backLabel="Back">
      {error ? <FieldError>{error}</FieldError> : null}
      <Receipt label="Equity reading">
        <ReceiptLine label="Date">
          <span className="num">{formatDate(form.occurredOn ?? "")}</span>
        </ReceiptLine>
        <ReceiptLine label="Account equity" hint="Before, then after this reading.">
          <span className="num">
            {formatMoney(preview.before.equityCents, { currency })} →{" "}
            {formatMoney(preview.after.equityCents, { currency })}
          </span>
        </ReceiptLine>
        <ReceiptLine label="NAV per unit" hint="Units do not change. A reading revalues them.">
          <span className="num">
            {formatNav(totalsOf(preview.before))} → {formatNav(totalsOf(preview.after))}
          </span>
        </ReceiptLine>
        {preview.after.holders.map((h, i) => (
          <ReceiptLine
            key={h.holderId}
            label={names[h.holderId] ?? `Holder #${h.holderId}`}
            hint={`${formatMoney(preview.valuesBefore[i]!, { currency })} → ${formatMoney(preview.valuesAfter[i]!, { currency })}`}
          >
            <DeltaMoney cents={change(i)} currency={currency} />
          </ReceiptLine>
        ))}
        <ReceiptTotal label="Total change in value" hint="Sums to the change in equity, exactly.">
          <DeltaMoney
            cents={preview.after.equityCents - preview.before.equityCents}
            currency={currency}
          />
        </ReceiptTotal>
      </Receipt>

      <form action={commitAction}>
        <input type="hidden" name="accountId" value={accountId} />
        <input type="hidden" name="occurredOn" value={form.occurredOn ?? ""} />
        <input type="hidden" name="equity" value={form.equity ?? ""} />
        {Object.entries(fields).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <SheetActions>
          <button className="btn btn-primary" type="submit">Post this reading</button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
```

- [ ] **Step 6: Create `app/a/[id]/actions/reading/page.tsx`**

```tsx
import { requireAccount } from "@/lib/compound/load/account";
import { loadHolderNames, loadLedger, loadSeeds } from "@/lib/compound/load/ledger";
import { planFor } from "@/lib/compound/load/reconcile";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { previewEntry } from "@/lib/compound/present/derive";
import { ReadingSheet, type ReadingGate } from "@/lib/compound/ui/reading-sheet";
import { deskHref, reviewHref } from "@/lib/compound/ui/routes";
import { postReading } from "../actions";

export const dynamic = "force-dynamic";

export default async function ReadingPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ step?: string; occurredOn?: string; equity?: string; error?: string }>;
}) {
  const account = await requireAccount((await params).id);
  const q = await searchParams;

  const [outcome, entries, seeds, names] = await Promise.all([
    planFor(account),
    loadLedger(account.id),
    loadSeeds(account.id),
    loadHolderNames(account.id),
  ]);

  let gate: ReadingGate;
  if (outcome.kind === "not-configured") gate = { kind: "not-configured" };
  else if (outcome.kind === "error") gate = { kind: "error", message: outcome.message };
  else if (outcome.plan.kind === "halt") {
    gate = {
      kind: "halted",
      candidateDate: outcome.plan.candidate.tradeDate,
      reviewHref: reviewHref(account.id),
    };
  } else if (outcome.plan.kind === "advance") {
    gate = {
      kind: "unposted",
      count: outcome.plan.readings.length,
      through: outcome.plan.newCursorDate,
    };
  } else {
    gate = { kind: "ready", earliestDate: outcome.lastSnapshotDate ?? account.inceptionDate };
  }

  let preview = null;
  if (q.step === "confirm" && q.occurredOn && q.equity && gate.kind === "ready") {
    try {
      preview = previewEntry({
        accountId: account.id,
        entries,
        seeds,
        proposed: {
          holderId: null,
          occurredOn: q.occurredOn,
          type: "equity_reading",
          amountCents: centsFromDecimal(q.equity),
          feeSettlement: null,
          splitBpsApplied: null,
        },
      });
    } catch {
      preview = null;
    }
  }

  return (
    <ReadingSheet
      accountId={account.id}
      gate={gate}
      currency={account.currency}
      names={names}
      preview={preview}
      form={{ occurredOn: q.occurredOn, equity: q.equity }}
      error={q.error}
      backHref={deskHref(account.id)}
      commitAction={postReading}
    />
  );
}
```

- [ ] **Step 7: Add the action bar to the desk**

In `lib/compound/ui/desk.tsx`, split the two concerns that Task 8 tied together:

```tsx
  actions?: React.ReactNode;
  /** Task 13 turns this on. Separate from `actions` so the desk can carry a
   *  reading button before a payout sheet exists to link to. */
  holderActions?: boolean;
```

and change the table call to `showActions={holderActions ?? false}`.

In `app/a/[id]/page.tsx`, pass the bar:

```tsx
      actions={
        <>
          <form action={refreshReadings}>
            <input type="hidden" name="accountId" value={account.id} />
            <button className="btn" type="submit">Refresh readings</button>
          </form>
          <a className="btn" href={readingHref(account.id)}>Post a reading by hand</a>
        </>
      }
```

- [ ] **Step 8: Write `lib/compound/present/errors.test.ts` and `fingerprint.test.ts`**

```typescript
// lib/compound/present/errors.test.ts
import { explainCommitError, isNextControlFlow } from "./errors";

describe("explainCommitError", () => {
  it("explains the interlock refusal in terms of what to do", () => {
    const msg = explainCommitError({ code: "CX002", message: "compound: reading crosses candidate" });
    expect(msg).toContain("unclassified capital event");
    expect(msg).toContain("Classify it in Review first");
    expect(msg).not.toContain("CX002");
  });

  it("explains a stale cursor without saying 'cursor'", () => {
    expect(explainCommitError({ code: "CX003" })).toContain("Readings only move forward");
  });

  it.each(["CX001", "CX002", "CX003", "CX004", "CX005", "CX101", "CX102", "CX201", "CX202", "CX203", "CX204"])(
    "has a sentence for %s",
    (code) => {
      const msg = explainCommitError({ code });
      expect(msg.length).toBeGreaterThan(20);
      expect(msg).not.toContain(code);
    },
  );

  it("passes a RangeError through, because the reconciler's own text is already the explanation", () => {
    const e = new RangeError("duplicate snapshot for tradeDate 2026-08-12 in the reading window");
    expect(explainCommitError(e)).toBe(e.message);
  });

  it("does not swallow an unrecognised code into a generic sentence with no signal", () => {
    // A code nobody handled must still surface the driver's own message, or a
    // new writer's refusal becomes invisible the day it is added.
    expect(explainCommitError(Object.assign(new Error("relation does not exist"), { code: "42P01" })))
      .toBe("relation does not exist");
  });

  it("has something to say about a value that is not an error at all", () => {
    expect(explainCommitError("boom")).toBe("Something went wrong and nothing was committed.");
  });
});

describe("isNextControlFlow", () => {
  it("recognises a redirect throw, which must never be reported as a failure", () => {
    expect(isNextControlFlow({ digest: "NEXT_REDIRECT;replace;/a/7;307;" })).toBe(true);
    expect(isNextControlFlow({ digest: "NEXT_NOT_FOUND" })).toBe(true);
  });

  it("does not mistake a real error for one", () => {
    expect(isNextControlFlow(new Error("nope"))).toBe(false);
    expect(isNextControlFlow({ digest: 42 })).toBe(false);
    expect(isNextControlFlow({ code: "CX002" })).toBe(false);
  });
});
```

```typescript
// lib/compound/present/fingerprint.test.ts
import { fold } from "@/lib/compound/engine/replay";
import { LEDGER, SEEDS } from "./fixture";
import { fingerprintOf } from "./derive";
import { fingerprintFromFields, fingerprintMismatch, fingerprintToFields } from "./fingerprint";

const F = fingerprintOf(7, fold(LEDGER, SEEDS));

describe("round trip", () => {
  it("survives the form, exactly, past Number.MAX_SAFE_INTEGER", () => {
    const big = { accountId: 7, seq: 6, equityCents: "9007199254740993", units: "402224547963043" };
    const fields = fingerprintToFields(big);
    const back = fingerprintFromFields((k) => fields[k] ?? null);
    expect(back).toEqual(big);
    // The value a Number round trip would have produced, for contrast.
    expect(Number(big.equityCents)).toBe(9_007_199_254_740_992);
  });

  it("carries every field as a string", () => {
    const fields = fingerprintToFields(F);
    expect(Object.values(fields).every((v) => typeof v === "string")).toBe(true);
  });

  it("refuses a missing field rather than defaulting it", () => {
    expect(fingerprintFromFields(() => null)).toBeNull();
    const fields = fingerprintToFields(F);
    expect(fingerprintFromFields((k) => (k === "fpUnits" ? null : fields[k] ?? null))).toBeNull();
  });

  it("refuses a field that is not a decimal integer", () => {
    const fields = { ...fingerprintToFields(F), fpEquityCents: "5574391.00" };
    expect(fingerprintFromFields((k) => fields[k] ?? null)).toBeNull();
  });
});

describe("fingerprintMismatch", () => {
  it("passes an unchanged pool", () => {
    expect(fingerprintMismatch(F, { ...F })).toBeNull();
  });

  it("refuses a different account outright", () => {
    expect(fingerprintMismatch(F, { ...F, accountId: 8 }))
      .toBe("That receipt belongs to a different account.");
  });

  it("refuses a moved seq, naming both positions", () => {
    const msg = fingerprintMismatch(F, { ...F, seq: 7 });
    expect(msg).toContain("was at entry 6");
    expect(msg).toContain("is at entry 7 now");
    expect(msg).toContain("Nothing was committed");
  });

  it("refuses equity that moved while seq did not", () => {
    // The case seq alone misses: a reversal of an old entry leaves the pool
    // different at a seq the reader might still recognise.
    expect(fingerprintMismatch(F, { ...F, equityCents: "5574390" })).not.toBeNull();
  });

  it("refuses units that moved while seq and equity did not", () => {
    expect(fingerprintMismatch(F, { ...F, units: "402224547963044" })).not.toBeNull();
  });
});
```

- [ ] **Step 9: Write `lib/compound/ui/reading-sheet.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { previewEntry } from "@/lib/compound/present/derive";
import { HOLDER_NAMES, LEDGER, SEEDS } from "@/lib/compound/present/fixture";
import { ReadingSheet, type ReadingGate } from "./reading-sheet";

const PREVIEW = previewEntry({
  accountId: 7, entries: LEDGER, seeds: SEEDS,
  proposed: {
    holderId: null, occurredOn: "2026-08-18", type: "equity_reading",
    amountCents: centsFromDecimal("57120.44"), feeSettlement: null, splitBpsApplied: null,
  },
});

const READY: ReadingGate = { kind: "ready", earliestDate: "2026-08-14" };
const noop = async () => {};

function renderSheet(over: Partial<Parameters<typeof ReadingSheet>[0]> = {}) {
  return render(
    <ReadingSheet
      accountId={7}
      gate={over.gate ?? READY}
      currency="USD"
      names={HOLDER_NAMES}
      preview={over.preview === undefined ? PREVIEW : over.preview}
      form={over.form ?? { occurredOn: "2026-08-18", equity: "57120.44" }}
      error={over.error}
      backHref="/a/7"
      commitAction={noop}
    />,
  );
}

describe("ReadingSheet — the receipt", () => {
  beforeEach(() => renderSheet());

  it("shows equity before and after", () => {
    expect(screen.getByLabelText("Account equity").textContent)
      .toBe("$55,743.91 → $57,120.44");
  });

  it("shows NAV before and after", () => {
    expect(screen.getByLabelText("NAV per unit").textContent).toBe("1.3858 → 1.4201");
  });

  it("shows every holder's change, signed", () => {
    expect(screen.getByLabelText("J. Marsh").textContent).toBe("+$855.57");
    expect(screen.getByLabelText("Ada Lovelace").textContent).toBe("+$311.90");
    expect(screen.getByLabelText("Grace Hopper").textContent).toBe("+$209.06");
  });

  it("totals the holder changes to the change in equity, exactly", () => {
    const parts = ["J. Marsh", "Ada Lovelace", "Grace Hopper"]
      .map((n) => BigInt(screen.getByLabelText(n).textContent!.replace(/\D/g, "")));
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(137_653n);
    expect(screen.getByLabelText("Total change in value").textContent).toBe("+$1,376.53");
  });

  it("carries the fingerprint into the commit form as decimal strings", () => {
    const value = (n: string) =>
      document.querySelector<HTMLInputElement>(`input[name="${n}"]`)!.value;
    expect(value("fpAccountId")).toBe("7");
    expect(value("fpSeq")).toBe("6");
    expect(value("fpEquityCents")).toBe("5574391");
    expect(value("fpUnits")).toBe("402224547963043");
  });

  it("says a reading does not move units", () => {
    expect(screen.getByText(/Units do not change/)).toBeInTheDocument();
  });
});

describe("ReadingSheet — the fence", () => {
  it("refuses while the reconciler has days left to post, and says why", () => {
    renderSheet({ gate: { kind: "unposted", count: 4, through: "2026-08-14" }, preview: null });
    expect(screen.getByText(/CopyTraderX has 4 days up to 14 Aug 2026 that are not posted/))
      .toBeInTheDocument();
    expect(screen.getByText(/absorbed into NAV without anyone seeing it/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Post this reading/ })).toBeNull();
  });

  it("refuses while a capital event is unclassified, and links to it", () => {
    renderSheet({
      gate: { kind: "halted", candidateDate: "2026-08-12", reviewHref: "/a/7/review" },
      preview: null,
    });
    expect(screen.getByText(/unexplained balance move on 12 Aug 2026/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review it" })).toHaveAttribute("href", "/a/7/review");
  });

  it("refuses when the broker offset is not configured", () => {
    renderSheet({ gate: { kind: "not-configured" }, preview: null });
    expect(screen.getByText(/broker UTC offset is not set/)).toBeInTheDocument();
  });

  it("shows a reconciler data defect as an error, not as a halt to be classified", () => {
    // A duplicate trade date is an upstream defect. Rendering it as "classify
    // this capital event" sends the manager looking for one that is not there.
    renderSheet({
      gate: { kind: "error", message: "duplicate snapshot for tradeDate 2026-08-12 in the reading window" },
      preview: null,
    });
    expect(screen.getByText(/duplicate snapshot for tradeDate 2026-08-12/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Review it" })).toBeNull();
  });
});

describe("ReadingSheet — step one", () => {
  it("will not let a date on or before the last posted day be picked", () => {
    renderSheet({ preview: null });
    expect(screen.getByLabelText("Date")).toHaveAttribute("min", "2026-08-14");
  });

  it("asks for equity and says why it is not balance", () => {
    renderSheet({ preview: null });
    expect(screen.getByText(/Equity, not balance/)).toBeInTheDocument();
  });

  it("shows a refusal from a previous attempt", () => {
    renderSheet({ preview: null, error: "There is an unclassified capital event." });
    expect(screen.getByRole("alert").textContent).toContain("unclassified capital event");
    expect(screen.getByRole("alert").textContent).toContain("Nothing was committed");
  });
});
```

- [ ] **Step 10: Run the gates and prove three probes**

```bash
supabase db reset && pnpm typecheck && pnpm test && pnpm test:db && pnpm build
```

Then, reverting each:

1. In `fingerprintMismatch`, compare only `seq`. Expect the equity-moved and units-moved tests to fail. Those two exist because comparing `seq` alone is the obvious implementation and it misses the reversal case.
2. In `reading-sheet.tsx`, render the gate's `unposted` case as `ready`. Expect three fence tests to fail. That gate is the only thing stopping a hand-posted reading walking the cursor over an unreconciled capital event.
3. In `planFor`, change the snapshot window to `{ from: cursor.lastReadingDate + 1 day }`. `planReadings` throws its window RangeError, `planFor` returns `kind: "error"`, and the desk shows it. Confirm the message names the cursor — if instead the run silently advances, the window query is wrong in the other direction and that is the more dangerous bug.

- [ ] **Step 11: Commit**

```bash
git add -A && git commit -m "$(cat <<'MSG'
feat(desk): the action seam, refreshing readings, and posting one by hand

Every receipt carries a fingerprint of the pool it was worked out against, and
every commit re-folds and refuses when it no longer matches. A hand-posted
reading is fenced behind the reconciler: it moves the cursor, and a cursor that
jumps unreconciled days absorbs any capital event in them into NAV.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 12: Adding an investor, and adding capital

Two sheets and two writers. They are one task because the second is meaningless without the first: an investor with no capital holds nothing, and adding capital needs a holder to add it to.

**The deposit receipt shows dilution of *share*, never of *value*.** A deposit issues units at the prevailing NAV, which is arithmetically incapable of moving anyone else's value — that is the whole reason units solve staggered entry. So the receipt shows every holder's share moving and every holder's value standing still, side by side. That contrast **is** the explanation, and it is the thing an existing investor asks about the moment a new one joins.

**Files:**
- Create: `supabase/migrations/<generated>_compound_add_holder.sql`
- Create: `supabase/migrations/<generated>_compound_commit_deposit.sql`
- Create: `lib/compound/db/write-holder.ts`
- Create: `lib/compound/db/write-deposit.ts`
- Create: `lib/compound/ui/investor-sheet.tsx`
- Create: `lib/compound/ui/capital-sheet.tsx`
- Create: `app/a/[id]/actions/investor/page.tsx`
- Create: `app/a/[id]/actions/capital/page.tsx`
- Modify: `app/a/[id]/actions/actions.ts`
- Test: `lib/compound/db/write-deposit.db.test.ts`
- Test: `lib/compound/ui/capital-sheet.test.tsx`
- Test: `lib/compound/ui/investor-sheet.test.tsx`

**Interfaces:**
- Consumes: `previewEntry` from `@/lib/compound/present/derive`; `PAYOUT_WORDS`, `formatSplitWords` from `@/lib/compound/present/*`
- Produces:
  - `public.compound_add_holder(...) returns bigint`
  - `public.compound_commit_deposit(...) returns jsonb`
  - `addHolder(c, input): Promise<number>`
  - `commitDeposit(c, input): Promise<{ ledgerEntryId: number; seq: number }>`
  - `InvestorSheet`, `CapitalSheet` components

- [ ] **Step 1: The holder writer**

```bash
supabase migration new compound_add_holder
```

```sql
-- ============================================================================
-- Add a holder to an account.
-- ============================================================================
--
-- No ledger entry. A holder is identity and terms; a holder with no deposit
-- holds no units and is worth nothing, which is exactly right — joining and
-- funding are separate events and the ledger records the second one.
--
-- is_manager is forced FALSE. Plan 3's P8 puts a one-manager-per-account
-- partial unique index on this table because replay.ts resolves the
-- fee-receiving manager with find(h => h.isManager) and would silently pick
-- whichever row came back first if there were two. The manager is created with
-- the account and cannot be added later, so this function does not offer it.
--
-- Custom SQLSTATEs:
--   CX102  attempted to add a second manager
-- ============================================================================

create or replace function public.compound_add_holder(
  p_account_id bigint,
  p_name       text,
  p_email      text,
  p_split_bps  int,
  p_joined_at  date,
  p_actor      uuid
) returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_holder_id bigint;
begin
  if not exists (select 1 from public.compound_account a where a.id = p_account_id) then
    raise exception 'compound: no account %', p_account_id using errcode = 'CX001';
  end if;

  insert into public.compound_holder
    (account_id, name, email, is_manager, split_bps, joined_at, status)
  values
    (p_account_id, p_name, nullif(p_email, ''), false, p_split_bps, p_joined_at, 'active')
  returning id into v_holder_id;

  insert into public.compound_audit (actor, action, entity, entity_id, account_id, prior_state)
  values (p_actor, 'add_holder', 'compound_holder', v_holder_id, p_account_id, null);

  return v_holder_id;
end;
$$;
```

```typescript
// lib/compound/db/write-holder.ts
/**
 * Adding a holder. Terms only — no ledger entry, because joining and funding
 * are separate events and only the second one moves money.
 */
import type { Queryable } from "./types";
import { toId } from "./sql";

export interface AddHolderInput {
  accountId: number;
  name: string;
  email: string | null;
  splitBps: number;
  /** YYYY-MM-DD. */
  joinedAt: string;
  actorUserId: string;
}

export async function addHolder(c: Queryable, input: AddHolderInput): Promise<number> {
  if (!Number.isInteger(input.splitBps) || input.splitBps < 0 || input.splitBps > 10_000) {
    throw new RangeError(`splitBps must be an integer 0..10000, got ${input.splitBps}`);
  }
  if (input.name.trim() === "") throw new RangeError("a holder needs a name");
  const { rows } = await c.query<{ id: string }>(
    `select public.compound_add_holder($1,$2,$3,$4,$5::date,$6::uuid) as id`,
    [input.accountId, input.name.trim(), input.email ?? "", input.splitBps,
     input.joinedAt, input.actorUserId],
  );
  return toId(rows[0]!.id, "compound_add_holder.id");
}
```

- [ ] **Step 2: The deposit writer**

```bash
supabase migration new compound_commit_deposit
```

```sql
-- ============================================================================
-- Record a deposit. One ledger entry, seq assigned server-side.
-- ============================================================================
--
-- No units_delta and no nav_at_entry (spec 6.1). Both are derived by folding,
-- and storing either creates a second truth that can disagree with the engine
-- the first time the engine changes.
--
-- The row lock on compound_account is what makes two concurrent writers get
-- disjoint seq numbers rather than colliding on unique (account_id, seq).
-- Same mechanism as compound_commit_reading_plan; do not simplify it away.
--
-- THE INTERLOCK APPLIES HERE TOO. A deposit dated on or after an unclassified
-- capital event is refused, for the reason section 5.3 gives: the pool's state
-- on that date is not known, so the NAV the deposit would issue units at is not
-- known either, and units issued at a wrong NAV cannot be corrected without
-- reversing everything after them.
--
-- Custom SQLSTATEs:
--   CX001  no such account
--   CX002  dated on or after an unclassified capital event
--   CX205  no such holder on this account
-- ============================================================================

create or replace function public.compound_commit_deposit(
  p_account_id   bigint,
  p_holder_id    bigint,
  p_occurred_on  date,
  p_amount_cents bigint,
  p_note         text,
  p_actor        uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_locked   bigint;
  v_next_seq bigint;
  v_entry_id bigint;
  v_blocker  date;
begin
  if p_amount_cents <= 0 then
    raise exception 'compound: a deposit must be positive, got %', p_amount_cents
      using errcode = 'CX206';
  end if;

  select a.id into v_locked
    from public.compound_account a where a.id = p_account_id for update;
  if v_locked is null then
    raise exception 'compound: no account %', p_account_id using errcode = 'CX001';
  end if;

  if not exists (
    select 1 from public.compound_holder h
     where h.id = p_holder_id and h.account_id = p_account_id
  ) then
    raise exception 'compound: holder % is not on account %', p_holder_id, p_account_id
      using errcode = 'CX205';
  end if;

  select min(k.trade_date) into v_blocker
    from public.compound_capital_event_candidate k
   where k.account_id = p_account_id
     and k.status = 'pending';

  if v_blocker is not null and p_occurred_on >= v_blocker then
    raise exception
      'compound: deposit dated % is on or after the unclassified capital event on %',
      p_occurred_on, v_blocker using errcode = 'CX002';
  end if;

  select coalesce(max(l.seq), 0) + 1 into v_next_seq
    from public.compound_ledger_entry l where l.account_id = p_account_id;

  insert into public.compound_ledger_entry
    (account_id, holder_id, seq, occurred_on, type, amount_cents, note, created_by)
  values
    (p_account_id, p_holder_id, v_next_seq, p_occurred_on, 'deposit',
     p_amount_cents, nullif(p_note, ''), p_actor)
  returning id into v_entry_id;

  insert into public.compound_audit (actor, action, entity, entity_id, account_id, prior_state)
  values (p_actor, 'commit_deposit', 'compound_ledger_entry', v_entry_id, p_account_id, null);

  return jsonb_build_object('ledger_entry_id', v_entry_id, 'seq', v_next_seq);
end;
$$;
```

```typescript
// lib/compound/db/write-deposit.ts
/**
 * Recording a deposit.
 *
 * The amount crosses the boundary as a DECIMAL STRING. JSON.stringify throws on
 * a bigint, and a JSON number above 2^53 is not the number you sent. pg's
 * parameter binding takes the string and Postgres casts it to bigint exactly.
 */
import type { Cents } from "@/lib/compound/engine/money";
import type { Queryable } from "./types";
import { toId } from "./sql";

export interface CommitDepositInput {
  accountId: number;
  holderId: number;
  /** YYYY-MM-DD, broker-server date. */
  occurredOn: string;
  amountCents: Cents;
  note: string | null;
  actorUserId: string;
}

export async function commitDeposit(
  c: Queryable,
  input: CommitDepositInput,
): Promise<{ ledgerEntryId: number; seq: number }> {
  if (input.amountCents <= 0n) {
    throw new RangeError(`a deposit must be positive, got ${input.amountCents}`);
  }
  const { rows } = await c.query<{ result: { ledger_entry_id: string; seq: string } }>(
    `select public.compound_commit_deposit($1,$2,$3::date,$4::bigint,$5,$6::uuid) as result`,
    [input.accountId, input.holderId, input.occurredOn,
     input.amountCents.toString(), input.note ?? "", input.actorUserId],
  );
  return {
    ledgerEntryId: toId(rows[0]!.result.ledger_entry_id, "compound_commit_deposit.ledger_entry_id"),
    seq: toId(rows[0]!.result.seq, "compound_commit_deposit.seq"),
  };
}
```

- [ ] **Step 3: Create `lib/compound/ui/investor-sheet.tsx`**

```tsx
/**
 * Adding an investor. No money changes hands, so there is no receipt of
 * figures — there is a statement of TERMS, which is the thing that will be
 * argued about later.
 *
 * The confirm step spells the split out in a sentence rather than as "4000
 * bps" or even "60 / 40", because the question this screen has to answer is
 * "what did I agree to", and a ratio does not answer it.
 */
import { formatDate, formatSplit, formatSplitWords } from "@/lib/compound/present/format";
import { PAYOUT_WORDS } from "@/lib/compound/present/wording";
import { Receipt, ReceiptLine } from "./receipt";
import { Field, FieldError, Sheet, SheetActions } from "./sheet";

export function InvestorSheet({
  accountId, defaultSplitBps, currency, form, error, backHref, commitAction,
}: {
  accountId: number;
  defaultSplitBps: number;
  currency: string;
  form: { name?: string; email?: string; split?: string; joinedAt?: string; step?: string };
  error?: string;
  backHref: string;
  commitAction: (formData: FormData) => Promise<void>;
}) {
  if (form.step !== "confirm") {
    return (
      <Sheet
        title="Add an investor"
        lede="Terms only. Nothing moves until you add capital for them, and their units are issued at the NAV on that day."
        backHref={backHref}
      >
        {error ? <FieldError>{error}</FieldError> : null}
        <form method="get">
          <input type="hidden" name="step" value="confirm" />
          <Field name="name" label="Name">
            <input id="name" name="name" required defaultValue={form.name} />
          </Field>
          <Field name="email" label="Email" hint="Optional. Used only for their statement when the portal lands.">
            <input id="email" name="email" type="email" defaultValue={form.email} />
          </Field>
          <Field
            name="split"
            label="Your share of their profit, percent"
            hint={`The account default is ${defaultSplitBps / 100}%. Set a different figure here if you agreed one.`}
          >
            <input
              id="split" name="split" inputMode="decimal" required
              defaultValue={form.split ?? String(defaultSplitBps / 100)}
            />
          </Field>
          <Field name="joinedAt" label="Joined">
            <input id="joinedAt" name="joinedAt" type="date" required defaultValue={form.joinedAt} />
          </Field>
          <SheetActions>
            <button className="btn btn-primary" type="submit">Review</button>
          </SheetActions>
        </form>
      </Sheet>
    );
  }

  const name = form.name ?? "";
  const splitBps = Math.round(Number(form.split ?? "0") * 100);

  return (
    <Sheet title="Add an investor" backHref={`${backHref}`} backLabel="Back">
      {error ? <FieldError>{error}</FieldError> : null}
      <Receipt label="Investor to be added">
        <ReceiptLine label="Name">{name}</ReceiptLine>
        <ReceiptLine label="Email">{form.email || "—"}</ReceiptLine>
        <ReceiptLine label="Joined">
          <span className="num">{form.joinedAt ? formatDate(form.joinedAt) : "—"}</span>
        </ReceiptLine>
        <ReceiptLine label="Split" hint={PAYOUT_WORDS.managerFeeHint}>
          <span className="num">{formatSplit(splitBps)}</span>
        </ReceiptLine>
      </Receipt>

      <p className="split-note">{formatSplitWords(splitBps, name)}</p>
      <p className="split-note">
        {name} holds no units until capital is added for them. Their {currency} goes in at
        the NAV on the day it lands, which is what stops a later investor diluting an
        earlier one.
      </p>

      <form action={commitAction}>
        <input type="hidden" name="accountId" value={accountId} />
        {(["name", "email", "split", "joinedAt"] as const).map((k) => (
          <input key={k} type="hidden" name={k} value={form[k] ?? ""} />
        ))}
        <SheetActions>
          <button className="btn btn-primary" type="submit">Add {name}</button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
```

- [ ] **Step 4: Create `lib/compound/ui/capital-sheet.tsx`**

```tsx
/**
 * Adding capital.
 *
 * The receipt's job is to make one thing obvious: a deposit dilutes SHARE and
 * does not touch VALUE. Every existing holder's percentage falls and their
 * money does not move, and the two columns sit next to each other so the
 * reader can see that rather than be told it.
 *
 * Units issued is a FLOOR. Ceiling them would issue more units than were paid
 * for, which lowers NAV for everyone else — and previewEntry refuses to build
 * a receipt that lowers NAV on a deposit, so this cannot render at all if the
 * engine's rounding is ever reversed.
 */
import type { Preview } from "@/lib/compound/present/derive";
import type { HolderRow } from "@/lib/compound/db/holders";
import { totalsOf } from "@/lib/compound/engine/replay";
import {
  formatDate, formatMoney, formatNav, formatPpm, formatUnitsDp,
} from "@/lib/compound/present/format";
import { fingerprintToFields } from "@/lib/compound/present/fingerprint";
import { Money } from "./primitives";
import { Receipt, ReceiptLine, ReceiptTotal } from "./receipt";
import { Field, FieldError, Sheet, SheetActions } from "./sheet";

export function CapitalSheet({
  accountId, holders, currency, preview, form, error, backHref, commitAction, blocked,
}: {
  accountId: number;
  holders: HolderRow[];
  currency: string;
  preview: Preview | null;
  form: { holderId?: string; amount?: string; occurredOn?: string; note?: string };
  error?: string;
  backHref: string;
  commitAction: (formData: FormData) => Promise<void>;
  /** Set when a pending capital event blocks any dated entry. */
  blocked?: { candidateDate: string; reviewHref: string };
}) {
  if (blocked) {
    return (
      <Sheet title="Add capital" backHref={backHref}>
        <div className="banner-halt" role="status">
          <strong>Not while a capital event is unclassified.</strong>
          <p style={{ margin: "6px 0 0" }}>
            There is an unexplained balance move on {formatDate(blocked.candidateDate)}. Until
            it is classified, the account&apos;s value on that date is not known — so neither is
            the NAV a deposit would issue units at, and units issued at the wrong NAV cannot
            be corrected without reversing everything after them.
          </p>
          <p style={{ margin: "6px 0 0" }}><a href={blocked.reviewHref}>Review it</a></p>
        </div>
      </Sheet>
    );
  }

  if (preview === null) {
    return (
      <Sheet
        title="Add capital"
        lede="Units are issued at the NAV on the day the money lands. That is what stops a new investor diluting an existing one."
        backHref={backHref}
      >
        {error ? <FieldError>{error}</FieldError> : null}
        <form method="get">
          <input type="hidden" name="step" value="confirm" />
          <Field name="holderId" label="Holder">
            <select id="holderId" name="holderId" required defaultValue={form.holderId}>
              <option value="">Choose…</option>
              {holders.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}{h.isManager ? " (you)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field name="amount" label={`Amount, ${currency}`}>
            <input id="amount" name="amount" inputMode="decimal" required defaultValue={form.amount} />
          </Field>
          <Field name="occurredOn" label="Date" hint="The broker-server date the money landed.">
            <input id="occurredOn" name="occurredOn" type="date" required defaultValue={form.occurredOn} />
          </Field>
          <Field name="note" label="Note" hint="Optional. Appears on the ledger.">
            <input id="note" name="note" defaultValue={form.note} />
          </Field>
          <SheetActions>
            <button className="btn btn-primary" type="submit">Review</button>
          </SheetActions>
        </form>
      </Sheet>
    );
  }

  const fields = fingerprintToFields(preview.fingerprint);
  const holderId = Number(form.holderId);
  const holder = holders.find((h) => h.id === holderId);
  const idx = preview.after.holders.findIndex((h) => h.holderId === holderId);
  const unitsIssued = preview.after.holders[idx]!.units - preview.before.holders[idx]!.units;
  const navMoved = preview.navResidualX1e4 !== 0n;

  return (
    <Sheet title={`Add capital — ${holder?.name ?? ""}`} backHref={backHref} backLabel="Back">
      {error ? <FieldError>{error}</FieldError> : null}

      <Receipt label="Deposit">
        <ReceiptLine label="Amount">
          <span className="num">{formatMoney(preview.equityDelta, { currency })}</span>
        </ReceiptLine>
        <ReceiptLine label="Date">
          <span className="num">{formatDate(form.occurredOn ?? "")}</span>
        </ReceiptLine>
        <ReceiptLine label="NAV units are issued at" hint="The NAV before this deposit.">
          <span className="num">{formatNav(totalsOf(preview.before))}</span>
        </ReceiptLine>
        <ReceiptLine
          label="Units issued"
          hint="Amount divided by NAV, rounded DOWN — never more units than were paid for."
        >
          <span className="num">{formatUnitsDp(unitsIssued, 10)}</span>
        </ReceiptLine>
        <ReceiptLine label="Units in issue" hint="Before, then after.">
          <span className="num">
            {formatUnitsDp(preview.before.units)} → {formatUnitsDp(preview.after.units)}
          </span>
        </ReceiptLine>
        <ReceiptLine
          label="NAV per unit"
          hint={navMoved
            ? "A deposit cannot lower NAV. The sub-cent rounding residual stays in the pool, which nudges it up."
            : "Unchanged, which is the point: a deposit issues units at the prevailing NAV."}
        >
          <span className="num">
            {formatNav(totalsOf(preview.before))} → {formatNav(totalsOf(preview.after))}
          </span>
        </ReceiptLine>
        <ReceiptTotal label="Account equity after">
          <Money cents={preview.after.equityCents} currency={currency} />
        </ReceiptTotal>
      </Receipt>

      <div className="scroller" style={{ marginTop: 18 }}>
        <table>
          <caption className="eyebrow">What this does to everyone</caption>
          <thead>
            <tr>
              <th scope="col">Holder</th>
              <th scope="col">Share before</th>
              <th scope="col">Share after</th>
              <th scope="col">Value before</th>
              <th scope="col">Value after</th>
            </tr>
          </thead>
          <tbody>
            {preview.after.holders.map((h, i) => (
              <tr key={h.holderId} className={h.holderId === holderId ? "own" : ""}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  {holders.find((x) => x.id === h.holderId)?.name ?? `Holder #${h.holderId}`}
                </th>
                <td className="num">{formatPpm(preview.sharesBefore[i]!)}</td>
                <td className="num">{formatPpm(preview.sharesAfter[i]!)}</td>
                <td><Money cents={preview.valuesBefore[i]!} currency={currency} /></td>
                <td><Money cents={preview.valuesAfter[i]!} currency={currency} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="split-note">
        Every other holder&apos;s share falls and their value does not move. A deposit buys
        units at the NAV that already existed, so it cannot take value from anyone who was
        already in. Where a division does not terminate, the sub-cent residual stays in the
        pool and can move a stated value by one cent — upward, never down.
      </p>

      <form action={commitAction}>
        <input type="hidden" name="accountId" value={accountId} />
        {(["holderId", "amount", "occurredOn", "note"] as const).map((k) => (
          <input key={k} type="hidden" name={k} value={form[k] ?? ""} />
        ))}
        {Object.entries(fields).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <SheetActions>
          <button className="btn btn-primary" type="submit">Record this deposit</button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
```

- [ ] **Step 5: The two pages and the two actions**

```tsx
// app/a/[id]/actions/investor/page.tsx
import { requireAccount } from "@/lib/compound/load/account";
import { InvestorSheet } from "@/lib/compound/ui/investor-sheet";
import { deskHref } from "@/lib/compound/ui/routes";
import { addInvestor } from "../actions";

export const dynamic = "force-dynamic";

export default async function InvestorPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const account = await requireAccount((await params).id);
  const q = await searchParams;
  return (
    <InvestorSheet
      accountId={account.id}
      defaultSplitBps={account.defaultSplitBps}
      currency={account.currency}
      form={q}
      error={q.error}
      backHref={deskHref(account.id)}
      commitAction={addInvestor}
    />
  );
}
```

```tsx
// app/a/[id]/actions/capital/page.tsx
import { withDb } from "@/lib/compound/db/client";
import { listHolders } from "@/lib/compound/db/holders";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { requireAccount } from "@/lib/compound/load/account";
import { loadInterlock } from "@/lib/compound/load/interlock";
import { loadLedger, loadSeeds } from "@/lib/compound/load/ledger";
import { previewEntry } from "@/lib/compound/present/derive";
import { CapitalSheet } from "@/lib/compound/ui/capital-sheet";
import { deskHref, reviewHref } from "@/lib/compound/ui/routes";
import { addCapital } from "../actions";

export const dynamic = "force-dynamic";

export default async function CapitalPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const account = await requireAccount((await params).id);
  const q = await searchParams;
  const [holders, entries, seeds, interlock] = await Promise.all([
    withDb((c) => listHolders(c, account.id)),
    loadLedger(account.id),
    loadSeeds(account.id),
    loadInterlock(account.id),
  ]);

  let preview = null;
  if (q.step === "confirm" && q.holderId && q.amount && q.occurredOn) {
    try {
      preview = previewEntry({
        accountId: account.id, entries, seeds,
        proposed: {
          holderId: Number(q.holderId),
          occurredOn: q.occurredOn,
          type: "deposit",
          amountCents: centsFromDecimal(q.amount),
          feeSettlement: null,
          splitBpsApplied: null,
        },
      });
    } catch {
      preview = null;
    }
  }

  return (
    <CapitalSheet
      accountId={account.id}
      holders={holders}
      currency={account.currency}
      preview={preview}
      form={q}
      error={q.error}
      backHref={deskHref(account.id)}
      commitAction={addCapital}
      blocked={interlock.pendingCandidateDate === null ? undefined : {
        candidateDate: interlock.pendingCandidateDate,
        reviewHref: reviewHref(account.id),
      }}
    />
  );
}
```

Append to `app/a/[id]/actions/actions.ts`:

```typescript
export async function addInvestor(formData: FormData) {
  const account = await requireAccount(String(formData.get("accountId")));
  const user = await requireManager();
  const back = investorHref(account.id);
  try {
    const holderId = await withDb((c) =>
      addHolder(c, {
        accountId: account.id,
        name: String(formData.get("name") ?? ""),
        email: String(formData.get("email") ?? "") || null,
        splitBps: Math.round(Number(formData.get("split")) * 100),
        joinedAt: String(formData.get("joinedAt")),
        actorUserId: user.id,
      }),
    );
    revalidatePath(deskHref(account.id), "layout");
    redirect(`${capitalHref(account.id)}?holderId=${holderId}`);
  } catch (e) {
    if (isNextControlFlow(e)) throw e;
    redirect(`${back}?step=confirm&error=${encodeURIComponent(explainCommitError(e))}`);
  }
}

export async function addCapital(formData: FormData) {
  const account = await requireAccount(String(formData.get("accountId")));
  const user = await requireManager();
  const back = capitalHref(account.id);

  const stale = await staleness(account.id, formData);
  if (stale !== null) redirect(`${back}?error=${encodeURIComponent(stale)}`);

  let amountCents: bigint;
  try {
    amountCents = centsFromDecimal(String(formData.get("amount")));
  } catch {
    redirect(`${back}?error=${encodeURIComponent("That is not an amount. Use digits and at most two decimal places.")}`);
    return;
  }

  try {
    await withDbTransaction((c) =>
      commitDeposit(c, {
        accountId: account.id,
        holderId: Number(formData.get("holderId")),
        occurredOn: String(formData.get("occurredOn")),
        amountCents,
        note: String(formData.get("note") ?? "") || null,
        actorUserId: user.id,
      }),
    );
    revalidatePath(deskHref(account.id), "layout");
    redirect(deskHref(account.id));
  } catch (e) {
    if (isNextControlFlow(e)) throw e;
    redirect(`${back}?error=${encodeURIComponent(explainCommitError(e))}`);
  }
}
```

Add `Add an investor` and `Add capital` to the desk's action bar in `app/a/[id]/page.tsx`.

- [ ] **Step 6: Write `lib/compound/ui/capital-sheet.test.tsx`**

The receipt is the deliverable, so the figures are what is asserted.

```tsx
import { render, screen, within } from "@testing-library/react";
import type { HolderRow } from "@/lib/compound/db/holders";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { previewEntry } from "@/lib/compound/present/derive";
import { ADA_ID, GRACE_ID, LEDGER, MANAGER_ID, SEEDS } from "@/lib/compound/present/fixture";
import { CapitalSheet } from "./capital-sheet";

const HOLDERS: HolderRow[] = [
  { id: MANAGER_ID, accountId: 7, name: "J. Marsh", email: null, userId: null,
    isManager: true, splitBps: 0, joinedAt: "2026-03-02", status: "active" },
  { id: ADA_ID, accountId: 7, name: "Ada Lovelace", email: null, userId: null,
    isManager: false, splitBps: 4000, joinedAt: "2026-05-04", status: "active" },
  { id: GRACE_ID, accountId: 7, name: "Grace Hopper", email: null, userId: null,
    isManager: false, splitBps: 3700, joinedAt: "2026-07-06", status: "active" },
];

const PREVIEW = previewEntry({
  accountId: 7, entries: LEDGER, seeds: SEEDS,
  proposed: {
    holderId: ADA_ID, occurredOn: "2026-08-18", type: "deposit",
    amountCents: centsFromDecimal("4250.00"), feeSettlement: null, splitBpsApplied: null,
  },
});

const noop = async () => {};

function renderSheet(over: Partial<Parameters<typeof CapitalSheet>[0]> = {}) {
  return render(
    <CapitalSheet
      accountId={7}
      holders={HOLDERS}
      currency="USD"
      preview={over.preview === undefined ? PREVIEW : over.preview}
      form={over.form ?? { holderId: String(ADA_ID), amount: "4250.00", occurredOn: "2026-08-18" }}
      error={over.error}
      backHref="/a/7"
      commitAction={noop}
      blocked={over.blocked}
    />,
  );
}

describe("CapitalSheet — the receipt", () => {
  beforeEach(() => renderSheet());

  it("shows the amount and the NAV it buys at", () => {
    expect(screen.getByLabelText("Amount").textContent).toBe("$4,250.00");
    expect(screen.getByLabelText("NAV units are issued at").textContent).toBe("1.3858");
  });

  it("shows units issued to ten places, floored", () => {
    // 4250.00 at NAV 1.3858... is 3066.6207821498... Ceiling it would end
    // 1499 and would lower NAV for everyone else.
    expect(screen.getByLabelText("Units issued").textContent).toBe("3,066.6207821498");
  });

  it("shows units in issue before and after, differing by exactly what was issued", () => {
    expect(screen.getByLabelText("Units in issue").textContent)
      .toBe("40,222.4547 → 43,289.0755");
  });

  it("shows NAV unchanged, and says why that is the point", () => {
    expect(screen.getByLabelText("NAV per unit").textContent).toBe("1.3858 → 1.3858");
    expect(screen.getByText(/issues units at the prevailing NAV/)).toBeInTheDocument();
  });

  it("shows the resulting equity", () => {
    expect(screen.getByLabelText("Account equity after").textContent).toBe("$59,993.91");
  });
});

describe("CapitalSheet — what it does to everyone", () => {
  beforeEach(() => renderSheet());

  function row(name: string): string[] {
    const r = screen.getByRole("row", { name: new RegExp(name) });
    return [...within(r).getAllByRole("rowheader"), ...within(r).getAllByRole("cell")]
      .map((c) => c.textContent ?? "");
  }

  it("dilutes every existing holder's share", () => {
    expect(row("J. Marsh").slice(1, 3)).toEqual(["62.15%", "57.75%"]);
    expect(row("Grace Hopper").slice(1, 3)).toEqual(["15.19%", "14.11%"]);
  });

  it("leaves every existing holder's value exactly where it was", () => {
    expect(row("J. Marsh").slice(3, 5)).toEqual(["$34,647.26", "$34,647.26"]);
    expect(row("Grace Hopper").slice(3, 5)).toEqual(["$8,466.04", "$8,466.04"]);
  });

  it("raises the depositor's share and their value by the amount deposited", () => {
    expect(row("Ada Lovelace").slice(1, 3)).toEqual(["22.66%", "28.14%"]);
    expect(row("Ada Lovelace").slice(3, 5)).toEqual(["$12,630.61", "$16,880.61"]);
  });

  it("keeps both share columns summing to a full pool", () => {
    for (const col of [1, 2]) {
      const total = ["J. Marsh", "Ada Lovelace", "Grace Hopper"]
        .map((n) => Number(row(n)[col]!.replace("%", "")))
        .reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(100, 1);
    }
  });

  it("says in words what the two columns show", () => {
    expect(screen.getByText(/share falls and their value does not move/)).toBeInTheDocument();
    expect(screen.getByText(/upward, never down/)).toBeInTheDocument();
  });
});

describe("CapitalSheet — the interlock", () => {
  it("refuses while a capital event is unclassified, and explains the NAV problem", () => {
    renderSheet({ preview: null, blocked: { candidateDate: "2026-08-12", reviewHref: "/a/7/review" } });
    expect(screen.getByText(/unexplained balance move on 12 Aug 2026/)).toBeInTheDocument();
    expect(screen.getByText(/units issued at the wrong NAV cannot be corrected/))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Record this deposit/ })).toBeNull();
  });
});

describe("CapitalSheet — a first deposit for a brand-new investor", () => {
  it("issues them units and leaves everyone else's value alone", () => {
    const seeds = [...SEEDS, { holderId: 4, isManager: false, splitBps: 4000 }];
    const preview = previewEntry({
      accountId: 7, entries: LEDGER, seeds,
      proposed: {
        holderId: 4, occurredOn: "2026-08-18", type: "deposit",
        amountCents: centsFromDecimal("6000.00"), feeSettlement: null, splitBpsApplied: null,
      },
    });
    render(
      <CapitalSheet
        accountId={7}
        holders={[...HOLDERS, { ...HOLDERS[1]!, id: 4, name: "Katherine Johnson" }]}
        currency="USD" preview={preview}
        form={{ holderId: "4", amount: "6000.00", occurredOn: "2026-08-18" }}
        backHref="/a/7" commitAction={noop}
      />,
    );
    expect(screen.getByLabelText("Units issued").textContent).toBe("4,329.3469865645");
    expect(screen.getByLabelText("NAV per unit").textContent).toBe("1.3858 → 1.3858");
    const r = screen.getByRole("row", { name: /Katherine Johnson/ });
    const cells = [...within(r).getAllByRole("cell")].map((c) => c.textContent);
    expect(cells[0]).toBe("0.00%");
    expect(cells[1]).toBe("9.72%");
    expect(cells[2]).toBe("$0.00");
    expect(cells[3]).toBe("$6,000.00");
  });
});
```

- [ ] **Step 7: Write `lib/compound/ui/investor-sheet.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import { InvestorSheet } from "./investor-sheet";

const noop = async () => {};
const base = {
  accountId: 7, defaultSplitBps: 4000, currency: "USD",
  backHref: "/a/7", commitAction: noop,
};

describe("InvestorSheet — step one", () => {
  it("offers the account default without hard-coding it", () => {
    render(<InvestorSheet {...base} defaultSplitBps={3700} form={{}} />);
    expect(screen.getByLabelText(/Your share of their profit/)).toHaveValue("37");
    expect(screen.getByText(/The account default is 37%/)).toBeInTheDocument();
  });

  it("says nothing moves until capital is added", () => {
    render(<InvestorSheet {...base} form={{}} />);
    expect(screen.getByText(/Nothing moves until you add capital/)).toBeInTheDocument();
  });
});

describe("InvestorSheet — the terms", () => {
  beforeEach(() =>
    render(
      <InvestorSheet
        {...base}
        form={{ step: "confirm", name: "Grace Hopper", email: "grace@example.com",
                split: "37", joinedAt: "2026-07-06" }}
      />,
    ));

  it("states the split as a ratio and as a sentence", () => {
    expect(screen.getByLabelText("Split").textContent).toBe("63 / 37");
    expect(screen.getByText(/Grace Hopper keeps 63% of profit and you keep 37%/))
      .toBeInTheDocument();
  });

  it("says when the fee applies, in the words the payout receipt uses", () => {
    expect(screen.getByText(/only when Grace Hopper withdraws/)).toBeInTheDocument();
    expect(screen.getByText(/only on withdrawal, and only on profit/)).toBeInTheDocument();
  });

  it("explains why staggered entry is safe", () => {
    expect(screen.getByText(/at the NAV on the day it lands/)).toBeInTheDocument();
    expect(screen.getByText(/stops a later investor diluting an earlier one/))
      .toBeInTheDocument();
  });

  it("names the person on the button, so a mis-typed name is caught here", () => {
    expect(screen.getByRole("button", { name: "Add Grace Hopper" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 8: Write `lib/compound/db/write-deposit.db.test.ts`**

```typescript
import { withDbTransaction } from "@/lib/compound/db/client";
import { getLedgerEntries } from "@/lib/compound/db/compound";
import { commitDeposit } from "@/lib/compound/db/write-deposit";
import { addHolder } from "@/lib/compound/db/write-holder";
import { MANAGER_USER_ID, seedTwoAccounts } from "@/lib/compound/db/test-harness";

const rollback = (e: Error) => { if (e.message !== "rollback") throw e; };

describe("commitDeposit", () => {
  it("assigns seq server-side, starting at 1 and rising", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const a = await commitDeposit(c, {
        accountId: mine.accountId, holderId: mine.managerHolderId,
        occurredOn: "2026-03-02", amountCents: 2_500_000n, note: null,
        actorUserId: MANAGER_USER_ID,
      });
      const b = await commitDeposit(c, {
        accountId: mine.accountId, holderId: mine.managerHolderId,
        occurredOn: "2026-03-03", amountCents: 100n, note: null,
        actorUserId: MANAGER_USER_ID,
      });
      expect(b.seq).toBe(a.seq + 1);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("keeps seq independent per account", async () => {
    await withDbTransaction(async (c) => {
      const { mine, theirs } = await seedTwoAccounts(c);
      const a = await commitDeposit(c, {
        accountId: mine.accountId, holderId: mine.managerHolderId,
        occurredOn: "2026-03-02", amountCents: 100n, note: null, actorUserId: MANAGER_USER_ID,
      });
      const b = await commitDeposit(c, {
        accountId: theirs.accountId, holderId: theirs.managerHolderId,
        occurredOn: "2026-03-02", amountCents: 100n, note: null, actorUserId: MANAGER_USER_ID,
      });
      expect(a.seq).toBe(b.seq);   // both are 1: seq is per account, not global
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("stores an amount past Number.MAX_SAFE_INTEGER exactly", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const big = 9_007_199_254_740_993n;
      await commitDeposit(c, {
        accountId: mine.accountId, holderId: mine.managerHolderId,
        occurredOn: "2026-03-02", amountCents: big, note: null, actorUserId: MANAGER_USER_ID,
      });
      const [entry] = await getLedgerEntries(c, mine.accountId);
      expect(entry!.amountCents).toBe(big);
      expect(entry!.amountCents).not.toBe(9_007_199_254_740_992n);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("stores no units_delta and no nav_at_entry, because there are no such columns", async () => {
    await withDbTransaction(async (c) => {
      const { rows } = await c.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'compound_ledger_entry'`,
      );
      const names = rows.map((r) => r.column_name);
      expect(names).not.toContain("units_delta");
      expect(names).not.toContain("nav_at_entry");
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("refuses a holder who belongs to another account, with CX205", async () => {
    await withDbTransaction(async (c) => {
      const { mine, theirs } = await seedTwoAccounts(c);
      await expect(commitDeposit(c, {
        accountId: mine.accountId, holderId: theirs.managerHolderId,
        occurredOn: "2026-03-02", amountCents: 100n, note: null, actorUserId: MANAGER_USER_ID,
      })).rejects.toThrow(/is not on account/);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("refuses a deposit dated on or after an unclassified capital event, with CX002", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      await c.query(
        `insert into public.compound_capital_event_candidate
           (account_id, trade_date, balance_delta_cents, explained_cents, unexplained_cents)
         values ($1, '2026-08-12', 500000, 0, 500000)`,
        [mine.accountId],
      );
      await expect(commitDeposit(c, {
        accountId: mine.accountId, holderId: mine.managerHolderId,
        occurredOn: "2026-08-12", amountCents: 100n, note: null, actorUserId: MANAGER_USER_ID,
      })).rejects.toThrow(/on or after the unclassified capital event/);

      // And permits one dated before it, or the guard is just "refuse everything".
      await expect(commitDeposit(c, {
        accountId: mine.accountId, holderId: mine.managerHolderId,
        occurredOn: "2026-08-11", amountCents: 100n, note: null, actorUserId: MANAGER_USER_ID,
      })).resolves.toBeDefined();
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("refuses a non-positive amount before it reaches SQL", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      await expect(commitDeposit(c, {
        accountId: mine.accountId, holderId: mine.managerHolderId,
        occurredOn: "2026-03-02", amountCents: 0n, note: null, actorUserId: MANAGER_USER_ID,
      })).rejects.toThrow(/a deposit must be positive/);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("cannot be updated or deleted afterwards", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const { ledgerEntryId } = await commitDeposit(c, {
        accountId: mine.accountId, holderId: mine.managerHolderId,
        occurredOn: "2026-03-02", amountCents: 100n, note: null, actorUserId: MANAGER_USER_ID,
      });
      await expect(
        c.query(`update public.compound_ledger_entry set amount_cents = 1 where id = $1`,
          [ledgerEntryId]),
      ).rejects.toThrow(/append-only|not permitted|permission denied/i);
      await expect(
        c.query(`delete from public.compound_ledger_entry where id = $1`, [ledgerEntryId]),
      ).rejects.toThrow(/append-only|not permitted|permission denied/i);
      throw new Error("rollback");
    }).catch(rollback);
  });
});

describe("addHolder", () => {
  it("refuses to create a second manager", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      // addHolder cannot ask for is_manager, so the only route to two managers
      // is direct SQL — which the partial unique index refuses.
      await expect(
        c.query(
          `insert into public.compound_holder
             (account_id, name, is_manager, split_bps, status)
           values ($1, 'Impostor', true, 0, 'active')`,
          [mine.accountId],
        ),
      ).rejects.toThrow(/unique|already exists/i);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("refuses an empty name", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      await expect(addHolder(c, {
        accountId: mine.accountId, name: "   ", email: null, splitBps: 4000,
        joinedAt: "2026-07-06", actorUserId: MANAGER_USER_ID,
      })).rejects.toThrow(/a holder needs a name/);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("stores the holder's own split, not the account default", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);   // account default is 4000
      const id = await addHolder(c, {
        accountId: mine.accountId, name: "Grace Hopper", email: null, splitBps: 3700,
        joinedAt: "2026-07-06", actorUserId: MANAGER_USER_ID,
      });
      const { rows } = await c.query<{ split_bps: number }>(
        `select split_bps from public.compound_holder where id = $1`, [id],
      );
      expect(rows[0]!.split_bps).toBe(3700);
      throw new Error("rollback");
    }).catch(rollback);
  });
});
```

- [ ] **Step 9: Run the gates and prove three probes**

```bash
supabase db reset && pnpm typecheck && pnpm test && pnpm test:db && pnpm build
```

Then, reverting each:

1. In `compound_commit_deposit`, delete the pending-candidate check. Expect the CX002 integration test to fail on its first assertion — and note that the second half of that test, the one that permits a deposit dated *before* the event, is what stops the guard being "refuse everything".
2. In `nav.ts`, switch `unitsForDeposit` from `mulDivFloor` to `mulDivCeil`. Expect `previewEntry` to throw `assertNavDidNotFall` and the entire capital-sheet suite to fail to render. That is the cross-module alarm: a rounding reversal in the engine takes the receipt down rather than quietly printing a smaller NAV.
3. In `CapitalSheet`, render `sharesAfter` in both share columns. Expect the dilution assertions to fail while the value assertions still pass — which is the pair that shows the receipt is making a claim about the difference rather than about either column alone.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "$(cat <<'MSG'
feat(desk): adding an investor, and adding capital

The deposit receipt shows every holder's share falling and every holder's value
standing still, side by side. That contrast is the explanation for why units
solve staggered entry, and it is the thing an existing investor asks about the
moment a new one joins.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 13: The payout receipt

**The screen this product exists for.** An investor reads these figures back in a dispute, so every one of them is on the page, named in words a non-accountant can check, and produced by the same reducer that will write the entry.

The receipt shows, in this order: units held, value at NAV, what they have put in, profit above that, their share, the manager's fee, units given up, units kept and what those are worth, and what they actually receive.

> **A payout writes its own settlement reading and does not move the reconcile cursor.**
>
> Spec §5.2: a payout may never settle against a drifting intraday figure, so it writes an equity reading capturing the exact equity used and the payout entry **in one transaction**. That reading pins the equity this payout settled against, at this payout's `seq`, permanently.
>
> The cursor stays where it was. When CopyTraderX's snapshot for that day arrives, the reconciler posts its own reading for the same date at a higher `seq`, which supersedes the settlement reading going forward. Neither disturbs the other, because `fold` applies entries in `seq` order and the payout took its figures from the totals at its own position. Moving the cursor would leave the payout's day permanently unreconciled — and a capital event on that day would then never be seen.

> **The freshness check is enforced in the database, not only in the action.** `compound_commit_payout` takes `p_expected_seq` and refuses under the account row lock when `max(seq)` no longer matches. The action's fingerprint check catches the common case with a good message; this catches the race between that check and the insert, which no amount of application code can close.

**Files:**
- Create: `supabase/migrations/<generated>_compound_commit_payout.sql`
- Create: `lib/compound/db/write-payout.ts`
- Create: `lib/compound/ui/payout-sheet.tsx`
- Create: `app/a/[id]/actions/payout/[hid]/page.tsx`
- Modify: `app/a/[id]/actions/actions.ts`, `app/a/[id]/page.tsx`, `app/a/[id]/holders/[hid]/page.tsx`
- Test: `lib/compound/db/write-payout.db.test.ts`
- Test: `lib/compound/ui/payout-sheet.test.tsx`

**Interfaces:**
- Consumes: `quote` from `@/lib/compound/engine/quote`; `holderPosition` from `@/lib/compound/present/holder`; `previewEntry` from `@/lib/compound/present/derive`; `PAYOUT_WORDS`
- Produces:
  - `public.compound_commit_payout(...) returns jsonb`
  - `commitPayout(c, input): Promise<{ readingEntryId; payoutEntryId; seq }>`
  - `PayoutSheet` component

- [ ] **Step 1: The payout writer**

```bash
supabase migration new compound_commit_payout
```

```sql
-- ============================================================================
-- Pay out. The settlement reading and the payout, together or not at all.
-- ============================================================================
--
-- Spec 5.2: "A payout may never settle against a drifting intraday figure --
-- it writes an equity reading capturing the exact equity used, then the payout
-- entry, in one transaction." Both inserts are in this function body, which IS
-- one transaction. If the reading landed without the payout the account would
-- be revalued for no reason; if the payout landed without the reading it would
-- have settled against whatever equity happened to be current, which is the
-- figure nobody can reproduce afterwards.
--
-- The cursor is NOT moved. That is deliberate and it is not an oversight: the
-- settlement reading pins the equity for THIS payout at THIS seq, and the
-- reconciler's own reading for the same day arrives later at a higher seq and
-- supersedes it going forward. Moving the cursor would leave the payout's day
-- permanently unreconciled, and a capital event on it would never be seen.
--
-- p_expected_seq closes a race the application cannot. The caller re-folds and
-- checks a fingerprint before submitting, and between that check and this
-- insert another session can commit. Under the row lock, max(seq) is the
-- authoritative answer.
--
-- No units_delta and no nav_at_entry: both derived (spec 6.1). amount_cents
-- carries the gross the caller quoted, as a record of what was asked for;
-- replay.ts recomputes the payout from quote() and never reads it.
--
-- Custom SQLSTATEs:
--   CX001  no such account
--   CX002  dated on or after an unclassified capital event
--   CX204  the account moved since the receipt was worked out
--   CX205  no such holder on this account
--   CX207  settlement equity must be positive
-- ============================================================================

create or replace function public.compound_commit_payout(
  p_account_id              bigint,
  p_holder_id               bigint,
  p_occurred_on             date,
  p_settlement_equity_cents bigint,
  p_mode                    text,     -- 'payout' | 'exit'
  p_fee_settlement          text,     -- 'units' | 'cash'
  p_split_bps_applied       int,
  p_gross_cents             bigint,
  p_expected_seq            bigint,
  p_note                    text,
  p_actor                   uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_locked     bigint;
  v_max_seq    bigint;
  v_reading_id bigint;
  v_payout_id  bigint;
  v_blocker    date;
begin
  if p_mode not in ('payout', 'exit') then
    raise exception 'compound: mode must be payout or exit, got %', p_mode using errcode = 'CX208';
  end if;
  if p_fee_settlement not in ('units', 'cash') then
    raise exception 'compound: fee settlement must be units or cash, got %', p_fee_settlement
      using errcode = 'CX208';
  end if;
  if p_settlement_equity_cents <= 0 then
    raise exception 'compound: settlement equity must be positive, got %',
      p_settlement_equity_cents using errcode = 'CX207';
  end if;

  select a.id into v_locked
    from public.compound_account a where a.id = p_account_id for update;
  if v_locked is null then
    raise exception 'compound: no account %', p_account_id using errcode = 'CX001';
  end if;

  if not exists (
    select 1 from public.compound_holder h
     where h.id = p_holder_id and h.account_id = p_account_id
  ) then
    raise exception 'compound: holder % is not on account %', p_holder_id, p_account_id
      using errcode = 'CX205';
  end if;

  select min(k.trade_date) into v_blocker
    from public.compound_capital_event_candidate k
   where k.account_id = p_account_id and k.status = 'pending';
  if v_blocker is not null and p_occurred_on >= v_blocker then
    raise exception
      'compound: payout dated % is on or after the unclassified capital event on %',
      p_occurred_on, v_blocker using errcode = 'CX002';
  end if;

  select coalesce(max(l.seq), 0) into v_max_seq
    from public.compound_ledger_entry l where l.account_id = p_account_id;

  if v_max_seq <> p_expected_seq then
    raise exception
      'compound: account is at entry % and the receipt was worked out at entry %',
      v_max_seq, p_expected_seq using errcode = 'CX204';
  end if;

  insert into public.compound_ledger_entry
    (account_id, holder_id, seq, occurred_on, type, amount_cents, note, created_by)
  values
    (p_account_id, null, v_max_seq + 1, p_occurred_on, 'equity_reading',
     p_settlement_equity_cents,
     'Settlement reading for the payout at seq ' || (v_max_seq + 2)::text, p_actor)
  returning id into v_reading_id;

  insert into public.compound_ledger_entry
    (account_id, holder_id, seq, occurred_on, type, amount_cents,
     fee_settlement, split_bps_applied, note, created_by)
  values
    (p_account_id, p_holder_id, v_max_seq + 2, p_occurred_on, p_mode, p_gross_cents,
     p_fee_settlement, p_split_bps_applied, nullif(p_note, ''), p_actor)
  returning id into v_payout_id;

  -- Decision D-M: the stored status is kept in step with what fold derives, so
  -- the database is not misleading to anyone reading it directly. Nothing in
  -- the application reads it.
  if p_mode = 'exit' then
    update public.compound_holder set status = 'closed' where id = p_holder_id;
  end if;

  insert into public.compound_audit (actor, action, entity, entity_id, account_id, prior_state)
  values (p_actor, 'commit_' || p_mode, 'compound_ledger_entry', v_payout_id, p_account_id,
          jsonb_build_object('expected_seq', p_expected_seq,
                             'settlement_equity_cents', p_settlement_equity_cents));

  return jsonb_build_object(
    'reading_entry_id', v_reading_id,
    'payout_entry_id',  v_payout_id,
    'seq',              v_max_seq + 2
  );
end;
$$;
```

```typescript
// lib/compound/db/write-payout.ts
/**
 * Committing a payout. Money crosses as decimal strings; see write-deposit.ts.
 */
import type { Cents } from "@/lib/compound/engine/money";
import type { Queryable } from "./types";
import { toId } from "./sql";

export interface CommitPayoutInput {
  accountId: number;
  holderId: number;
  /** YYYY-MM-DD, broker-server date. */
  occurredOn: string;
  /** The exact equity this payout settles against. Written as a reading. */
  settlementEquityCents: Cents;
  mode: "payout" | "exit";
  feeSettlement: "units" | "cash";
  splitBpsApplied: number;
  /** What quote() computed. Recorded, never re-read by fold. */
  grossCents: Cents;
  /** max(seq) at the moment the receipt was rendered. */
  expectedSeq: number;
  note: string | null;
  actorUserId: string;
}

export async function commitPayout(
  c: Queryable,
  input: CommitPayoutInput,
): Promise<{ readingEntryId: number; payoutEntryId: number; seq: number }> {
  if (!Number.isInteger(input.splitBpsApplied) ||
      input.splitBpsApplied < 0 || input.splitBpsApplied > 10_000) {
    throw new RangeError(`splitBpsApplied must be an integer 0..10000, got ${input.splitBpsApplied}`);
  }
  if (input.settlementEquityCents <= 0n) {
    throw new RangeError(`settlement equity must be positive, got ${input.settlementEquityCents}`);
  }
  const { rows } = await c.query<{
    result: { reading_entry_id: string; payout_entry_id: string; seq: string };
  }>(
    `select public.compound_commit_payout(
       $1,$2,$3::date,$4::bigint,$5,$6,$7,$8::bigint,$9::bigint,$10,$11::uuid) as result`,
    [
      input.accountId, input.holderId, input.occurredOn,
      input.settlementEquityCents.toString(), input.mode, input.feeSettlement,
      input.splitBpsApplied, input.grossCents.toString(), String(input.expectedSeq),
      input.note ?? "", input.actorUserId,
    ],
  );
  const r = rows[0]!.result;
  return {
    readingEntryId: toId(r.reading_entry_id, "compound_commit_payout.reading_entry_id"),
    payoutEntryId: toId(r.payout_entry_id, "compound_commit_payout.payout_entry_id"),
    seq: toId(r.seq, "compound_commit_payout.seq"),
  };
}
```

- [ ] **Step 2: Create `lib/compound/ui/payout-sheet.tsx`**

```tsx
/**
 * The payout receipt.
 *
 * This is the screen an investor reads back in a dispute, so:
 *
 *  - Every figure that goes into the answer is on the page. Not a summary of
 *    them, not a total with the workings hidden behind a disclosure.
 *  - Every accounting term appears with the sentence that defines it. "Cost
 *    basis, their high-water mark" is precise and is jargon; what is rendered
 *    is "What Ada has put in", with the mechanism underneath.
 *  - The fee line is the only amber on the page, per spec section 8.2, and it
 *    uses --fee-ink rather than --fee, which is 2.15:1 and cannot carry text.
 *  - Below the high-water mark, profit-only is DISABLED WITH THE RECOVERY
 *    FIGURE STATED, and exit stays available at current value with zero fee.
 *    A disabled control with no number is a dead end; a disabled control that
 *    says "$1,364.84 of recovery is needed" is an answer.
 *
 * Every figure comes from quote() and from previewEntry()'s fold. Nothing on
 * this page is computed here.
 */
import type { Cents } from "@/lib/compound/engine/money";
import { valueOfUnits } from "@/lib/compound/engine/nav";
import { totalsOf } from "@/lib/compound/engine/replay";
import type { HolderRow } from "@/lib/compound/db/holders";
import type { Preview } from "@/lib/compound/present/derive";
import type { HolderPosition } from "@/lib/compound/present/holder";
import {
  formatDate, formatMoney, formatNav, formatSplit, formatUnitsDp,
} from "@/lib/compound/present/format";
import { fingerprintToFields } from "@/lib/compound/present/fingerprint";
import { PAYOUT_WORDS as W } from "@/lib/compound/present/wording";
import { DeltaMoney, FeeMoney, Money } from "./primitives";
import { Receipt, ReceiptLine, ReceiptTotal } from "./receipt";
import { Field, FieldError, Sheet, SheetActions } from "./sheet";

export interface PayoutForm {
  mode?: "payout" | "exit";
  fee?: "units" | "cash";
  occurredOn?: string;
  equity?: string;
  note?: string;
}

export function PayoutSheet({
  accountId, holder, position, preview, form, currency, error, backHref, commitAction,
  liveEquityCents, blocked,
}: {
  accountId: number;
  holder: HolderRow;
  position: HolderPosition;
  /** Null on step one. */
  preview: Preview | null;
  form: PayoutForm;
  currency: string;
  error?: string;
  backHref: string;
  commitAction: (formData: FormData) => Promise<void>;
  liveEquityCents: Cents | null;
  blocked?: { candidateDate: string; reviewHref: string };
}) {
  const name = holder.name;
  const money = (c: Cents) => formatMoney(c, { currency });
  const managerPct = formatSplit(holder.splitBps).split(" / ")[1]!;
  const holderPct = formatSplit(holder.splitBps).split(" / ")[0]!;
  const mode = form.mode ?? "payout";
  const feeSettlement = form.fee ?? "units";

  if (blocked) {
    return (
      <Sheet title={`Pay out — ${name}`} backHref={backHref}>
        <div className="banner-halt" role="status">
          <strong>Not while a capital event is unclassified.</strong>
          <p style={{ margin: "6px 0 0" }}>
            There is an unexplained balance move on {formatDate(blocked.candidateDate)}. NAV
            must not cross it, and a payout settles at NAV.
          </p>
          <p style={{ margin: "6px 0 0" }}><a href={blocked.reviewHref}>Review it</a></p>
        </div>
      </Sheet>
    );
  }

  if (position.holder.units === 0n) {
    return (
      <Sheet title={`Pay out — ${name}`} backHref={backHref}>
        <div className="banner-halt" role="status">
          <strong>{name} holds no units.</strong>
          <p style={{ margin: "6px 0 0" }}>
            There is nothing to pay out. Add capital for {name} first, or check you picked
            the right holder.
          </p>
        </div>
      </Sheet>
    );
  }

  // --- step one -------------------------------------------------------------
  if (preview === null) {
    const canTakeProfit = position.markState === "above";
    return (
      <Sheet
        title={`Pay out — ${name}`}
        lede={`This payout settles at the equity you enter below, and that figure is written into the ledger as a reading in the same transaction. Nothing settles against a number that can drift.`}
        backHref={backHref}
      >
        {error ? <FieldError>{error}</FieldError> : null}

        {canTakeProfit ? null : (
          <div className="banner-halt" role="status">
            <strong>
              {position.markState === "below" ? W.belowMarkTitle : W.atMarkTitle}
            </strong>
            <p style={{ margin: "6px 0 0" }}>
              {position.markState === "below"
                ? W.belowMark(
                    name,
                    money(position.holder.basisCents),
                    money(position.settlementValueCents),
                    money(position.recoveryCents),
                  )
                : W.atMark(name)}
            </p>
            <p style={{ margin: "6px 0 0" }}>
              {W.exitStillAvailable(money(position.exitQuote.toHolderCents))}
            </p>
          </div>
        )}

        <form method="get">
          <input type="hidden" name="step" value="confirm" />
          <fieldset className="field" style={{ border: 0, padding: 0, margin: "0 0 14px" }}>
            <legend><span className="eyebrow">What kind of withdrawal</span></legend>
            <label style={{ display: "block", margin: "8px 0" }}>
              <input
                type="radio" name="mode" value="payout"
                defaultChecked={mode === "payout"} disabled={!canTakeProfit}
                aria-describedby="profit-only-hint"
              />{" "}
              {W.profitOnly}
              {canTakeProfit ? null : " — unavailable"}
              <small id="profit-only-hint" className="muted" style={{ display: "block", marginLeft: 22 }}>
                {canTakeProfit
                  ? W.profitOnlyHint(name)
                  : position.markState === "below"
                  ? `${money(position.recoveryCents)} of recovery is needed first.`
                  : `There is no profit above what ${name} has put in.`}
              </small>
            </label>
            <label style={{ display: "block", margin: "8px 0" }}>
              <input type="radio" name="mode" value="exit" defaultChecked={mode === "exit" || !canTakeProfit} />{" "}
              {W.exitInFull}
              <small className="muted" style={{ display: "block", marginLeft: 22 }}>
                {W.exitInFullHint(name)}
              </small>
            </label>
          </fieldset>

          <Field name="occurredOn" label="Date" hint="The broker-server date this settles on.">
            <input id="occurredOn" name="occurredOn" type="date" required defaultValue={form.occurredOn} />
          </Field>
          <Field
            name="equity"
            label={`Settlement equity, ${currency}`}
            hint={liveEquityCents === null
              ? "Account equity at the moment this settles. Written into the ledger as a reading."
              : `Account equity at the moment this settles. CopyTraderX's latest live figure is ${money(liveEquityCents)}. Written into the ledger as a reading.`}
          >
            <input
              id="equity" name="equity" inputMode="decimal" required
              defaultValue={form.equity ?? (liveEquityCents === null ? undefined : formatMoney(liveEquityCents).replace(/[^0-9.]/g, ""))}
            />
          </Field>
          <Field name="note" label="Note" hint="Optional. Appears on the ledger.">
            <input id="note" name="note" defaultValue={form.note} />
          </Field>
          <SheetActions>
            <button className="btn btn-primary" type="submit">Work out the figures</button>
          </SheetActions>
        </form>
      </Sheet>
    );
  }

  // --- step two: the receipt -----------------------------------------------
  const q = mode === "exit" ? position.exitQuote : position.profitQuote;
  const idx = preview.after.holders.findIndex((h) => h.holderId === holder.id);
  const unitsKept = preview.after.holders[idx]!.units;
  const keptWorth = valueOfUnits(totalsOf(preview.after), unitsKept);
  const fields = fingerprintToFields(preview.fingerprint);
  const settlementNav = formatNav(totalsOf(preview.before));
  const toggleHref = (over: Partial<PayoutForm>) => {
    const p = new URLSearchParams({
      step: "confirm",
      mode: over.mode ?? mode,
      fee: over.fee ?? feeSettlement,
      occurredOn: form.occurredOn ?? "",
      equity: form.equity ?? "",
      note: form.note ?? "",
    });
    return `?${p.toString()}`;
  };

  return (
    <Sheet
      title={`Pay out — ${name}`}
      lede={`${mode === "exit" ? W.exitInFull : W.profitOnly}. Settling at NAV ${settlementNav} on ${formatDate(form.occurredOn ?? "")}.`}
      backHref={`${backHref}`}
      backLabel="Back"
    >
      {error ? <FieldError>{error}</FieldError> : null}

      <p className="actions" style={{ marginTop: 0 }}>
        <a
          className={`btn${mode === "payout" ? " btn-primary" : ""}`}
          href={toggleHref({ mode: "payout" })}
          aria-disabled={position.markState !== "above" ? "true" : undefined}
          aria-current={mode === "payout" ? "true" : undefined}
        >
          {W.profitOnly}
        </a>
        <a
          className={`btn${mode === "exit" ? " btn-primary" : ""}`}
          href={toggleHref({ mode: "exit" })}
          aria-current={mode === "exit" ? "true" : undefined}
        >
          {W.exitInFull}
        </a>
      </p>

      <Receipt label={`Payout receipt for ${name}`}>
        <ReceiptLine label={W.unitsHeld} hint={W.unitsHeldHint}>
          <span className="num">{formatUnitsDp(position.holder.units)}</span>
        </ReceiptLine>
        <ReceiptLine label={`${W.valueNow} (${settlementNav})`} hint={W.valueNowHint}>
          <span className="num">{money(q.valueCents)}</span>
        </ReceiptLine>
        <ReceiptLine label={W.capitalIn(name)} hint={W.capitalInHint(name)}>
          <span className="num">{money(position.holder.basisCents)}</span>
        </ReceiptLine>
        <ReceiptLine label={W.profit} hint={W.profitHint}>
          <DeltaMoney cents={q.profitCents} currency={currency} />
        </ReceiptLine>

        <ReceiptLine label={W.holderShare(name, holderPct)}>
          <span className="num">{money(q.profitCents > 0n ? q.profitCents - q.feeCents : 0n)}</span>
        </ReceiptLine>
        <ReceiptLine label={W.managerFee(managerPct)} hint={W.managerFeeHint} tone="fee">
          <FeeMoney cents={q.feeCents} currency={currency} />
        </ReceiptLine>

        <ReceiptLine label={W.unitsRedeemed(name)}>
          <span className="num">
            {formatUnitsDp(q.unitsRedeemed)}
            {mode === "exit" ? <span className="muted"> (all of them)</span> : null}
          </span>
        </ReceiptLine>
        <ReceiptLine
          label={W.unitsKept(name)}
          hint={`${W.unitsKeptHint} ${money(keptWorth)}`}
        >
          <span className="num">{formatUnitsDp(unitsKept)}</span>
        </ReceiptLine>

        <ReceiptTotal label={W.receives(name)}>
          <span className="num">{money(q.toHolderCents)}</span>
        </ReceiptTotal>
      </Receipt>

      <fieldset style={{ border: 0, padding: 0, margin: "18px 0 0" }}>
        <legend><span className="eyebrow">{W.feeSettlement}</span></legend>
        <p className="actions" style={{ marginTop: 8 }}>
          <a
            className={`btn${feeSettlement === "units" ? " btn-primary" : ""}`}
            href={toggleHref({ fee: "units" })}
            aria-current={feeSettlement === "units" ? "true" : undefined}
          >
            {W.feeSettlementUnits}
          </a>
          <a
            className={`btn${feeSettlement === "cash" ? " btn-primary" : ""}`}
            href={toggleHref({ fee: "cash" })}
            aria-current={feeSettlement === "cash" ? "true" : undefined}
          >
            {W.feeSettlementCash}
          </a>
        </p>
        <p className="split-note">
          {feeSettlement === "units" ? W.feeSettlementUnitsHint : W.feeSettlementCashHint}
        </p>
      </fieldset>

      <Receipt label="What this does to the account">
        <ReceiptLine label="Account equity" hint="Before, then after.">
          <span className="num">
            {money(preview.before.equityCents)} → {money(preview.after.equityCents)}
          </span>
        </ReceiptLine>
        <ReceiptLine label="Units in issue" hint="Before, then after.">
          <span className="num">
            {formatUnitsDp(preview.before.units)} → {formatUnitsDp(preview.after.units)}
          </span>
        </ReceiptLine>
        <ReceiptLine label="NAV per unit" hint="A payout settles at constant NAV. It takes value out; it does not move the price of a unit.">
          <span className="num">
            {formatNav(totalsOf(preview.before))} → {formatNav(totalsOf(preview.after))}
          </span>
        </ReceiptLine>
      </Receipt>

      <form action={commitAction}>
        <input type="hidden" name="accountId" value={accountId} />
        <input type="hidden" name="holderId" value={holder.id} />
        <input type="hidden" name="mode" value={mode === "exit" ? "exit" : "payout"} />
        <input type="hidden" name="fee" value={feeSettlement} />
        <input type="hidden" name="occurredOn" value={form.occurredOn ?? ""} />
        <input type="hidden" name="equity" value={form.equity ?? ""} />
        <input type="hidden" name="note" value={form.note ?? ""} />
        <input type="hidden" name="grossCents" value={q.grossCents.toString()} />
        <input type="hidden" name="splitBpsApplied" value={String(q.splitBpsApplied)} />
        {Object.entries(fields).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <SheetActions>
          <button className="btn btn-primary" type="submit">
            Pay {name} {money(q.toHolderCents)}
          </button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
```

- [ ] **Step 3: The page and the action**

```tsx
// app/a/[id]/actions/payout/[hid]/page.tsx
import { notFound } from "next/navigation";
import { withDb } from "@/lib/compound/db/client";
import { listHolders } from "@/lib/compound/db/holders";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { fold } from "@/lib/compound/engine/replay";
import { requireAccount } from "@/lib/compound/load/account";
import { loadInterlock } from "@/lib/compound/load/interlock";
import { loadLedger, loadLive, loadSeeds } from "@/lib/compound/load/ledger";
import { previewEntry } from "@/lib/compound/present/derive";
import { holderPosition } from "@/lib/compound/present/holder";
import { PayoutSheet } from "@/lib/compound/ui/payout-sheet";
import { holderHref, reviewHref } from "@/lib/compound/ui/routes";
import { payOut } from "../../actions";

export const dynamic = "force-dynamic";

export default async function PayoutPage({
  params, searchParams,
}: {
  params: Promise<{ id: string; hid: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id, hid } = await params;
  const account = await requireAccount(id);
  if (!/^[1-9][0-9]{0,17}$/.test(hid)) notFound();
  const holderId = Number(hid);
  const q = await searchParams;

  const [holders, entries, seeds, live, interlock] = await Promise.all([
    withDb((c) => listHolders(c, account.id)),
    loadLedger(account.id),
    loadSeeds(account.id),
    loadLive(account.mt5Account),
    loadInterlock(account.id),
  ]);
  const holder = holders.find((h) => h.id === holderId);
  if (holder === undefined) notFound();

  const mode = q.mode === "exit" ? "exit" : "payout";
  const fee = q.fee === "cash" ? "cash" : "units";

  // The position is quoted against the SETTLEMENT equity, not against the last
  // committed reading — the settlement reading is what this payout will apply
  // at, so the receipt must be worked out at that NAV.
  let preview = null;
  let position = holderPosition(fold(entries, seeds), holderId);

  if (q.step === "confirm" && q.occurredOn && q.equity) {
    try {
      const settlement = centsFromDecimal(q.equity);
      const withReading = [
        ...entries,
        {
          id: Math.max(0, ...entries.map((e) => e.id)) + 1,
          seq: Math.max(0, ...entries.map((e) => e.seq)) + 1,
          holderId: null, occurredOn: q.occurredOn, type: "equity_reading" as const,
          amountCents: settlement, feeSettlement: null, splitBpsApplied: null, reversesId: null,
        },
      ];
      position = holderPosition(fold(withReading, seeds), holderId);
      const quoted = mode === "exit" ? position.exitQuote : position.profitQuote;
      preview = previewEntry({
        accountId: account.id,
        entries: withReading,
        seeds,
        proposed: {
          holderId, occurredOn: q.occurredOn, type: mode,
          amountCents: quoted.grossCents, feeSettlement: fee,
          splitBpsApplied: quoted.splitBpsApplied,
        },
      });
    } catch {
      preview = null;
    }
  }

  return (
    <PayoutSheet
      accountId={account.id}
      holder={holder}
      position={position}
      preview={preview}
      form={{ mode, fee, occurredOn: q.occurredOn, equity: q.equity, note: q.note }}
      currency={account.currency}
      error={q.error}
      backHref={holderHref(account.id, holderId)}
      commitAction={payOut}
      liveEquityCents={live?.equityCents ?? null}
      blocked={interlock.pendingCandidateDate === null ? undefined : {
        candidateDate: interlock.pendingCandidateDate,
        reviewHref: reviewHref(account.id),
      }}
    />
  );
}
```

> **Note on the fingerprint here.** `previewEntry` is called with `withReading`, so its fingerprint carries the *pre-reading* state's `seq` — the settlement reading is not in the ledger yet. That is exactly right: `expectedSeq` must be `max(seq)` as the database will find it, and the writer inserts the reading itself at `max(seq) + 1`. Do not "fix" this to include the synthetic reading's seq; the CX204 test in Step 5 fails if you do.

Append to `app/a/[id]/actions/actions.ts`:

```typescript
export async function payOut(formData: FormData) {
  const account = await requireAccount(String(formData.get("accountId")));
  const user = await requireManager();
  const holderId = Number(formData.get("holderId"));
  const back = payoutHref(account.id, holderId);

  const stale = await staleness(account.id, formData);
  if (stale !== null) redirect(`${back}?error=${encodeURIComponent(stale)}`);

  const shown = fingerprintFromFields((k) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : null;
  })!;

  let settlementEquityCents: bigint;
  try {
    settlementEquityCents = centsFromDecimal(String(formData.get("equity")));
  } catch {
    redirect(`${back}?error=${encodeURIComponent("That is not an amount. Use digits and at most two decimal places.")}`);
    return;
  }

  try {
    await withDbTransaction((c) =>
      commitPayout(c, {
        accountId: account.id,
        holderId,
        occurredOn: String(formData.get("occurredOn")),
        settlementEquityCents,
        mode: formData.get("mode") === "exit" ? "exit" : "payout",
        feeSettlement: formData.get("fee") === "cash" ? "cash" : "units",
        splitBpsApplied: Number(formData.get("splitBpsApplied")),
        grossCents: BigInt(String(formData.get("grossCents"))),
        expectedSeq: shown.seq,
        note: String(formData.get("note") ?? "") || null,
        actorUserId: user.id,
      }),
    );
    revalidatePath(deskHref(account.id), "layout");
    redirect(holderHref(account.id, holderId));
  } catch (e) {
    if (isNextControlFlow(e)) throw e;
    redirect(`${back}?error=${encodeURIComponent(explainCommitError(e))}`);
  }
}
```

Turn on the holder actions: pass `holderActions` on the desk, and pass `withdrawAction` on the holder statement page.

- [ ] **Step 4: Write `lib/compound/ui/payout-sheet.test.tsx`**

The most important test file in the plan. Every figure the brief names is asserted, in all four settlement combinations.

```tsx
import { render, screen, within } from "@testing-library/react";
import type { HolderRow } from "@/lib/compound/db/holders";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { fold } from "@/lib/compound/engine/replay";
import { previewEntry } from "@/lib/compound/present/derive";
import { holderPosition } from "@/lib/compound/present/holder";
import { ADA_ID, LEDGER, LEDGER_UNDERWATER, SEEDS } from "@/lib/compound/present/fixture";
import { PayoutSheet, type PayoutForm } from "./payout-sheet";

const ADA: HolderRow = {
  id: ADA_ID, accountId: 7, name: "Ada Lovelace", email: null, userId: null,
  isManager: false, splitBps: 4000, joinedAt: "2026-05-04", status: "active",
};
const noop = async () => {};

function build(ledger = LEDGER, mode: "payout" | "exit" = "payout", fee: "units" | "cash" = "units") {
  const state = fold(ledger, SEEDS);
  const position = holderPosition(state, ADA_ID);
  const q = mode === "exit" ? position.exitQuote : position.profitQuote;
  const preview = previewEntry({
    accountId: 7, entries: ledger, seeds: SEEDS,
    proposed: {
      holderId: ADA_ID, occurredOn: "2026-08-18", type: mode,
      amountCents: q.grossCents, feeSettlement: fee, splitBpsApplied: q.splitBpsApplied,
    },
  });
  return { position, preview };
}

function renderSheet(
  ledger = LEDGER,
  form: PayoutForm = { mode: "payout", fee: "units", occurredOn: "2026-08-18", equity: "55743.91" },
  step2 = true,
) {
  const { position, preview } = build(ledger, form.mode ?? "payout", form.fee ?? "units");
  return render(
    <PayoutSheet
      accountId={7} holder={ADA} position={position}
      preview={step2 ? preview : null} form={form} currency="USD"
      backHref="/a/7/holders/2" commitAction={noop}
      liveEquityCents={centsFromDecimal("55930.00")}
    />,
  );
}

describe("the receipt — profit only, fee retained as units", () => {
  beforeEach(() => renderSheet());

  it("shows the units held", () => {
    expect(screen.getByLabelText("Units held").textContent).toBe("9,113.7132");
  });

  it("shows the value at the NAV this settles against", () => {
    expect(screen.getByLabelText("Value at today's NAV (1.3858)").textContent)
      .toBe("$12,630.60");
  });

  it("shows what Ada has put in, by that name", () => {
    expect(screen.getByLabelText("What Ada Lovelace has put in").textContent)
      .toBe("$10,000.00");
  });

  it("explains the high-water mark without using the term as a label", () => {
    expect(screen.getByText(/rises when Ada Lovelace adds capital/)).toBeInTheDocument();
    expect(screen.getByText(/resets to zero on a full exit/)).toBeInTheDocument();
  });

  it("shows profit above that, signed", () => {
    expect(screen.getByLabelText("Profit above that").textContent).toBe("+$2,630.60");
  });

  it("shows Ada's share and the manager's fee, and they sum to the profit", () => {
    const share = screen.getByLabelText("Ada Lovelace's share of the profit (60%)").textContent!;
    const fee = screen.getByLabelText("Your fee (40%)").textContent!;
    expect(share).toBe("$1,578.36");
    expect(fee).toBe("$1,052.24");
    const n = (s: string) => BigInt(s.replace(/\D/g, ""));
    expect(n(share) + n(fee)).toBe(263_060n);
  });

  it("uses Ada's own split in the labels, not the account default", () => {
    // Grace is 37%. A hard-coded 40 would still pass on Ada, which is why the
    // Grace case below exists.
    expect(screen.getByLabelText(/share of the profit \(60%\)/)).toBeInTheDocument();
  });

  it("shows the units given up and the units kept, with what they are worth", () => {
    expect(screen.getByLabelText("Units Ada Lovelace gives up").textContent).toBe("1,898.1300");
    expect(screen.getByLabelText("Units Ada Lovelace keeps").textContent).toBe("7,215.5832");
    expect(screen.getByText(/immediately after this payout: \$10,000\.00/)).toBeInTheDocument();
  });

  it("shows what Ada actually receives, as the total", () => {
    expect(screen.getByLabelText("Ada Lovelace receives").textContent).toBe("$1,578.36");
  });

  it("names the amount on the button, so the confirm click is not blind", () => {
    expect(screen.getByRole("button", { name: "Pay Ada Lovelace $1,578.36" }))
      .toBeInTheDocument();
  });

  it("puts exactly one line in amber, and it is the fee", () => {
    const amber = document.querySelectorAll(".receipt-line.is-fee");
    expect(amber).toHaveLength(1);
    expect(amber[0]!.textContent).toContain("Your fee (40%)");
  });

  it("shows what it does to the account, at constant NAV", () => {
    expect(screen.getByLabelText("Account equity").textContent)
      .toBe("$55,743.91 → $54,165.55");
    expect(screen.getByLabelText("Units in issue").textContent)
      .toBe("40,222.4547 → 39,083.5767");
    expect(screen.getByLabelText("NAV per unit").textContent).toBe("1.3858 → 1.3858");
  });

  it("explains that the fee stays in the pool as units", () => {
    expect(screen.getByText(/cash stays in the pool and you are issued units/))
      .toBeInTheDocument();
    expect(screen.getByText(/capital in rises by the fee/)).toBeInTheDocument();
  });
});

describe("the receipt — profit only, fee taken as cash", () => {
  beforeEach(() => renderSheet(LEDGER, { mode: "payout", fee: "cash", occurredOn: "2026-08-18", equity: "55743.91" }));

  it("pays Ada the same figure — the settlement choice is yours, not hers", () => {
    expect(screen.getByLabelText("Ada Lovelace receives").textContent).toBe("$1,578.36");
    expect(screen.getByLabelText("Your fee (40%)").textContent).toBe("$1,052.24");
  });

  it("takes the fee out of the account as well as Ada's cash", () => {
    expect(screen.getByLabelText("Account equity").textContent)
      .toBe("$55,743.91 → $53,113.31");
    expect(screen.getByLabelText("Units in issue").textContent)
      .toBe("40,222.4547 → 38,324.3247");
  });

  it("still settles at constant NAV", () => {
    expect(screen.getByLabelText("NAV per unit").textContent).toBe("1.3858 → 1.3858");
  });
});

describe("the receipt — exit in full", () => {
  beforeEach(() => renderSheet(LEDGER, { mode: "exit", fee: "units", occurredOn: "2026-08-18", equity: "55743.91" }));

  it("pays the whole value less the fee", () => {
    expect(screen.getByLabelText("Ada Lovelace receives").textContent).toBe("$11,578.36");
  });

  it("charges the same fee — a fee is on profit, not on the amount withdrawn", () => {
    expect(screen.getByLabelText("Your fee (40%)").textContent).toBe("$1,052.24");
  });

  it("surrenders every unit, and says so", () => {
    expect(screen.getByLabelText("Units Ada Lovelace gives up").textContent)
      .toBe("9,113.7132 (all of them)");
    expect(screen.getByLabelText("Units Ada Lovelace keeps").textContent).toBe("0.0000");
  });

  it("still settles at constant NAV", () => {
    expect(screen.getByLabelText("Account equity").textContent)
      .toBe("$55,743.91 → $44,165.55");
    expect(screen.getByLabelText("NAV per unit").textContent).toBe("1.3858 → 1.3858");
  });
});

describe("below the high-water mark", () => {
  beforeEach(() =>
    renderSheet(LEDGER_UNDERWATER, { mode: "payout", occurredOn: "2026-08-18", equity: "38110.44" }, false));

  it("says so, and states the recovery figure", () => {
    expect(screen.getByText("Below the high-water mark")).toBeInTheDocument();
    expect(screen.getByText(/\$1,364\.84 of recovery is needed before any profit can be withdrawn/))
      .toBeInTheDocument();
  });

  it("disables profit-only and repeats the recovery figure on the control itself", () => {
    const profitOnly = screen.getByRole("radio", { name: /Profit only/ });
    expect(profitOnly).toBeDisabled();
    expect(screen.getByText("$1,364.84 of recovery is needed first.")).toBeInTheDocument();
  });

  it("keeps exit available, at current value, with no fee", () => {
    expect(screen.getByRole("radio", { name: /Exit in full/ })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /Exit in full/ })).toBeChecked();
    expect(screen.getByText(/still available, at today's value of \$8,635\.16, with no fee/))
      .toBeInTheDocument();
  });
});

describe("exactly at the high-water mark", () => {
  it("does not claim the holder is below it", () => {
    // A holder whose value equals their basis exactly. quote() reports
    // belowHighWaterMark true here; the sheet must not.
    const ledger = [...LEDGER, {
      id: 7, seq: 7, holderId: null, occurredOn: "2026-08-18",
      type: "equity_reading" as const,
      // Chosen so Ada's floored value lands on her $10,000.00 basis.
      amountCents: centsFromDecimal("44133.62"),
      feeSettlement: null, splitBpsApplied: null, reversesId: null,
    }];
    const position = holderPosition(fold(ledger, SEEDS), ADA_ID);
    render(
      <PayoutSheet
        accountId={7} holder={ADA} position={position} preview={null}
        form={{ mode: "payout" }} currency="USD" backHref="/a/7/holders/2"
        commitAction={noop} liveEquityCents={null}
      />,
    );
    if (position.markState === "at") {
      expect(screen.getByText("Exactly at the high-water mark")).toBeInTheDocument();
      expect(screen.queryByText("Below the high-water mark")).toBeNull();
      expect(screen.getByText(/no profit to withdraw yet/)).toBeInTheDocument();
    } else {
      // The reading above must be tuned until markState is "at". Do not delete
      // this branch — make it unreachable by picking the right figure, and
      // leave the guard so a later fixture change cannot silently skip the case.
      throw new Error(
        `fixture does not sit on the mark: profit is ${position.profitCents}. ` +
          `Adjust the equity_reading amount until holderPosition reports "at".`,
      );
    }
  });
});

describe("guards", () => {
  it("refuses a holder with no units, and says what to do", () => {
    const empty = holderPosition(fold(LEDGER, SEEDS), 1);
    render(
      <PayoutSheet
        accountId={7} holder={{ ...ADA, id: 1, name: "Nobody" }}
        position={{ ...empty, holder: { ...empty.holder, units: 0n } }}
        preview={null} form={{}} currency="USD" backHref="/a/7"
        commitAction={noop} liveEquityCents={null}
      />,
    );
    expect(screen.getByText("Nobody holds no units.")).toBeInTheDocument();
    expect(screen.getByText(/Add capital for Nobody first/)).toBeInTheDocument();
  });

  it("refuses while a capital event is unclassified, because a payout settles at NAV", () => {
    const { position } = build();
    render(
      <PayoutSheet
        accountId={7} holder={ADA} position={position} preview={null}
        form={{}} currency="USD" backHref="/a/7" commitAction={noop}
        liveEquityCents={null}
        blocked={{ candidateDate: "2026-08-12", reviewHref: "/a/7/review" }}
      />,
    );
    expect(screen.getByText(/NAV must not cross it, and a payout settles at NAV/))
      .toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers the live figure as the settlement default, labelled as CopyTraderX's", () => {
    renderSheet(LEDGER, { mode: "payout" }, false);
    expect(screen.getByText(/CopyTraderX's latest live figure is \$55,930\.00/))
      .toBeInTheDocument();
  });

  it("carries the pre-reading seq in the fingerprint, not the settlement reading's", () => {
    renderSheet();
    expect(document.querySelector<HTMLInputElement>('input[name="fpSeq"]')!.value).toBe("6");
  });
});

describe("a holder on a non-default split", () => {
  it("uses their split in every label and every figure", () => {
    const GRACE: HolderRow = { ...ADA, id: 3, name: "Grace Hopper", splitBps: 3700 };
    const state = fold(LEDGER, SEEDS);
    const position = holderPosition(state, 3);
    const preview = previewEntry({
      accountId: 7, entries: LEDGER, seeds: SEEDS,
      proposed: {
        holderId: 3, occurredOn: "2026-08-18", type: "payout",
        amountCents: position.profitQuote.grossCents, feeSettlement: "units",
        splitBpsApplied: position.profitQuote.splitBpsApplied,
      },
    });
    render(
      <PayoutSheet
        accountId={7} holder={GRACE} position={position} preview={preview}
        form={{ mode: "payout", fee: "units", occurredOn: "2026-08-18", equity: "55743.91" }}
        currency="USD" backHref="/a/7" commitAction={noop} liveEquityCents={null}
      />,
    );
    expect(screen.getByLabelText("Grace Hopper's share of the profit (63%)").textContent)
      .toBe("$608.61");
    expect(screen.getByLabelText("Your fee (37%)").textContent).toBe("$357.43");
    expect(screen.getByLabelText("Grace Hopper receives").textContent).toBe("$608.61");
  });
});
```

**How these bite.** This table is the point of the task.

| Change | What goes red |
|---|---|
| render `position.statementValueCents` instead of `q.valueCents` | value reads `$12,630.61`; share + fee no longer sums to profit |
| use `allocateValues` for the kept-units worth | `$10,000.01` where `$10,000.00` belongs, and the high-water-mark story stops being visible |
| charge the fee on `grossCents` instead of on profit | the exit case reads `$5,052.24`, four times the right fee |
| hard-code 40% | every Grace assertion |
| derive exit's `unitsRedeemed` from value rather than `holderUnits` | "all of them" no longer matches `9,113.7132`, and units kept becomes a residual fraction rather than zero |
| render `belowHighWaterMark` instead of `markState` | the at-the-mark case claims "below" |
| drop the recovery figure from the disabled control's hint | the disabled-control assertion — a dead end instead of an answer |
| include the synthetic settlement reading in the fingerprint | `fpSeq` reads `7`, and the CX204 integration test in Step 5 refuses every payout |
| paint the fee with `--fee` instead of `--fee-ink` | `tokens.test.ts`'s amber rule, from Task 1 |

- [ ] **Step 5: Write `lib/compound/db/write-payout.db.test.ts`**

```typescript
import { withDb, withDbTransaction } from "@/lib/compound/db/client";
import { getHolderSeeds, getLedgerEntries } from "@/lib/compound/db/compound";
import { listHolders } from "@/lib/compound/db/holders";
import { commitDeposit } from "@/lib/compound/db/write-deposit";
import { commitPayout } from "@/lib/compound/db/write-payout";
import { assertInvariants } from "@/lib/compound/engine/invariants";
import { fold } from "@/lib/compound/engine/replay";
import { addHolder } from "@/lib/compound/db/write-holder";
import { MANAGER_USER_ID, seedTwoAccounts } from "@/lib/compound/db/test-harness";

const rollback = (e: Error) => { if (e.message !== "rollback") throw e; };

/** A funded account: manager in for 25,000, Ada in for 10,000, equity 55,743.91. */
async function funded(c: Parameters<typeof commitDeposit>[0], accountId: number, managerHolderId: number) {
  await commitDeposit(c, {
    accountId, holderId: managerHolderId, occurredOn: "2026-03-02",
    amountCents: 2_500_000n, note: null, actorUserId: MANAGER_USER_ID,
  });
  const adaId = await addHolder(c, {
    accountId, name: "Ada Lovelace", email: null, splitBps: 4000,
    joinedAt: "2026-05-04", actorUserId: MANAGER_USER_ID,
  });
  await commitDeposit(c, {
    accountId, holderId: adaId, occurredOn: "2026-05-04",
    amountCents: 1_000_000n, note: null, actorUserId: MANAGER_USER_ID,
  });
  return adaId;
}

describe("commitPayout", () => {
  it("writes the settlement reading and the payout, in that order, adjacent", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const adaId = await funded(c, mine.accountId, mine.managerHolderId);
      const before = await getLedgerEntries(c, mine.accountId);
      const maxSeq = Math.max(...before.map((e) => e.seq));

      const r = await commitPayout(c, {
        accountId: mine.accountId, holderId: adaId, occurredOn: "2026-08-18",
        settlementEquityCents: 5_574_391n, mode: "payout", feeSettlement: "units",
        splitBpsApplied: 4000, grossCents: 263_060n, expectedSeq: maxSeq,
        note: null, actorUserId: MANAGER_USER_ID,
      });

      const after = await getLedgerEntries(c, mine.accountId);
      const reading = after.find((e) => e.id === r.readingEntryId)!;
      const payout = after.find((e) => e.id === r.payoutEntryId)!;
      expect(reading.type).toBe("equity_reading");
      expect(reading.seq).toBe(maxSeq + 1);
      expect(reading.amountCents).toBe(5_574_391n);
      expect(payout.type).toBe("payout");
      expect(payout.seq).toBe(maxSeq + 2);
      expect(payout.splitBpsApplied).toBe(4000);
      expect(payout.feeSettlement).toBe("units");
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("folds to a state that satisfies every invariant", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const adaId = await funded(c, mine.accountId, mine.managerHolderId);
      const maxSeq = Math.max(...(await getLedgerEntries(c, mine.accountId)).map((e) => e.seq));
      await commitPayout(c, {
        accountId: mine.accountId, holderId: adaId, occurredOn: "2026-08-18",
        settlementEquityCents: 5_574_391n, mode: "payout", feeSettlement: "units",
        splitBpsApplied: 4000, grossCents: 263_060n, expectedSeq: maxSeq,
        note: null, actorUserId: MANAGER_USER_ID,
      });
      const state = fold(
        await getLedgerEntries(c, mine.accountId),
        await getHolderSeeds(c, mine.accountId),
      );
      expect(() => assertInvariants(state)).not.toThrow();
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("refuses when the account has moved since the receipt, with CX204", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const adaId = await funded(c, mine.accountId, mine.managerHolderId);
      const maxSeq = Math.max(...(await getLedgerEntries(c, mine.accountId)).map((e) => e.seq));
      await expect(commitPayout(c, {
        accountId: mine.accountId, holderId: adaId, occurredOn: "2026-08-18",
        settlementEquityCents: 5_574_391n, mode: "payout", feeSettlement: "units",
        splitBpsApplied: 4000, grossCents: 263_060n,
        expectedSeq: maxSeq - 1,   // a receipt worked out one entry ago
        note: null, actorUserId: MANAGER_USER_ID,
      })).rejects.toThrow(/the receipt was worked out at entry/);

      // And the correct seq still works, so the guard is not "refuse everything".
      await expect(commitPayout(c, {
        accountId: mine.accountId, holderId: adaId, occurredOn: "2026-08-18",
        settlementEquityCents: 5_574_391n, mode: "payout", feeSettlement: "units",
        splitBpsApplied: 4000, grossCents: 263_060n, expectedSeq: maxSeq,
        note: null, actorUserId: MANAGER_USER_ID,
      })).resolves.toBeDefined();
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("writes nothing at all when the seq check fails", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const adaId = await funded(c, mine.accountId, mine.managerHolderId);
      const before = (await getLedgerEntries(c, mine.accountId)).length;
      await expect(commitPayout(c, {
        accountId: mine.accountId, holderId: adaId, occurredOn: "2026-08-18",
        settlementEquityCents: 5_574_391n, mode: "payout", feeSettlement: "units",
        splitBpsApplied: 4000, grossCents: 263_060n, expectedSeq: 0,
        note: null, actorUserId: MANAGER_USER_ID,
      })).rejects.toThrow();
      // The reading must not survive without its payout. The seq guard fires
      // before either insert, so this is a weak assertion on its own — the
      // atomicity that matters is tested next, where the SECOND insert fails.
      expect((await getLedgerEntries(c, mine.accountId)).length).toBe(before);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("leaves no orphan reading when the payout insert fails", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const adaId = await funded(c, mine.accountId, mine.managerHolderId);
      const before = (await getLedgerEntries(c, mine.accountId)).length;
      const maxSeq = Math.max(...(await getLedgerEntries(c, mine.accountId)).map((e) => e.seq));
      // split_bps_applied out of range fails the CHECK on the SECOND insert,
      // after the reading has already been written. If the two were separate
      // client calls, the reading would survive.
      await expect(c.query(
        `select public.compound_commit_payout($1,$2,'2026-08-18'::date,$3::bigint,
           'payout','units',$4,$5::bigint,$6::bigint,'',$7::uuid)`,
        [mine.accountId, adaId, "5574391", 99_999, "263060", String(maxSeq), MANAGER_USER_ID],
      )).rejects.toThrow();
      expect((await getLedgerEntries(c, mine.accountId)).length).toBe(before);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("closes the holder's stored status on exit, in step with what fold derives", async () => {
    // Decision D-M, and the test plan 3 could not write because none of its
    // fixtures had a payout in them.
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const adaId = await funded(c, mine.accountId, mine.managerHolderId);
      const maxSeq = Math.max(...(await getLedgerEntries(c, mine.accountId)).map((e) => e.seq));
      await commitPayout(c, {
        accountId: mine.accountId, holderId: adaId, occurredOn: "2026-08-18",
        settlementEquityCents: 5_574_391n, mode: "exit", feeSettlement: "units",
        splitBpsApplied: 4000, grossCents: 1_263_060n, expectedSeq: maxSeq,
        note: null, actorUserId: MANAGER_USER_ID,
      });
      const stored = (await listHolders(c, mine.accountId)).find((h) => h.id === adaId)!;
      const derived = fold(
        await getLedgerEntries(c, mine.accountId),
        await getHolderSeeds(c, mine.accountId),
      ).holders.find((h) => h.holderId === adaId)!;
      expect(stored.status).toBe("closed");
      expect(derived.status).toBe("closed");
      expect(stored.status).toBe(derived.status);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("does not move the reconcile cursor", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const adaId = await funded(c, mine.accountId, mine.managerHolderId);
      await c.query(
        `insert into public.compound_reconcile_cursor (account_id, last_reading_date)
         values ($1, '2026-08-14')
         on conflict (account_id) do update set last_reading_date = excluded.last_reading_date`,
        [mine.accountId],
      );
      const maxSeq = Math.max(...(await getLedgerEntries(c, mine.accountId)).map((e) => e.seq));
      await commitPayout(c, {
        accountId: mine.accountId, holderId: adaId, occurredOn: "2026-08-18",
        settlementEquityCents: 5_574_391n, mode: "payout", feeSettlement: "units",
        splitBpsApplied: 4000, grossCents: 263_060n, expectedSeq: maxSeq,
        note: null, actorUserId: MANAGER_USER_ID,
      });
      const { rows } = await c.query<{ last_reading_date: string }>(
        `select last_reading_date::text from public.compound_reconcile_cursor where account_id = $1`,
        [mine.accountId],
      );
      expect(rows[0]!.last_reading_date).toBe("2026-08-14");
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("refuses a payout dated on or after an unclassified capital event", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const adaId = await funded(c, mine.accountId, mine.managerHolderId);
      await c.query(
        `insert into public.compound_capital_event_candidate
           (account_id, trade_date, balance_delta_cents, explained_cents, unexplained_cents)
         values ($1, '2026-08-12', 500000, 0, 500000)`, [mine.accountId],
      );
      const maxSeq = Math.max(...(await getLedgerEntries(c, mine.accountId)).map((e) => e.seq));
      await expect(commitPayout(c, {
        accountId: mine.accountId, holderId: adaId, occurredOn: "2026-08-18",
        settlementEquityCents: 5_574_391n, mode: "payout", feeSettlement: "units",
        splitBpsApplied: 4000, grossCents: 263_060n, expectedSeq: maxSeq,
        note: null, actorUserId: MANAGER_USER_ID,
      })).rejects.toThrow(/on or after the unclassified capital event/);
      throw new Error("rollback");
    }).catch(rollback);
  });
});
```

- [ ] **Step 6: Run the gates and prove three probes**

```bash
supabase db reset && pnpm typecheck && pnpm test && pnpm test:db && pnpm build
```

Then, reverting each:

1. In `quote.ts`, change `mulDivFloor(feeableCents, ...)` to `mulDivCeil`. Expect Ada's fee to move from `$1,052.24` and at least four receipt assertions to fail, plus the engine's own suite. Rounding a fee up favours the manager over the investor, which is the direction spec §4 forbids.
2. In `compound_commit_payout`, move the reading insert after the payout insert. Expect the seq assertions to fail — and note *why they matter*: `fold` applies in `seq` order, so a payout at a lower `seq` than its own settlement reading would settle at the previous NAV, and the receipt would have been right about a transaction that did not happen.
3. In `compound_commit_payout`, delete the `v_max_seq <> p_expected_seq` check. Expect the CX204 test to fail. Confirm the second half of that test still passes, or the guard has become "refuse everything" and proves nothing.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "$(cat <<'MSG'
feat(desk): the payout receipt

The screen this product exists for. Units held, value at NAV, what they have
put in, profit above that, their share, the fee, units given up, units kept and
what those are worth, and what they actually receive — every one of them on the
page, in words a non-accountant can check.

Below the high-water mark, profit-only is disabled WITH THE RECOVERY FIGURE
STATED, and exit stays available at current value with no fee. A disabled
control with no number is a dead end.

The writer puts the settlement reading and the payout in one function body, per
spec 5.2, and refuses under the row lock when the account has moved since the
receipt was worked out.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 14: `/a/[id]/review` — the capital-event queue

What the interlock produces, and the only way past it.

**Written against the reconciler as it now stands** (merged, 211 tests). Two facts from that shape drive this task:

1. **`ReadingPlan` carries `droppedDeals: DroppedDeal[]` on every variant** — `idle`, `advance` and `halt` alike, always present, never optional. Each `DroppedDeal` carries the deal and the `duplicateOfTicket` it was judged a copy of. **This page renders them.** Until that field existed nothing downstream could learn a deal had been suppressed, and dedupe's own module doc says dropping a genuine trade "destroys real P/L silently". A suppression nobody can see is a suppression nobody can challenge.

2. **`planReadings` and `reconcileDays` throw `RangeError` on a duplicate snapshot `tradeDate`**, as well as on a window that starts after the cursor. **Neither is a halt.** A halt says "there is a capital event, classify it"; a `RangeError` says "the data upstream is wrong". Rendering the second as the first sends the manager looking for a capital event that does not exist, and the real one — which the duplicate date was hiding — stays hidden. `planFor` (Task 11) already separates them; this page must keep them separate on screen.

> **Which way a dedupe mistake fails, because the manager needs to know which way to worry.**
>
> A genuine trade wrongly **dropped** makes `explained` too small, so `unexplained` is too large and a candidate appears that should not. That is loud and safe — it shows up in this queue.
>
> A duplicate wrongly **kept** makes `explained` too large, so `unexplained` is too small and a real capital event can be masked entirely. That is silent and expensive.
>
> So the suppressed-duplicates panel is not decoration. Every row on it is a pair the manager can check, and the pair that is *not* listed is the one that would hurt.

> **Decision D-J: classification offers three outcomes and no more.**
>
> - **Deposit** — someone put money in. Writes a `deposit` entry dated on the candidate's day. Offered only for a positive unexplained move.
> - **Match an existing entry** — the money moved for a payout already recorded in the ledger. Sets `resolved_ledger_entry_id` and writes nothing new. This is what that column is for: a payout recorded in Compound and then executed at the broker still produces a candidate, because the reconciler compares balance against closed trades and a withdrawal is neither.
> - **Not a capital event** — a broker credit, a rebate, a correction. Status `ignored`, **a note is required**, and the amount is then absorbed into NAV pro-rata, which is correct for money that belongs to everyone.
>
> A negative unexplained move that is *not* an already-recorded payout is a partial withdrawal, which spec §12 defers as P6. The queue says so plainly rather than offering a control that would record it wrongly.

**Files:**
- Create: `supabase/migrations/<generated>_compound_classify_candidate.sql`
- Create: `lib/compound/db/write-classify.ts`
- Modify: `lib/compound/present/format.ts` — add `formatLots`
- Create: `lib/compound/ui/review-queue.tsx`
- Create: `lib/compound/ui/classify-sheet.tsx`
- Create: `app/a/[id]/review/page.tsx`
- Create: `app/a/[id]/review/[cid]/page.tsx`
- Modify: `app/a/[id]/actions/actions.ts`
- Test: `lib/compound/ui/review-queue.test.tsx`
- Test: `lib/compound/ui/classify-sheet.test.tsx`
- Test: `lib/compound/db/write-classify.db.test.ts`

**Interfaces:**
- Consumes: `ReadingPlan`, `CapitalEventCandidate` from `@/lib/compound/reconcile/interlock`; `DroppedDeal` from `@/lib/compound/reconcile/dedupe`; `dealNetCents` from `@/lib/compound/reconcile/types`; `CapitalEventCandidateRow`, `listCandidates` from `@/lib/compound/db/compound`; `planFor` from `@/lib/compound/load/reconcile`
- Produces:
  - `formatLots(milliLots: number): string`
  - `public.compound_classify_candidate(...) returns jsonb`
  - `classifyCandidate(c, input): Promise<{ ledgerEntryId: number | null }>`
  - `ReviewQueue`, `SuppressedDeals`, `ClassifySheet` components

- [ ] **Step 1: Add `formatLots` to `lib/compound/present/format.ts`**

Into the existing module, not a new one — there is one money-and-figure formatter in this repository and plan 5 greps for a second.

```typescript
/** Milli-lots to lots. `volumeMilliLots` is lots x 1000 as an integer, so 50 is
 *  0.05 lots. Integer arithmetic: a float divide reintroduces the comparison
 *  problem the milli-lot representation exists to avoid. */
export function formatLots(milliLots: number): string {
  if (!Number.isInteger(milliLots) || milliLots < 0) {
    throw new RangeError(`milliLots must be a non-negative integer, got ${milliLots}`);
  }
  return `${Math.trunc(milliLots / 1000)}.${(milliLots % 1000).toString().padStart(3, "0")}`;
}
```

with tests appended to `format.test.ts`:

```typescript
describe("formatLots", () => {
  it("renders 0.05 lots from 50 milli-lots", () => {
    expect(formatLots(50)).toBe("0.050");
  });

  it("renders a whole lot", () => {
    expect(formatLots(1000)).toBe("1.000");
  });

  it("pads a fraction with leading zeros", () => {
    expect(formatLots(1)).toBe("0.001");
  });

  it("refuses a fractional milli-lot", () => {
    expect(() => formatLots(0.5)).toThrow(/must be a non-negative integer/);
  });
});
```

- [ ] **Step 2: The classification writer**

```bash
supabase migration new compound_classify_candidate
```

```sql
-- ============================================================================
-- Classify a capital-event candidate. The only way past the interlock.
-- ============================================================================
--
-- Three outcomes (decision D-J):
--
--   deposit  someone put money in. A deposit entry is written DATED ON THE
--            CANDIDATE'S DAY. That is exactly the date compound_commit_deposit
--            refuses, which is why classification needs its own writer: the
--            interlock exists to stop entries crossing an UNCLASSIFIED event,
--            and this function is the act of classifying it.
--
--   match    the money moved for something already in the ledger — a payout
--            recorded here and then executed at the broker. Nothing new is
--            written; resolved_ledger_entry_id points at the existing entry.
--            That column exists for exactly this.
--
--   ignore   a broker credit, a rebate, a correction. No entry. The amount is
--            absorbed into NAV pro-rata by the next reading, which is correct
--            for money that belongs to every holder. A NOTE IS REQUIRED,
--            because this is the outcome that discards information and the
--            note is the only record of why.
--
-- The candidate must be 'pending'. Classifying a resolved one twice would
-- write a second deposit for the same money.
--
-- Custom SQLSTATEs:
--   CX001  no such account
--   CX203  that candidate is not pending
--   CX204  the account moved since the receipt was worked out
--   CX205  no such holder on this account
--   CX209  the ignore outcome requires a note
--   CX210  the matched entry is not on this account
--   CX211  a deposit classification needs a positive amount
-- ============================================================================

create or replace function public.compound_classify_candidate(
  p_account_id     bigint,
  p_candidate_id   bigint,
  p_outcome        text,     -- 'deposit' | 'match' | 'ignore'
  p_holder_id      bigint,   -- deposit only
  p_amount_cents   bigint,   -- deposit only
  p_match_entry_id bigint,   -- match only
  p_note           text,
  p_expected_seq   bigint,
  p_actor          uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_locked    bigint;
  v_max_seq   bigint;
  v_trade_date date;
  v_status    text;
  v_entry_id  bigint := null;
begin
  if p_outcome not in ('deposit', 'match', 'ignore') then
    raise exception 'compound: outcome must be deposit, match or ignore, got %', p_outcome
      using errcode = 'CX208';
  end if;

  select a.id into v_locked
    from public.compound_account a where a.id = p_account_id for update;
  if v_locked is null then
    raise exception 'compound: no account %', p_account_id using errcode = 'CX001';
  end if;

  select k.trade_date, k.status into v_trade_date, v_status
    from public.compound_capital_event_candidate k
   where k.id = p_candidate_id and k.account_id = p_account_id
     for update;

  if v_trade_date is null then
    raise exception 'compound: no candidate % on account %', p_candidate_id, p_account_id
      using errcode = 'CX203';
  end if;
  if v_status <> 'pending' then
    raise exception 'compound: candidate % is already %', p_candidate_id, v_status
      using errcode = 'CX203';
  end if;

  select coalesce(max(l.seq), 0) into v_max_seq
    from public.compound_ledger_entry l where l.account_id = p_account_id;
  if v_max_seq <> p_expected_seq then
    raise exception
      'compound: account is at entry % and the receipt was worked out at entry %',
      v_max_seq, p_expected_seq using errcode = 'CX204';
  end if;

  if p_outcome = 'deposit' then
    if p_amount_cents is null or p_amount_cents <= 0 then
      raise exception 'compound: a deposit classification needs a positive amount, got %',
        p_amount_cents using errcode = 'CX211';
    end if;
    if not exists (
      select 1 from public.compound_holder h
       where h.id = p_holder_id and h.account_id = p_account_id
    ) then
      raise exception 'compound: holder % is not on account %', p_holder_id, p_account_id
        using errcode = 'CX205';
    end if;

    insert into public.compound_ledger_entry
      (account_id, holder_id, seq, occurred_on, type, amount_cents, note, created_by)
    values
      (p_account_id, p_holder_id, v_max_seq + 1, v_trade_date, 'deposit',
       p_amount_cents, nullif(p_note, ''), p_actor)
    returning id into v_entry_id;

  elsif p_outcome = 'match' then
    if not exists (
      select 1 from public.compound_ledger_entry l
       where l.id = p_match_entry_id and l.account_id = p_account_id
    ) then
      raise exception 'compound: entry % is not on account %', p_match_entry_id, p_account_id
        using errcode = 'CX210';
    end if;
    v_entry_id := p_match_entry_id;

  else
    if p_note is null or btrim(p_note) = '' then
      raise exception
        'compound: classifying a capital event as "not a capital event" requires a note'
        using errcode = 'CX209';
    end if;
  end if;

  update public.compound_capital_event_candidate
     set status = case when p_outcome = 'ignore' then 'ignored' else 'classified' end,
         resolved_ledger_entry_id = v_entry_id,
         resolved_at = now(),
         resolved_by = p_actor
   where id = p_candidate_id;

  insert into public.compound_audit (actor, action, entity, entity_id, account_id, prior_state)
  values (p_actor, 'classify_' || p_outcome, 'compound_capital_event_candidate',
          p_candidate_id, p_account_id,
          jsonb_build_object('status', v_status, 'trade_date', v_trade_date, 'note', p_note));

  return jsonb_build_object('ledger_entry_id', v_entry_id);
end;
$$;
```

```typescript
// lib/compound/db/write-classify.ts
import type { Cents } from "@/lib/compound/engine/money";
import type { Queryable } from "./types";
import { toId } from "./sql";

export type ClassifyOutcome = "deposit" | "match" | "ignore";

export interface ClassifyInput {
  accountId: number;
  candidateId: number;
  outcome: ClassifyOutcome;
  holderId: number | null;
  amountCents: Cents | null;
  matchEntryId: number | null;
  note: string | null;
  expectedSeq: number;
  actorUserId: string;
}

export async function classifyCandidate(
  c: Queryable,
  input: ClassifyInput,
): Promise<{ ledgerEntryId: number | null }> {
  if (input.outcome === "deposit" && (input.amountCents === null || input.amountCents <= 0n)) {
    throw new RangeError(`a deposit classification needs a positive amount, got ${input.amountCents}`);
  }
  if (input.outcome === "ignore" && (input.note ?? "").trim() === "") {
    throw new RangeError(
      'classifying a capital event as "not a capital event" requires a note',
    );
  }
  const { rows } = await c.query<{ result: { ledger_entry_id: string | null } }>(
    `select public.compound_classify_candidate(
       $1,$2,$3,$4,$5::bigint,$6,$7,$8::bigint,$9::uuid) as result`,
    [
      input.accountId, input.candidateId, input.outcome, input.holderId,
      input.amountCents === null ? null : input.amountCents.toString(),
      input.matchEntryId, input.note ?? "", String(input.expectedSeq), input.actorUserId,
    ],
  );
  const id = rows[0]!.result.ledger_entry_id;
  return { ledgerEntryId: id === null ? null : toId(id, "compound_classify_candidate.ledger_entry_id") };
}
```

- [ ] **Step 3: Create `lib/compound/ui/review-queue.tsx`**

```tsx
/**
 * The capital-event queue, and the suppressed-duplicates audit beneath it.
 *
 * Four states, and keeping them apart is most of this component's job:
 *
 *   clear           nothing pending. Readings are advancing.
 *   halted          the reconciler stopped. There is a candidate to classify.
 *   defect          planReadings threw. Upstream data is wrong — a duplicate
 *                   trade date, or a window that starts after the cursor. This
 *                   is NOT a halt and must not be dressed as one: telling a
 *                   manager to classify a capital event that does not exist
 *                   sends them looking in the wrong place while the real
 *                   problem, which the duplicate date may be hiding, stays put.
 *   not-configured  no broker offset, so nothing has been reconciled at all.
 *
 * The arithmetic on a candidate is rendered as an equation, because that is
 * what it is: the balance moved by X, closed trades explain Y, and the
 * difference is what nobody has accounted for.
 */
import type { ReadingPlan } from "@/lib/compound/reconcile/interlock";
import type { DroppedDeal } from "@/lib/compound/reconcile/dedupe";
import { dealNetCents } from "@/lib/compound/reconcile/types";
import type { CapitalEventCandidateRow } from "@/lib/compound/db/compound";
import {
  formatDate, formatLots, formatMoney, formatUtcStamp,
} from "@/lib/compound/present/format";
import { DeltaMoney, EmptyState, Eyebrow, Money, Panel } from "./primitives";
import { classifyHref } from "./routes";

export function SuppressedDeals({
  dropped, currency,
}: { dropped: DroppedDeal[]; currency: string }) {
  return (
    <Panel flush>
      <div className="scroller">
        <table>
          <caption className="eyebrow">
            Suppressed as duplicates · {dropped.length}
          </caption>
          <thead>
            <tr>
              <th scope="col">Ticket</th>
              <th scope="col">Symbol</th>
              <th scope="col">Side</th>
              <th scope="col">Volume</th>
              <th scope="col">Closed</th>
              <th scope="col">Net</th>
              <th scope="col">Judged a copy of</th>
            </tr>
          </thead>
          <tbody>
            {dropped.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "left" }} className="muted">
                  Nothing was suppressed in this run.
                </td>
              </tr>
            ) : (
              dropped.map((d) => (
                <tr key={d.deal.ticket}>
                  <th scope="row" className="num" style={{ fontWeight: 400 }}>
                    {d.deal.ticket}
                  </th>
                  <td>{d.deal.symbol}</td>
                  <td>{d.deal.side}</td>
                  <td className="num">{formatLots(d.deal.volumeMilliLots)}</td>
                  <td className="num">{formatUtcStamp(d.deal.closeTime)}</td>
                  <td><DeltaMoney cents={dealNetCents(d.deal)} currency={currency} /></td>
                  <td className="num">{d.duplicateOfTicket}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="foot" style={{ padding: "14px 16px" }}>
        These rows were excluded from reconciliation as time-shifted copies of the ticket
        named beside them. Check each pair really is one trade recorded twice. A genuine
        trade wrongly suppressed makes the explained figure too small, so it shows up here
        as a capital event that is not one — loud, and safe. A duplicate wrongly kept makes
        the explained figure too large and can mask a real capital event entirely — silent,
        and the reason this list exists at all.
      </p>
    </Panel>
  );
}

export function ReviewQueue({
  accountId, currency, plan, pending, frozenAt, defect, notConfigured, refreshAction,
}: {
  accountId: number;
  currency: string;
  /** Null when planReadings could not run. */
  plan: ReadingPlan | null;
  pending: CapitalEventCandidateRow[];
  frozenAt: string | null;
  defect: string | null;
  notConfigured: boolean;
  refreshAction: React.ReactNode;
}) {
  return (
    <>
      {notConfigured ? (
        <Panel>
          <div className="banner-halt" role="status">
            <strong>Reconciliation is switched off for this account.</strong>
            <p style={{ margin: "6px 0 0" }}>
              The broker&apos;s UTC offset is not set. Without it the duplicate-deal guard
              cannot run, and reconciling with duplicates left in inflates the explained
              figure and can hide a real capital event. Set the offset on the account to
              switch reconciliation on.
            </p>
          </div>
        </Panel>
      ) : null}

      {defect !== null ? (
        <Panel>
          <div className="banner-halt" role="alert">
            <strong>The data upstream is wrong, and this is not a capital event.</strong>
            <p style={{ margin: "6px 0 0" }}>{defect}</p>
            <p style={{ margin: "6px 0 0" }} className="muted">
              Nothing here needs classifying. Reconciliation cannot run until the snapshot
              rows are fixed at the source — and note that a duplicated trade date can be
              concealing a real capital event, so this is worth fixing rather than working
              around.
            </p>
          </div>
        </Panel>
      ) : null}

      {pending.length === 0 && defect === null && !notConfigured ? (
        <Panel>
          <EmptyState title="Nothing waiting">
            Every balance move CopyTraderX has reported is explained by closed trades or by
            an entry in the ledger. Readings are advancing
            {frozenAt === null ? "" : `, last posted ${formatDate(frozenAt)}`}.
          </EmptyState>
          <div className="actions" style={{ justifyContent: "center" }}>{refreshAction}</div>
        </Panel>
      ) : null}

      {pending.length > 0 ? (
        <div className="queue">
          {pending.map((k) => (
            <article className="queue-item" key={k.id} aria-labelledby={`cand-${k.id}`}>
              <Eyebrow>Unexplained balance move</Eyebrow>
              <h2
                id={`cand-${k.id}`}
                style={{ fontFamily: "var(--serif)", fontWeight: 400, fontSize: 24, margin: "4px 0 10px" }}
              >
                {formatDate(k.tradeDate)}
              </h2>

              <dl className="receipt" aria-label={`Arithmetic for ${k.tradeDate}`}>
                <div className="receipt-line">
                  <dt className="l" id={`bd-${k.id}`}>
                    The balance moved by
                    <small>Close-to-close, against the previous snapshot.</small>
                  </dt>
                  <dd className="r" aria-labelledby={`bd-${k.id}`} style={{ margin: 0 }}>
                    <DeltaMoney cents={k.balanceDeltaCents} currency={currency} />
                  </dd>
                </div>
                <div className="receipt-line">
                  <dt className="l" id={`ex-${k.id}`}>
                    Closed trades explain
                    <small>Profit, swap and commission on every deal that closed in between, duplicates removed.</small>
                  </dt>
                  <dd className="r" aria-labelledby={`ex-${k.id}`} style={{ margin: 0 }}>
                    <DeltaMoney cents={k.explainedCents} currency={currency} />
                  </dd>
                </div>
                <div className="receipt-line receipt-total">
                  <dt className="l" id={`un-${k.id}`}>
                    Nobody has accounted for
                    <small>The difference. Capital moved, or something upstream is wrong.</small>
                  </dt>
                  <dd className="r" aria-labelledby={`un-${k.id}`} style={{ margin: 0 }}>
                    <DeltaMoney cents={k.unexplainedCents} currency={currency} />
                  </dd>
                </div>
              </dl>

              <p className="split-note">
                Readings are frozen at{" "}
                {frozenAt === null ? "inception" : formatDate(frozenAt)} and NAV will not
                advance past it until this is classified. That is deliberate: an unrecorded
                deposit is indistinguishable from profit, and profit gets split.
              </p>

              <div className="actions">
                <a className="btn btn-primary" href={classifyHref(accountId, k.id)}>
                  Classify this
                </a>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {plan === null ? null : (
        <SuppressedDeals dropped={plan.droppedDeals} currency={currency} />
      )}
    </>
  );
}
```

- [ ] **Step 4: Create `lib/compound/ui/classify-sheet.tsx`**

```tsx
/**
 * Classifying one capital event.
 *
 * Three outcomes and no fourth (decision D-J). A negative unexplained move that
 * is not an already-recorded payout is a partial withdrawal, which spec section
 * 12 defers as P6 — so the sheet says that rather than offering a control that
 * would record it wrongly. A missing feature stated plainly beats a present
 * feature that is subtly incorrect about someone's money.
 */
import type { CapitalEventCandidateRow } from "@/lib/compound/db/compound";
import type { HolderRow } from "@/lib/compound/db/holders";
import type { LedgerEntry } from "@/lib/compound/engine/replay";
import type { Fingerprint } from "@/lib/compound/present/derive";
import { formatDate, formatMoney } from "@/lib/compound/present/format";
import { fingerprintToFields } from "@/lib/compound/present/fingerprint";
import { DeltaMoney } from "./primitives";
import { Receipt, ReceiptLine, ReceiptTotal } from "./receipt";
import { Field, FieldError, Sheet, SheetActions } from "./sheet";

export function ClassifySheet({
  accountId, candidate, holders, matchable, fingerprint, currency, form, error,
  backHref, commitAction,
}: {
  accountId: number;
  candidate: CapitalEventCandidateRow;
  holders: HolderRow[];
  /** Ledger entries whose cash movement could account for this. */
  matchable: { entry: LedgerEntry; cashCents: bigint }[];
  fingerprint: Fingerprint;
  currency: string;
  form: { outcome?: string; holderId?: string; amount?: string; matchEntryId?: string; note?: string };
  error?: string;
  backHref: string;
  commitAction: (formData: FormData) => Promise<void>;
}) {
  const money = (c: bigint) => formatMoney(c, { currency });
  const positive = candidate.unexplainedCents > 0n;
  const fields = fingerprintToFields(fingerprint);
  const defaultAmount = candidate.unexplainedCents < 0n
    ? -candidate.unexplainedCents
    : candidate.unexplainedCents;

  return (
    <Sheet
      title={`Classify — ${formatDate(candidate.tradeDate)}`}
      lede="Readings are frozen until this is resolved. NAV never crosses a capital event nobody has explained."
      backHref={backHref}
    >
      {error ? <FieldError>{error}</FieldError> : null}

      <Receipt label="What happened on this day">
        <ReceiptLine label="The balance moved by">
          <DeltaMoney cents={candidate.balanceDeltaCents} currency={currency} />
        </ReceiptLine>
        <ReceiptLine label="Closed trades explain">
          <DeltaMoney cents={candidate.explainedCents} currency={currency} />
        </ReceiptLine>
        <ReceiptTotal label="Nobody has accounted for">
          <DeltaMoney cents={candidate.unexplainedCents} currency={currency} />
        </ReceiptTotal>
      </Receipt>

      {positive ? null : (
        <p className="split-note">
          Money left the account. If it was a payout you have already recorded here, match
          it below. If it was a partial withdrawal that is not in the ledger, Compound
          cannot record it yet — partial capital withdrawal is deferred (spec §12, P6) —
          and marking it &ldquo;not a capital event&rdquo; would give the loss to every
          holder pro-rata, which is wrong. Record it as a full exit through the payout
          screen instead, or leave this pending until P6 lands.
        </p>
      )}

      <form action={commitAction}>
        <input type="hidden" name="accountId" value={accountId} />
        <input type="hidden" name="candidateId" value={candidate.id} />
        {Object.entries(fields).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}

        <fieldset style={{ border: 0, padding: 0, margin: "18px 0 0" }}>
          <legend><span className="eyebrow">What was this</span></legend>

          {positive ? (
            <div style={{ margin: "12px 0", paddingBottom: 12, borderBottom: "1px solid var(--rule-soft)" }}>
              <label>
                <input type="radio" name="outcome" value="deposit" defaultChecked={form.outcome !== "match" && form.outcome !== "ignore"} />{" "}
                <strong>A deposit</strong>
                <small className="muted" style={{ display: "block", marginLeft: 22 }}>
                  Someone put money in. Units are issued to them at the NAV on{" "}
                  {formatDate(candidate.tradeDate)}, which is what makes a late-recorded
                  deposit fair to everyone already in.
                </small>
              </label>
              <div style={{ marginLeft: 22, marginTop: 10 }}>
                <Field name="holderId" label="Whose">
                  <select id="holderId" name="holderId" defaultValue={form.holderId}>
                    <option value="">Choose…</option>
                    {holders.map((h) => (
                      <option key={h.id} value={h.id}>{h.name}{h.isManager ? " (you)" : ""}</option>
                    ))}
                  </select>
                </Field>
                <Field
                  name="amount"
                  label={`Amount, ${currency}`}
                  hint={`Defaults to the unexplained figure, ${money(defaultAmount)}. Change it only if part of the move was something else.`}
                >
                  <input
                    id="amount" name="amount" inputMode="decimal"
                    defaultValue={form.amount ?? money(defaultAmount).replace(/[^0-9.]/g, "")}
                  />
                </Field>
              </div>
            </div>
          ) : null}

          <div style={{ margin: "12px 0", paddingBottom: 12, borderBottom: "1px solid var(--rule-soft)" }}>
            <label>
              <input
                type="radio" name="outcome" value="match"
                defaultChecked={form.outcome === "match" || (!positive && form.outcome !== "ignore")}
                disabled={matchable.length === 0}
              />{" "}
              <strong>Already recorded here</strong>
              <small className="muted" style={{ display: "block", marginLeft: 22 }}>
                {matchable.length === 0
                  ? "No entry in the ledger has a cash movement that could account for this."
                  : "A payout recorded in Compound and then executed at the broker still shows up here, because the reconciler compares balance against closed trades and a withdrawal is neither."}
              </small>
            </label>
            {matchable.length === 0 ? null : (
              <div style={{ marginLeft: 22, marginTop: 10 }}>
                <Field name="matchEntryId" label="Which entry">
                  <select id="matchEntryId" name="matchEntryId" defaultValue={form.matchEntryId}>
                    <option value="">Choose…</option>
                    {matchable.map(({ entry, cashCents }) => (
                      <option key={entry.id} value={entry.id}>
                        #{entry.seq} · {formatDate(entry.occurredOn)} · {entry.type} ·{" "}
                        {money(cashCents)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
          </div>

          <div style={{ margin: "12px 0" }}>
            <label>
              <input type="radio" name="outcome" value="ignore" defaultChecked={form.outcome === "ignore"} />{" "}
              <strong>Not a capital event</strong>
              <small className="muted" style={{ display: "block", marginLeft: 22 }}>
                A broker credit, a rebate, a correction. No ledger entry is written and the
                amount is absorbed into NAV pro-rata by the next reading — which is right for
                money that belongs to every holder, and wrong for money that belongs to one.
              </small>
            </label>
            <div style={{ marginLeft: 22, marginTop: 10 }}>
              <Field
                name="note"
                label="Why (required)"
                hint="This is the only record of the decision. Nothing else will remember it."
              >
                <input id="note" name="note" defaultValue={form.note} />
              </Field>
            </div>
          </div>
        </fieldset>

        <SheetActions>
          <button className="btn btn-primary" type="submit">Classify and unfreeze</button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
```

- [ ] **Step 5: The pages and the action**

```tsx
// app/a/[id]/review/page.tsx
import { withDb } from "@/lib/compound/db/client";
import { listCandidates } from "@/lib/compound/db/compound";
import { requireAccount } from "@/lib/compound/load/account";
import { loadInterlock } from "@/lib/compound/load/interlock";
import { planFor } from "@/lib/compound/load/reconcile";
import { ReviewQueue } from "@/lib/compound/ui/review-queue";
import { refreshReadings } from "../actions/actions";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const account = await requireAccount((await params).id);
  const [outcome, pending, interlock] = await Promise.all([
    planFor(account),
    withDb((c) => listCandidates(c, account.id, "pending")),
    loadInterlock(account.id),
  ]);

  return (
    <ReviewQueue
      accountId={account.id}
      currency={account.currency}
      plan={outcome.kind === "plan" ? outcome.plan : null}
      pending={[...pending].sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1))}
      frozenAt={interlock.frozenAt}
      defect={outcome.kind === "error" ? outcome.message : null}
      notConfigured={outcome.kind === "not-configured"}
      refreshAction={
        <form action={refreshReadings}>
          <input type="hidden" name="accountId" value={account.id} />
          <button className="btn" type="submit">Refresh readings</button>
        </form>
      }
    />
  );
}
```

```tsx
// app/a/[id]/review/[cid]/page.tsx
import { notFound } from "next/navigation";
import { withDb } from "@/lib/compound/db/client";
import { listCandidates } from "@/lib/compound/db/compound";
import { listHolders } from "@/lib/compound/db/holders";
import { requireAccount } from "@/lib/compound/load/account";
import { loadLedger, loadPoolState, loadSeeds } from "@/lib/compound/load/ledger";
import { fingerprintOf, ledgerSteps } from "@/lib/compound/present/derive";
import { ClassifySheet } from "@/lib/compound/ui/classify-sheet";
import { reviewHref } from "@/lib/compound/ui/routes";
import { classify } from "../../actions/actions";

export const dynamic = "force-dynamic";

export default async function ClassifyPage({
  params, searchParams,
}: {
  params: Promise<{ id: string; cid: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id, cid } = await params;
  const account = await requireAccount(id);
  if (!/^[1-9][0-9]{0,17}$/.test(cid)) notFound();
  const q = await searchParams;

  const [candidates, holders, entries, seeds, state] = await Promise.all([
    withDb((c) => listCandidates(c, account.id, "pending")),
    withDb((c) => listHolders(c, account.id)),
    loadLedger(account.id),
    loadSeeds(account.id),
    loadPoolState(account.id),
  ]);
  const candidate = candidates.find((k) => k.id === Number(cid));
  if (candidate === undefined) notFound();

  // An entry can account for this move when its cash movement matches the
  // unexplained figure. The cash movement is the EQUITY DELTA, not the stored
  // amount — replay recomputes a payout and never reads that field.
  const matchable = ledgerSteps(entries, seeds)
    .filter((s) => !s.voided && s.equityDelta !== 0n)
    .filter((s) => s.equityDelta === candidate.unexplainedCents)
    .map((s) => ({ entry: s.entry, cashCents: s.equityDelta }));

  return (
    <ClassifySheet
      accountId={account.id}
      candidate={candidate}
      holders={holders}
      matchable={matchable}
      fingerprint={fingerprintOf(account.id, state)}
      currency={account.currency}
      form={q}
      error={q.error}
      backHref={reviewHref(account.id)}
      commitAction={classify}
    />
  );
}
```

Append to `app/a/[id]/actions/actions.ts`:

```typescript
export async function classify(formData: FormData) {
  const account = await requireAccount(String(formData.get("accountId")));
  const user = await requireManager();
  const candidateId = Number(formData.get("candidateId"));
  const back = classifyHref(account.id, candidateId);

  const stale = await staleness(account.id, formData);
  if (stale !== null) redirect(`${back}?error=${encodeURIComponent(stale)}`);
  const shown = fingerprintFromFields((k) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : null;
  })!;

  const outcome = String(formData.get("outcome"));
  if (outcome !== "deposit" && outcome !== "match" && outcome !== "ignore") {
    redirect(`${back}?error=${encodeURIComponent("Choose what this was before classifying it.")}`);
  }

  let amountCents: bigint | null = null;
  if (outcome === "deposit") {
    try {
      amountCents = centsFromDecimal(String(formData.get("amount")));
    } catch {
      redirect(`${back}?error=${encodeURIComponent("That is not an amount. Use digits and at most two decimal places.")}`);
      return;
    }
  }

  try {
    await withDbTransaction((c) =>
      classifyCandidate(c, {
        accountId: account.id,
        candidateId,
        outcome: outcome as "deposit" | "match" | "ignore",
        holderId: outcome === "deposit" ? Number(formData.get("holderId")) : null,
        amountCents,
        matchEntryId: outcome === "match" ? Number(formData.get("matchEntryId")) : null,
        note: String(formData.get("note") ?? "") || null,
        expectedSeq: shown.seq,
        actorUserId: user.id,
      }),
    );
    revalidatePath(deskHref(account.id), "layout");
    redirect(reviewHref(account.id));
  } catch (e) {
    if (isNextControlFlow(e)) throw e;
    redirect(`${back}?error=${encodeURIComponent(explainCommitError(e))}`);
  }
}
```

- [ ] **Step 6: Write `lib/compound/ui/review-queue.test.tsx`**

```tsx
import { render, screen, within } from "@testing-library/react";
import type { CapitalEventCandidateRow } from "@/lib/compound/db/compound";
import type { DroppedDeal } from "@/lib/compound/reconcile/dedupe";
import type { ClosedDeal } from "@/lib/compound/reconcile/types";
import type { ReadingPlan } from "@/lib/compound/reconcile/interlock";
import { ReviewQueue, SuppressedDeals } from "./review-queue";

const CANDIDATE: CapitalEventCandidateRow = {
  id: 12, accountId: 7, tradeDate: "2026-08-12",
  balanceDeltaCents: 500_000n, explainedCents: 0n, unexplainedCents: 500_000n,
  status: "pending", detectedAt: "2026-08-13T02:00:00.000Z",
};

const DEAL: ClosedDeal = {
  ticket: 90_019_999, symbol: "EURUSD", side: "sell", volumeMilliLots: 100,
  openTime: "2026-08-06T08:00:00.000Z", closeTime: "2026-08-06T11:00:00.000Z",
  profitCents: 8_000n, swapCents: 0n, commissionCents: 0n,
};
const DROPPED: DroppedDeal[] = [{ deal: DEAL, duplicateOfTicket: 90_010_004 }];

const IDLE: ReadingPlan = { kind: "idle", droppedDeals: DROPPED };
const refresh = <button type="button">Refresh readings</button>;

function renderQueue(over: Partial<Parameters<typeof ReviewQueue>[0]> = {}) {
  return render(
    <ReviewQueue
      accountId={7}
      currency="USD"
      plan={over.plan === undefined ? IDLE : over.plan}
      pending={over.pending ?? [CANDIDATE]}
      frozenAt={over.frozenAt === undefined ? "2026-08-11" : over.frozenAt}
      defect={over.defect ?? null}
      notConfigured={over.notConfigured ?? false}
      refreshAction={refresh}
    />,
  );
}

describe("ReviewQueue — a pending candidate", () => {
  beforeEach(() => renderQueue());

  it("shows the arithmetic as an equation the reader can check", () => {
    expect(screen.getByLabelText("The balance moved by").textContent).toBe("+$5,000.00");
    expect(screen.getByLabelText("Closed trades explain").textContent).toBe("+$0.00");
    expect(screen.getByLabelText("Nobody has accounted for").textContent).toBe("+$5,000.00");
  });

  it("adds up: explained plus unexplained is the balance move", () => {
    const n = (label: string) => {
      const t = screen.getByLabelText(label).textContent!;
      return BigInt(t.replace(/[^0-9]/g, "")) * (t.startsWith("-") ? -1n : 1n);
    };
    expect(n("Closed trades explain") + n("Nobody has accounted for"))
      .toBe(n("The balance moved by"));
  });

  it("dates the event and says where figures are frozen", () => {
    expect(screen.getByRole("heading", { name: "12 Aug 2026" })).toBeInTheDocument();
    expect(screen.getByText(/Readings are frozen at 11 Aug 2026/)).toBeInTheDocument();
  });

  it("says why freezing is deliberate rather than apologising for it", () => {
    expect(screen.getByText(/an unrecorded deposit is indistinguishable from profit/))
      .toBeInTheDocument();
  });

  it("links to the classify sheet", () => {
    expect(screen.getByRole("link", { name: "Classify this" }))
      .toHaveAttribute("href", "/a/7/review/12");
  });
});

describe("ReviewQueue — suppressed duplicates", () => {
  it("lists every dropped deal with the ticket it was judged a copy of", () => {
    renderQueue();
    const row = screen.getByRole("row", { name: /90019999/ });
    const cells = [...within(row).getAllByRole("rowheader"), ...within(row).getAllByRole("cell")]
      .map((c) => c.textContent);
    expect(cells).toEqual([
      "90019999", "EURUSD", "sell", "0.100",
      "6 Aug 2026, 11:00 UTC", "+$80.00", "90010004",
    ]);
  });

  it("shows the panel even when nothing is pending, because it is an audit", () => {
    renderQueue({ pending: [] });
    expect(screen.getByText(/Suppressed as duplicates · 1/)).toBeInTheDocument();
  });

  it("says which way a dedupe mistake fails, in both directions", () => {
    renderQueue();
    const note = screen.getByText(/wrongly suppressed/).textContent!;
    expect(note).toContain("explained figure too small");
    expect(note).toContain("loud, and safe");
    expect(note).toContain("wrongly kept makes the explained figure too large");
    expect(note).toContain("silent");
  });

  it("says so plainly when nothing was suppressed", () => {
    render(<SuppressedDeals dropped={[]} currency="USD" />);
    expect(screen.getByText("Nothing was suppressed in this run.")).toBeInTheDocument();
    expect(screen.getByText(/Suppressed as duplicates · 0/)).toBeInTheDocument();
  });
});

describe("ReviewQueue — a data defect is not a halt", () => {
  const message =
    "duplicate snapshot for tradeDate 2026-08-12 in the reading window: two rows both " +
    "claim to close that day";

  beforeEach(() => renderQueue({ pending: [], plan: null, defect: message }));

  it("says the data is wrong, not that something needs classifying", () => {
    expect(screen.getByRole("alert").textContent)
      .toContain("The data upstream is wrong, and this is not a capital event.");
    expect(screen.getByText(/duplicate snapshot for tradeDate 2026-08-12/)).toBeInTheDocument();
  });

  it("offers no classify control, because there is nothing to classify", () => {
    expect(screen.queryByRole("link", { name: /Classify/ })).toBeNull();
  });

  it("warns that the duplicate date may be concealing a real event", () => {
    expect(screen.getByText(/can be concealing a real capital event/)).toBeInTheDocument();
  });

  it("does not claim everything is fine", () => {
    expect(screen.queryByText("Nothing waiting")).toBeNull();
  });
});

describe("ReviewQueue — nothing pending", () => {
  it("says readings are advancing and when the last one landed", () => {
    renderQueue({ pending: [] });
    expect(screen.getByText("Nothing waiting")).toBeInTheDocument();
    expect(screen.getByText(/Readings are advancing, last posted 11 Aug 2026/))
      .toBeInTheDocument();
  });
});

describe("ReviewQueue — reconciliation switched off", () => {
  it("explains the offset, and does not pretend the queue is clear", () => {
    renderQueue({ pending: [], plan: null, notConfigured: true });
    expect(screen.getByText(/broker's UTC offset is not set/)).toBeInTheDocument();
    expect(screen.getByText(/can hide a real capital event/)).toBeInTheDocument();
    expect(screen.queryByText("Nothing waiting")).toBeNull();
  });
});

describe("ReviewQueue — a plan that halted", () => {
  it("still renders the suppressed list, because halt carries droppedDeals too", () => {
    const halt: ReadingPlan = {
      kind: "halt", readings: [], newCursorDate: "2026-08-11",
      candidate: {
        tradeDate: "2026-08-12", previousDate: "2026-08-11",
        balanceDeltaCents: 500_000n, explainedCents: 0n, unexplainedCents: 500_000n,
      },
      droppedDeals: DROPPED,
    };
    renderQueue({ plan: halt });
    expect(screen.getByRole("row", { name: /90019999/ })).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Write `lib/compound/ui/classify-sheet.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import type { CapitalEventCandidateRow } from "@/lib/compound/db/compound";
import type { HolderRow } from "@/lib/compound/db/holders";
import { ADA_ID, MANAGER_ID } from "@/lib/compound/present/fixture";
import { ClassifySheet } from "./classify-sheet";

const HOLDERS: HolderRow[] = [
  { id: MANAGER_ID, accountId: 7, name: "J. Marsh", email: null, userId: null,
    isManager: true, splitBps: 0, joinedAt: "2026-03-02", status: "active" },
  { id: ADA_ID, accountId: 7, name: "Ada Lovelace", email: null, userId: null,
    isManager: false, splitBps: 4000, joinedAt: "2026-05-04", status: "active" },
];
const FP = { accountId: 7, seq: 6, equityCents: "5574391", units: "402224547963043" };
const noop = async () => {};

function candidate(over: Partial<CapitalEventCandidateRow> = {}): CapitalEventCandidateRow {
  return {
    id: 12, accountId: 7, tradeDate: "2026-08-12",
    balanceDeltaCents: 500_000n, explainedCents: 0n, unexplainedCents: 500_000n,
    status: "pending", detectedAt: "2026-08-13T02:00:00.000Z", ...over,
  };
}

function renderSheet(
  k = candidate(),
  matchable: Parameters<typeof ClassifySheet>[0]["matchable"] = [],
) {
  return render(
    <ClassifySheet
      accountId={7} candidate={k} holders={HOLDERS} matchable={matchable}
      fingerprint={FP} currency="USD" form={{}} backHref="/a/7/review"
      commitAction={noop}
    />,
  );
}

describe("ClassifySheet — a positive move", () => {
  beforeEach(() => renderSheet());

  it("restates the arithmetic before asking for a decision", () => {
    expect(screen.getByLabelText("Nobody has accounted for").textContent).toBe("+$5,000.00");
  });

  it("offers all three outcomes", () => {
    expect(screen.getByRole("radio", { name: /A deposit/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Already recorded here/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Not a capital event/ })).toBeInTheDocument();
  });

  it("defaults the deposit amount to the unexplained figure", () => {
    expect(screen.getByLabelText(/Amount, USD/)).toHaveValue("5000.00");
  });

  it("says units are issued at the NAV of the event's own day", () => {
    expect(screen.getByText(/Units are issued to them at the NAV on 12 Aug 2026/))
      .toBeInTheDocument();
  });

  it("disables matching when nothing in the ledger could account for it", () => {
    expect(screen.getByRole("radio", { name: /Already recorded here/ })).toBeDisabled();
    expect(screen.getByText(/No entry in the ledger has a cash movement/)).toBeInTheDocument();
  });

  it("requires a note to ignore, and says why", () => {
    expect(screen.getByLabelText("Why (required)")).toBeInTheDocument();
    expect(screen.getByText(/only record of the decision/)).toBeInTheDocument();
  });

  it("says what ignoring actually does to the money", () => {
    expect(screen.getByText(/absorbed into NAV pro-rata/)).toBeInTheDocument();
    expect(screen.getByText(/right for money that belongs to every holder, and wrong for money that belongs to one/))
      .toBeInTheDocument();
  });

  it("carries the fingerprint so a stale classification cannot be committed", () => {
    expect(document.querySelector<HTMLInputElement>('input[name="fpSeq"]')!.value).toBe("6");
  });
});

describe("ClassifySheet — a negative move", () => {
  beforeEach(() => renderSheet(candidate({
    balanceDeltaCents: -500_000n, explainedCents: 0n, unexplainedCents: -500_000n,
  })));

  it("does not offer a deposit for money that left", () => {
    expect(screen.queryByRole("radio", { name: /A deposit/ })).toBeNull();
  });

  it("says partial withdrawal is deferred, and what to do instead", () => {
    expect(screen.getByText(/partial capital withdrawal is deferred/)).toBeInTheDocument();
    expect(screen.getByText(/Record it as a full exit through the payout screen instead/))
      .toBeInTheDocument();
  });

  it("warns that ignoring a withdrawal gives the loss to everyone", () => {
    expect(screen.getByText(/would give the loss to every holder pro-rata, which is wrong/))
      .toBeInTheDocument();
  });
});

describe("ClassifySheet — matching an existing entry", () => {
  it("offers the entries whose cash movement matches, with their figures", () => {
    renderSheet(
      candidate({ balanceDeltaCents: -157_836n, explainedCents: 0n, unexplainedCents: -157_836n }),
      [{
        entry: {
          id: 7, seq: 7, holderId: ADA_ID, occurredOn: "2026-08-18", type: "payout",
          amountCents: 263_060n, feeSettlement: "units", splitBpsApplied: 4000, reversesId: null,
        },
        cashCents: -157_836n,
      }],
    );
    const option = screen.getByRole("option", { name: /#7 · 18 Aug 2026 · payout · -\$1,578\.36/ });
    expect(option).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Already recorded here/ })).toBeEnabled();
  });

  it("explains why a recorded payout shows up here at all", () => {
    renderSheet(
      candidate({ unexplainedCents: -157_836n }),
      [{
        entry: {
          id: 7, seq: 7, holderId: ADA_ID, occurredOn: "2026-08-18", type: "payout",
          amountCents: 263_060n, feeSettlement: "units", splitBpsApplied: 4000, reversesId: null,
        },
        cashCents: -157_836n,
      }],
    );
    expect(screen.getByText(/compares balance against closed trades and a withdrawal is neither/))
      .toBeInTheDocument();
  });
});
```

- [ ] **Step 8: Write `lib/compound/db/write-classify.db.test.ts`**

```typescript
import { withDbTransaction } from "@/lib/compound/db/client";
import { getLedgerEntries, listCandidates } from "@/lib/compound/db/compound";
import { classifyCandidate } from "@/lib/compound/db/write-classify";
import { commitDeposit } from "@/lib/compound/db/write-deposit";
import { MANAGER_USER_ID, seedTwoAccounts } from "@/lib/compound/db/test-harness";

const rollback = (e: Error) => { if (e.message !== "rollback") throw e; };

async function withCandidate(c: Parameters<typeof classifyCandidate>[0], accountId: number, unexplained = 500_000n) {
  const { rows } = await c.query<{ id: string }>(
    `insert into public.compound_capital_event_candidate
       (account_id, trade_date, balance_delta_cents, explained_cents, unexplained_cents)
     values ($1, '2026-08-12', $2, 0, $2) returning id`,
    [accountId, unexplained.toString()],
  );
  return Number(rows[0]!.id);
}

describe("classifyCandidate", () => {
  it("as a deposit, writes an entry dated on the event's own day", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      await commitDeposit(c, {
        accountId: mine.accountId, holderId: mine.managerHolderId, occurredOn: "2026-03-02",
        amountCents: 2_500_000n, note: null, actorUserId: MANAGER_USER_ID,
      });
      const candidateId = await withCandidate(c, mine.accountId);
      const maxSeq = Math.max(...(await getLedgerEntries(c, mine.accountId)).map((e) => e.seq));

      const { ledgerEntryId } = await classifyCandidate(c, {
        accountId: mine.accountId, candidateId, outcome: "deposit",
        holderId: mine.managerHolderId, amountCents: 500_000n, matchEntryId: null,
        note: "Late-recorded transfer", expectedSeq: maxSeq, actorUserId: MANAGER_USER_ID,
      });

      const entry = (await getLedgerEntries(c, mine.accountId)).find((e) => e.id === ledgerEntryId)!;
      expect(entry.type).toBe("deposit");
      expect(entry.occurredOn).toBe("2026-08-12");    // the event's day, not today
      expect(entry.amountCents).toBe(500_000n);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("resolves the candidate and points it at the entry it created", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const candidateId = await withCandidate(c, mine.accountId);
      const { ledgerEntryId } = await classifyCandidate(c, {
        accountId: mine.accountId, candidateId, outcome: "deposit",
        holderId: mine.managerHolderId, amountCents: 500_000n, matchEntryId: null,
        note: null, expectedSeq: 0, actorUserId: MANAGER_USER_ID,
      });
      expect(await listCandidates(c, mine.accountId, "pending")).toEqual([]);
      const { rows } = await c.query<{ status: string; resolved_ledger_entry_id: string | null }>(
        `select status, resolved_ledger_entry_id
           from public.compound_capital_event_candidate where id = $1`, [candidateId],
      );
      expect(rows[0]!.status).toBe("classified");
      expect(Number(rows[0]!.resolved_ledger_entry_id)).toBe(ledgerEntryId);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("refuses to classify the same candidate twice, with CX203", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const candidateId = await withCandidate(c, mine.accountId);
      await classifyCandidate(c, {
        accountId: mine.accountId, candidateId, outcome: "deposit",
        holderId: mine.managerHolderId, amountCents: 500_000n, matchEntryId: null,
        note: null, expectedSeq: 0, actorUserId: MANAGER_USER_ID,
      });
      await expect(classifyCandidate(c, {
        accountId: mine.accountId, candidateId, outcome: "deposit",
        holderId: mine.managerHolderId, amountCents: 500_000n, matchEntryId: null,
        note: null, expectedSeq: 1, actorUserId: MANAGER_USER_ID,
      })).rejects.toThrow(/is already classified/);
      // And exactly one deposit exists for it, not two.
      const deposits = (await getLedgerEntries(c, mine.accountId))
        .filter((e) => e.type === "deposit" && e.occurredOn === "2026-08-12");
      expect(deposits).toHaveLength(1);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("as ignore, writes no entry and requires a note", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const candidateId = await withCandidate(c, mine.accountId);
      await expect(classifyCandidate(c, {
        accountId: mine.accountId, candidateId, outcome: "ignore",
        holderId: null, amountCents: null, matchEntryId: null,
        note: "   ", expectedSeq: 0, actorUserId: MANAGER_USER_ID,
      })).rejects.toThrow(/requires a note/);

      const { ledgerEntryId } = await classifyCandidate(c, {
        accountId: mine.accountId, candidateId, outcome: "ignore",
        holderId: null, amountCents: null, matchEntryId: null,
        note: "Broker rebate, confirmed by support ticket 4471",
        expectedSeq: 0, actorUserId: MANAGER_USER_ID,
      });
      expect(ledgerEntryId).toBeNull();
      expect(await getLedgerEntries(c, mine.accountId)).toEqual([]);
      const { rows } = await c.query<{ status: string }>(
        `select status from public.compound_capital_event_candidate where id = $1`, [candidateId],
      );
      expect(rows[0]!.status).toBe("ignored");
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("as match, writes no entry and points at the existing one", async () => {
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const { ledgerEntryId: existing } = await commitDeposit(c, {
        accountId: mine.accountId, holderId: mine.managerHolderId, occurredOn: "2026-03-02",
        amountCents: 2_500_000n, note: null, actorUserId: MANAGER_USER_ID,
      });
      const candidateId = await withCandidate(c, mine.accountId);
      const before = (await getLedgerEntries(c, mine.accountId)).length;
      const r = await classifyCandidate(c, {
        accountId: mine.accountId, candidateId, outcome: "match",
        holderId: null, amountCents: null, matchEntryId: existing,
        note: null, expectedSeq: 1, actorUserId: MANAGER_USER_ID,
      });
      expect(r.ledgerEntryId).toBe(existing);
      expect((await getLedgerEntries(c, mine.accountId)).length).toBe(before);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("refuses to match an entry belonging to another account, with CX210", async () => {
    await withDbTransaction(async (c) => {
      const { mine, theirs } = await seedTwoAccounts(c);
      const { ledgerEntryId: theirEntry } = await commitDeposit(c, {
        accountId: theirs.accountId, holderId: theirs.managerHolderId,
        occurredOn: "2026-03-02", amountCents: 100n, note: null, actorUserId: MANAGER_USER_ID,
      });
      const candidateId = await withCandidate(c, mine.accountId);
      await expect(classifyCandidate(c, {
        accountId: mine.accountId, candidateId, outcome: "match",
        holderId: null, amountCents: null, matchEntryId: theirEntry,
        note: null, expectedSeq: 0, actorUserId: MANAGER_USER_ID,
      })).rejects.toThrow(/is not on account/);
      throw new Error("rollback");
    }).catch(rollback);
  });

  it("unfreezes the interlock: a reading past the event is accepted afterwards", async () => {
    // The point of the whole task. Before classification a deposit dated on
    // that day is refused; after it, it is accepted.
    await withDbTransaction(async (c) => {
      const { mine } = await seedTwoAccounts(c);
      const candidateId = await withCandidate(c, mine.accountId);
      await expect(commitDeposit(c, {
        accountId: mine.accountId, holderId: mine.managerHolderId, occurredOn: "2026-08-13",
        amountCents: 100n, note: null, actorUserId: MANAGER_USER_ID,
      })).rejects.toThrow(/on or after the unclassified capital event/);

      await classifyCandidate(c, {
        accountId: mine.accountId, candidateId, outcome: "ignore",
        holderId: null, amountCents: null, matchEntryId: null,
        note: "Broker rebate", expectedSeq: 0, actorUserId: MANAGER_USER_ID,
      });

      await expect(commitDeposit(c, {
        accountId: mine.accountId, holderId: mine.managerHolderId, occurredOn: "2026-08-13",
        amountCents: 100n, note: null, actorUserId: MANAGER_USER_ID,
      })).resolves.toBeDefined();
      throw new Error("rollback");
    }).catch(rollback);
  });
});
```

- [ ] **Step 9: Run the gates and prove three probes**

```bash
supabase db reset && pnpm typecheck && pnpm test && pnpm test:db && pnpm build
```

Then, reverting each:

1. In `ReviewQueue`, render the `defect` case using the same markup as a candidate. Expect the four "a data defect is not a halt" assertions to fail. That block exists because the two states look alike on screen and are opposites in meaning.
2. In `ReviewQueue`, hide `SuppressedDeals` when `pending.length === 0`. Expect "shows the panel even when nothing is pending" to fail. The audit is most valuable exactly when the queue looks clear — a masked capital event produces no candidate at all.
3. In `compound_classify_candidate`, drop the `v_status <> 'pending'` check. Expect the twice-classified test to fail on `toHaveLength(1)` — two deposits for the same money, which is the concrete harm.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "$(cat <<'MSG'
feat(desk): the capital-event queue and classification

Renders what the interlock produces and provides the only way past it: deposit,
match an entry already in the ledger, or not-a-capital-event with a required
note. A negative unexplained move that is not an already-recorded payout is a
partial withdrawal, which is deferred, and the queue says so rather than
offering a control that would record it wrongly.

Also surfaces droppedDeals. A duplicate wrongly kept masks a real capital event
silently; every suppressed pair is now something the manager can check.

A duplicate-trade-date RangeError renders as a data defect, not as a halt.
Telling a manager to classify an event that does not exist sends them looking in
the wrong place while the real one stays hidden.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 15: Retiring the shell, and verifying what no unit test can

Everything the deployment shell demonstrated is now demonstrated by the desk itself, against real data. This task removes it, checks the things that only a browser can check, and runs the full gate.

**What is genuinely not covered by the tests in this plan**, stated plainly rather than assumed away:

| Not covered | Why | Covered instead by |
|---|---|---|
| The pages themselves | async Server Components cannot be rendered by `@testing-library/react`; each page is *resolve, load, render* with no branches | the smoke pass in Step 3 |
| Server Actions end to end | they redirect and revalidate; testing that needs a running server | the smoke pass, and the writer integration tests |
| That a loader fetched the right rows | mocking the loader and asserting the mock was called tests the mock | plan 3's integration suite, and Tasks 5/6/9/12/13/14's `.db.test.ts` files |
| Visual layout at each breakpoint | no automated check is honest about this | Step 4, by hand, at four widths |
| Focus order and keyboard operation | jsdom has no layout and no real focus model | Step 4, by hand |

- [ ] **Step 1: Delete the shell**

```bash
git rm lib/compound/demo/fixture-ledger.ts
rmdir lib/compound/demo 2>/dev/null || true
```

`app/page.tsx` was already replaced in Task 6. Confirm nothing else imports the demo fixture:

```bash
grep -rn "compound/demo\|DEMO_LEDGER\|DEMO_HOLDERS\|DEMO_HOLDER_NAMES" --include='*.ts' --include='*.tsx' . | grep -v node_modules
```

Expected: no output. **Plan 5 does not reference it** — checked against its merged plan, which builds only under `lib/compound/ui/journal|calendar|performance/` and reads through plan 3's readers.

- [ ] **Step 2: Update `app/layout.tsx` for the fonts the design system actually uses**

Unchanged in substance — Instrument Serif, Inter and IBM Plex Mono are already preconnected and loaded. Add the one thing missing: a skip link, so a keyboard reader is not walked through the masthead and six nav entries on every page.

```tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Serif&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
```

with, in `app/globals.css`:

```css
.skip {
  position: absolute; left: -9999px; top: 0;
  background: var(--card); color: var(--ink); padding: 10px 14px;
  border: 1px solid var(--ink); border-radius: 3px; z-index: 100;
}
.skip:focus { left: 8px; top: 8px; }
```

- [ ] **Step 3: The smoke pass**

Start the stack and walk every route. This is the only check that the pages compose, and there is no substitute for it.

```bash
supabase db reset
pnpm build && pnpm start
```

Sign in as the seeded manager, then, in order:

- [ ] `/` — with no accounts, the empty state offers `Add an account`.
- [ ] `/accounts/new` — create one against the seeded MT5 account `90000001`, broker offset `3`. The confirm step reports 10 daily snapshots. Landing page is the new desk.
- [ ] `/` again — one account, so it **redirects** to `/a/1`.
- [ ] `/a/1` — empty desk, "Nothing posted yet".
- [ ] Add capital for the manager, then add an investor, then add capital for them. The desk fills in; the rail shows two segments; the value column sums to equity.
- [ ] **Refresh readings.** The seed has an unexplained `+5000.00` on `2026-08-12`, so this must **halt**: the sub-nav Review badge shows `1`, the frozen banner appears on every account page including `/a/1/ledger`.
- [ ] `/a/1/review` — the candidate shows `+$5,000.00` moved, `+$0.00` explained, `+$5,000.00` unaccounted for. The suppressed-duplicates panel lists ticket `90019999` as a copy of `90010004`. **Both of these come from the seed and both must appear.**
- [ ] `/a/1/actions/capital` and `/a/1/actions/payout/...` — both refuse while the candidate is pending.
- [ ] Classify it as a deposit for the investor. Review goes clear, the badge disappears, the banner goes.
- [ ] **Refresh readings** again — now advances. The desk's equity matches the seed's last snapshot.
- [ ] `/a/1/ledger` — the classified deposit is dated `12 Aug 2026`, and the last row's state equals the desk.
- [ ] `/a/1/holders/2` — the statement's figures match the desk's row for that holder, and the statement/settlement note names two figures.
- [ ] Pay the investor out, profit only, fee as units. The receipt's `receives` figure matches what the holder statement previewed. Confirm. The ledger gains **two** rows: the settlement reading and the payout, adjacent.
- [ ] Open the payout sheet again in a second tab, commit in the first, then confirm in the second. **The second must refuse** with "the account moved while this was open", and nothing must be written.
- [ ] `/a/1/journal`, `/a/1/calendar`, `/a/1/performance` — 404 until plan 5 lands. Expected, and agreed.
- [ ] `/a/2` — 404 for an account that does not exist.

- [ ] **Step 4: Accessibility and responsive verification**

Spec §8.4, at 375 / 768 / 1024 / 1440. Check each and record what you found — an unrecorded pass is indistinguishable from a skipped check.

- [ ] **No horizontal page scroll at 375.** Every table is inside `.scroller`; the page body is not.
- [ ] **The statement head's equity figure** stays on one line at 375 (it is `clamp(32px, 6vw, 48px)`).
- [ ] **The KPI strip** reflows to one column at 375 and does not clip a figure.
- [ ] **The ownership rail** stays readable at 375 — segments below about 3% are visually thin, and the **legend is what carries the information**, per §8.4. Confirm the legend wraps rather than truncating.
- [ ] **Keyboard**: tab from the skip link through the masthead, switcher, sub-nav and into the page. The `<details>` switcher opens on Enter and closes on Escape. Every focused element has a visible ring (Task 1's `:focus-visible` rule).
- [ ] **The payout sheet by keyboard alone**: choose exit, tab to the settlement equity, submit, read the receipt, confirm. No mouse.
- [ ] **`prefers-reduced-motion`**: enable it at the OS level and confirm nothing animates.
- [ ] **Greyscale**: view the desk with colour removed. P/L still readable (the sign carries it), the fee column still identifiable (the amber tile has a label), the rail segments still distinguishable (Task 3's adjacent-lightness rule) and labelled.
- [ ] **Zoom to 200%** at 1440. Nothing overlaps; the tables scroll.

- [ ] **Step 5: The full gate**

```bash
supabase db reset
pnpm typecheck && pnpm test && pnpm test:db && pnpm build && pnpm check:secrets
```

All five must pass. `check:secrets` matters more than usual here: this plan adds fixtures, a seed-driven smoke pass and a screenshot-prone masthead, and the repository is public.

- [ ] **Step 6: Confirm the public-repository rules held**

```bash
grep -rn "90000001" --include='*.ts' --include='*.tsx' --include='*.sql' . | grep -v node_modules | grep -v supabase/seed.sql
```

Expected: only `supabase/seed.sql`, which is fictional by construction. No real account number, broker name or holder name in any file this plan touched. Every name in every fixture — J. Marsh, Ada Lovelace, Grace Hopper, Katherine Johnson — is invented.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "$(cat <<'MSG'
feat(desk): retire the deployment shell

Everything it demonstrated — the container runs, the engine computes — is now
demonstrated by the desk itself, against real data. Adds a skip link, and
records the accessibility and responsive pass at 375/768/1024/1440.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Plan self-review

**Spec coverage.** Every clause of §7 (surfaces), §8 (design system) and §9 (auth) maps to a task, along with the parts of §3, §4 and §5 that reach a screen.

| Spec | Task |
|---|---|
| §3.2 cost basis and the high-water mark, on screen | 10, 13 |
| §3.3 the split, on a receipt | 13 |
| §3.4 fee settlement — units or cash, both NAV-neutral | 13 |
| §3.5 invariant 2 (Σ value = equity) rendered exactly | 3, 4, 8 |
| §3.5 invariant 3 (NAV never falls) asserted at the presentation boundary | 3, 12 |
| §4 money, units, splits as integers to the screen edge | 2 |
| §4 NAV rounded to 4dp **at the presentation boundary only** | 2 |
| §4 rounding policy — allocated for reporting, floored for settlement | 2, 3, 10 (decision D-A) |
| §5.2 committed versus live NAV | 4, 8, 13 |
| §5.2 a payout writes its settlement reading in one transaction | 13 |
| §5.3 the safety interlock, visible on every account surface | 7, 11, 12, 13, 14 |
| §6.1 the ledger stores inputs, not outputs | 12, 13 |
| §6.2 `seq` defines replay order | 5, 9, 12, 13 |
| §6.3 duplicate deals — the suppression is now auditable | 14 |
| §7 `/` account list, or redirect when there is one | 6 |
| §7 `/a/[id]` the desk | 8 |
| §7 `/a/[id]/ledger` | 9 |
| §7 `/a/[id]/review` | 14 |
| §7 `/a/[id]/holders/[hid]` | 10 |
| §7 modal — post an equity reading | 11 |
| §7 modal — add an investor | 12 |
| §7 modal — add capital | 12 |
| §7 modal — pay out | 13 |
| §7 modal — classify a capital event | 14 |
| §7 "each shows full arithmetic before commit" | 11 (D-C, D-D), 12, 13, 14 |
| §8.1 tokens, exact values | 1 |
| §8.2 three hues, three meanings, none overloaded | 1, 3, 4 |
| §8.3 Instrument Serif / Inter / IBM Plex Mono, tabular | 1, 15 |
| §8.4 contrast floor, sign carries P/L, focus rings, reduced motion | 1, 15 |
| §8.4 verified at 375/768/1024/1440 | 15 |
| §9 the admin AND ownership gate | 5 (decision D-F) |
| §9 no `investor` role, no third role | 5 |
| §9 append-only visible in the product | 9, 12 |
| §10 no real identifiers in tracked files | 2, 15 |
| §11 "component tests for the payout receipt and review queue arithmetic" | 13, 14 |

Covered by other plans, not here: the engine (merged), the reconciler (merged), schema/RLS/append-only enforcement and the readers (plan 3), and `/journal`, `/calendar`, `/performance` (plan 5, merged at `700f89a`).

Deferred by the spec itself and deliberately absent: the investor portal (§12), partial capital withdrawal P6 — named on screen in Task 14 rather than silently missing — payout PDFs P7, scheduled payouts P8, time-weighted return R7, manager earnings R8, multi-currency beyond a symbol, and E5's reverse-an-entry control (§11 puts E5 outside v1; Task 9 renders a reversal correctly but offers no button that creates one).

**Type consistency.** Every engine and reconciler type is imported, never redefined: `Cents`, `Units`, `PoolTotals`, `PoolState`, `HolderState`, `HolderSeed`, `LedgerEntry`, `LedgerEntryType`, `Quote`, `PayoutMode`, `DailySnapshot`, `ClosedDeal`, `ReadingPlan`, `PlannedReading`, `CapitalEventCandidate`, `ReconcileCursor`, `DroppedDeal`. Plan 3's `CompoundAccount`, `CapitalEventCandidateRow` and `Queryable` likewise — `CompoundAccount` is *extended* in Task 5 with `brokerOffsetHours`, in plan 3's own file, rather than shadowed by a second shape.

Types this plan introduces are each defined once and used by that name throughout: `RailSegment`, `LedgerStep`, `CapitalMark`, `ProposedEntry`, `Fingerprint`, `Preview`, `PreviewInput`, `DeskRow`, `DeskFigures`, `HolderPosition`, `HolderStatementRow`, `HolderRow`, `LedgerEntryMeta`, `ResolvedAccount`, `SessionUser`, `InterlockState`, `ReconcileOutcome`, `ReadingGate`, `PayoutForm`, `LiveFigures`, `KpiItem`, `NavEntry`, `ClassifyOutcome`, and the five writer input types.

Functions defined in exactly one task and used consistently after it: `formatMoney`, `splitMoney`, `formatUnitsDp`, `formatNav`, `formatSinceInception`, `formatPpm`, `formatSplit`, `formatSplitWords`, `formatDate`, `formatUtcStamp`, `formatLots`, `signOf`, `allocateShares`, `railTint`, `railIsHatched`, `railSegments`, `ledgerSteps`, `capitalMarks`, `fingerprintOf`, `assertNavDidNotFall`, `previewEntry`, `deskFigures`, `holderPosition`, `holderStatement`, `explainCommitError`, `isNextControlFlow`, `fingerprintToFields`, `fingerprintFromFields`, `fingerprintMismatch`, `planFor`, `requireManager`, `requireAccount`, `resolveOwnedAccount`, `listManagerAccounts`, `loadLedger`, `loadSeeds`, `loadHolderNames`, `loadPoolState`, `loadLive`, `loadInterlock`, `listHolders`, `listLedgerMeta`, `getUserRole`, `createAccount`, `addHolder`, `commitDeposit`, `commitPayout`, `classifyCandidate`, `maskMt5`.

**One deliberate near-collision, checked.** `capitalMarks` returns `CapitalMark`, and plan 3's `CapitalEventCandidateRow` and the reconciler's `CapitalEventCandidate` are three different things with similar names. They are: a mark on an equity curve, a database row, and the reconciler's finding. All three appear in Task 14 and are imported under their own names; none is aliased.

**Placeholder scan.** No `TBD`. No "add error handling". No "similar to Task N". Every code step contains the code it describes. The two places that read like gaps are deliberate and are labelled as such:

- Task 5's note that `seedTwoAccounts` and `seedLedger` belong in **plan 3's** harness, with instructions to add them there rather than inline — because three plans' integration tests need the same seeder and three copies would drift.
- Task 13's at-the-mark component test carries a `throw` in its else branch rather than a skip, so a fixture that drifts off the mark fails loudly instead of quietly testing nothing.

**Every fixture figure in this plan was computed by running the merged engine**, not by hand. The one-cent gap between `$12,630.61` and `$12,630.60`, the 999,998 ppm share total, the `759.2520121904` fee units, the `1,376.53` reading delta and all four payout settlement combinations are transcriptions of that run.

---

## Deviations from the spec, for the record

Fold these back into the spec before executing.

1. **`--ink-3` cannot carry body text (D-L).** §8.1 sets it to `#8A96A6`, which is 3.00:1 on `--card` and 2.49:1 on `--paper`; §8.4 requires body text at ≥ 4.5:1. Both cannot be true. This plan restricts `--ink-3` to rules, decoration and large display text and moves every small label to `--ink-2`. The alternative — changing the token to `#5F6B7C` (5.41:1 / 4.49:1) — is a spec edit and was not taken unilaterally.

2. **A holder's value has two correct answers (D-A).** §4 specifies allocation for reporting and flooring for operations and never addresses their appearing on adjacent screens. They differ by up to a cent. The desk and holder tables show the allocated figure; the payout receipt shows the floored one; the holder statement reconciles them in words.

3. **`broker_offset_hours` is a new column on `compound_account`, nullable, range 1..14.** §6's schema sketch has no such column and `planReadings` requires the value. The range matches `dedupe.ts`'s own `MIN_OFFSET_HOURS`..`MAX_OFFSET_HOURS`, so the database cannot store a value the engine throws on. **Consequence worth deciding on: a broker running on UTC exactly cannot be configured**, because `MIN_OFFSET_HOURS` is 1. Widening it to 0 is a reconciler change.

4. **Spec §9's AND gate is enforced in application code, not by RLS (D-F).** Plan 3's P4 runs every connection as `service_role`, which carries `BYPASSRLS`. The policies are real and protect other clients; they do not run for these pages. §9 should say where the gate that actually binds lives.

5. **Money flows are routes, not overlays (D-B), and are two-step (D-C).** §7 calls them "modal flows". Every figure stays server-rendered, the back button works, and nothing hydrates.

6. **Sign-in and account creation are in scope (D-H, D-I).** Neither appears in §7's route table and without both nothing in this plan is reachable. Account creation writes the manager holder in the same transaction, because `fold` cannot settle a fee without one.

7. **Classification offers three outcomes, and partial withdrawal is named as absent (D-J).** §7 says "classify capital event" without saying into what. A negative unexplained move that is not an already-recorded payout is P6, which §12 defers; the queue says so rather than offering a control that would record it wrongly.

8. **`toleranceCents` is `0n` (D-O).** §6.3 verified a residual of exactly zero on real history and §5.3 does not name a tolerance. Any non-zero value is a capital event small enough to hide permanently.

9. **A payout does not move the reconcile cursor.** §5.2 requires the settlement reading and the payout in one transaction and says nothing about the cursor. Moving it would leave the payout's own day permanently unreconciled.

10. **`compound_holder.status` is written and never read (D-M).** This closes the gap plan 3 carried forward. `fold` decides; the column is kept in step by Task 13's exit writer so the database is not misleading to a direct reader, and Task 13's integration test asserts the two agree — the test plan 3 could not write, because none of its fixtures contained a payout.
