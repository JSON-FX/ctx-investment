# Compound Journal, Calendar and Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port CopyTraderX's journal arithmetic into Compound as exact integer-cent functions, and build the three trading surfaces on top of them — `/a/[id]/journal`, `/a/[id]/calendar`, `/a/[id]/performance` — so a pooled account answers "how is this actually trading" without a single duplicated deal reaching a count and without a deposit ever reading as a good week.

**Architecture:** Two layers with a hard rule between them. `lib/compound/journal/` holds pure aggregation over `bigint` cents — no React, no I/O, no floating point. `lib/compound/ui/` holds server-rendered presentation, and it is the only place a cent becomes a `number`, and then only as a pixel coordinate. Between them sits one choke point: `buildTradeHistory()` returns a branded `DedupedDeals` type that every aggregate requires, so a surface that forgets to deduplicate does not compile. All three routes are fully server-rendered with URL-driven state — no client components, no hydration, no serialisation boundary for money to leak across.

**Tech Stack:** TypeScript 5 (strict), Next.js 16 App Router, React 19 server components, Jest 29 + ts-jest, `react-dom/server`'s `renderToStaticMarkup` for component tests, `pg` 8 via plan 3's `db/` layer, pnpm 10, Node 23. No charting library, no date library, no CSS framework.

**Spec:** [`docs/superpowers/specs/2026-08-21-compound-investor-desk-design.md`](../specs/2026-08-21-compound-investor-desk-design.md) — §1 (what Compound reads from CopyTraderX), §4 (numeric representation), §5.3 (the safety interlock), §6.3 (upstream duplicate deals), §7 (surfaces), §8 (design system), §11 (testing).

**Implements decision D6:** *"Copy `lib/journal/`, rebuild the components. The pure functions are stable and tested; the components are exactly what should look different."*

---

## Scope note — read before starting

This is one plan in two phases with a hard checkpoint between them.

| Phase | Tasks | Ends at |
|---|---|---|
| **A — arithmetic and data** | 1–7 | Every journal figure computable from a deduplicated deal list in exact cents, with the database readers that supply it. No UI at all. |
| **B — the three surfaces** | 8–13 | `/journal`, `/calendar` and `/performance` rendering, verified against the spec's accessibility floor. |

**If the executor wants two plans, split after Task 7.** Phase A is independently mergeable and independently valuable — the desk built by plan 4 can consume `computeTradeStats` and `buildAccountEquitySeries` without any of Phase B existing. Phase B cannot start before it. Do not split anywhere else: Tasks 8–13 share one presentation module and one fixture.

## Prerequisites

- [ ] **Plan 1 (`feat/accounting-engine`)** — Tasks 6 and 11 import `Cents` and `formatCents` from `lib/compound/engine/money.ts`, and `LedgerEntry` from `lib/compound/engine/replay.ts`. Already merged.
- [ ] **Plan 2 (`feat/reconciler`)** — Task 2 imports `dedupeDeals` from `lib/compound/reconcile/dedupe.ts`, `ClosedDeal`/`DailySnapshot`/`dealNetCents` from `lib/compound/reconcile/types.ts`, and `utcDateKey` from `lib/compound/reconcile/date-key.ts`. Already merged.
- [ ] **Plan 3 (`feat/persistence`) Tasks 5 and 6** — Task 7 extends `lib/compound/db/copytraderx.ts` and uses `Queryable`, `centsExpr`, `utcIsoExpr`, `toCents`, `toId`, `toSide` from `lib/compound/db/sql.ts`, plus the test harness from `lib/compound/db/testing/harness.ts`.
- [ ] **Plan 4 (`feat/desk`)** — Phase B only. See the contract below.

## The contract with plan 4, agreed in writing

Plan 4 owns the account shell. This plan owns three pages inside it and nothing else. The following was settled between the two authors before either plan was written; it is recorded here so an executor can verify it rather than rediscover it.

| Thing | Owner | This plan's use |
|---|---|---|
| `app/a/[id]/layout.tsx` — masthead, account switcher, sub-nav | **Plan 4** | Assumed to exist. This plan creates no layout. |
| Sub-nav, six entries: Desk · Journal · Calendar · Performance · Ledger · Review | **Plan 4** | Plan 4 must include this plan's three routes. |
| `lib/compound/load/account.ts` → `requireAccount(idParam): Promise<ResolvedAccount>`, React `cache()`d, `notFound()` on a bad id | **Plan 4** | Every page here calls it. Fields used: `id`, `mt5Account`, `label`, `currency`, `brokerOffsetHours`. |
| `broker_offset_hours` on `compound_account` | **Plan 4** | Read only. See Task 2 for what happens when it is not configured. |
| `lib/compound/load/ledger.ts` → `loadLedger(accountId): Promise<LedgerEntry[]>` | **Plan 4** | `/performance` only. |
| `lib/compound/present/capital-marks.ts` → `capitalMarks(entries): CapitalMark[]`, applying `fold`'s voiding rule | **Plan 4** | `/performance` only. Consumed unchanged; this plan adds no field to `CapitalMark`. |
| `lib/compound/load/interlock.ts` → `loadInterlock(accountId): Promise<InterlockState>` where `InterlockState = { frozenAt: string \| null; pendingCandidateDate: string \| null; pendingCount: number }` | **Plan 4** | `/performance` only, and only `frozenAt` and `pendingCandidateDate`. `pendingCount` is plan 4's Review badge. Task 11 carries a fallback if plan 4 has not landed. |
| `broker_offset_hours` is `int` **NULL, no default** | **Plan 4** | Null means "not configured". Plan 4 hard-gates its reconcile action on it; this plan renders a visible notice instead. Same fact, two responses, neither pretends. |
| `lib/compound/ui/banner.tsx` → `InterlockBanner`, and the live-versus-committed label | **Plan 4** | Rendered, never re-phrased. |
| `lib/compound/present/rail.ts` → `railTint()` | **Plan 4** | **Not used here.** Green means ownership; this plan's charts use `--ink`, `--gain`, `--loss` only. |
| `globals.css` classes `.kpi .kpi-item .receipt .receipt-line .receipt-total .modal .modal-scrim .queue .queue-item .chip .btn .btn-primary .btn-danger .hairline .switcher .subnav .banner-halt .field .field-error` | **Plan 4** | `.chip` and `.btn` are reused by the filter bar. The rest are untouched. |
| `globals.css` classes `.cal* .curve* .hist* .filters*` | **This plan** | Four new families, added in Tasks 9–11. |
| Orders and positions — fixture tables and readers | **This plan** | Plan 3 does not read them and no fixture table exists. Task 7 closes the gap. |
| A jsdom Jest project | **Plan 4** | Not needed by this plan. See Global Constraints. |

---

## Decisions this plan makes that the spec did not settle

Six. Each is a real choice with a real alternative, and each is recorded because a reviewer will otherwise assume it was accidental.

1. **The calendar day is a UTC day, not a broker-server day.** `account_snapshots_daily.trade_date` is a broker date (§4) but `reconcile/date-key.ts` keys deals on UTC, and `detect.ts` reconciles the two against each other already. Introducing a *second* day definition for the calendar would put two different "Tuesdays" on one product. The calendar is therefore keyed on UTC and the UI says so. Consequence, stated plainly: for a broker at +3, a trade closing at 23:30 UTC appears on the calendar one day earlier than in the broker's own terminal. That is the lesser evil, and Task 4 has a test that pins it.

2. **All three routes are server-rendered with URL-driven state.** Month, day, filter, sort, search and page are search params. No client component, no `useState`, no hydration. This follows from the design direction — §8 calls it *Statement*, editorial, like a printed fund statement — and it removes the entire class of bug where a `bigint` has to cross a serialisation boundary. It also makes every drill-down linkable.

3. **The day drill-down is a route, not a modal.** `?day=2026-05-07` renders a panel under the grid. Plan 4's `.modal` exists for money-moving flows that need a confirm step; a read-only list of a day's trades needs no confirmation and no JavaScript.

4. **Statistics floor.** Averages, win rate and profit factor are integer divisions that rarely terminate. All floor, consistent with the engine's floor bias (§4). Win rate is exposed as integer basis points, profit factor as integer thousandths. No float ever decides a displayed figure, and no float comparison ever decides a colour.

5. **Trade counts use gross `profitCents`; money figures use net.** A trade whose gross profit is +5¢ and whose commission is −31¢ counts as a **win** and contributes **−26¢**. Win/loss is a statement about the setup; the money figure is a statement about the account. The upstream `trade-filters.ts` already documents this reasoning for its summary line but does not apply it in `calendar-aggregate.ts`, which uses gross for both. This plan applies it consistently and tests the distinction.

6. **`/performance` shows two curves, and the pairing is what satisfies R4.** A capital event does not move closed-trade P/L, so marking one on a trading-P/L curve communicates nothing. The curve that steps up on a deposit is the account-equity curve. So the page stacks: account equity plus a *cumulative contributed capital* line derived from the ledger's capital marks, with a marker per event; and below it, the capital-neutral trading-P/L curve. On a deposit the two top lines step by the same amount, the gap between them — which is performance — does not move, and the bottom curve is flat. Task 6 tests exactly that.

---

## What is ported from `lib/journal/`, what is rebuilt, and what is not brought across

D6 says *copy the pure functions, rebuild the components*. That is the right instruction and it is not a blanket one: the upstream is a prop-firm journal, three of its modules encode challenge rules that mean nothing to a pooled fund, and every one of its money paths uses `number`. Each module below is judged on two axes — does the behaviour belong in a fund desk, and what happens to its money representation.

The money rule applied throughout: **a value that is summed, compared or counted stays `bigint` cents; a value that is only ever displayed may become a string; a value that becomes a pixel becomes a `number` in one named module and never comes back.** Nothing is left in `number` merely because it was.

| Upstream module | Disposition | Money | Reasoning |
|---|---|---|---|
| `calendar-aggregate` | **Port, converted** (Task 4) | `netCents`, `grossCents` as `bigint` | It sums P/L across a day and those sums feed the month footer and the drill-down. `+=` on `number` dollars over a year of trading is the side door. Also gains a gross/net split the upstream lacks. |
| `streaks` | **Port, near-verbatim** (Task 4) | Compares `profitCents` against `0n` | Never does arithmetic on money, only asks the sign. Gains a ticket tie-break and a `skippedFlat` count. |
| `trade-stats` | **Port, converted** (Task 3) | Sums `bigint`; ratios as scaled integers | Six of its ten figures are sums and must be exact. Its four ratios are genuinely fractional, so they become integer basis points and thousandths rather than floats — no float ever decides a rendered figure or a colour. |
| `trade-equity` | **Port, converted** (Task 5) | All `bigint` | The most float-dangerous module in the set: a running sum over every closed trade, off which every figure on `/performance` is read. |
| `histogram` | **Port, rewritten in integers** (Task 5) | Bin edges `bigint`, counts `number` | Integer edges remove the upstream's float step, its `0.0001` sign threshold and its float off-by-one at the top edge. Counts are counts. |
| `trade-filters` | **Port, one layering fix** (Task 8) | Summary in `bigint`; `cmpBig` comparator | The upstream imports `TableState` from a React hook file — a pure module depending on `components/`. Here `TableState` is defined in the pure layer and the UI imports it. Comparators use `cmpBig`, never `Number(a - b)`. |
| `order-filters` | **Port, same fix** (Task 8) | No money | `classifyOrderState` is a good pure mapping and is kept as-is. |
| `order-display` | **Port verbatim in substance** (Task 8) | No money | A pure constant-to-label map with a title-cased fallback. Nothing to convert, nothing to improve. |
| `data-age` | **Port when a surface needs it** — not in this plan | No money (milliseconds) | `deriveDataAge` is genuinely useful and staleness is a first-class concern under §5.3, but the live-versus-committed labelling belongs to plan 4's desk, and plan 4 owns that component. Duplicating it here would put two staleness vocabularies on one product. |
| `format-pnl` | **Rebuilt, not ported** (Task 9) | `bigint` in, string out | `fmtCash` runs `Intl.NumberFormat` over a `number`, which means dividing cents by 100 into a float. Porting it would create a second money formatter that takes floats — the side door, arriving through presentation. `present/figures.ts` is built on `engine/money.ts`'s `formatCents` instead, and `fmtPct` is replaced by `pctFromBps` because percentages arrive as integer basis points. |
| `export` | **Excluded** | — | Spec §7 does not list export among either route's contents, and §12 does not defer it either — it is simply not in v1. It is also the one module where a wrong conversion writes a wrong number into a file someone keeps. **If it is added later it must serialise money through `formatCents`, never `String(number)`,** and its `computePips` must be dropped or reworked: pips are float arithmetic over prices, and this plan carries prices as verbatim strings precisely so no float touches them. |
| `baseline` | **Excluded** | — | `resolveBaseline` answers "what is this prop-firm account's starting size, so P/L can be shown as a percent of it". A pooled fund has no account size. Its denominator for a percentage is NAV since inception, which `engine/nav.ts`'s `navTimes1e4` already computes exactly. Porting `baseline` would introduce a second, wrong denominator next to a correct one. |
| `objectives` | **Excluded** | — | Prop-firm challenge evaluation: profit target, daily loss limit, total loss limit, minimum trading days, pass/fail. Every field is a rule from a challenge agreement. A fund has no challenge to pass and no threshold to breach. There is nothing here to translate. |
| `passer-progress` | **Excluded** | — | Builds the three challenge KPI cards from an `ObjectivesResult`. Dead the moment `objectives` is excluded. Its formatting ideas are worth borrowing; its content is not. |
| `dashboard-drawdown` | **Excluded** | — | Measures drawdown against `PropfirmRule.account_size` and a challenge loss threshold. A fund's drawdown is peak-to-trough on its own curve, which `trade-equity` already computes. Porting this would put two drawdown numbers with different meanings on one product, and the reader would have no way to tell which is which. |
| `queries.ts` | **Excluded** | — | `@supabase/supabase-js` against PostgREST, which serialises `bigint` and `numeric` as JSON numbers. Plan 3 replaced it deliberately and for exactly that reason. |

**Net: nine modules ported, one rebuilt, five excluded.** Two modules with no upstream counterpart are added: `history.ts` (Task 2), which is the defence against §6.3, and `equity-series.ts` (Task 6), which is R4.

---

## Global Constraints

- **Every journal surface deduplicates before counting.** Spec §6.3. `lib/compound/reconcile/dedupe.ts` already implements the rule; this plan makes bypassing it a **type error**, not a convention. No aggregate function accepts `readonly ClosedDeal[]`.
- **No floating point in `lib/compound/journal/`.** Money is `Cents = bigint`. `number` is permitted only for counts, array indices, basis points and millisecond offsets. Enforced by a guard test in Task 1.
- **Cents become `number` in exactly one place:** `lib/compound/ui/scale.ts`, which converts a cent value to a pixel coordinate that never returns to an accounting path. Every other `lib/compound/ui/` module receives preformatted strings.
- **No `bigint` crosses the server/client boundary.** These three routes satisfy it by having no client components at all. The constraint is restated because it is global to the product, not because this plan is at risk of breaking it.
- Money: integer minor units (cents) as `bigint`. Splits: basis points as integer. `40%` is `4000`.
- Rounding on displayed statistics: **floor**, including for negative values, via `divFloor` in Task 1. BigInt `/` truncates toward zero and is therefore wrong for negatives.
- Dates: `YYYY-MM-DD` strings throughout, produced by `utcDateKey`. **No `new Date()` in `lib/compound/journal/` and none in any page or component.** A calendar grid built from local `Date` objects shifts a month boundary west of UTC.
- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`, `target: "ES2022"`.
- **No new `:root` custom properties.** Spec §8's tokens are already in `app/globals.css`. Four new class families only: `.cal*`, `.curve*`, `.hist*`, `.filters*`.
- Every number rendered carries `font-variant-numeric: tabular-nums` — the existing `.num` class. Spec §8.3: columns of money must not shift width between renders.
- Colour is never the sole carrier of meaning (§8.4). Every P/L figure carries an explicit sign; every calendar cell carries its figure as text; every chart mark carries a `<title>`.
- Repository is public (§10). Fictional account numbers, fictional symbols where practical, fictional amounts. No real balances, tickets or broker names in any file.
- Gates: `pnpm typecheck` and `pnpm test`. Database tests: `pnpm test:db`. Do **not** add `eslint-config-next`.

## The testing standard this plan is held to

Read [`2026-08-21-accounting-engine-carried-forward.md`](./2026-08-21-accounting-engine-carried-forward.md) before writing a single test. Twelve assertions that could not fail have shipped in this project across nine mechanisms. Three of those mechanisms bite specifically here:

| Mechanism | How it appears in this plan's subject matter | Countermeasure, applied throughout |
|---|---|---|
| **Fixture too thin to discriminate** | A calendar test with one trade per day cannot catch a bug that drops one of two same-day trades. | The shared fixture (Task 2) has **two trades on 2026-05-04**, **two on 2026-05-07** and **three on 2026-05-08**, and no day where the count is 1 except deliberately. |
| **Fixture lacks the defect under test** | A test whose deals contain no offset-shifted twin cannot detect a missing `dedupeDeals` call. | The shared fixture contains **one planted duplicate pair**, and it is planted where it changes the answer of *every* aggregate — trade count, win count, win rate, profit factor, max win streak, final cumulative P/L, and one calendar day's total. Each module has an assertion that goes red if the pair survives. |
| **Snapshot in place of assertion** | "The chart did not change" is not "the chart was ever right". | **No `toMatchSnapshot` anywhere in this plan.** Component assertions name the specific attribute and the specific value. |

Two rules, applied to every task:

1. **Every test names the mutation it catches**, in a comment or in its own name. A test that cannot be traced to a wrong implementation is decoration.
2. **Every task ends with a step that breaks the code and confirms the tests go red.** Not "run the tests" — deliberately introduce the wrong implementation, observe which test fails, and record anything that stayed green when it should not have.

---

# Phase A — arithmetic and data

---

### Task 1: `int.ts` and the guard that keeps floats out of `journal/`

The floor everything in Phase A stands on, and the test that stops the next person undoing it. Mirrors `engine/purity.test.ts`, which has held that line since plan 1.

**Files:**
- Create: `lib/compound/journal/int.ts`
- Create: `lib/compound/journal/int.test.ts`
- Create: `lib/compound/journal/purity.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `divFloor(n: bigint, d: bigint): bigint`
  - `absBig(n: bigint): bigint`
  - `maxBig(a: bigint, b: bigint): bigint`
  - `minBig(a: bigint, b: bigint): bigint`
  - `toIndex(n: bigint): number`

- [ ] **Step 1: Create `lib/compound/journal/int.ts`**

```typescript
/**
 * Integer arithmetic for the journal layer.
 *
 * This module exists for one reason: BigInt's `/` truncates toward zero, and
 * almost every statistic on a journal surface can be negative. -2773n / 3n is
 * -924n, not -925n. Truncation is not floor, and a codebase that assumes it is
 * will be right for winners and wrong for losers — the worst possible split,
 * because the tests are usually written with winners.
 *
 * Spec section 4 sets the engine's bias: floor. These are display figures that
 * move no money, so the direction is chosen for consistency with the engine
 * rather than for safety, and consistency is the point — one rounding
 * direction in the product, not two.
 *
 * This is also the ONLY file in lib/compound/journal/ permitted to call
 * Number(). purity.test.ts exempts it by name.
 */

/** Floor division. `n / d` truncates toward zero; this does not. */
export function divFloor(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError("divFloor: division by zero");
  const q = n / d;
  if (n % d === 0n) return q;
  return n < 0n !== d < 0n ? q - 1n : q;
}

export function absBig(n: bigint): bigint {
  return n < 0n ? -n : n;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * A bigint used as an array index.
 *
 * Throws rather than silently losing precision. The ceiling is deliberately
 * far below 2^53 — nothing in this layer indexes a million-element array, so a
 * value that large means the caller computed an index from a money figure by
 * mistake, and a loud failure is worth more than a correct conversion.
 */
export function toIndex(n: bigint): number {
  if (n < 0n || n > 1_000_000n) {
    throw new RangeError(`toIndex: out of range: ${n}`);
  }
  return Number(n);
}
```

- [ ] **Step 2: Create `lib/compound/journal/int.test.ts`**

Every case below is chosen because truncation and floor disagree on it. The positive cases are controls — they agree, and they are here so the suite does not look like it only ever tests negatives.

```typescript
import { absBig, divFloor, maxBig, minBig, toIndex } from "./int";

describe("divFloor", () => {
  // Mutation caught: `return n / d`. BigInt division truncates toward zero,
  // so every one of these negative cases comes back one too high.
  it("floors a negative quotient away from zero", () => {
    expect(divFloor(-7n, 2n)).toBe(-4n);       // truncation gives -3n
    expect(divFloor(-2773n, 3n)).toBe(-925n);  // truncation gives -924n
    expect(divFloor(-1n, 3n)).toBe(-1n);       // truncation gives 0n
  });

  it("floors a positive quotient toward zero, which is the same thing", () => {
    expect(divFloor(7n, 2n)).toBe(3n);
    expect(divFloor(6231n, 5n)).toBe(1246n);   // 1246.2
  });

  // Mutation caught: an unconditional `q - 1n`, which would make every exact
  // division one too low.
  it("does not adjust an exact division, in either sign", () => {
    expect(divFloor(-8n, 2n)).toBe(-4n);
    expect(divFloor(8n, 2n)).toBe(4n);
    expect(divFloor(0n, 5n)).toBe(0n);
  });

  // Mutation caught: comparing signs with `n < 0n && d < 0n` instead of `!==`.
  it("floors correctly when the divisor is negative", () => {
    expect(divFloor(7n, -2n)).toBe(-4n);
    expect(divFloor(-7n, -2n)).toBe(3n);
  });

  it("rejects a zero divisor rather than returning a poisoned value", () => {
    expect(() => divFloor(1n, 0n)).toThrow(/division by zero/);
  });
});

describe("absBig / maxBig / minBig", () => {
  it("handles the sign boundary", () => {
    expect(absBig(-1n)).toBe(1n);
    expect(absBig(0n)).toBe(0n);
    expect(maxBig(-5n, -9n)).toBe(-5n);
    expect(minBig(-5n, -9n)).toBe(-9n);
  });
});

describe("toIndex", () => {
  it("converts a small non-negative bigint", () => {
    expect(toIndex(0n)).toBe(0);
    expect(toIndex(7n)).toBe(7);
  });

  // Mutation caught: `Number(n)` with no guard. 9007199254740993n silently
  // becomes 9007199254740992 — the exact failure spec section 4 exists to
  // prevent, arriving through an index instead of through a balance.
  it("refuses a value that could only have come from a money figure", () => {
    expect(() => toIndex(9_007_199_254_740_993n)).toThrow(/out of range/);
    expect(() => toIndex(-1n)).toThrow(/out of range/);
  });
});
```

- [ ] **Step 3: Create `lib/compound/journal/purity.test.ts`**

```typescript
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = __dirname;

/** int.ts is the single sanctioned bigint-to-number conversion point. */
const NUMBER_EXEMPT = new Set(["int.ts"]);

const FORBIDDEN: Array<[string, RegExp]> = [
  ["imports the db layer", /from\s+["']@?[./\w-]*\/compound\/db/],
  ["imports the ui layer", /from\s+["']@?[./\w-]*\/compound\/ui/],
  ["imports next", /from\s+["']next/],
  ["imports react", /from\s+["']react/],
  ["imports @supabase", /from\s+["']@supabase/],
  // A month grid or a day key built from a local Date shifts west of UTC.
  // reconcile/date-key.ts is where Date is allowed; nothing here needs it.
  ["constructs a Date", /new\s+Date\s*\(/],
  ["reads the clock", /Date\.now\s*\(/],
  ["uses parseFloat", /\bparseFloat\s*\(/],
  // A decimal literal in this layer is a float amount of money or a float
  // threshold. Both are forbidden by spec section 4.
  ["contains a decimal literal", /(?<![\w.])\d+\.\d+(?![\w.])/],
];

function sourceFiles(): string[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
}

describe("journal purity", () => {
  it("has source files to check", () => {
    // Mutation caught: the guard silently passing because it is pointed at an
    // empty directory. This is the assertion plan 1 learned to write first.
    expect(sourceFiles().length).toBeGreaterThan(0);
  });

  it.each(sourceFiles())("%s stays pure", (file) => {
    const src = readFileSync(join(DIR, file), "utf8");
    for (const [label, pattern] of FORBIDDEN) {
      expect({ file, label, matched: pattern.test(src) }).toEqual({
        file,
        label,
        matched: false,
      });
    }
  });

  it.each(sourceFiles().filter((f) => !NUMBER_EXEMPT.has(f)))(
    "%s does not call Number()",
    (file) => {
      const src = readFileSync(join(DIR, file), "utf8");
      expect({ file, matched: /\bNumber\s*\(/.test(src) }).toEqual({
        file,
        matched: false,
      });
    },
  );
});
```

- [ ] **Step 4: Run the gates**

```bash
pnpm typecheck && pnpm test -- lib/compound/journal
```

Expected: green. `int.ts` is the only source file, and it is exempt from the `Number()` rule.

- [ ] **Step 5: Prove these tests bite**

Run each mutation, confirm the named test goes red, then restore.

1. **`divFloor` returns `n / d`.** Expected red: all three assertions in `"floors a negative quotient away from zero"`, and nothing else. If a positive-only test also goes red, the mutation was applied wrong.
2. **`divFloor` returns `q - 1n` unconditionally.** Expected red: `"does not adjust an exact division, in either sign"` and `"floors a positive quotient toward zero"`.
3. **`toIndex` drops its guard.** Expected red: `"refuses a value that could only have come from a money figure"`. Record the value it returns — `9007199254740992` — because that number is the whole argument for the guard.
4. **Add `const RATE = 0.75;` to `int.ts`.** Expected red: `"int.ts stays pure"` on `contains a decimal literal`. Delete it.
5. **Add `import { fold } from "@/lib/compound/engine/replay";` to `int.ts`.** Expected: **green**. Record it. `engine/` is a permitted import — it is pure, it speaks cents, and Task 6 needs `LedgerEntry` from it. The guard is about I/O, React and floats, not about all imports.
6. **Rename `int.ts` to `intx.ts`** so `NUMBER_EXEMPT` no longer matches. Expected red: `"intx.ts does not call Number()"`. This proves the exemption is doing real work rather than being decorative. Rename back.

- [ ] **Step 6: Commit**

```bash
git add lib/compound/journal/
git commit -m "feat(journal): integer helpers and a purity guard for the journal layer"
```

---

### Task 2: The dedupe choke point, and a fixture that can tell whether it ran

The defect in spec §6.3 is live, and the sibling product shows phantom trades on a real account because every one of its surfaces calls the deals query directly. The fix is not "remember to call `dedupeDeals`". The fix is a type that only `buildTradeHistory` can produce, so a surface that forgets does not compile.

This task also builds the fixture every later task uses. **Its single most important property is that it contains a planted duplicate pair positioned so that leaving it in changes the answer of every aggregate in Phase A.** A fixture without one cannot detect a missing dedupe call, and that is exactly the shape of vacuous test this project has shipped before.

**Files:**
- Create: `lib/compound/journal/history.ts`
- Create: `lib/compound/journal/history.test.ts`
- Create: `lib/compound/journal/__fixtures__/deals.ts`
- Create: `lib/compound/journal/chokepoint.test.ts`

**Interfaces:**
- Consumes: `dedupeDeals`, `DroppedDeal` from `@/lib/compound/reconcile/dedupe`; `ClosedDeal` from `@/lib/compound/reconcile/types`
- Produces:
  - `type DedupedDeals` — a branded `readonly ClosedDeal[]`
  - `type DedupeGuard = "applied" | "not-configured"`
  - `interface TradeHistory { deals: DedupedDeals; dropped: readonly DroppedDeal[]; guard: DedupeGuard; rawCount: number }`
  - `buildTradeHistory(raw: readonly ClosedDeal[], brokerOffsetHours: number | null): TradeHistory`
  - `EMPTY_HISTORY: TradeHistory`
- Produces (fixture): `RAW_DEALS: ClosedDeal[]`, `FIXTURE_OFFSET_HOURS = 3`, `fixtureHistory(): TradeHistory`

- [ ] **Step 1: Create `lib/compound/journal/history.ts`**

```typescript
/**
 * The one door into a journal surface.
 *
 * Spec section 6.3: some trades reach the deals table twice, identical in
 * every value field, with both timestamps shifted by exactly the broker's UTC
 * offset, under an out-of-sequence ticket. Left in, they inflate trade counts
 * and distort P/L. The sibling product does not defend against this and shows
 * phantom trades on a real account.
 *
 * The defence here is a branded type. Every aggregate in this layer takes
 * DedupedDeals, which only this module can construct, so forgetting to
 * deduplicate is a compile error rather than a wrong number on a screen. That
 * is deliberately stronger than a test: a test catches the code you wrote, a
 * type catches the code you have not written yet.
 *
 * On the offset argument. dedupeDeals accepts an integer 1..14, because the
 * defect is a timezone reinterpretation and a zero-hour reinterpretation moves
 * nothing. compound_account.broker_offset_hours may legitimately be null (not
 * yet configured) or zero (a broker actually on UTC). In both cases there is
 * nothing to detect, so this returns the deals untouched and says so via
 * `guard`. The journal page renders that state visibly rather than implying a
 * protection that is not running — a silent no-op here would recreate the
 * exact defect this module exists to prevent.
 */
import { dedupeDeals, type DroppedDeal } from "@/lib/compound/reconcile/dedupe";
import type { ClosedDeal } from "@/lib/compound/reconcile/types";

declare const DEDUPED: unique symbol;

/**
 * A deal list that has passed through buildTradeHistory.
 *
 * The brand is a phantom property: it exists in the type system and not at
 * runtime, so this costs nothing at execution time. There is no runtime
 * validator and there should not be one — the guarantee is structural.
 */
export type DedupedDeals = readonly ClosedDeal[] & { readonly [DEDUPED]: true };

export type DedupeGuard = "applied" | "not-configured";

export interface TradeHistory {
  deals: DedupedDeals;
  dropped: readonly DroppedDeal[];
  /** Whether the duplicate guard actually ran. Rendered, not swallowed. */
  guard: DedupeGuard;
  /** Rows read from the database, before deduplication. */
  rawCount: number;
}

function byTicket(deals: readonly ClosedDeal[]): ClosedDeal[] {
  return [...deals].sort((a, b) => a.ticket - b.ticket);
}

export function buildTradeHistory(
  raw: readonly ClosedDeal[],
  brokerOffsetHours: number | null,
): TradeHistory {
  if (brokerOffsetHours === null || brokerOffsetHours === 0) {
    return {
      // Same ordering contract as the dedupe path: dedupeDeals sorts its
      // output by ticket, and a caller must not be able to tell which branch
      // ran by looking at the order.
      deals: byTicket(raw) as unknown as DedupedDeals,
      dropped: [],
      guard: "not-configured",
      rawCount: raw.length,
    };
  }

  // The defect is symmetric in sign: a broker at -5 produces exactly the same
  // shifted twin as a broker at +5. dedupeDeals is documented for 1..14, so
  // the magnitude is what it needs.
  const { kept, dropped } = dedupeDeals(raw, Math.abs(brokerOffsetHours));
  return {
    deals: kept as unknown as DedupedDeals,
    dropped,
    guard: "applied",
    rawCount: raw.length,
  };
}

export const EMPTY_HISTORY: TradeHistory = {
  deals: [] as unknown as DedupedDeals,
  dropped: [],
  guard: "not-configured",
  rawCount: 0,
};
```

- [ ] **Step 2: Create `lib/compound/journal/__fixtures__/deals.ts`**

Read the header comment before changing any number in this file. Every value is load-bearing.

```typescript
/**
 * The shared journal fixture. Fictional throughout — spec section 10.
 *
 * FOUR PROPERTIES ARE LOAD-BEARING. Changing a number without preserving them
 * silently turns later assertions into decoration.
 *
 * 1. TICKET 5092 IS A PLANTED DUPLICATE of ticket 5008: identical symbol,
 *    side, volume, profit, swap and commission, with BOTH timestamps shifted
 *    by exactly +3h, under a higher ticket. It is planted at the end of a
 *    winning run on the busiest day, so leaving it in changes the answer of
 *    every aggregate in this layer:
 *
 *      aggregate                with dedupe   without
 *      total trades             9             10
 *      wins                     5             6
 *      win rate (bps)           5555          6000
 *      profit factor (milli)    2247          2755
 *      max win streak           2             3
 *      final cumulative P/L     3163          4516
 *      2026-05-08 day count     3             4
 *
 *    No aggregate in Phase A is allowed to ship without an assertion that
 *    distinguishes those columns.
 *
 * 2. AWKWARD DENOMINATORS. 5 wins over 9 trades is 5555.55 bps; 6231 over
 *    2773 is 2247.02 thousandths; 2773 over 3 losses is 924.33 cents. None of
 *    these divide evenly, which is the whole point — the carried-forward note
 *    from plan 1 records that round numbers are precisely the inputs where a
 *    correct and an incorrect implementation agree.
 *
 * 3. MULTIPLE TRADES PER DAY. 2026-05-04 has two (one win, one loss),
 *    2026-05-07 has two, 2026-05-08 has three. A calendar test built on one
 *    trade per day cannot detect a bug that drops one of two same-day trades,
 *    and that exact mutation has already survived a full suite in the sibling
 *    project.
 *
 * 4. EDGE CASES, one each:
 *      - ticket 5003 closes at 23:30 UTC. With the fixture's +3h broker
 *        offset its broker date is the NEXT day, so it discriminates the UTC
 *        day-keying decision.
 *      - ticket 5005 has profit exactly 0 and a non-zero commission. Streaks
 *        must skip it; the day total must not.
 *      - ticket 5009 has gross profit +5 and commission -31, so it is a WIN
 *        that contributes -26 cents. It discriminates gross-versus-net.
 *
 * The array is deliberately NOT in chronological or ticket order. Any function
 * whose answer depends on order must sort for itself; a missing sort shows up
 * as a wrong answer rather than as a coincidence.
 */
import type { ClosedDeal } from "@/lib/compound/reconcile/types";
import { buildTradeHistory, type TradeHistory } from "../history";

export const FIXTURE_OFFSET_HOURS = 3;

const D = (
  ticket: number,
  symbol: string,
  side: "buy" | "sell",
  volumeMilliLots: number,
  openTime: string,
  closeTime: string,
  profitCents: bigint,
  swapCents: bigint,
  commissionCents: bigint,
): ClosedDeal => ({
  ticket,
  symbol,
  side,
  volumeMilliLots,
  openTime,
  closeTime,
  profitCents,
  swapCents,
  commissionCents,
});

export const RAW_DEALS: readonly ClosedDeal[] = [
  // Scrambled on purpose. See property 4 in the header.
  D(5004, "BTCUSD", "sell", 10, "2026-05-06T12:00:00.000Z", "2026-05-06T13:07:00.000Z", -1511n, 0n, -11n),
  D(5008, "GBPUSD", "sell", 60, "2026-05-08T11:00:00.000Z", "2026-05-08T14:15:00.000Z", 1409n, -19n, -37n),
  D(5001, "EURUSD", "buy", 50, "2026-05-04T07:15:00.000Z", "2026-05-04T09:40:00.000Z", 1237n, -13n, -29n),
  // The planted duplicate: 5008 with both ends moved +3h, higher ticket.
  D(5092, "GBPUSD", "sell", 60, "2026-05-08T14:00:00.000Z", "2026-05-08T17:15:00.000Z", 1409n, -19n, -37n),
  D(5006, "XAUUSD", "buy", 40, "2026-05-07T09:10:00.000Z", "2026-05-07T15:55:00.000Z", 677n, -3n, -23n),
  D(5002, "EURUSD", "sell", 30, "2026-05-04T10:05:00.000Z", "2026-05-04T11:20:00.000Z", -409n, 0n, -17n),
  D(5009, "EURUSD", "sell", 10, "2026-05-08T15:00:00.000Z", "2026-05-08T16:20:00.000Z", 5n, 0n, -31n),
  D(5003, "GBPUSD", "buy", 70, "2026-05-05T06:00:00.000Z", "2026-05-05T23:30:00.000Z", 2903n, -41n, -41n),
  D(5007, "XAUUSD", "sell", 40, "2026-05-08T07:00:00.000Z", "2026-05-08T10:30:00.000Z", -853n, 0n, -23n),
  D(5005, "EURUSD", "buy", 20, "2026-05-07T08:00:00.000Z", "2026-05-07T08:45:00.000Z", 0n, 0n, -7n),
];

/** The deduplicated history every later test starts from. */
export function fixtureHistory(): TradeHistory {
  return buildTradeHistory(RAW_DEALS, FIXTURE_OFFSET_HOURS);
}

/**
 * The same deals with the guard disabled, so a test can assert that an
 * aggregate's answer actually differs. Used only to prove a test bites.
 */
export function fixtureHistoryUnguarded(): TradeHistory {
  return buildTradeHistory(RAW_DEALS, null);
}
```

- [ ] **Step 3: Create `lib/compound/journal/history.test.ts`**

```typescript
import { buildTradeHistory } from "./history";
import { FIXTURE_OFFSET_HOURS, RAW_DEALS, fixtureHistory } from "./__fixtures__/deals";

describe("buildTradeHistory", () => {
  // Mutation caught: `return { deals: raw, dropped: [], guard: "applied" }` —
  // the exact shape of the sibling product's defect.
  it("drops the offset-shifted twin and keeps the lower ticket", () => {
    const h = fixtureHistory();
    expect(h.rawCount).toBe(10);
    expect(h.deals).toHaveLength(9);
    expect(h.deals.map((d) => d.ticket)).not.toContain(5092);
    expect(h.deals.map((d) => d.ticket)).toContain(5008);
    expect(h.dropped.map((d) => d.deal.ticket)).toEqual([5092]);
    expect(h.dropped[0]!.duplicateOfTicket).toBe(5008);
    expect(h.guard).toBe("applied");
  });

  // Mutation caught: matching on value fields alone and ignoring the shift.
  // 5007 and 5009 are genuine trades with distinct values; 5001 and 5002 are
  // the same symbol on the same day and must both survive.
  it("keeps every genuine trade, including same-symbol same-day pairs", () => {
    const h = fixtureHistory();
    expect(h.deals.map((d) => d.ticket)).toEqual([
      5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008, 5009,
    ]);
  });

  // Mutation caught: matching a pair at any gap rather than at exactly the
  // offset. These two differ in every timestamp by 5h, not 3h, and are two
  // real trades — dropping one destroys real P/L silently.
  it("does not drop a value-identical pair at the wrong gap", () => {
    const twinAtFiveHours = {
      ...RAW_DEALS[1]!,
      ticket: 5993,
      openTime: "2026-05-08T16:00:00.000Z",
      closeTime: "2026-05-08T19:15:00.000Z",
    };
    const h = buildTradeHistory([...RAW_DEALS, twinAtFiveHours], FIXTURE_OFFSET_HOURS);
    expect(h.deals.map((d) => d.ticket)).toContain(5993);
    expect(h.deals).toHaveLength(10);
  });

  // Mutation caught: passing the signed offset straight to dedupeDeals, which
  // throws a RangeError for anything below 1.
  it("treats a negative broker offset as the same magnitude", () => {
    const plus = buildTradeHistory(RAW_DEALS, 3);
    const minus = buildTradeHistory(RAW_DEALS, -3);
    expect(minus.deals.map((d) => d.ticket)).toEqual(plus.deals.map((d) => d.ticket));
    expect(minus.guard).toBe("applied");
  });

  // Mutation caught: throwing on 0/null, which would 500 the journal page for
  // any account whose offset has not been set.
  it.each([[null], [0]])("reports not-configured for offset %p rather than throwing", (offset) => {
    const h = buildTradeHistory(RAW_DEALS, offset as number | null);
    expect(h.guard).toBe("not-configured");
    expect(h.deals).toHaveLength(10);
    expect(h.dropped).toEqual([]);
  });

  // Mutation caught: returning `raw` unsorted on the not-configured branch, so
  // a caller could tell which branch ran from the ordering alone.
  it("returns ticket order on both branches", () => {
    const unguarded = buildTradeHistory(RAW_DEALS, null);
    expect(unguarded.deals.map((d) => d.ticket)).toEqual([
      5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008, 5009, 5092,
    ]);
  });

  it("does not mutate its input", () => {
    const before = RAW_DEALS.map((d) => d.ticket);
    buildTradeHistory(RAW_DEALS, FIXTURE_OFFSET_HOURS);
    expect(RAW_DEALS.map((d) => d.ticket)).toEqual(before);
  });

  it("handles an empty list", () => {
    const h = buildTradeHistory([], FIXTURE_OFFSET_HOURS);
    expect(h.deals).toHaveLength(0);
    expect(h.guard).toBe("applied");
  });
});
```

- [ ] **Step 4: Create `lib/compound/journal/chokepoint.test.ts`**

The brand stops a *typed* bypass. This stops the two untyped ones: a cast, and a call to the raw query from a surface.

```typescript
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(__dirname, "..", "..", "..");
const SCANNED = ["lib", "app"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "__fixtures__"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

function sources(): string[] {
  return SCANNED.flatMap((d) => {
    const full = join(REPO, d);
    return statSync(full).isDirectory() ? walk(full) : [];
  });
}

describe("the dedupe choke point", () => {
  it("scans a plausible number of files", () => {
    // Mutation caught: a broken walker returning [], which would make every
    // assertion below pass vacuously. This is the ratchet the carried-forward
    // note asks for.
    expect(sources().length).toBeGreaterThan(10);
  });

  // Mutation caught: `deals as unknown as DedupedDeals` written in a page to
  // get past the compiler. The brand is only as strong as the ban on casting.
  it("brands DedupedDeals only inside history.ts", () => {
    const offenders = sources()
      .filter((f) => !f.endsWith(join("journal", "history.ts")))
      .filter((f) => /as\s+(unknown\s+as\s+)?DedupedDeals/.test(readFileSync(f, "utf8")))
      .map((f) => relative(REPO, f));
    expect(offenders).toEqual([]);
  });

  // Mutation caught: a page calling getClosedDeals directly and handing the
  // rows to a component — precisely what the sibling product does.
  it("calls getClosedDeals only from db/ and load/", () => {
    const allowed = [join("compound", "db"), join("compound", "load")];
    const offenders = sources()
      .filter((f) => !allowed.some((a) => f.includes(a)))
      .filter((f) => /\bgetClosedDeals\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => relative(REPO, f));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 5: Run the gates**

```bash
pnpm typecheck && pnpm test -- lib/compound/journal
```

- [ ] **Step 6: Prove these tests bite**

1. **Make `buildTradeHistory` return `raw` unchanged on the configured branch.** Expected red: `"drops the offset-shifted twin and keeps the lower ticket"`, `"keeps every genuine trade"`, `"treats a negative broker offset as the same magnitude"`. Everything in Tasks 3–6 will also go red once written — that is the fixture doing its job.
2. **Pass `brokerOffsetHours` unmodified to `dedupeDeals`.** Expected red: `"treats a negative broker offset as the same magnitude"` with a `RangeError`, not a wrong count. Note the difference: this is a crash, not a silent wrong answer, which is the better failure mode and the reason `Math.abs` is explicit rather than incidental.
3. **Throw on `brokerOffsetHours === 0`.** Expected red: both cases of `"reports not-configured"`.
4. **Add `const x = deals as unknown as DedupedDeals;` to any file under `app/`.** Expected red: `"brands DedupedDeals only inside history.ts"`, naming the file. Delete it.
5. **Point `SCANNED` at a directory that does not exist.** Expected red: `"scans a plausible number of files"`. Restore.
6. **Delete the `DEDUPED` brand from the type**, leaving `export type DedupedDeals = readonly ClosedDeal[]`. Expected: **green**, every test. Record this. It is the whole reason the brand exists — no runtime test can detect its absence, only `tsc` can, and only once Task 3 has a function that requires it. Task 3 Step 5 repeats this mutation and checks `pnpm typecheck` instead.

- [ ] **Step 7: Commit**

```bash
git add lib/compound/journal/history.ts lib/compound/journal/history.test.ts \
        lib/compound/journal/chokepoint.test.ts lib/compound/journal/__fixtures__/
git commit -m "feat(journal): brand deduplicated deals so a surface cannot skip the guard"
```

---

### Task 3: `trade-stats.ts` — the headline figures, in exact integers

The upstream module computes ten statistics in `number` dollars. Six of them are sums, and a sum of floats over a few hundred trades is precisely the side door spec §4 closes. Four are ratios, and those are genuinely fractional — they become scaled integers rather than floats, so no float comparison ever decides a displayed figure or a colour.

**This is also the first task whose signature requires `DedupedDeals`.** Once it lands, deleting the brand from Task 2 is a `tsc` failure, which Step 5 proves.

**Files:**
- Create: `lib/compound/journal/trade-stats.ts`
- Create: `lib/compound/journal/trade-stats.test.ts`

**Interfaces:**
- Consumes: `DedupedDeals` from `./history`; `divFloor`, `toIndex`, `maxBig`, `minBig` from `./int`; `Cents` from `@/lib/compound/engine/money`; `dealNetCents` from `@/lib/compound/reconcile/types`
- Produces: `interface TradeStats`, `computeTradeStats(deals: DedupedDeals): TradeStats`

- [ ] **Step 1: Create `lib/compound/journal/trade-stats.ts`**

```typescript
/**
 * Closed-trade statistics, in exact integers.
 *
 * Three deliberate departures from the upstream lib/journal/trade-stats.ts:
 *
 * 1. EVERY SUM IS bigint CENTS. The upstream accumulates `number` dollars.
 *    Over a few hundred trades that drifts, and the drift lands in a figure a
 *    manager reads to decide something. Spec section 4 forbids it.
 *
 * 2. RATIOS ARE SCALED INTEGERS. winRateBps is basis points (5 wins in 9
 *    trades is 5555, not 0.5555555555555556); profitFactorMilli is
 *    thousandths and a bigint, because a strategy with one tiny loss can have
 *    a profit factor in the thousands and clamping it would be a quiet lie.
 *    profitFactorMilli is null rather than Infinity when there are no losses —
 *    Infinity is a float value and this layer has none.
 *
 * 3. WIN AND LOSS COUNTS USE GROSS PROFIT; MONEY FIGURES USE NET. A trade with
 *    gross +5c and commission -31c is a WIN that contributes -26c. Win or loss
 *    is a statement about the setup; the money figure is a statement about the
 *    account. Upstream applies this rule in trade-filters.ts and not in
 *    trade-stats.ts; here it is applied consistently and tested.
 *
 * expectedPayoffCents is netAfterFees / trades. The upstream computes
 * avgWin*winRate - avgLoss*(1-winRate) through four floats, which over the
 * rationals is exactly (grossProfit - grossLoss)/N — one integer division.
 * This uses net rather than gross, because what a manager wants from "expected
 * payoff" is what a trade puts in the account, not what it earned before the
 * broker took its cut.
 */
import type { Cents } from "@/lib/compound/engine/money";
import { dealNetCents } from "@/lib/compound/reconcile/types";
import type { DedupedDeals } from "./history";
import { divFloor, maxBig, minBig, toIndex } from "./int";

export interface TradeStats {
  totalTrades: number;
  /** Gross profit strictly greater than zero. */
  wins: number;
  /** Gross profit strictly less than zero. */
  losses: number;
  /** Gross profit exactly zero. Counted, never silently folded into losses. */
  flat: number;
  /** Integer basis points, floored. 5 of 9 is 5555. */
  winRateBps: number;
  /** Sum of positive gross profits. Non-negative. */
  grossProfitCents: Cents;
  /** Magnitude of the sum of negative gross profits. Non-negative. */
  grossLossCents: Cents;
  /** grossProfit - grossLoss. */
  netProfitCents: Cents;
  /** Sum of profit + swap + commission. What reached the account. */
  netAfterFeesCents: Cents;
  /** Sum of swap + commission. Normally negative. */
  totalFeesCents: Cents;
  /** grossProfit/grossLoss in thousandths, floored. Null when losses is 0. */
  profitFactorMilli: bigint | null;
  /** grossProfit / wins, floored. Zero when there are no wins. */
  avgWinCents: Cents;
  /** grossLoss / losses, floored, as a magnitude. Zero when there are none. */
  avgLossCents: Cents;
  bestTradeCents: Cents;
  worstTradeCents: Cents;
  /** netAfterFees / totalTrades, floored. */
  expectedPayoffCents: Cents;
}

const EMPTY: TradeStats = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
  flat: 0,
  winRateBps: 0,
  grossProfitCents: 0n,
  grossLossCents: 0n,
  netProfitCents: 0n,
  netAfterFeesCents: 0n,
  totalFeesCents: 0n,
  profitFactorMilli: null,
  avgWinCents: 0n,
  avgLossCents: 0n,
  bestTradeCents: 0n,
  worstTradeCents: 0n,
  expectedPayoffCents: 0n,
};

export function computeTradeStats(deals: DedupedDeals): TradeStats {
  if (deals.length === 0) return { ...EMPTY };

  let wins = 0;
  let losses = 0;
  let flat = 0;
  let grossProfitCents: Cents = 0n;
  let grossLossCents: Cents = 0n;
  let netAfterFeesCents: Cents = 0n;
  let totalFeesCents: Cents = 0n;
  let bestTradeCents: Cents = deals[0]!.profitCents;
  let worstTradeCents: Cents = deals[0]!.profitCents;

  for (const d of deals) {
    if (d.profitCents > 0n) {
      wins += 1;
      grossProfitCents += d.profitCents;
    } else if (d.profitCents < 0n) {
      losses += 1;
      grossLossCents -= d.profitCents;
    } else {
      flat += 1;
    }
    totalFeesCents += d.swapCents + d.commissionCents;
    netAfterFeesCents += dealNetCents(d);
    bestTradeCents = maxBig(bestTradeCents, d.profitCents);
    worstTradeCents = minBig(worstTradeCents, d.profitCents);
  }

  const totalTrades = deals.length;
  const total = BigInt(totalTrades);

  return {
    totalTrades,
    wins,
    losses,
    flat,
    winRateBps: toIndex(divFloor(BigInt(wins) * 10_000n, total)),
    grossProfitCents,
    grossLossCents,
    netProfitCents: grossProfitCents - grossLossCents,
    netAfterFeesCents,
    totalFeesCents,
    profitFactorMilli:
      grossLossCents === 0n ? null : divFloor(grossProfitCents * 1_000n, grossLossCents),
    avgWinCents: wins === 0 ? 0n : divFloor(grossProfitCents, BigInt(wins)),
    avgLossCents: losses === 0 ? 0n : divFloor(grossLossCents, BigInt(losses)),
    bestTradeCents,
    worstTradeCents,
    expectedPayoffCents: divFloor(netAfterFeesCents, total),
  };
}
```

- [ ] **Step 2: Create `lib/compound/journal/trade-stats.test.ts`**

```typescript
import { buildTradeHistory } from "./history";
import {
  FIXTURE_OFFSET_HOURS,
  RAW_DEALS,
  fixtureHistory,
  fixtureHistoryUnguarded,
} from "./__fixtures__/deals";
import { computeTradeStats } from "./trade-stats";

describe("computeTradeStats", () => {
  const s = computeTradeStats(fixtureHistory().deals);

  it("counts nine trades, five wins, three losses, one flat", () => {
    expect(s.totalTrades).toBe(9);
    expect(s.wins).toBe(5);
    expect(s.losses).toBe(3);
    // Mutation caught: `else { losses++ }`, folding the zero-profit trade into
    // losses. wins + losses would still be 9, so a total-only check misses it.
    expect(s.flat).toBe(1);
    expect(s.wins + s.losses + s.flat).toBe(s.totalTrades);
  });

  it("sums gross profit and gross loss exactly", () => {
    expect(s.grossProfitCents).toBe(6231n);
    expect(s.grossLossCents).toBe(2773n);
    expect(s.netProfitCents).toBe(3458n);
  });

  // Mutation caught: netAfterFees computed as profit only, dropping swap and
  // commission. The two figures differ by exactly the fee total, which is the
  // third assertion.
  it("keeps net-after-fees distinct from gross, and the fees reconcile", () => {
    expect(s.netAfterFeesCents).toBe(3163n);
    expect(s.totalFeesCents).toBe(-295n);
    expect(s.netProfitCents + s.totalFeesCents).toBe(s.netAfterFeesCents);
  });

  // 5 * 10000 / 9 = 5555.55... Mutation caught: rounding instead of flooring
  // gives 5556; using a float and truncating the string gives 5555 by luck on
  // this input but not on all, so the value is pinned rather than the method.
  it("computes win rate as floored basis points on an awkward denominator", () => {
    expect(s.winRateBps).toBe(5555);
  });

  // 6231 * 1000 / 2773 = 2247.02... Mutation caught: dividing before scaling,
  // which in bigint gives 6231/2773 = 2, then *1000 = 2000.
  it("computes profit factor in thousandths, scaling before dividing", () => {
    expect(s.profitFactorMilli).toBe(2247n);
  });

  // Mutation caught: `Infinity`. There is no float in this layer, and a
  // component that formats Infinity prints the word.
  it("returns null profit factor rather than Infinity when nothing lost", () => {
    const winnersOnly = buildTradeHistory(
      RAW_DEALS.filter((d) => d.profitCents > 0n),
      FIXTURE_OFFSET_HOURS,
    );
    const w = computeTradeStats(winnersOnly.deals);
    expect(w.losses).toBe(0);
    expect(w.profitFactorMilli).toBeNull();
  });

  // 6231/5 = 1246.2 and 2773/3 = 924.33 — neither divides evenly, which is the
  // point. Mutation caught: rounding (1246 vs 1246, but 924 vs 924 — so the
  // discriminating case is the negative one below).
  it("floors the averages", () => {
    expect(s.avgWinCents).toBe(1246n);
    expect(s.avgLossCents).toBe(924n);
  });

  // 3163/9 = 351.44. Mutation caught: using netProfit (gross) instead of
  // netAfterFees, which gives 384.
  it("computes expected payoff from what reached the account", () => {
    expect(s.expectedPayoffCents).toBe(351n);
  });

  // Mutation caught: seeding best at 0n instead of the first trade, which
  // would report 0 for an all-losing account.
  it("reports the best and worst gross trades", () => {
    expect(s.bestTradeCents).toBe(2903n);
    expect(s.worstTradeCents).toBe(-1511n);
  });

  it("reports a negative best trade when every trade lost", () => {
    const losersOnly = buildTradeHistory(
      RAW_DEALS.filter((d) => d.profitCents < 0n),
      FIXTURE_OFFSET_HOURS,
    );
    const l = computeTradeStats(losersOnly.deals);
    expect(l.bestTradeCents).toBe(-409n);
    expect(l.worstTradeCents).toBe(-1511n);
  });

  // THE DEDUPE ASSERTION. Every headline figure moves if the planted twin
  // survives. Mutation caught: any change that skips dedupeDeals.
  it("differs from the undeduplicated answer on every headline figure", () => {
    const bad = computeTradeStats(fixtureHistoryUnguarded().deals);
    expect(bad.totalTrades).toBe(10);
    expect(bad.wins).toBe(6);
    expect(bad.winRateBps).toBe(6000);
    expect(bad.grossProfitCents).toBe(7640n);
    expect(bad.netAfterFeesCents).toBe(4516n);
    expect(bad.profitFactorMilli).toBe(2755n);

    expect(bad.totalTrades).not.toBe(s.totalTrades);
    expect(bad.winRateBps).not.toBe(s.winRateBps);
    expect(bad.netAfterFeesCents).not.toBe(s.netAfterFeesCents);
  });

  it("returns zeros for an empty list without dividing by zero", () => {
    const e = computeTradeStats(buildTradeHistory([], FIXTURE_OFFSET_HOURS).deals);
    expect(e.totalTrades).toBe(0);
    expect(e.winRateBps).toBe(0);
    expect(e.profitFactorMilli).toBeNull();
    expect(e.expectedPayoffCents).toBe(0n);
  });

  it("returns bigints, not numbers, for every money field", () => {
    for (const key of [
      "grossProfitCents",
      "grossLossCents",
      "netProfitCents",
      "netAfterFeesCents",
      "totalFeesCents",
      "avgWinCents",
      "avgLossCents",
      "bestTradeCents",
      "worstTradeCents",
      "expectedPayoffCents",
    ] as const) {
      expect({ key, type: typeof s[key] }).toEqual({ key, type: "bigint" });
    }
  });
});
```

- [ ] **Step 3: Run the gates**

```bash
pnpm typecheck && pnpm test -- lib/compound/journal
```

- [ ] **Step 4: Prove these tests bite**

1. **Fold the zero-profit trade into losses** (`else { losses += 1; }`). Expected red: `"counts nine trades, five wins, three losses, one flat"` on `flat`, and `"floors the averages"` on `avgLossCents` (2773/4 = 693). Note that `wins + losses + flat === totalTrades` still holds — which is why the individual counts are asserted and not just the sum.
2. **Divide before scaling** in `profitFactorMilli`: `divFloor(grossProfitCents, grossLossCents) * 1000n`. Expected red: `"computes profit factor in thousandths"` with `2000n`.
3. **Return `Infinity` for a zero loss.** Expected: a `tsc` failure, because the field is `bigint | null`. Record it — this is the type doing the work the test would otherwise have to.
4. **Use `netProfitCents` in `expectedPayoffCents`.** Expected red: `"computes expected payoff from what reached the account"` with `384n`.
5. **Seed `bestTradeCents` at `0n`.** Expected red: `"reports a negative best trade when every trade lost"`, and nothing else. That test exists solely for this mutation — the main fixture has a positive best trade, so it cannot detect it.
6. **Delete the `DEDUPED` brand from `history.ts`**, leaving `export type DedupedDeals = readonly ClosedDeal[]`, then add `computeTradeStats(RAW_DEALS)` to a scratch file. Expected: it **compiles**. Restore the brand; the same line must now fail `pnpm typecheck` with "Property '[DEDUPED]' is missing". This closes out Task 2 Step 6's probe 6, which had nothing to bite on yet. Delete the scratch file.

- [ ] **Step 5: Commit**

```bash
git add lib/compound/journal/trade-stats.ts lib/compound/journal/trade-stats.test.ts
git commit -m "feat(journal): exact integer trade statistics"
```

---

### Task 4: `calendar-aggregate.ts` and `streaks.ts`

Day aggregation and win/loss runs. The month grid is built with pure integer calendar arithmetic rather than `Date`, because a grid built from local `Date` objects puts the wrong days in the wrong cells west of UTC — and the day keys come from `utcDateKey`, so a mismatch is silent rather than obvious.

**Files:**
- Create: `lib/compound/journal/calendar-aggregate.ts`
- Create: `lib/compound/journal/calendar-aggregate.test.ts`
- Create: `lib/compound/journal/streaks.ts`
- Create: `lib/compound/journal/streaks.test.ts`

**Interfaces:**
- Consumes: `DedupedDeals` from `./history`; `Cents` from `@/lib/compound/engine/money`; `dealNetCents` from `@/lib/compound/reconcile/types`; `utcDateKey` from `@/lib/compound/reconcile/date-key`
- Produces:
  - `interface CalendarDay { date; netCents; grossCents; tradeCount; wins; losses; flat }`
  - `aggregateCalendar(deals: DedupedDeals): Map<string, CalendarDay>`
  - `isLeapYear(year: number): boolean`
  - `daysInMonth(year: number, month1: number): number`
  - `daysFromEpoch(year: number, month1: number, day: number): number`
  - `dayOfWeekUtc(dateKey: string): number` — 0 = Sunday
  - `parseMonth(month: string): { year: number; month1: number }`
  - `monthGrid(month: string): (string | null)[][]`
  - `monthSummary(days: Map<string, CalendarDay>, month: string): MonthSummary`
  - `shiftMonth(month: string, delta: number): string`
  - `interface StreakStats`, `computeStreaks(deals: DedupedDeals): StreakStats`

- [ ] **Step 1: Create `lib/compound/journal/calendar-aggregate.ts`**

```typescript
/**
 * Calendar aggregation, keyed on the UTC day.
 *
 * WHY UTC AND NOT THE BROKER DAY. account_snapshots_daily.trade_date is a
 * broker-server date (spec section 4), but reconcile/date-key.ts keys deals on
 * UTC and detect.ts already reconciles the two against each other. A calendar
 * on broker days would put a second definition of "Tuesday" in the product.
 * One definition that is slightly off the broker's beats two that disagree.
 * The consequence is real and is stated in the UI: for a broker at +3, a trade
 * closing at 23:30 UTC shows one day earlier here than in the terminal.
 *
 * WHY NO Date. Every function below does integer calendar arithmetic. A grid
 * built from local Date objects and formatted locally puts the wrong day
 * numbers against UTC-keyed totals on any machine that is not on UTC, and the
 * failure is silent — the grid still looks like a calendar.
 * daysFromEpoch is Howard Hinnant's days_from_civil. Its divisions are on
 * small integers where floating-point division is exact, and none of them
 * touches money.
 */
import type { Cents } from "@/lib/compound/engine/money";
import { utcDateKey } from "@/lib/compound/reconcile/date-key";
import { dealNetCents } from "@/lib/compound/reconcile/types";
import type { DedupedDeals } from "./history";

export interface CalendarDay {
  /** YYYY-MM-DD, UTC. */
  date: string;
  /** profit + swap + commission. What the day did to the account. */
  netCents: Cents;
  /** profit only. What the setups earned before costs. */
  grossCents: Cents;
  tradeCount: number;
  /** Counted on gross profit, per this plan's decision 5. */
  wins: number;
  losses: number;
  flat: number;
}

export function aggregateCalendar(deals: DedupedDeals): Map<string, CalendarDay> {
  const out = new Map<string, CalendarDay>();
  for (const d of deals) {
    const key = utcDateKey(d.closeTime);
    const cur = out.get(key) ?? {
      date: key,
      netCents: 0n,
      grossCents: 0n,
      tradeCount: 0,
      wins: 0,
      losses: 0,
      flat: 0,
    };
    cur.netCents += dealNetCents(d);
    cur.grossCents += d.profitCents;
    cur.tradeCount += 1;
    if (d.profitCents > 0n) cur.wins += 1;
    else if (d.profitCents < 0n) cur.losses += 1;
    else cur.flat += 1;
    out.set(key, cur);
  }
  return out;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month1: number): number {
  if (month1 < 1 || month1 > 12) throw new RangeError(`month out of range: ${month1}`);
  if (month1 === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month1 - 1]!;
}

/** Days from 1970-01-01. Negative before it. */
export function daysFromEpoch(year: number, month1: number, day: number): number {
  const y = month1 <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month1 + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** 0 = Sunday. 1970-01-01 was a Thursday. */
export function dayOfWeekUtc(dateKey: string): number {
  const m = DATE_RE.exec(dateKey);
  if (!m) throw new RangeError(`not a date key: ${JSON.stringify(dateKey)}`);
  const days = daysFromEpoch(Number.parseInt(m[1]!, 10), Number.parseInt(m[2]!, 10), Number.parseInt(m[3]!, 10));
  return (((days + 4) % 7) + 7) % 7;
}

export function parseMonth(month: string): { year: number; month1: number } {
  const m = MONTH_RE.exec(month);
  if (!m) throw new RangeError(`not a month: ${JSON.stringify(month)}`);
  const year = Number.parseInt(m[1]!, 10);
  const month1 = Number.parseInt(m[2]!, 10);
  if (month1 < 1 || month1 > 12) throw new RangeError(`month out of range: ${month}`);
  return { year, month1 };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function shiftMonth(month: string, delta: number): string {
  const { year, month1 } = parseMonth(month);
  const zero = year * 12 + (month1 - 1) + delta;
  return `${Math.floor(zero / 12)}-${pad2((((zero % 12) + 12) % 12) + 1)}`;
}

/**
 * Week rows of YYYY-MM-DD keys, Sunday first, with null for cells outside the
 * month. The row count is natural — four to six — rather than always six. A
 * printed statement does not pad two blank weeks onto February.
 */
export function monthGrid(month: string): (string | null)[][] {
  const { year, month1 } = parseMonth(month);
  const first = `${year}-${pad2(month1)}-01`;
  const leading = dayOfWeekUtc(first);
  const count = daysInMonth(year, month1);
  const cells: (string | null)[] = [];
  for (let i = 0; i < leading; i += 1) cells.push(null);
  for (let d = 1; d <= count; d += 1) cells.push(`${year}-${pad2(month1)}-${pad2(d)}`);
  while (cells.length % 7 !== 0) cells.push(null);
  const rows: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

export interface MonthSummary {
  month: string;
  netCents: Cents;
  grossCents: Cents;
  tradeCount: number;
  wins: number;
  losses: number;
  /** Days in the month with at least one trade. */
  tradingDays: number;
}

export function monthSummary(
  days: Map<string, CalendarDay>,
  month: string,
): MonthSummary {
  const prefix = `${month}-`;
  const out: MonthSummary = {
    month,
    netCents: 0n,
    grossCents: 0n,
    tradeCount: 0,
    wins: 0,
    losses: 0,
    tradingDays: 0,
  };
  for (const [key, day] of days) {
    if (!key.startsWith(prefix)) continue;
    out.netCents += day.netCents;
    out.grossCents += day.grossCents;
    out.tradeCount += day.tradeCount;
    out.wins += day.wins;
    out.losses += day.losses;
    out.tradingDays += 1;
  }
  return out;
}
```

- [ ] **Step 2: Create `lib/compound/journal/calendar-aggregate.test.ts`**

```typescript
import {
  aggregateCalendar,
  dayOfWeekUtc,
  daysFromEpoch,
  daysInMonth,
  isLeapYear,
  monthGrid,
  monthSummary,
  parseMonth,
  shiftMonth,
} from "./calendar-aggregate";
import { buildTradeHistory } from "./history";
import { FIXTURE_OFFSET_HOURS, fixtureHistory, fixtureHistoryUnguarded } from "./__fixtures__/deals";

describe("aggregateCalendar", () => {
  const days = aggregateCalendar(fixtureHistory().deals);

  it("covers exactly the five trading days in the fixture", () => {
    expect([...days.keys()].sort()).toEqual([
      "2026-05-04",
      "2026-05-05",
      "2026-05-06",
      "2026-05-07",
      "2026-05-08",
    ]);
  });

  // Mutation caught: `out.set(key, {...one deal...})` instead of accumulating,
  // which keeps only the last trade of a day. THIS IS THE MUTATION THAT
  // SURVIVED A FULL SUITE IN THE SIBLING PROJECT, because its fixture had one
  // trade per day. Both counts and both money figures are asserted.
  it("accumulates two trades on the same day rather than keeping one", () => {
    const d = days.get("2026-05-04")!;
    expect(d.tradeCount).toBe(2);
    expect(d.wins).toBe(1);
    expect(d.losses).toBe(1);
    expect(d.grossCents).toBe(828n);
    expect(d.netCents).toBe(769n);
  });

  it("accumulates three trades on the same day", () => {
    const d = days.get("2026-05-08")!;
    expect(d.tradeCount).toBe(3);
    expect(d.netCents).toBe(451n);
  });

  // Mutation caught: counting wins on net rather than gross. Ticket 5009 is
  // gross +5 and net -26. On net, 2026-05-08 has one win and two losses.
  it("counts a fee-eroded winner as a win but as negative money", () => {
    const d = days.get("2026-05-08")!;
    expect(d.wins).toBe(2);
    expect(d.losses).toBe(1);
    expect(d.grossCents).toBe(561n);
    expect(d.netCents).toBe(451n);
  });

  // Mutation caught: netCents computed from profit only. 2026-05-07's gross is
  // 677 and its net is 644 — the flat trade's -7 commission is the difference.
  it("includes swap and commission in the day's money figure", () => {
    const d = days.get("2026-05-07")!;
    expect(d.tradeCount).toBe(2);
    expect(d.flat).toBe(1);
    expect(d.grossCents).toBe(677n);
    expect(d.netCents).toBe(644n);
  });

  // Mutation caught: keying on the BROKER day (close_time + offset) or on a
  // local Date. Ticket 5003 closes at 23:30Z; at +3 its broker date is 05-06.
  // Run under TZ=Pacific/Kiritimati to make the local-Date variant fail too.
  it("keys the 23:30 UTC close on the UTC day, not the broker day", () => {
    expect(days.get("2026-05-05")!.tradeCount).toBe(1);
    expect(days.get("2026-05-05")!.netCents).toBe(2821n);
    expect(days.get("2026-05-06")!.tradeCount).toBe(1);
    expect(days.get("2026-05-06")!.netCents).toBe(-1522n);
  });

  // THE DEDUPE ASSERTION for this module.
  it("differs from the undeduplicated answer on 2026-05-08", () => {
    const bad = aggregateCalendar(fixtureHistoryUnguarded().deals);
    expect(bad.get("2026-05-08")!.tradeCount).toBe(4);
    expect(bad.get("2026-05-08")!.netCents).toBe(1804n);
    expect(bad.get("2026-05-08")!.netCents).not.toBe(days.get("2026-05-08")!.netCents);
  });

  it("returns an empty map for no deals", () => {
    expect(aggregateCalendar(buildTradeHistory([], FIXTURE_OFFSET_HOURS).deals).size).toBe(0);
  });
});

describe("monthSummary", () => {
  const days = aggregateCalendar(fixtureHistory().deals);

  // Mutation caught: `key.startsWith(month)` without the trailing dash, which
  // would make "2026-0" match; and summing every day regardless of month.
  it("sums only the days inside the month", () => {
    const s = monthSummary(days, "2026-05");
    expect(s.tradeCount).toBe(9);
    expect(s.tradingDays).toBe(5);
    expect(s.netCents).toBe(3163n);
    expect(s.grossCents).toBe(3458n);
    expect(s.wins).toBe(5);
    expect(s.losses).toBe(3);
  });

  it("returns zeros for a month with no trading", () => {
    const s = monthSummary(days, "2026-06");
    expect(s.tradeCount).toBe(0);
    expect(s.tradingDays).toBe(0);
    expect(s.netCents).toBe(0n);
  });
});

describe("calendar arithmetic", () => {
  // Mutation caught: `year % 4 === 0` alone, which makes 2100 a leap year;
  // and `year % 4 === 0 && year % 100 !== 0` alone, which makes 2000 common.
  it.each([
    [2024, true],
    [2026, false],
    [2028, true],
    [2100, false],
    [2000, true],
  ])("isLeapYear(%i) is %p", (y, expected) => {
    expect(isLeapYear(y)).toBe(expected);
  });

  it("gives February the right length in each of those years", () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  // Mutation caught: any error in days_from_civil. The epoch is the anchor.
  it("anchors on the epoch", () => {
    expect(daysFromEpoch(1970, 1, 1)).toBe(0);
    expect(daysFromEpoch(1969, 12, 31)).toBe(-1);
    expect(daysFromEpoch(2026, 5, 1)).toBe(20574);
  });

  // Mutation caught: the +4 epoch-day offset being wrong, which rotates the
  // whole calendar by a fixed amount and is invisible without a known date.
  it("puts known dates on the right weekday", () => {
    expect(dayOfWeekUtc("1970-01-01")).toBe(4); // Thursday
    expect(dayOfWeekUtc("2026-05-01")).toBe(5); // Friday
    expect(dayOfWeekUtc("2026-05-04")).toBe(1); // Monday
    expect(dayOfWeekUtc("2026-03-01")).toBe(0); // Sunday
  });

  it("rejects a malformed date key rather than guessing", () => {
    expect(() => dayOfWeekUtc("2026-5-1")).toThrow(/not a date key/);
    expect(() => parseMonth("2026-13")).toThrow(/out of range/);
    expect(() => parseMonth("May 2026")).toThrow(/not a month/);
  });

  // Mutation caught: `zero % 12` without the double modulo, which produces
  // month 0 or a negative month when stepping back across January.
  it("steps months across a year boundary in both directions", () => {
    expect(shiftMonth("2026-05", 1)).toBe("2026-06");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-01", -13)).toBe("2024-12");
  });
});

describe("monthGrid", () => {
  // Mutation caught: leading blanks computed from a local Date, or off by one.
  it("puts 2026-05-01 in the Friday column with five leading blanks", () => {
    const rows = monthGrid("2026-05");
    expect(rows[0]!.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(rows[0]![5]).toBe("2026-05-01");
    expect(rows[0]![6]).toBe("2026-05-02");
  });

  // Mutation caught: always emitting a leading blank. March 2026 starts on a
  // Sunday, so the first cell is the first of the month.
  it("emits no leading blank when the month starts on a Sunday", () => {
    const rows = monthGrid("2026-03");
    expect(rows[0]![0]).toBe("2026-03-01");
  });

  it("emits whole weeks and the natural number of rows", () => {
    expect(monthGrid("2026-05")).toHaveLength(6);
    expect(monthGrid("2026-02")).toHaveLength(4); // starts Sunday, 28 days
    for (const rows of [monthGrid("2026-05"), monthGrid("2026-02"), monthGrid("2028-02")]) {
      for (const row of rows) expect(row).toHaveLength(7);
    }
  });

  it("emits every day of the month exactly once, in order", () => {
    const flat = monthGrid("2028-02").flat().filter((d): d is string => d !== null);
    expect(flat).toHaveLength(29); // leap
    expect(flat[0]).toBe("2028-02-01");
    expect(flat[28]).toBe("2028-02-29");
    expect(new Set(flat).size).toBe(29);
  });

  // Mutation caught: single-digit days rendered without padding, which would
  // never match a utcDateKey and would silently show every early-month day as
  // empty.
  it("zero-pads day and month so the keys match utcDateKey", () => {
    const flat = monthGrid("2026-05").flat().filter((d): d is string => d !== null);
    expect(flat[0]).toBe("2026-05-01");
    expect(flat).toContain("2026-05-09");
    const days = aggregateCalendar(fixtureHistory().deals);
    expect(flat.filter((d) => days.has(d))).toHaveLength(5);
  });
});
```

- [ ] **Step 3: Create `lib/compound/journal/streaks.ts`**

```typescript
/**
 * Win and loss runs over closed trades.
 *
 * A zero-profit trade is skipped rather than counted as a loss: it neither
 * continues nor breaks a run. Upstream does the same; it is restated here
 * because the obvious `profit > 0 ? "win" : "loss"` gets it wrong and the
 * error only shows on accounts that have a scratch trade.
 *
 * The sort tie-breaks on ticket. Two deals closing in the same second have no
 * inherent order, and a comparator that returns 0 for them leaves the run
 * length dependent on the order the database happened to return.
 */
import type { DedupedDeals } from "./history";

export type StreakKind = "win" | "loss" | "none";

export interface StreakStats {
  maxWinStreak: number;
  maxLossStreak: number;
  currentStreak: number;
  currentStreakKind: StreakKind;
  /** Trades excluded because gross profit was exactly zero. */
  skippedFlat: number;
}

export function computeStreaks(deals: DedupedDeals): StreakStats {
  const decisive = deals
    .filter((d) => d.profitCents !== 0n)
    .slice()
    .sort((a, b) => {
      if (a.closeTime < b.closeTime) return -1;
      if (a.closeTime > b.closeTime) return 1;
      return a.ticket - b.ticket;
    });

  const skippedFlat = deals.length - decisive.length;

  if (decisive.length === 0) {
    return {
      maxWinStreak: 0,
      maxLossStreak: 0,
      currentStreak: 0,
      currentStreakKind: "none",
      skippedFlat,
    };
  }

  let maxWin = 0;
  let maxLoss = 0;
  let run = 0;
  let kind: StreakKind = "none";

  for (const d of decisive) {
    const thisKind: StreakKind = d.profitCents > 0n ? "win" : "loss";
    if (thisKind === kind) run += 1;
    else {
      run = 1;
      kind = thisKind;
    }
    if (kind === "win" && run > maxWin) maxWin = run;
    if (kind === "loss" && run > maxLoss) maxLoss = run;
  }

  return {
    maxWinStreak: maxWin,
    maxLossStreak: maxLoss,
    currentStreak: run,
    currentStreakKind: kind,
    skippedFlat,
  };
}
```

- [ ] **Step 4: Create `lib/compound/journal/streaks.test.ts`**

```typescript
import { computeStreaks } from "./streaks";
import { buildTradeHistory } from "./history";
import {
  FIXTURE_OFFSET_HOURS,
  RAW_DEALS,
  fixtureHistory,
  fixtureHistoryUnguarded,
} from "./__fixtures__/deals";

describe("computeStreaks", () => {
  const s = computeStreaks(fixtureHistory().deals);

  // Chronologically the deduplicated fixture is W L W L [flat] W L W W.
  // Mutation caught: no sort at all. The fixture array is scrambled, so an
  // unsorted pass reads a different sequence and gets different maxima.
  it("reads the fixture in close-time order", () => {
    expect(s.maxWinStreak).toBe(2);
    expect(s.maxLossStreak).toBe(1);
    expect(s.currentStreak).toBe(2);
    expect(s.currentStreakKind).toBe("win");
  });

  // Mutation caught: `profitCents > 0n ? "win" : "loss"` without the filter,
  // which turns the flat trade into a loss and joins two single losses into a
  // run of two.
  it("skips the zero-profit trade rather than calling it a loss", () => {
    expect(s.skippedFlat).toBe(1);
    expect(s.maxLossStreak).toBe(1);
  });

  // THE DEDUPE ASSERTION for this module. The planted twin sits at the end of
  // the winning run, so leaving it in lengthens both the maximum and the
  // current streak.
  it("differs from the undeduplicated answer", () => {
    const bad = computeStreaks(fixtureHistoryUnguarded().deals);
    expect(bad.maxWinStreak).toBe(3);
    expect(bad.currentStreak).toBe(3);
    expect(bad.maxWinStreak).not.toBe(s.maxWinStreak);
  });

  // Mutation caught: a comparator with no tie-break, which leaves the answer
  // dependent on input order for same-second closes.
  it("is order-independent for trades closing in the same second", () => {
    const same = "2026-06-01T12:00:00.000Z";
    const a = { ...RAW_DEALS[2]!, ticket: 7001, closeTime: same, profitCents: 100n };
    const b = { ...RAW_DEALS[2]!, ticket: 7002, closeTime: same, profitCents: -100n };
    const forward = computeStreaks(buildTradeHistory([a, b], FIXTURE_OFFSET_HOURS).deals);
    const backward = computeStreaks(buildTradeHistory([b, a], FIXTURE_OFFSET_HOURS).deals);
    expect(forward).toEqual(backward);
    expect(forward.currentStreakKind).toBe("loss");
  });

  it("returns none for no deals and for all-flat deals", () => {
    expect(computeStreaks(buildTradeHistory([], FIXTURE_OFFSET_HOURS).deals)).toEqual({
      maxWinStreak: 0,
      maxLossStreak: 0,
      currentStreak: 0,
      currentStreakKind: "none",
      skippedFlat: 0,
    });
    const flats = RAW_DEALS.filter((d) => d.profitCents === 0n);
    const f = computeStreaks(buildTradeHistory(flats, FIXTURE_OFFSET_HOURS).deals);
    expect(f.currentStreakKind).toBe("none");
    expect(f.skippedFlat).toBe(1);
  });

  it("does not mutate the input array", () => {
    const h = fixtureHistory();
    const before = h.deals.map((d) => d.ticket);
    computeStreaks(h.deals);
    expect(h.deals.map((d) => d.ticket)).toEqual(before);
  });
});
```

- [ ] **Step 5: Run the gates**

```bash
pnpm typecheck && pnpm test -- lib/compound/journal
TZ=Pacific/Kiritimati pnpm test -- lib/compound/journal
```

Both must be green. The second run is the one that catches a local-`Date` implementation; record that it passes.

- [ ] **Step 6: Prove these tests bite**

1. **Replace the accumulate with a set** in `aggregateCalendar`: build a fresh `CalendarDay` for every deal and `out.set(key, fresh)`. Expected red: `"accumulates two trades on the same day"`, `"accumulates three trades"`, `"counts a fee-eroded winner"`, `"includes swap and commission"`, `"sums only the days inside the month"`, and the dedupe assertion. This is the mutation the sibling project's suite missed; confirm it is loud here.
2. **Use `d.profitCents` for `netCents`.** Expected red: `"includes swap and commission in the day's money figure"` and `"accumulates two trades on the same day"` on `netCents`. `grossCents` stays right, which is why both are asserted.
3. **Count wins on `dealNetCents(d)`.** Expected red: `"counts a fee-eroded winner as a win but as negative money"` only.
4. **Key on the broker day**: `utcDateKey(new Date(Date.parse(d.closeTime) + 3 * 3600_000).toISOString())`. Expected red: `"keys the 23:30 UTC close on the UTC day"`, and the `journal purity` guard on `new Date(`. Two independent failures for one mistake is the intended design.
5. **Change `isLeapYear` to `year % 4 === 0`.** Expected red: `isLeapYear(2100)` and `daysInMonth(2100, 2)`, and nothing else — 2100 is in the table for exactly this reason.
6. **Change `dayOfWeekUtc`'s `+ 4` to `+ 3`.** Expected red: all four cases of `"puts known dates on the right weekday"` and both `monthGrid` leading-blank tests. Note that `"emits every day of the month exactly once"` stays green — a rotated calendar still contains every day, which is why that test is not the one holding this line.
7. **Drop the sort in `computeStreaks`.** Expected red: `"reads the fixture in close-time order"`. This works only because the fixture array is scrambled; if it were chronological the mutation would survive, so do not reorder the fixture.
8. **Drop the ticket tie-break.** Expected red: `"is order-independent for trades closing in the same second"`. Record whether it fails deterministically; if `Array.prototype.sort` happens to be stable for a two-element array on this Node build and it stays green, add a third same-second deal to the test until it discriminates.

- [ ] **Step 7: Commit**

```bash
git add lib/compound/journal/calendar-aggregate.ts lib/compound/journal/calendar-aggregate.test.ts \
        lib/compound/journal/streaks.ts lib/compound/journal/streaks.test.ts
git commit -m "feat(journal): UTC calendar aggregation and streaks over deduplicated deals"
```

---

### Task 5: `trade-equity.ts` and `histogram.ts`

The cumulative trading-P/L curve with drawdown, and the P/L distribution. `trade-equity` is the single most float-dangerous module in the upstream set — it accumulates a running sum over every closed trade, and every subsequent figure on `/performance` reads off it. The histogram gets integer bin edges, which removes the upstream's `0.0001` sign threshold and its floating-point off-by-one at the top edge.

**Files:**
- Create: `lib/compound/journal/trade-equity.ts`
- Create: `lib/compound/journal/trade-equity.test.ts`
- Create: `lib/compound/journal/histogram.ts`
- Create: `lib/compound/journal/histogram.test.ts`

**Interfaces:**
- Consumes: `DedupedDeals` from `./history`; `divFloor`, `maxBig`, `toIndex` from `./int`; `Cents` from `@/lib/compound/engine/money`; `dealNetCents` from `@/lib/compound/reconcile/types`
- Produces:
  - `interface CumulativePoint { ts; ticket; symbol; netCents; cumCents; drawdownCents }`
  - `interface TradeEquityResult { curve; netCents; maxDrawdownCents; currentDrawdownCents; totalFeesCents; peakCents }`
  - `computeTradeEquity(deals: DedupedDeals): TradeEquityResult`
  - `interface HistogramBin { startCents; endCents; count; sign }`, `interface HistogramResult { bins; minCents; maxCents; total }`
  - `binNetPnl(values: readonly Cents[], binCount: number): HistogramResult`

- [ ] **Step 1: Create `lib/compound/journal/trade-equity.ts`**

```typescript
/**
 * The trading-P/L curve: cumulative net of every closed trade, with drawdown
 * measured from the running peak of that curve.
 *
 * Two things this curve deliberately is NOT.
 *
 * It is not account equity. A deposit does not move closed-trade P/L at all,
 * which is exactly why this curve is the honest answer to "how is it actually
 * trading" — it is capital-neutral by construction. equity-series.ts builds
 * the other curve, the one a deposit does move, and /performance shows both.
 *
 * It is not drawdown against an account size. Upstream's dashboard-drawdown.ts
 * measures against a prop-firm rule's account_size; a pooled fund has no such
 * figure and the peak of its own curve is the only meaningful reference.
 *
 * Fees are included in every point, because what a manager needs from this
 * curve is what reached the account.
 */
import type { Cents } from "@/lib/compound/engine/money";
import { dealNetCents } from "@/lib/compound/reconcile/types";
import type { DedupedDeals } from "./history";

export interface CumulativePoint {
  /** ISO close time of the deal. */
  ts: string;
  ticket: number;
  symbol: string;
  /** This deal's contribution: profit + swap + commission. */
  netCents: Cents;
  /** Running total after this deal. */
  cumCents: Cents;
  /** Running peak minus cumCents at this point. Never negative. */
  drawdownCents: Cents;
}

export interface TradeEquityResult {
  curve: CumulativePoint[];
  /** Final cumulative total. */
  netCents: Cents;
  /** Highest cumulative total reached. Never negative — the curve starts at 0. */
  peakCents: Cents;
  /** Largest peak-to-trough decline anywhere on the curve. */
  maxDrawdownCents: Cents;
  /** Decline from the peak at the final point. Zero at a new high. */
  currentDrawdownCents: Cents;
  totalFeesCents: Cents;
}

const EMPTY: TradeEquityResult = {
  curve: [],
  netCents: 0n,
  peakCents: 0n,
  maxDrawdownCents: 0n,
  currentDrawdownCents: 0n,
  totalFeesCents: 0n,
};

export function computeTradeEquity(deals: DedupedDeals): TradeEquityResult {
  if (deals.length === 0) return { ...EMPTY };

  // Tie-break on ticket. Two deals closing in the same second have no inherent
  // order, and without a tie-break the drawdown depends on the order the
  // database happened to return them in.
  const sorted = [...deals].sort((a, b) => {
    if (a.closeTime < b.closeTime) return -1;
    if (a.closeTime > b.closeTime) return 1;
    return a.ticket - b.ticket;
  });

  let cum: Cents = 0n;
  let peak: Cents = 0n;
  let maxDd: Cents = 0n;
  let fees: Cents = 0n;
  const curve: CumulativePoint[] = [];

  for (const d of sorted) {
    const net = dealNetCents(d);
    fees += d.swapCents + d.commissionCents;
    cum += net;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
    curve.push({
      ts: d.closeTime,
      ticket: d.ticket,
      symbol: d.symbol,
      netCents: net,
      cumCents: cum,
      drawdownCents: dd,
    });
  }

  return {
    curve,
    netCents: cum,
    peakCents: peak,
    maxDrawdownCents: maxDd,
    currentDrawdownCents: curve[curve.length - 1]!.drawdownCents,
    totalFeesCents: fees,
  };
}
```

- [ ] **Step 2: Create `lib/compound/journal/trade-equity.test.ts`**

```typescript
import { computeTradeEquity } from "./trade-equity";
import { buildTradeHistory } from "./history";
import {
  FIXTURE_OFFSET_HOURS,
  RAW_DEALS,
  fixtureHistory,
  fixtureHistoryUnguarded,
} from "./__fixtures__/deals";

describe("computeTradeEquity", () => {
  const r = computeTradeEquity(fixtureHistory().deals);

  // Mutation caught: no sort. The fixture array is scrambled, so an unsorted
  // pass produces a different sequence of cumulative values and, with it, a
  // different drawdown.
  it("walks the curve in close-time order", () => {
    expect(r.curve.map((p) => p.ticket)).toEqual([
      5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008, 5009,
    ]);
  });

  // Every cumulative value is pinned, not just the last. Mutation caught: an
  // off-by-one that drops the first or last point but still totals correctly.
  it("accumulates net-of-fees exactly at every point", () => {
    expect(r.curve.map((p) => p.cumCents)).toEqual([
      1195n, 769n, 3590n, 2068n, 2061n, 2712n, 1836n, 3189n, 3163n,
    ]);
    expect(r.netCents).toBe(3163n);
    expect(r.totalFeesCents).toBe(-295n);
  });

  // The maximum drawdown (1754) happens at the seventh point and the final
  // drawdown (427) is different, and both differ from zero. Mutation caught:
  // returning the final drawdown as the maximum, or the maximum as the
  // current — a curve whose worst point is also its last cannot tell them
  // apart, which is why this fixture recovers afterwards.
  it("separates maximum drawdown from current drawdown", () => {
    expect(r.peakCents).toBe(3590n);
    expect(r.maxDrawdownCents).toBe(1754n);
    expect(r.currentDrawdownCents).toBe(427n);
  });

  it("records the drawdown at each point", () => {
    expect(r.curve.map((p) => p.drawdownCents)).toEqual([
      0n, 426n, 0n, 1522n, 1529n, 878n, 1754n, 401n, 427n,
    ]);
  });

  // Mutation caught: seeding peak at the first cumulative value rather than
  // zero. An account that is under water from its first trade would then show
  // no drawdown at all.
  it("measures drawdown from zero when the account never goes positive", () => {
    const losers = buildTradeHistory(
      RAW_DEALS.filter((d) => d.profitCents < 0n),
      FIXTURE_OFFSET_HOURS,
    );
    const l = computeTradeEquity(losers.deals);
    expect(l.peakCents).toBe(0n);
    expect(l.netCents).toBe(-2824n);
    expect(l.maxDrawdownCents).toBe(2824n);
    expect(l.currentDrawdownCents).toBe(2824n);
  });

  // THE DEDUPE ASSERTION for this module.
  it("differs from the undeduplicated answer", () => {
    const bad = computeTradeEquity(fixtureHistoryUnguarded().deals);
    expect(bad.curve).toHaveLength(10);
    expect(bad.netCents).toBe(4516n);
    expect(bad.netCents).not.toBe(r.netCents);
  });

  it("returns an empty result for no deals without indexing off the end", () => {
    const e = computeTradeEquity(buildTradeHistory([], FIXTURE_OFFSET_HOURS).deals);
    expect(e.curve).toEqual([]);
    expect(e.currentDrawdownCents).toBe(0n);
  });

  it("returns bigints for every money field on every point", () => {
    for (const p of r.curve) {
      expect(typeof p.cumCents).toBe("bigint");
      expect(typeof p.drawdownCents).toBe("bigint");
      expect(typeof p.netCents).toBe("bigint");
    }
  });
});
```

- [ ] **Step 3: Create `lib/compound/journal/histogram.ts`**

```typescript
/**
 * P/L distribution with integer bin edges.
 *
 * Upstream computes a float step, indexes with Math.floor and clamps the top
 * edge, then decides each bin's sign against a 0.0001 threshold to work around
 * float dust. In integers none of that is needed: the edges are exact cents,
 * the top bin is closed rather than half-open, and a bin's sign is the sign of
 * its integer midpoint.
 *
 * The step is floor(range / binCount), so the top bin absorbs the remainder
 * and is at most binCount-1 cents wider than the others. Distributing the
 * remainder across bins would make the edges uneven and buy nothing — these
 * are display buckets, not an accounting path.
 */
import type { Cents } from "@/lib/compound/engine/money";
import { divFloor, toIndex } from "./int";

export type BinSign = "win" | "loss" | "zero";

export interface HistogramBin {
  startCents: Cents;
  /** Inclusive on the last bin, exclusive on every other. */
  endCents: Cents;
  count: number;
  sign: BinSign;
}

export interface HistogramResult {
  bins: HistogramBin[];
  minCents: Cents;
  maxCents: Cents;
  /** Values binned. Equals the sum of every bin's count. */
  total: number;
}

function signOf(startCents: Cents, endCents: Cents): BinSign {
  const mid = divFloor(startCents + endCents, 2n);
  return mid > 0n ? "win" : mid < 0n ? "loss" : "zero";
}

export function binNetPnl(values: readonly Cents[], binCount: number): HistogramResult {
  if (!Number.isInteger(binCount) || binCount <= 0) {
    throw new RangeError(`binCount must be a positive integer, got ${binCount}`);
  }
  if (values.length === 0) {
    return { bins: [], minCents: 0n, maxCents: 0n, total: 0 };
  }

  let minCents = values[0]!;
  let maxCents = values[0]!;
  for (const v of values) {
    if (v < minCents) minCents = v;
    if (v > maxCents) maxCents = v;
  }

  if (minCents === maxCents) {
    return {
      bins: [
        {
          startCents: minCents,
          endCents: maxCents,
          count: values.length,
          sign: signOf(minCents, maxCents),
        },
      ],
      minCents,
      maxCents,
      total: values.length,
    };
  }

  const range = maxCents - minCents;
  // A range narrower than the requested bin count would give a zero step.
  // Narrow the histogram instead of dividing by zero.
  const effective = range < BigInt(binCount) ? toIndex(range) : binCount;
  const step = range / BigInt(effective);

  const bins: HistogramBin[] = [];
  for (let i = 0; i < effective; i += 1) {
    const startCents = minCents + step * BigInt(i);
    const endCents = i === effective - 1 ? maxCents : minCents + step * BigInt(i + 1);
    bins.push({ startCents, endCents, count: 0, sign: signOf(startCents, endCents) });
  }

  for (const v of values) {
    const raw = toIndex((v - minCents) / step);
    // The maximum lands one past the last bin: (max-min)/step is exactly
    // `effective` when the range divides evenly, and can exceed it when the
    // remainder went to the top bin. The clamp is load-bearing, not defensive.
    const idx = raw >= effective ? effective - 1 : raw;
    bins[idx]!.count += 1;
  }

  return { bins, minCents, maxCents, total: values.length };
}
```

- [ ] **Step 4: Create `lib/compound/journal/histogram.test.ts`**

```typescript
import { binNetPnl } from "./histogram";
import { computeTradeEquity } from "./trade-equity";
import { fixtureHistory, fixtureHistoryUnguarded } from "./__fixtures__/deals";

const VALUES = computeTradeEquity(fixtureHistory().deals).curve.map((p) => p.netCents);
// [1195, -426, 2821, -1522, -7, 651, -876, 1353, -26]

describe("binNetPnl", () => {
  const h = binNetPnl(VALUES, 8);

  it("spans the observed range exactly", () => {
    expect(h.minCents).toBe(-1522n);
    expect(h.maxCents).toBe(2821n);
    expect(h.bins).toHaveLength(8);
    expect(h.bins[0]!.startCents).toBe(-1522n);
    expect(h.bins[7]!.endCents).toBe(2821n);
  });

  // step = floor(4343/8) = 542. Mutation caught: a float step, which gives
  // 542.875 and shifts every interior edge.
  it("uses integer edges with the remainder in the top bin", () => {
    expect(h.bins.map((b) => b.startCents)).toEqual([
      -1522n, -980n, -438n, 104n, 646n, 1188n, 1730n, 2272n,
    ]);
    // The top bin is 549 wide; the rest are 542.
    expect(h.bins[7]!.endCents - h.bins[7]!.startCents).toBe(549n);
    expect(h.bins[0]!.endCents - h.bins[0]!.startCents).toBe(542n);
  });

  // Mutation caught: dropping the top-edge clamp, which sends 2821 to index 8
  // and throws or silently loses it; and an off-by-one that shifts every
  // value one bin left. Empty bins at index 3 and 6 are asserted because a
  // "drop empty bins" mutation is otherwise invisible.
  it("counts every value into exactly one bin, including the maximum", () => {
    expect(h.bins.map((b) => b.count)).toEqual([1, 1, 3, 0, 1, 2, 0, 1]);
    expect(h.bins.reduce((a, b) => a + b.count, 0)).toBe(VALUES.length);
    expect(h.total).toBe(9);
  });

  // Mutation caught: signing a bin by its start rather than its midpoint. Bin
  // 2 spans -438..104 and is a loss bin by midpoint; by start it would also be
  // a loss, but bin 3 spans 104..646 and by midpoint is a win — a mutation
  // using endCents alone would call bin 2 a win.
  it("signs each bin by its integer midpoint", () => {
    expect(h.bins.map((b) => b.sign)).toEqual([
      "loss", "loss", "loss", "win", "win", "win", "win", "win",
    ]);
  });

  // THE DEDUPE ASSERTION for this module.
  it("differs from the undeduplicated answer", () => {
    const badValues = computeTradeEquity(fixtureHistoryUnguarded().deals).curve.map(
      (p) => p.netCents,
    );
    const bad = binNetPnl(badValues, 8);
    expect(bad.total).toBe(10);
    expect(bad.bins.map((b) => b.count)).not.toEqual(h.bins.map((b) => b.count));
  });

  it("returns one bin when every value is identical", () => {
    const one = binNetPnl([500n, 500n, 500n], 8);
    expect(one.bins).toHaveLength(1);
    expect(one.bins[0]!.count).toBe(3);
    expect(one.bins[0]!.sign).toBe("win");
  });

  it("signs an all-zero distribution as zero", () => {
    expect(binNetPnl([0n, 0n], 4).bins[0]!.sign).toBe("zero");
  });

  // Mutation caught: `range / BigInt(binCount)` with no narrowing, which is
  // 0n for a range of 3 over 8 bins and then divides by zero.
  it("narrows the histogram rather than dividing by zero on a tiny range", () => {
    const tiny = binNetPnl([1n, 2n, 3n, 4n], 8);
    expect(tiny.bins).toHaveLength(3);
    expect(tiny.bins.reduce((a, b) => a + b.count, 0)).toBe(4);
  });

  it("returns nothing for no values and rejects a bad bin count", () => {
    expect(binNetPnl([], 8)).toEqual({ bins: [], minCents: 0n, maxCents: 0n, total: 0 });
    expect(() => binNetPnl(VALUES, 0)).toThrow(/positive integer/);
    expect(() => binNetPnl(VALUES, 2.5)).toThrow(/positive integer/);
  });
});
```

- [ ] **Step 5: Run the gates**

```bash
pnpm typecheck && pnpm test -- lib/compound/journal
```

- [ ] **Step 6: Prove these tests bite**

1. **Drop the sort in `computeTradeEquity`.** Expected red: `"walks the curve in close-time order"`, `"accumulates net-of-fees exactly at every point"`, `"separates maximum drawdown from current drawdown"`.
2. **Return `currentDrawdownCents` as `maxDrawdownCents`.** Expected red: `"separates maximum drawdown from current drawdown"` only. Record that `"records the drawdown at each point"` stays green — the per-point values are right; only the summary is wrong, which is precisely why both are asserted.
3. **Seed `peak` at the first cumulative value.** Expected red: `"measures drawdown from zero when the account never goes positive"`. The main fixture goes positive on trade one, so it cannot detect this.
4. **Use `d.profitCents` instead of `dealNetCents(d)`.** Expected red: `"accumulates net-of-fees exactly at every point"` — the curve becomes the gross series and `totalFeesCents` no longer reconciles.
5. **Remove the top-edge clamp** in `binNetPnl`. Expected: a `RangeError` from `bins[8]` being undefined under `noUncheckedIndexedAccess`, or a lost value. Either way `"counts every value into exactly one bin"` goes red. Record which.
6. **Sign bins by `startCents`** (`startCents > 0n ? "win" : ...`). Expected red: `"signs each bin by its integer midpoint"` — bin 3 becomes `zero` because its start is 104... verify and record the actual output; if it happens to agree, widen the fixture range until a bin straddles zero with a positive midpoint and a non-positive start.
7. **Remove the `effective` narrowing.** Expected red: `"narrows the histogram rather than dividing by zero"` with a division-by-zero `RangeError` from `toIndex` or from bigint division.

- [ ] **Step 7: Commit**

```bash
git add lib/compound/journal/trade-equity.ts lib/compound/journal/trade-equity.test.ts \
        lib/compound/journal/histogram.ts lib/compound/journal/histogram.test.ts
git commit -m "feat(journal): cumulative trading P/L, drawdown, and an integer-edge histogram"
```

---

### Task 6: `equity-series.ts` — the curve a deposit actually moves

This is spec **R4**. The task brief for this plan states it plainly: *step-ups should read as deposits, not performance.*

The insight that shapes the module: a capital event does not move closed-trade P/L at all, so marking one on Task 5's curve communicates nothing. The curve that steps up on a deposit is the **account equity** curve from `account_snapshots_daily`. So this module builds that curve and, alongside it, a **cumulative contributed capital** line derived from the ledger's capital marks. On a deposit both step by the same amount, and the gap between them — which is performance — does not move. `/performance` renders the pair, plus Task 5's capital-neutral curve below, and the three together make a step-up unambiguous without the reader having to interpret a legend.

**On the input type.** This module defines `CapitalMarkInput` structurally rather than importing plan 4's `CapitalMark`. Plan 4's type is assignable to it — it carries `occurredOn`, `amountCents` and `direction` plus a `type` field this module does not read — so `capitalMarks(entries)` feeds straight in. Defining it locally is what keeps Phase A mergeable without plan 4, and it is not a second truth: it is a narrower view of the same one.

**Files:**
- Create: `lib/compound/journal/equity-series.ts`
- Create: `lib/compound/journal/equity-series.test.ts`

**Interfaces:**
- Consumes: `Cents` from `@/lib/compound/engine/money`; `DailySnapshot` from `@/lib/compound/reconcile/types`
- Produces:
  - `interface CapitalMarkInput { occurredOn: string; amountCents: Cents; direction: "in" | "out" }`
  - `interface EquityPoint { date; equityCents; contributedCents; performanceCents; marks; incompleteMarks }`
  - `interface AccountEquitySeries { points; trailingMarks; marksCompleteThrough }`
  - `buildAccountEquitySeries(input): AccountEquitySeries`

- [ ] **Step 1: Create `lib/compound/journal/equity-series.ts`**

```typescript
/**
 * The account-equity curve, with capital events made visible. Spec R4.
 *
 * Three lines come out of this, and the relationship between them is the
 * whole point:
 *
 *   equityCents        what the account is worth (from account_snapshots_daily)
 *   contributedCents   cumulative capital put in, less capital taken out
 *   performanceCents   the difference — what trading did, immune to capital
 *
 * On a deposit the first two step by the same amount and the third does not
 * move. An investor looking at a curve that jumps can therefore see, without
 * reading a legend, that it was money in rather than a good week.
 *
 * A mark is attributed to the FIRST SNAPSHOT AT OR AFTER its date, not to a
 * snapshot on the same date. Snapshot series have weekend and holiday gaps and
 * a deposit lands on whatever day the manager made it; exact-date matching
 * would silently drop every capital event that fell in a gap, and a dropped
 * deposit is precisely the failure R4 exists to prevent.
 *
 * Marks after the last snapshot are returned in trailingMarks rather than
 * folded into the final point. Attributing an event to a day whose equity
 * reading predates it would show a step in the wrong place.
 *
 * marksCompleteThrough carries the reconcile cursor. Past that date the ledger
 * may be missing an event: the section 5.3 interlock stops advancing readings
 * at an unclassified capital move, and the deposit that explains it is by
 * definition not committed yet. Points past the cursor are flagged rather than
 * silently drawn as if complete.
 */
import type { Cents } from "@/lib/compound/engine/money";
import type { DailySnapshot } from "@/lib/compound/reconcile/types";

/**
 * The three fields this module reads from a capital event. Plan 4's
 * CapitalMark is assignable to this; it carries a `type` field as well, which
 * the renderer uses for its label and this module does not need.
 */
export interface CapitalMarkInput {
  /** YYYY-MM-DD. */
  occurredOn: string;
  /** Always positive. Direction carries the sign. */
  amountCents: Cents;
  direction: "in" | "out";
}

export interface EquityPoint {
  /** YYYY-MM-DD. */
  date: string;
  equityCents: Cents;
  /** Cumulative net capital contributed through this date. */
  contributedCents: Cents;
  /** equityCents - contributedCents. */
  performanceCents: Cents;
  /** Marks attributed to this point, in input order. */
  marks: CapitalMarkInput[];
  /** True when this point is later than marksCompleteThrough. */
  incompleteMarks: boolean;
}

export interface AccountEquitySeries {
  points: EquityPoint[];
  /** Marks dated after the last snapshot. Rendered as pending, never dropped. */
  trailingMarks: CapitalMarkInput[];
  marksCompleteThrough: string | null;
}

function signedDelta(m: CapitalMarkInput): Cents {
  return m.direction === "in" ? m.amountCents : -m.amountCents;
}

export function buildAccountEquitySeries(input: {
  snapshots: readonly DailySnapshot[];
  marks: readonly CapitalMarkInput[];
  /** compound_reconcile_cursor.last_reading_date. Null when nothing posted. */
  marksCompleteThrough: string | null;
}): AccountEquitySeries {
  const { snapshots, marks, marksCompleteThrough } = input;

  const orderedSnapshots = [...snapshots].sort((a, b) =>
    a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0,
  );
  // Stable within a day: two events on the same date keep ledger order, which
  // is seq order (spec section 6.2). Array.prototype.sort is stable in every
  // engine this project targets.
  const orderedMarks = [...marks].sort((a, b) =>
    a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : 0,
  );

  const points: EquityPoint[] = [];
  let contributed: Cents = 0n;
  let cursor = 0;

  for (const snap of orderedSnapshots) {
    const attributed: CapitalMarkInput[] = [];
    while (cursor < orderedMarks.length && orderedMarks[cursor]!.occurredOn <= snap.tradeDate) {
      const m = orderedMarks[cursor]!;
      contributed += signedDelta(m);
      attributed.push(m);
      cursor += 1;
    }
    points.push({
      date: snap.tradeDate,
      equityCents: snap.equityCloseCents,
      contributedCents: contributed,
      performanceCents: snap.equityCloseCents - contributed,
      marks: attributed,
      incompleteMarks: marksCompleteThrough === null || snap.tradeDate > marksCompleteThrough,
    });
  }

  return {
    points,
    trailingMarks: orderedMarks.slice(cursor),
    marksCompleteThrough,
  };
}
```

- [ ] **Step 2: Create `lib/compound/journal/equity-series.test.ts`**

The fixture is deliberately **not** consistent with the deal fixture. These two answer different questions and pretending the numbers reconcile would invite a reader to check a relationship this module does not claim.

```typescript
import type { DailySnapshot } from "@/lib/compound/reconcile/types";
import { buildAccountEquitySeries, type CapitalMarkInput } from "./equity-series";

const S = (tradeDate: string, equityCloseCents: bigint): DailySnapshot => ({
  tradeDate,
  balanceCloseCents: equityCloseCents,
  equityCloseCents,
});

/**
 * Fictional. Five snapshots with a weekend gap at 2026-05-07, and four marks
 * positioned to catch four different mistakes:
 *   2026-05-01  before the first snapshot   — pre-window marks must count
 *   2026-05-07  on a day with NO snapshot   — gap marks must roll forward
 *   2026-05-11  two marks on one day        — a Map keyed by date loses one
 *   2026-05-20  after the last snapshot     — must not be folded into 05-11
 */
const SNAPSHOTS: DailySnapshot[] = [
  S("2026-05-05", 1_002_234n),
  S("2026-05-04", 999_413n), // out of order on purpose
  S("2026-05-11", 1_047_119n),
  S("2026-05-06", 1_000_712n),
  S("2026-05-08", 1_051_363n),
];

const MARKS: CapitalMarkInput[] = [
  { occurredOn: "2026-05-11", amountCents: 12_500n, direction: "out" },
  { occurredOn: "2026-05-01", amountCents: 900_000n, direction: "in" },
  { occurredOn: "2026-05-20", amountCents: 700n, direction: "out" },
  { occurredOn: "2026-05-11", amountCents: 3_333n, direction: "in" },
  { occurredOn: "2026-05-07", amountCents: 50_000n, direction: "in" },
];

const build = (completeThrough: string | null = "2026-05-11") =>
  buildAccountEquitySeries({
    snapshots: SNAPSHOTS,
    marks: MARKS,
    marksCompleteThrough: completeThrough,
  });

describe("buildAccountEquitySeries", () => {
  const series = build();

  // Mutation caught: no sort on snapshots. The fixture is scrambled.
  it("orders points by date", () => {
    expect(series.points.map((p) => p.date)).toEqual([
      "2026-05-04",
      "2026-05-05",
      "2026-05-06",
      "2026-05-08",
      "2026-05-11",
    ]);
  });

  // Mutation caught: starting the walk at the first snapshot and ignoring
  // anything earlier. The genesis deposit is the largest single figure in the
  // series and dropping it makes every performance number wrong by 900000.
  it("counts a mark dated before the first snapshot", () => {
    expect(series.points[0]!.contributedCents).toBe(900_000n);
    expect(series.points[0]!.performanceCents).toBe(99_413n);
    expect(series.points[0]!.marks).toHaveLength(1);
  });

  // Mutation caught: matching a mark to a snapshot with the same date. There
  // is no 2026-05-07 snapshot, so exact matching drops the deposit entirely.
  it("rolls a mark in a snapshot gap forward to the next snapshot", () => {
    const may8 = series.points[3]!;
    expect(may8.date).toBe("2026-05-08");
    expect(may8.marks.map((m) => m.amountCents)).toEqual([50_000n]);
    expect(may8.contributedCents).toBe(950_000n);
  });

  // THE R4 ASSERTION. Between 05-06 and 05-08 equity rises by 50651. Only 651
  // of that is performance; the rest is money in. Mutation caught: dropping
  // the mark, or applying it with the wrong sign — either makes the second
  // figure equal the first.
  it("keeps performance flat across a deposit while equity steps", () => {
    const before = series.points[2]!; // 2026-05-06
    const after = series.points[3]!;  // 2026-05-08
    expect(after.equityCents - before.equityCents).toBe(50_651n);
    expect(after.performanceCents - before.performanceCents).toBe(651n);
    expect(after.contributedCents - before.contributedCents).toBe(50_000n);
  });

  // Mutation caught: a Map keyed by date, or a `find` that stops at the first
  // match, either of which keeps one of the two 05-11 marks.
  it("attributes both marks dated on the same day", () => {
    const may11 = series.points[4]!;
    expect(may11.marks).toHaveLength(2);
    // 950000 - 12500 + 3333
    expect(may11.contributedCents).toBe(940_833n);
    expect(may11.performanceCents).toBe(106_286n);
  });

  // Mutation caught: adding every mark regardless of direction. That would
  // give 965833 and hide a withdrawal as if it were a contribution.
  it("subtracts a payout instead of adding it", () => {
    const inOnly = buildAccountEquitySeries({
      snapshots: SNAPSHOTS,
      marks: MARKS.map((m) => ({ ...m, direction: "in" as const })),
      marksCompleteThrough: null,
    });
    expect(inOnly.points[4]!.contributedCents).toBe(965_833n);
    expect(series.points[4]!.contributedCents).toBe(940_833n);
  });

  // Mutation caught: clamping leftover marks onto the last point, which draws
  // a step on a day whose equity reading predates the event.
  it("holds a mark dated after the last snapshot aside", () => {
    expect(series.trailingMarks).toHaveLength(1);
    expect(series.trailingMarks[0]!.occurredOn).toBe("2026-05-20");
    expect(series.points[4]!.contributedCents).toBe(940_833n);
  });

  // Mutation caught: `>=` instead of `>`, which would flag the cursor date
  // itself as incomplete; and treating a null cursor as "complete".
  it("flags points past the reconcile cursor as possibly incomplete", () => {
    const partial = build("2026-05-06");
    expect(partial.points.map((p) => p.incompleteMarks)).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    const nothingPosted = build(null);
    expect(nothingPosted.points.every((p) => p.incompleteMarks)).toBe(true);
    expect(build("2026-05-11").points.every((p) => p.incompleteMarks)).toBe(false);
  });

  it("holds performance equal to equity when there are no marks", () => {
    const none = buildAccountEquitySeries({
      snapshots: SNAPSHOTS,
      marks: [],
      marksCompleteThrough: "2026-05-11",
    });
    for (const p of none.points) {
      expect(p.contributedCents).toBe(0n);
      expect(p.performanceCents).toBe(p.equityCents);
    }
  });

  it("returns an empty series with every mark trailing when there are no snapshots", () => {
    const empty = buildAccountEquitySeries({
      snapshots: [],
      marks: MARKS,
      marksCompleteThrough: null,
    });
    expect(empty.points).toEqual([]);
    expect(empty.trailingMarks).toHaveLength(MARKS.length);
  });

  it("reads equity, not balance", () => {
    // Same date, different figures. A deposit moves balance; floating P/L does
    // not — spec section 5.2. This curve is a valuation and must use equity.
    const split = buildAccountEquitySeries({
      snapshots: [{ tradeDate: "2026-05-04", balanceCloseCents: 111n, equityCloseCents: 222n }],
      marks: [],
      marksCompleteThrough: null,
    });
    expect(split.points[0]!.equityCents).toBe(222n);
  });
});
```

- [ ] **Step 3: Run the gates**

```bash
pnpm typecheck && pnpm test -- lib/compound/journal
```

- [ ] **Step 4: Prove these tests bite**

1. **Change the attribution to exact-date matching** (`occurredOn === snap.tradeDate`). Expected red: `"rolls a mark in a snapshot gap forward"`, `"keeps performance flat across a deposit"`, `"attributes both marks dated on the same day"` on `contributedCents`, `"counts a mark dated before the first snapshot"`.
2. **Apply every mark as `+amountCents`.** Expected red: `"subtracts a payout instead of adding it"` and `"attributes both marks dated on the same day"`.
3. **Fold `trailingMarks` into the last point.** Expected red: `"holds a mark dated after the last snapshot aside"`.
4. **Read `balanceCloseCents`.** Expected red: `"reads equity, not balance"` only — every other assertion uses a fixture where the two are equal, which is why that one snapshot exists.
5. **Use `>=` for `incompleteMarks`.** Expected red: `"flags points past the reconcile cursor"` on the `build("2026-05-11")` case.
6. **Drop the snapshot sort.** Expected red: `"orders points by date"` and, because the walk is order-dependent, most of the contributed figures.
7. **Reverse the mark sort** (descending). Expected red: `"counts a mark dated before the first snapshot"` — the walk consumes marks in the wrong order and attributes the genesis deposit to a later point. Record the exact failure; if it stays green, the walk is not actually order-sensitive and the sort should be documented as belt-and-braces rather than load-bearing.

- [ ] **Step 5: Commit**

```bash
git add lib/compound/journal/equity-series.ts lib/compound/journal/equity-series.test.ts
git commit -m "feat(journal): account equity series with contributed-capital line (R4)"
```

---

### Task 7: Orders, positions, and the request-scoped loaders

Two gaps close here.

**The first is a real hole in plan 3.** Spec §1 lists `orders` and `positions` among the tables Compound reads for the journal surfaces, but plan 3's Task 6 reads only `deals`, `account_snapshots_daily`, `account_snapshots_current` and `licenses`, and `supabase/migrations/20260821004302_copytraderx_fixture_tables.sql` creates no stand-in for either. Nothing in the product can render an open position today. Plan 4's author has confirmed it is adding neither, so this task owns both.

**The second is the loader layer.** `getClosedDeals` returns raw rows. Nothing outside `db/` and `load/` may call it — Task 2's `chokepoint.test.ts` enforces that — so `load/trades.ts` is where the raw query and `buildTradeHistory` are joined, once, for every page.

**On prices.** `open_price`, `close_price`, `sl`, `tp`, `price_open` and `price_current` are returned as **strings**, exactly as Postgres renders the `numeric`, and displayed verbatim. They are exchange rates, not money: nothing adds them, no accounting path touches them, and a display-only value has no reason to become a float on the way to a table cell. This also settles the upstream `computePips` question — pip arithmetic is float arithmetic over prices, it is not a spec §7 requirement, and it is not built.

**Where the two row types live.** In `lib/compound/journal/rows.ts`, not in `db/`. Plan 3's convention is that `db/` imports its return types from the pure layer and never defines them — `ClosedDeal` lives in `reconcile/types.ts` for exactly that reason, so that `dedupe.ts` and `detect.ts` cannot drift from the reader. `OpenPosition` and `OrderRow` are consumed by `journal/order-filters.ts` in Task 8, and `journal/` may not import from `db/` at all, so the pure layer is the only place they can live.

**Files:**
- Create: `supabase/migrations/20260821120000_copytraderx_orders_positions.sql`
- Create: `lib/compound/journal/rows.ts`
- Modify: `lib/compound/db/copytraderx.ts`
- Create: `lib/compound/db/copytraderx-journal.db.test.ts`
- Create: `lib/compound/load/trades.ts`
- Modify: `lib/compound/journal/purity.test.ts`

**Interfaces:**
- Consumes: `Queryable` from `@/lib/compound/db/types`; `centsExpr`, `milliLotsExpr`, `utcIsoExpr`, `toCents`, `toId`, `toSide` from `@/lib/compound/db/sql`; `withDb` from `@/lib/compound/db/client`; `buildTradeHistory` from `@/lib/compound/journal/history`
- Produces (in `lib/compound/journal/rows.ts`):
  - `interface OpenPosition { ticket; symbol; side; volumeMilliLots; openPrice; currentPrice; slPrice; tpPrice; profitCents; swapCents; commissionCents; openTime; comment }`
  - `interface OrderRow { ticket; symbol; type; state; volumeInitialMilliLots; volumeCurrentMilliLots; priceOpen; priceCurrent; slPrice; tpPrice; timeSetup; timeDone; comment }`
- Produces (in `lib/compound/db/copytraderx.ts`):
  - `getOpenPositions(c: Queryable, mt5Account: number): Promise<OpenPosition[]>`
  - `getOrders(c: Queryable, mt5Account: number, range?: DateRange): Promise<OrderRow[]>`
  - `loadTradeHistory(mt5Account: number, brokerOffsetHours: number | null, from?: string | null, to?: string | null): Promise<TradeHistory>`
  - `loadOpenPositions(mt5Account: number): Promise<OpenPosition[]>`
  - `loadOrders(mt5Account: number, from?: string | null, to?: string | null): Promise<OrderRow[]>`
  - `loadDailySnapshots(mt5Account: number, from?: string | null, to?: string | null): Promise<DailySnapshot[]>`

- [ ] **Step 1: Create `supabase/migrations/20260821120000_copytraderx_orders_positions.sql`**

```sql
-- ============================================================================
-- LOCAL FIXTURE / STAND-IN TABLES — NOT FOR PRODUCTION
-- ============================================================================
--
-- positions and orders are owned by CopyTraderX and populated by an Expert
-- Advisor pushing to the live production Supabase project. Compound reads
-- both and writes to neither.
--
-- This migration exists solely so a LOCAL Supabase instance has something
-- shaped like them for lib/compound/db/ to read against. It must NEVER be
-- applied to the live CopyTraderX project — those tables already exist there,
-- next to real trading data.
--
-- Columns are reproduced from the real migrations at
-- ~/Documents/development/EA/JSONFX-IMPULSE/supabase/migrations/
-- (20260502000003_create_positions.sql and 20260502000005_create_orders.sql)
-- rather than guessed. That path is local-machine context, not something this
-- repo can assume exists, so it is recorded here for whoever next needs to
-- re-verify. The real tables carry an ea_source CHECK against a fixed product
-- list; that constraint is omitted here because Compound never writes these
-- rows and a fixture that rejects a test insert helps nobody.
-- ============================================================================

create table public.positions (
  mt5_account    bigint        not null,
  ticket         bigint        not null,
  ea_source      text          not null,
  symbol         text          not null,
  side           text          not null,
  volume         numeric(10,2) not null,
  open_price     numeric(18,5) not null,
  current_price  numeric(18,5) not null,
  sl             numeric(18,5),
  tp             numeric(18,5),
  profit         numeric(18,2) not null,
  swap           numeric(18,2) not null,
  commission     numeric(18,2) not null,
  open_time      timestamptz   not null,
  comment        text,
  magic          bigint,
  primary key (mt5_account, ticket),
  constraint positions_side_chk check (side in ('buy','sell'))
);

comment on table public.positions is
  'LOCAL FIXTURE stand-in for a table owned by CopyTraderX. Do not apply to the live project.';

create table public.orders (
  mt5_account     bigint        not null,
  ticket          bigint        not null,
  ea_source       text          not null,
  symbol          text          not null,
  type            text          not null,
  state           text          not null,
  volume_initial  numeric(10,2) not null,
  volume_current  numeric(10,2) not null,
  price_open      numeric(18,5),
  price_current   numeric(18,5),
  sl              numeric(18,5),
  tp              numeric(18,5),
  time_setup      timestamptz   not null,
  time_done       timestamptz,
  comment         text,
  magic           bigint,
  primary key (mt5_account, ticket)
);

create index orders_account_time_setup_idx
  on public.orders (mt5_account, time_setup desc);

comment on table public.orders is
  'LOCAL FIXTURE stand-in for a table owned by CopyTraderX. Do not apply to the live project.';
```

- [ ] **Step 2: Create `lib/compound/journal/rows.ts`**

```typescript
/**
 * The two CopyTraderX row shapes the journal surfaces read, beyond deals.
 *
 * These live in the pure layer, not in db/, for the same reason ClosedDeal
 * does: db/ maps rows ONTO these types and never defines them, so a reader
 * and a filter cannot drift apart. journal/ may not import from db/ at all.
 *
 * PRICES ARE STRINGS. open_price, current_price, sl, tp, price_open and
 * price_current come back exactly as Postgres renders the numeric and are
 * displayed verbatim. They are exchange rates, not money: nothing sums them,
 * no accounting path reads them, and turning a display-only value into a float
 * on the way to a table cell buys nothing and costs the guarantee. It also
 * settles the upstream computePips question — pip arithmetic is float
 * arithmetic over prices, and it is not a spec section 7 requirement.
 *
 * Money on these rows is cents, converted in SQL, same as everywhere else.
 */
import type { Cents } from "@/lib/compound/engine/money";

export interface OpenPosition {
  ticket: number;
  symbol: string;
  side: "buy" | "sell";
  /** Lots x 1000 as an integer. 0.05 lots is 50. */
  volumeMilliLots: number;
  /** Rendered verbatim. Never parsed. */
  openPrice: string;
  currentPrice: string;
  slPrice: string | null;
  tpPrice: string | null;
  /** Floating P/L on this position right now. */
  profitCents: Cents;
  swapCents: Cents;
  commissionCents: Cents;
  /** ISO 8601, UTC. */
  openTime: string;
  comment: string | null;
}

export interface OrderRow {
  ticket: number;
  symbol: string;
  /** Raw MT5 constant, e.g. order_type_buy_limit. Humanised in the UI layer. */
  type: string;
  /** Raw MT5 constant, e.g. order_state_filled. */
  state: string;
  volumeInitialMilliLots: number;
  volumeCurrentMilliLots: number;
  priceOpen: string | null;
  priceCurrent: string | null;
  slPrice: string | null;
  tpPrice: string | null;
  /** ISO 8601, UTC. */
  timeSetup: string;
  timeDone: string | null;
  comment: string | null;
}
```

- [ ] **Step 3: Append the readers to `lib/compound/db/copytraderx.ts`**

Add `import type { OpenPosition, OrderRow } from "@/lib/compound/journal/rows";` and re-export both so a caller can import either shape from the reader it uses: `export type { OpenPosition, OrderRow };`

```typescript
export async function getOpenPositions(
  c: Queryable,
  mt5Account: number,
): Promise<OpenPosition[]> {
  const { rows } = await c.query<{
    ticket: string;
    symbol: string;
    side: string;
    volume_milli_lots: number;
    open_price: string;
    current_price: string;
    sl: string | null;
    tp: string | null;
    profit_cents: string;
    swap_cents: string;
    commission_cents: string;
    open_time: string;
    comment: string | null;
  }>(
    `select ticket,
            symbol,
            side,
            ${milliLotsExpr("volume")} as volume_milli_lots,
            open_price::text  as open_price,
            current_price::text as current_price,
            sl::text as sl,
            tp::text as tp,
            ${centsExpr("profit")} as profit_cents,
            ${centsExpr("swap")} as swap_cents,
            ${centsExpr("commission")} as commission_cents,
            ${utcIsoExpr("open_time")} as open_time,
            comment
       from public.positions
      where mt5_account = $1
      order by open_time asc, ticket asc`,
    [mt5Account],
  );

  return rows.map((r) => ({
    ticket: toId(r.ticket, "positions.ticket"),
    symbol: r.symbol,
    side: toSide(r.side, "positions.side"),
    volumeMilliLots: r.volume_milli_lots,
    openPrice: r.open_price,
    currentPrice: r.current_price,
    slPrice: r.sl,
    tpPrice: r.tp,
    profitCents: toCents(r.profit_cents, "positions.profit"),
    swapCents: toCents(r.swap_cents, "positions.swap"),
    commissionCents: toCents(r.commission_cents, "positions.commission"),
    openTime: r.open_time,
    comment: r.comment,
  }));
}

export async function getOrders(
  c: Queryable,
  mt5Account: number,
  range: DateRange = {},
): Promise<OrderRow[]> {
  const { rows } = await c.query<{
    ticket: string;
    symbol: string;
    type: string;
    state: string;
    volume_initial_milli_lots: number;
    volume_current_milli_lots: number;
    price_open: string | null;
    price_current: string | null;
    sl: string | null;
    tp: string | null;
    time_setup: string;
    time_done: string | null;
    comment: string | null;
  }>(
    `select ticket,
            symbol,
            type,
            state,
            ${milliLotsExpr("volume_initial")} as volume_initial_milli_lots,
            ${milliLotsExpr("volume_current")} as volume_current_milli_lots,
            price_open::text    as price_open,
            price_current::text as price_current,
            sl::text as sl,
            tp::text as tp,
            ${utcIsoExpr("time_setup")} as time_setup,
            ${utcIsoExpr("time_done")} as time_done,
            comment
       from public.orders
      where mt5_account = $1
        and ($2::date is null or (time_setup at time zone 'UTC')::date >= $2::date)
        and ($3::date is null or (time_setup at time zone 'UTC')::date <= $3::date)
      order by time_setup desc, ticket desc`,
    [mt5Account, range.from ?? null, range.to ?? null],
  );

  return rows.map((r) => ({
    ticket: toId(r.ticket, "orders.ticket"),
    symbol: r.symbol,
    type: r.type,
    state: r.state,
    volumeInitialMilliLots: r.volume_initial_milli_lots,
    volumeCurrentMilliLots: r.volume_current_milli_lots,
    priceOpen: r.price_open,
    priceCurrent: r.price_current,
    slPrice: r.sl,
    tpPrice: r.tp,
    timeSetup: r.time_setup,
    timeDone: r.time_done,
    comment: r.comment,
  }));
}
```

> **Note on `utcIsoExpr` and a null timestamp.** `time_done` is nullable. Confirm plan 3's `utcIsoExpr` renders `null` as `null` rather than as the string `"null"`; if it does not, wrap it: `case when time_done is null then null else ${utcIsoExpr("time_done")} end`. The test below asserts it, so this is not left to inspection.

- [ ] **Step 4: Create `lib/compound/db/copytraderx-journal.db.test.ts`**

```typescript
import { getOpenPositions, getOrders } from "./copytraderx";
import { closeTestPool, withTestClient } from "./testing/harness";

/** Fictional. Isolated from the shipped seed and from plan 3's fixtures. */
const MT5 = 9_900_701;
const OTHER_MT5 = 9_900_702;

beforeAll(async () => {
  await withTestClient(async (c) => {
    await c.query("delete from public.positions where mt5_account = any($1::bigint[])", [
      [MT5, OTHER_MT5],
    ]);
    await c.query("delete from public.orders where mt5_account = any($1::bigint[])", [
      [MT5, OTHER_MT5],
    ]);

    // -2.05 * 100 is -204.99999999999997 in IEEE 754, so a float path gives
    // -204. 0.29 * 100 is 28.999999999999996, so a float path gives 28.
    await c.query(
      `insert into public.positions
         (mt5_account, ticket, ea_source, symbol, side, volume,
          open_price, current_price, sl, tp, profit, swap, commission,
          open_time, comment)
       values
         ($1, 8801, 'impulse', 'EURUSD', 'buy',  0.05, 1.09341, 1.09507,
          1.09000, null, 83.00, -2.05, -0.29, '2026-05-08T07:00:00+00', 'grid-1'),
         ($1, 8802, 'impulse', 'XAUUSD', 'sell', 0.12, 2411.55000, 2409.10000,
          null, 2400.00000, -29.40, 0.00, -0.72, '2026-05-08T09:15:00+00', null),
         ($2, 8899, 'impulse', 'GBPUSD', 'buy',  1.00, 1.26000, 1.26100,
          null, null, 100.00, 0.00, 0.00, '2026-05-08T10:00:00+00', null)`,
      [MT5, OTHER_MT5],
    );

    await c.query(
      `insert into public.orders
         (mt5_account, ticket, ea_source, symbol, type, state,
          volume_initial, volume_current, price_open, price_current,
          sl, tp, time_setup, time_done, comment)
       values
         ($1, 7701, 'impulse', 'EURUSD', 'order_type_buy',        'order_state_filled',
          0.05, 0.00, 1.09341, null, null, null,
          '2026-05-08T06:59:00+00', '2026-05-08T07:00:00+00', null),
         ($1, 7702, 'impulse', 'XAUUSD', 'order_type_sell_limit', 'order_state_placed',
          0.12, 0.12, 2415.00000, 2409.10000, null, null,
          '2026-05-09T08:00:00+00', null, 'pending'),
         ($1, 7703, 'impulse', 'BTCUSD', 'order_type_buy_stop',   'order_state_canceled',
          0.01, 0.01, 61000.00000, null, null, null,
          '2026-05-10T23:45:00+00', '2026-05-11T00:05:00+00', null),
         ($2, 7799, 'impulse', 'GBPUSD', 'order_type_buy',        'order_state_filled',
          1.00, 0.00, 1.26000, null, null, null,
          '2026-05-08T10:00:00+00', '2026-05-08T10:00:01+00', null)`,
      [MT5, OTHER_MT5],
    );
  });
});

afterAll(async () => {
  await withTestClient(async (c) => {
    await c.query("delete from public.positions where mt5_account = any($1::bigint[])", [
      [MT5, OTHER_MT5],
    ]);
    await c.query("delete from public.orders where mt5_account = any($1::bigint[])", [
      [MT5, OTHER_MT5],
    ]);
  });
  await closeTestPool();
});

describe("getOpenPositions", () => {
  it("returns the account's positions in open-time order", async () => {
    const rows = await withTestClient((c) => getOpenPositions(c, MT5));
    expect(rows.map((r) => r.ticket)).toEqual([8801, 8802]);
  });

  // Mutation caught: converting cents in JavaScript. -205, not -204; -29, not -28.
  it("converts money to exact cents including negatives", async () => {
    const rows = await withTestClient((c) => getOpenPositions(c, MT5));
    expect(rows[0]!.profitCents).toBe(8300n);
    expect(rows[0]!.swapCents).toBe(-205n);
    expect(rows[0]!.commissionCents).toBe(-29n);
    expect(rows[1]!.profitCents).toBe(-2940n);
    expect(typeof rows[0]!.profitCents).toBe("bigint");
  });

  // Mutation caught: parsing a price with Number(), which drops trailing
  // precision and turns 2411.55000 into 2411.55 — a different string on screen
  // from what the terminal shows.
  it("returns prices verbatim as strings", async () => {
    const rows = await withTestClient((c) => getOpenPositions(c, MT5));
    expect(rows[0]!.openPrice).toBe("1.09341");
    expect(rows[1]!.openPrice).toBe("2411.55000");
    expect(typeof rows[0]!.openPrice).toBe("string");
  });

  // Mutation caught: coalescing a null stop to 0, which renders as a stop at
  // zero — a materially wrong statement about the position.
  it("keeps an absent stop or target null", async () => {
    const rows = await withTestClient((c) => getOpenPositions(c, MT5));
    expect(rows[0]!.slPrice).toBe("1.09000");
    expect(rows[0]!.tpPrice).toBeNull();
    expect(rows[1]!.slPrice).toBeNull();
  });

  it("converts lots to integer milli-lots", async () => {
    const rows = await withTestClient((c) => getOpenPositions(c, MT5));
    expect(rows[0]!.volumeMilliLots).toBe(50);
    expect(rows[1]!.volumeMilliLots).toBe(120);
  });

  it("does not leak another account's positions", async () => {
    const rows = await withTestClient((c) => getOpenPositions(c, MT5));
    expect(rows.map((r) => r.ticket)).not.toContain(8899);
  });

  it("returns nothing for an account with no open positions", async () => {
    expect(await withTestClient((c) => getOpenPositions(c, 9_909_999))).toEqual([]);
  });
});

describe("getOrders", () => {
  it("returns the account's orders newest first", async () => {
    const rows = await withTestClient((c) => getOrders(c, MT5));
    expect(rows.map((r) => r.ticket)).toEqual([7703, 7702, 7701]);
  });

  // Mutation caught: rendering a null timestamp as the string "null".
  it("keeps an unfinished order's time_done null", async () => {
    const rows = await withTestClient((c) => getOrders(c, MT5));
    const pending = rows.find((r) => r.ticket === 7702)!;
    expect(pending.timeDone).toBeNull();
    expect(pending.priceCurrent).toBe("2409.10000");
    const filled = rows.find((r) => r.ticket === 7701)!;
    expect(filled.timeDone).toBe("2026-05-08T07:00:00.000Z");
    expect(filled.priceCurrent).toBeNull();
  });

  // Mutation caught: mapping the raw constants to labels in SQL. The UI layer
  // humanises them; the reader must not, or an unrecognised constant is lost
  // before anyone can see it.
  it("returns raw MT5 type and state constants", async () => {
    const rows = await withTestClient((c) => getOrders(c, MT5));
    expect(rows.map((r) => r.type).sort()).toEqual([
      "order_type_buy",
      "order_type_buy_stop",
      "order_type_sell_limit",
    ]);
    expect(rows.find((r) => r.ticket === 7703)!.state).toBe("order_state_canceled");
  });

  it("keeps initial and current volume apart", async () => {
    const rows = await withTestClient((c) => getOrders(c, MT5));
    const filled = rows.find((r) => r.ticket === 7701)!;
    expect(filled.volumeInitialMilliLots).toBe(50);
    expect(filled.volumeCurrentMilliLots).toBe(0);
  });

  // Mutation caught: comparing time_setup against a bare date, which resolves
  // in the session timezone. Ticket 7703 is set up at 23:45 UTC on 05-10.
  it("filters on the UTC calendar day of time_setup", async () => {
    const rows = await withTestClient((c) => getOrders(c, MT5, { from: "2026-05-10" }));
    expect(rows.map((r) => r.ticket)).toEqual([7703]);
    const to = await withTestClient((c) => getOrders(c, MT5, { to: "2026-05-08" }));
    expect(to.map((r) => r.ticket)).toEqual([7701]);
  });

  it("does not leak another account's orders", async () => {
    const rows = await withTestClient((c) => getOrders(c, MT5));
    expect(rows.map((r) => r.ticket)).not.toContain(7799);
  });
});
```

- [ ] **Step 5: Create `lib/compound/load/trades.ts`**

```typescript
/**
 * Request-scoped loaders for the trading surfaces.
 *
 * THIS FILE IS THE ONLY CALLER OF getClosedDeals OUTSIDE db/. Every page gets
 * its deals through loadTradeHistory, which runs the section 6.3 duplicate
 * guard before anything counts them. chokepoint.test.ts fails the build if a
 * page reaches around it.
 *
 * Arguments are scalars, deliberately. React's cache() keys on argument
 * identity, and an options object built fresh at each call site would produce
 * a cache miss every time — three queries per page instead of one.
 */
import { cache } from "react";
import { withDb } from "@/lib/compound/db/client";
import {
  getClosedDeals,
  getDailySnapshots,
  getOpenPositions,
  getOrders,
  type OpenPosition,
  type OrderRow,
} from "@/lib/compound/db/copytraderx";
import type { DailySnapshot } from "@/lib/compound/reconcile/types";
import { buildTradeHistory, type TradeHistory } from "@/lib/compound/journal/history";

export const loadTradeHistory = cache(
  async (
    mt5Account: number,
    brokerOffsetHours: number | null,
    from: string | null = null,
    to: string | null = null,
  ): Promise<TradeHistory> => {
    const deals = await withDb((c) =>
      getClosedDeals(c, mt5Account, { from: from ?? undefined, to: to ?? undefined }),
    );
    return buildTradeHistory(deals, brokerOffsetHours);
  },
);

export const loadOpenPositions = cache(
  async (mt5Account: number): Promise<OpenPosition[]> =>
    withDb((c) => getOpenPositions(c, mt5Account)),
);

export const loadOrders = cache(
  async (
    mt5Account: number,
    from: string | null = null,
    to: string | null = null,
  ): Promise<OrderRow[]> =>
    withDb((c) => getOrders(c, mt5Account, { from: from ?? undefined, to: to ?? undefined })),
);

export const loadDailySnapshots = cache(
  async (
    mt5Account: number,
    from: string | null = null,
    to: string | null = null,
  ): Promise<DailySnapshot[]> =>
    withDb((c) =>
      getDailySnapshots(c, mt5Account, { from: from ?? undefined, to: to ?? undefined }),
    ),
);
```

- [ ] **Step 6: Ratchet the purity guard**

Add to `lib/compound/journal/purity.test.ts`, so a module that is quietly deleted or renamed out of the guard's reach fails the build:

```typescript
it("guards every module Phase A is supposed to have built", () => {
  // Mutation caught: a module dropped from the directory, or the guard being
  // pointed somewhere it no longer sees them. The engine build's lesson: a
  // guard with nothing to guard passes silently.
  expect(sourceFiles()).toEqual([
    "calendar-aggregate.ts",
    "equity-series.ts",
    "histogram.ts",
    "history.ts",
    "int.ts",
    "rows.ts",
    "streaks.ts",
    "trade-equity.ts",
    "trade-stats.ts",
  ]);
});
```

Task 8 adds four more modules to this directory. **Extend the list then, in the same commit** — a guard whose list is behind the directory is a guard with a hole in it. Do not weaken the assertion to `toContain`; the exhaustive form is what catches a module that never gets guarded.

- [ ] **Step 7: Run the gates**

```bash
supabase db reset
pnpm typecheck && pnpm test && pnpm test:db
```

- [ ] **Step 8: Prove these tests bite**

1. **Convert position money in JavaScript**: return `profit::text` and do `BigInt(Math.trunc(Number(raw) * 100))`. Expected red: `"converts money to exact cents including negatives"` with `-204n`, plus plan 3's `db/` purity guard.
2. **Parse prices with `Number()`.** Expected red: `"returns prices verbatim as strings"` — `2411.55000` becomes `2411.55`.
3. **Coalesce `sl` to `'0'`.** Expected red: `"keeps an absent stop or target null"`.
4. **Humanise `state` in SQL** with a `case` expression. Expected red: `"returns raw MT5 type and state constants"`.
5. **Compare `time_setup` against a bare date.** Run `TZ=Pacific/Kiritimati pnpm test:db`. Expected: `"filters on the UTC calendar day of time_setup"` behaves differently under the two timezones. Record what you observe; ticket 7703 is at 23:45 UTC specifically so that it can.
6. **Drop the `mt5_account` filter from `getOrders`.** Expected red: `"returns the account's orders newest first"` and `"does not leak another account's orders"`.
7. **Have `loadTradeHistory` return the raw deals** without calling `buildTradeHistory`. Expected: a `tsc` failure — `ClosedDeal[]` is not `DedupedDeals`. Record it. The type is doing the work, not the test.
8. **Add `getClosedDeals(c, 1)` to any file under `app/`.** Expected red: `chokepoint.test.ts`'s `"calls getClosedDeals only from db/ and load/"`. Delete it.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20260821120000_copytraderx_orders_positions.sql \
        lib/compound/journal/rows.ts lib/compound/journal/purity.test.ts \
        lib/compound/db/copytraderx.ts lib/compound/db/copytraderx-journal.db.test.ts \
        lib/compound/load/trades.ts
git commit -m "feat(db): read orders and open positions, and load deals through the dedupe guard"
```

---

## CHECKPOINT — end of Phase A

Everything the three surfaces need is now computable and readable, with no UI in the repository.

Before starting Phase B, confirm all of the following and record the output:

```bash
supabase db reset && pnpm typecheck && pnpm test && pnpm test:db
```

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test` green, and `TZ=Pacific/Kiritimati pnpm test` green as well.
- [ ] `pnpm test:db` green.
- [ ] Every one of the eight modules in `lib/compound/journal/` has a test that distinguishes the deduplicated answer from the undeduplicated one. Grep for `fixtureHistoryUnguarded` and confirm it appears in `trade-stats.test.ts`, `calendar-aggregate.test.ts`, `streaks.test.ts`, `trade-equity.test.ts` and `histogram.test.ts` — five modules; `history.test.ts` tests the guard itself, and `equity-series.ts` and `int.ts` do not take deals.
- [ ] `pnpm check:secrets` clean.

**This branch is mergeable here.** If the executor is splitting the plan, stop, merge, and take Tasks 8–12 as a separate branch off the result.

---

# Phase B — the three surfaces

---

### Task 8: Table state from the URL, filters, and order display

The three tables on `/journal` need filter, sort, search and pagination, and this plan's decision 2 says that state lives in the URL rather than in React. So the parser is a pure function over search params, and it is the product's only untrusted input on these pages — it validates against an allowlist rather than trusting what it is handed.

`order-display.ts` ports upstream unchanged in spirit: a pure mapping from MT5 constants to labels and tone variants, with a title-cased fallback so a constant nobody has seen yet renders as words instead of as `order_type_something`.

**Files:**
- Create: `lib/compound/journal/table-state.ts`
- Create: `lib/compound/journal/table-state.test.ts`
- Create: `lib/compound/journal/trade-filters.ts`
- Create: `lib/compound/journal/trade-filters.test.ts`
- Create: `lib/compound/journal/order-filters.ts`
- Create: `lib/compound/journal/order-filters.test.ts`
- Create: `lib/compound/journal/order-display.ts`
- Create: `lib/compound/journal/order-display.test.ts`
- Modify: `lib/compound/journal/purity.test.ts` — extend the module list

**Interfaces:**
- Consumes: `DedupedDeals` from `./history`; `OpenPosition`, `OrderRow` from `./rows`; `Cents` from `@/lib/compound/engine/money`; `dealNetCents` from `@/lib/compound/reconcile/types`
- Produces:
  - `interface TableState { page; size; sort; search; filters }`, `interface TableSpec { sorts; defaultSort; filterKeys; sizes? }`
  - `parseTableState(params, spec, prefix?): TableState`
  - `hrefWith(basePath, allParams, patch): string`
  - `toggleSort(current: string, key: string): string`
  - `TRADE_SPEC`, `applyTradeFilters(input: DedupedDeals, state: TableState): TradeFilterResult`
  - `ORDER_SPEC`, `classifyOrderState(raw: string): StateBucket`, `applyOrderFilters(input: readonly OrderRow[], state: TableState): OrderFilterResult`
  - `POSITION_SPEC`, `applyPositionSort(input: readonly OpenPosition[], state: TableState): PositionResult`
  - `humanizeOrderType(raw): OrderTypeDisplay`, `humanizeOrderState(raw): OrderStateDisplay`

- [ ] **Step 1: Create `lib/compound/journal/table-state.ts`**

```typescript
/**
 * Table state carried in the URL.
 *
 * These pages have no client JavaScript, so every control is a link and every
 * piece of table state is a search parameter. Two consequences shape this
 * module.
 *
 * First, a search parameter is UNTRUSTED INPUT. Nothing here trusts a value:
 * the sort key must be in the table's allowlist, the page size must be in a
 * fixed set, the page number must be a positive integer below a ceiling, and
 * free text is length-capped. An unrecognised value falls back to the default
 * rather than propagating.
 *
 * Second, three tables share one URL, so each one gets a prefix — t.page,
 * o.sort, p.size — and hrefWith preserves every parameter it is not changing.
 * Without that, sorting the orders table would reset the trades table.
 */
export interface TableState {
  /** 1-based. */
  page: number;
  size: number;
  /** One of spec.sorts. */
  sort: string;
  search: string;
  filters: Readonly<Record<string, string>>;
}

export interface TableSpec {
  readonly sorts: readonly string[];
  readonly defaultSort: string;
  readonly filterKeys: readonly string[];
  readonly sizes?: readonly number[];
}

export const DEFAULT_SIZES = [25, 50, 100] as const;
const MAX_PAGE = 10_000;
const MAX_TEXT = 64;

export type Params = Readonly<Record<string, string | undefined>>;

function key(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name;
}

export function parseTableState(params: Params, spec: TableSpec, prefix = ""): TableState {
  const get = (name: string): string | undefined => params[key(prefix, name)];

  const sizes = spec.sizes ?? DEFAULT_SIZES;
  const rawSize = Number.parseInt(get("size") ?? "", 10);
  const size = sizes.includes(rawSize) ? rawSize : sizes[0]!;

  const rawPage = Number.parseInt(get("page") ?? "", 10);
  const page =
    Number.isInteger(rawPage) && rawPage >= 1 ? Math.min(rawPage, MAX_PAGE) : 1;

  const rawSort = get("sort") ?? "";
  const sort = spec.sorts.includes(rawSort) ? rawSort : spec.defaultSort;

  const search = (get("q") ?? "").slice(0, MAX_TEXT);

  const filters: Record<string, string> = {};
  for (const name of spec.filterKeys) {
    const v = get(name);
    if (v !== undefined && v !== "") filters[name] = v.slice(0, MAX_TEXT);
  }

  return { page, size, sort, search, filters };
}

/**
 * A href with `patch` merged over the current parameters. A null or empty
 * patch value removes the parameter, which is how "clear this filter" works.
 * Keys are emitted in sorted order so a href is a deterministic string and a
 * test can assert it.
 */
export function hrefWith(
  basePath: string,
  allParams: Params,
  patch: Readonly<Record<string, string | null>>,
): string {
  const merged = new Map<string, string>();
  for (const [k, v] of Object.entries(allParams)) {
    if (v !== undefined && v !== "") merged.set(k, v);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === "") merged.delete(k);
    else merged.set(k, v);
  }
  const qs = [...merged.keys()]
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(merged.get(k)!)}`)
    .join("&");
  return qs === "" ? basePath : `${basePath}?${qs}`;
}

/** Clicking a column header: same column flips direction, new column starts descending. */
export function toggleSort(current: string, column: string): string {
  return current === `${column}_desc` ? `${column}_asc` : `${column}_desc`;
}

/** Splits "profit_desc" into ["profit", "desc"]. */
export function splitSort(sort: string): [string, "asc" | "desc"] {
  const at = sort.lastIndexOf("_");
  const column = at === -1 ? sort : sort.slice(0, at);
  const dir = sort.slice(at + 1) === "asc" ? "asc" : "desc";
  return [column, dir];
}

export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageCount: number;
}

/** Clamps the page to the available range, so a stale link cannot show nothing. */
export function paginate<T>(rows: readonly T[], state: TableState): Paged<T> {
  const total = rows.length;
  const pageCount = total === 0 ? 1 : Math.ceil(total / state.size);
  const page = Math.min(state.page, pageCount);
  const start = (page - 1) * state.size;
  return { rows: rows.slice(start, start + state.size), total, page, pageCount };
}
```

- [ ] **Step 2: Create `lib/compound/journal/table-state.test.ts`**

```typescript
import {
  DEFAULT_SIZES,
  hrefWith,
  paginate,
  parseTableState,
  splitSort,
  toggleSort,
  type TableSpec,
} from "./table-state";

const SPEC: TableSpec = {
  sorts: ["closed_desc", "closed_asc", "profit_desc", "profit_asc"],
  defaultSort: "closed_desc",
  filterKeys: ["outcome", "symbol"],
};

describe("parseTableState", () => {
  it("reads a well-formed prefixed state", () => {
    const s = parseTableState(
      { "t.page": "3", "t.size": "50", "t.sort": "profit_asc", "t.q": "XAU", "t.symbol": "XAUUSD" },
      SPEC,
      "t",
    );
    expect(s).toEqual({
      page: 3,
      size: 50,
      sort: "profit_asc",
      search: "XAU",
      filters: { symbol: "XAUUSD" },
    });
  });

  // Mutation caught: trusting the URL. Every one of these is a value a user
  // can type, and every fallback is the safe one.
  it.each([
    ["sort not in the allowlist", { "t.sort": "profit_desc; drop table" }, "sort", "closed_desc"],
    ["sort of a column that exists but a direction that does not", { "t.sort": "profit_sideways" }, "sort", "closed_desc"],
    ["empty sort", { "t.sort": "" }, "sort", "closed_desc"],
  ])("falls back on %s", (_label, params, field, expected) => {
    const s = parseTableState(params, SPEC, "t") as unknown as Record<string, unknown>;
    expect(s[field]).toBe(expected);
  });

  it.each([
    ["a size outside the allowlist", "1000000", 25],
    ["a non-numeric size", "big", 25],
    ["a negative size", "-50", 25],
    ["an allowed size", "100", 100],
  ])("handles %s", (_label, raw, expected) => {
    expect(parseTableState({ "t.size": raw }, SPEC, "t").size).toBe(expected);
  });

  it.each([
    ["zero", "0", 1],
    ["negative", "-3", 1],
    ["fractional", "2.7", 2], // parseInt takes the leading integer
    ["absurd", "99999999", 10_000],
    ["valid", "4", 4],
  ])("clamps page %s", (_label, raw, expected) => {
    expect(parseTableState({ "t.page": raw }, SPEC, "t").page).toBe(expected);
  });

  // Mutation caught: no length cap, which lets a 100KB query string reach the
  // filter loop and the rendered chip.
  it("caps free text at 64 characters", () => {
    const long = "x".repeat(500);
    expect(parseTableState({ "t.q": long }, SPEC, "t").search).toHaveLength(64);
    expect(parseTableState({ "t.symbol": long }, SPEC, "t").filters.symbol).toHaveLength(64);
  });

  // Mutation caught: ignoring the prefix, which would make the orders table
  // read the trades table's parameters.
  it("reads only its own prefix", () => {
    const params = { "t.sort": "profit_asc", "o.sort": "closed_asc", "t.symbol": "EURUSD" };
    expect(parseTableState(params, SPEC, "o").sort).toBe("closed_asc");
    expect(parseTableState(params, SPEC, "o").filters).toEqual({});
    expect(parseTableState(params, SPEC, "t").filters).toEqual({ symbol: "EURUSD" });
  });

  // Mutation caught: copying every parameter into filters rather than only the
  // declared keys, which would turn `?t.page=2` into a filter on "page".
  it("keeps only declared filter keys", () => {
    const s = parseTableState({ "t.nonsense": "1", "t.outcome": "wins" }, SPEC, "t");
    expect(s.filters).toEqual({ outcome: "wins" });
  });

  it("uses the first declared size as the default", () => {
    expect(parseTableState({}, SPEC, "t").size).toBe(DEFAULT_SIZES[0]);
  });
});

describe("hrefWith", () => {
  // Mutation caught: replacing the whole query string instead of merging,
  // which resets every other table on the page.
  it("preserves parameters it is not changing", () => {
    expect(hrefWith("/a/1/journal", { "t.sort": "profit_asc", "o.page": "2" }, { "t.page": "3" })).toBe(
      "/a/1/journal?o.page=2&t.page=3&t.sort=profit_asc",
    );
  });

  // Mutation caught: writing an empty value instead of removing the key,
  // leaving `?t.symbol=` in every subsequent link.
  it("removes a parameter set to null or empty", () => {
    expect(hrefWith("/a/1/journal", { "t.symbol": "EURUSD" }, { "t.symbol": null })).toBe(
      "/a/1/journal",
    );
    expect(hrefWith("/a/1/journal", { "t.symbol": "EURUSD" }, { "t.symbol": "" })).toBe(
      "/a/1/journal",
    );
  });

  // Mutation caught: string concatenation without encoding, which breaks on
  // any symbol or comment containing & or a space.
  it("encodes keys and values", () => {
    expect(hrefWith("/a/1/journal", {}, { "t.q": "a b&c=d" })).toBe("/a/1/journal?t.q=a%20b%26c%3Dd");
  });

  it("returns the bare path when nothing is left", () => {
    expect(hrefWith("/a/1/calendar", {}, {})).toBe("/a/1/calendar");
  });
});

describe("toggleSort and splitSort", () => {
  // Mutation caught: always returning `_desc`, so a column can never be
  // sorted ascending; or always flipping, so clicking a new column inherits
  // the previous column's direction.
  it("flips only the active column and starts new columns descending", () => {
    expect(toggleSort("closed_desc", "closed")).toBe("closed_asc");
    expect(toggleSort("closed_asc", "closed")).toBe("closed_desc");
    expect(toggleSort("closed_asc", "profit")).toBe("profit_desc");
  });

  // Mutation caught: splitting on the FIRST underscore, which turns
  // "time_setup_desc" into ["time", "setup_desc"] and then defaults to desc
  // for every direction.
  it("splits on the last underscore", () => {
    expect(splitSort("profit_desc")).toEqual(["profit", "desc"]);
    expect(splitSort("time_setup_asc")).toEqual(["time_setup", "asc"]);
    expect(splitSort("garbage")).toEqual(["garbage", "desc"]);
  });
});

describe("paginate", () => {
  const rows = Array.from({ length: 9 }, (_, i) => i + 1);
  const state = { page: 1, size: 4, sort: "x_desc", search: "", filters: {} };

  it("slices the requested page and reports the count", () => {
    expect(paginate(rows, { ...state, page: 2 })).toEqual({
      rows: [5, 6, 7, 8],
      total: 9,
      page: 2,
      pageCount: 3,
    });
    expect(paginate(rows, { ...state, page: 3 }).rows).toEqual([9]);
  });

  // Mutation caught: no clamp, so a bookmark to page 9 renders an empty table
  // with no explanation.
  it("clamps a page beyond the end back to the last page", () => {
    expect(paginate(rows, { ...state, page: 99 })).toEqual({
      rows: [9],
      total: 9,
      page: 3,
      pageCount: 3,
    });
  });

  // Mutation caught: pageCount 0 for an empty table, which renders "Page 1 of 0".
  it("reports one page for an empty table", () => {
    expect(paginate([], state)).toEqual({ rows: [], total: 0, page: 1, pageCount: 1 });
  });
});
```

- [ ] **Step 3: Create `lib/compound/journal/trade-filters.ts`**

```typescript
/**
 * Filtering, sorting and pagination for the closed-trades table.
 *
 * The summary is computed over the FILTERED set and before pagination, so the
 * line above the table describes what the filter selected rather than what
 * happens to be on the current page.
 *
 * Money comparisons use cmpBig rather than subtraction. A comparator must
 * return a number, and `Number(a - b)` on two cent values a long way apart
 * loses precision above 2^53 — the same failure spec section 4 forbids
 * everywhere else, arriving through a sort.
 */
import type { Cents } from "@/lib/compound/engine/money";
import { dealNetCents, type ClosedDeal } from "@/lib/compound/reconcile/types";
import type { DedupedDeals } from "./history";
import { paginate, splitSort, type Paged, type TableSpec, type TableState } from "./table-state";

export const TRADE_SPEC: TableSpec = {
  sorts: [
    "closed_desc", "closed_asc",
    "symbol_desc", "symbol_asc",
    "side_desc", "side_asc",
    "vol_desc", "vol_asc",
    "profit_desc", "profit_asc",
    "ticket_desc", "ticket_asc",
  ],
  defaultSort: "closed_desc",
  filterKeys: ["outcome", "symbol", "side"],
};

export interface TradeSummary {
  count: number;
  /** profit + swap + commission over the filtered set. */
  netCents: Cents;
  /** profit only. */
  grossCents: Cents;
  wins: number;
  losses: number;
}

export interface TradeFilterResult extends Paged<ClosedDeal> {
  summary: TradeSummary;
}

function cmpBig(a: Cents, b: Cents): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function applyTradeFilters(
  input: DedupedDeals,
  state: TableState,
): TradeFilterResult {
  const { outcome, symbol, side } = state.filters;

  let rows: ClosedDeal[] = [...input];
  if (outcome === "wins") rows = rows.filter((d) => d.profitCents > 0n);
  if (outcome === "losses") rows = rows.filter((d) => d.profitCents < 0n);
  if (outcome === "flat") rows = rows.filter((d) => d.profitCents === 0n);
  if (symbol) rows = rows.filter((d) => d.symbol === symbol);
  if (side === "buy" || side === "sell") rows = rows.filter((d) => d.side === side);
  if (state.search !== "") {
    const q = state.search.toLowerCase();
    rows = rows.filter(
      (d) => d.symbol.toLowerCase().includes(q) || String(d.ticket).includes(q),
    );
  }

  const summary: TradeSummary = {
    count: rows.length,
    netCents: rows.reduce<Cents>((a, d) => a + dealNetCents(d), 0n),
    grossCents: rows.reduce<Cents>((a, d) => a + d.profitCents, 0n),
    wins: rows.reduce((a, d) => a + (d.profitCents > 0n ? 1 : 0), 0),
    losses: rows.reduce((a, d) => a + (d.profitCents < 0n ? 1 : 0), 0),
  };

  const [column, dir] = splitSort(state.sort);
  rows.sort((a, b) => {
    let cmp = 0;
    switch (column) {
      case "closed": cmp = cmpStr(a.closeTime, b.closeTime); break;
      case "symbol": cmp = cmpStr(a.symbol, b.symbol); break;
      case "side":   cmp = cmpStr(a.side, b.side); break;
      case "vol":    cmp = a.volumeMilliLots - b.volumeMilliLots; break;
      case "profit": cmp = cmpBig(a.profitCents, b.profitCents); break;
      default:       cmp = 0;
    }
    // Ticket breaks every tie, so the order does not depend on what the
    // database returned or on whether Array.sort happened to be stable.
    if (cmp === 0) cmp = a.ticket - b.ticket;
    return dir === "asc" ? cmp : -cmp;
  });

  return { ...paginate(rows, state), summary };
}

/** Distinct symbols in the history, for the filter bar. Sorted. */
export function symbolsOf(input: DedupedDeals): string[] {
  return [...new Set(input.map((d) => d.symbol))].sort();
}
```

- [ ] **Step 4: Create `lib/compound/journal/trade-filters.test.ts`**

```typescript
import { applyTradeFilters, symbolsOf, TRADE_SPEC } from "./trade-filters";
import { parseTableState, type TableState } from "./table-state";
import { buildTradeHistory } from "./history";
import { FIXTURE_OFFSET_HOURS, RAW_DEALS, fixtureHistory } from "./__fixtures__/deals";

const DEALS = fixtureHistory().deals;
const state = (params: Record<string, string> = {}, extra: Partial<TableState> = {}): TableState => ({
  ...parseTableState(params, TRADE_SPEC),
  ...extra,
});

describe("applyTradeFilters", () => {
  it("defaults to newest first and returns every trade", () => {
    const r = applyTradeFilters(DEALS, state());
    expect(r.rows.map((d) => d.ticket)).toEqual([
      5009, 5008, 5007, 5006, 5005, 5004, 5003, 5002, 5001,
    ]);
    expect(r.total).toBe(9);
  });

  // Mutation caught: computing the summary after pagination, which would make
  // the line above the table describe the visible page rather than the filter.
  it("summarises the whole filtered set, not the visible page", () => {
    const r = applyTradeFilters(DEALS, state({}, { size: 4, page: 2 }));
    expect(r.rows).toHaveLength(4);
    expect(r.summary.count).toBe(9);
    expect(r.summary.netCents).toBe(3163n);
    expect(r.summary.grossCents).toBe(3458n);
  });

  // Mutation caught: filtering on net rather than gross, which reclassifies
  // ticket 5009 (gross +5, net -26).
  it("filters wins on gross profit", () => {
    const r = applyTradeFilters(DEALS, state({ outcome: "wins" }));
    expect(r.rows.map((d) => d.ticket).sort()).toEqual([5001, 5003, 5006, 5008, 5009]);
    expect(r.summary.wins).toBe(5);
    expect(r.summary.losses).toBe(0);
    // Five winners, but the fee on 5009 makes the net less than the gross.
    expect(r.summary.grossCents).toBe(6231n);
    expect(r.summary.netCents).toBe(5994n);
  });

  it("filters the flat trade out of both wins and losses", () => {
    expect(applyTradeFilters(DEALS, state({ outcome: "flat" })).total).toBe(1);
    expect(applyTradeFilters(DEALS, state({ outcome: "losses" })).total).toBe(3);
  });

  it("filters by symbol and by side, and summarises what is left", () => {
    const eur = applyTradeFilters(DEALS, state({ symbol: "EURUSD" }));
    expect(eur.total).toBe(4);
    expect(eur.summary.netCents).toBe(736n);
    expect(eur.summary.grossCents).toBe(833n);
    expect(applyTradeFilters(DEALS, state({ side: "sell" })).total).toBe(5);
  });

  // Mutation caught: a case-sensitive search, which is what a user typing
  // "xau" would hit first.
  it("searches symbol case-insensitively and ticket as a substring", () => {
    expect(applyTradeFilters(DEALS, state({ q: "xau" })).total).toBe(2);
    expect(applyTradeFilters(DEALS, state({ q: "5003" })).total).toBe(1);
    expect(applyTradeFilters(DEALS, state({ q: "500" })).total).toBe(9);
  });

  // Mutation caught: `Number(a.profitCents - b.profitCents)` in the
  // comparator. It happens to work on small fixtures, which is why the second
  // assertion uses values either side of 2^53.
  it("sorts by profit exactly, including beyond the safe integer range", () => {
    const r = applyTradeFilters(DEALS, state({ sort: "profit_desc" }));
    expect(r.rows.map((d) => d.ticket)).toEqual([
      5003, 5008, 5001, 5006, 5009, 5005, 5002, 5007, 5004,
    ]);

    const huge = buildTradeHistory(
      [
        { ...RAW_DEALS[0]!, ticket: 6001, profitCents: 9_007_199_254_740_993n },
        { ...RAW_DEALS[0]!, ticket: 6002, profitCents: 9_007_199_254_740_992n },
      ],
      FIXTURE_OFFSET_HOURS,
    );
    const big = applyTradeFilters(huge.deals, state({ sort: "profit_desc" }));
    expect(big.rows.map((d) => d.ticket)).toEqual([6001, 6002]);
  });

  // Mutation caught: no tie-break, leaving the order dependent on input order.
  it("breaks ties on ticket", () => {
    const r = applyTradeFilters(DEALS, state({ sort: "symbol_asc" }));
    expect(r.rows.map((d) => d.ticket)).toEqual([
      5004, 5001, 5002, 5005, 5009, 5003, 5008, 5006, 5007,
    ]);
  });

  // Mutation caught: sorting in place on the caller's array. DedupedDeals is
  // readonly by type, but the runtime array is shared with every other
  // surface on the page.
  it("does not reorder the input", () => {
    const before = DEALS.map((d) => d.ticket);
    applyTradeFilters(DEALS, state({ sort: "profit_asc" }));
    expect(DEALS.map((d) => d.ticket)).toEqual(before);
  });

  it("returns an empty page with a zero summary when nothing matches", () => {
    const r = applyTradeFilters(DEALS, state({ symbol: "NOPE" }));
    expect(r.rows).toEqual([]);
    expect(r.summary).toEqual({ count: 0, netCents: 0n, grossCents: 0n, wins: 0, losses: 0 });
    expect(r.pageCount).toBe(1);
  });
});

describe("symbolsOf", () => {
  it("lists each symbol once, sorted", () => {
    expect(symbolsOf(DEALS)).toEqual(["BTCUSD", "EURUSD", "GBPUSD", "XAUUSD"]);
  });
});
```

- [ ] **Step 5: Create `lib/compound/journal/order-filters.ts`**

```typescript
/**
 * Filtering and sorting for the orders and open-positions tables.
 *
 * classifyOrderState buckets MT5's six order states into the four a person
 * cares about. Rejected and expired join canceled because the distinction
 * matters to a post-mortem and not to a filter; the raw state is still shown
 * in the row, so nothing is lost.
 */
import type { Cents } from "@/lib/compound/engine/money";
import type { OpenPosition, OrderRow } from "./rows";
import { paginate, splitSort, type Paged, type TableSpec, type TableState } from "./table-state";

export type StateBucket = "filled" | "canceled" | "partial" | "open" | "other";

export function classifyOrderState(raw: string): StateBucket {
  if (raw === "order_state_filled") return "filled";
  if (
    raw === "order_state_canceled" ||
    raw === "order_state_expired" ||
    raw === "order_state_rejected"
  ) {
    return "canceled";
  }
  if (raw === "order_state_partial") return "partial";
  if (raw === "order_state_placed") return "open";
  return "other";
}

export const ORDER_SPEC: TableSpec = {
  sorts: [
    "setup_desc", "setup_asc",
    "symbol_desc", "symbol_asc",
    "type_desc", "type_asc",
    "state_desc", "state_asc",
    "ticket_desc", "ticket_asc",
  ],
  defaultSort: "setup_desc",
  filterKeys: ["state", "type", "symbol"],
};

export const POSITION_SPEC: TableSpec = {
  sorts: [
    "opened_desc", "opened_asc",
    "symbol_desc", "symbol_asc",
    "profit_desc", "profit_asc",
    "ticket_desc", "ticket_asc",
  ],
  defaultSort: "opened_desc",
  filterKeys: [],
  sizes: [100],
};

export interface OrderSummary {
  count: number;
  filled: number;
  canceled: number;
  open: number;
}

export interface OrderFilterResult extends Paged<OrderRow> {
  summary: OrderSummary;
}

export interface PositionSummary {
  count: number;
  /** Floating P/L across the open book, fees included. */
  floatingCents: Cents;
  longs: number;
  shorts: number;
}

export interface PositionResult extends Paged<OpenPosition> {
  summary: PositionSummary;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpBig(a: Cents, b: Cents): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function applyOrderFilters(
  input: readonly OrderRow[],
  state: TableState,
): OrderFilterResult {
  const { state: bucket, type, symbol } = state.filters;

  let rows = [...input];
  if (bucket) rows = rows.filter((o) => classifyOrderState(o.state) === bucket);
  if (type) rows = rows.filter((o) => o.type === type);
  if (symbol) rows = rows.filter((o) => o.symbol === symbol);
  if (state.search !== "") {
    const q = state.search.toLowerCase();
    rows = rows.filter(
      (o) => o.symbol.toLowerCase().includes(q) || String(o.ticket).includes(q),
    );
  }

  const summary: OrderSummary = {
    count: rows.length,
    filled: rows.filter((o) => classifyOrderState(o.state) === "filled").length,
    canceled: rows.filter((o) => classifyOrderState(o.state) === "canceled").length,
    open: rows.filter((o) => classifyOrderState(o.state) === "open").length,
  };

  const [column, dir] = splitSort(state.sort);
  rows.sort((a, b) => {
    let cmp = 0;
    switch (column) {
      case "setup":  cmp = cmpStr(a.timeSetup, b.timeSetup); break;
      case "symbol": cmp = cmpStr(a.symbol, b.symbol); break;
      case "type":   cmp = cmpStr(a.type, b.type); break;
      case "state":  cmp = cmpStr(a.state, b.state); break;
      default:       cmp = 0;
    }
    if (cmp === 0) cmp = a.ticket - b.ticket;
    return dir === "asc" ? cmp : -cmp;
  });

  return { ...paginate(rows, state), summary };
}

export function applyPositionSort(
  input: readonly OpenPosition[],
  state: TableState,
): PositionResult {
  const rows = [...input];
  const summary: PositionSummary = {
    count: rows.length,
    floatingCents: rows.reduce<Cents>(
      (a, p) => a + p.profitCents + p.swapCents + p.commissionCents,
      0n,
    ),
    longs: rows.filter((p) => p.side === "buy").length,
    shorts: rows.filter((p) => p.side === "sell").length,
  };

  const [column, dir] = splitSort(state.sort);
  rows.sort((a, b) => {
    let cmp = 0;
    switch (column) {
      case "opened": cmp = cmpStr(a.openTime, b.openTime); break;
      case "symbol": cmp = cmpStr(a.symbol, b.symbol); break;
      case "profit": cmp = cmpBig(a.profitCents, b.profitCents); break;
      default:       cmp = 0;
    }
    if (cmp === 0) cmp = a.ticket - b.ticket;
    return dir === "asc" ? cmp : -cmp;
  });

  return { ...paginate(rows, state), summary };
}
```

- [ ] **Step 6: Create `lib/compound/journal/order-display.ts`**

```typescript
/**
 * MT5 constants to labels and tone variants. Ported unchanged in substance
 * from the upstream module: it has no money in it, no I/O, and it has been
 * right for a year.
 *
 * The fallback title-cases an unrecognised constant instead of throwing or
 * echoing it raw. MT5 gains order types between builds, and a journal that
 * renders "Order Type Sell Stop Limit Whatever" is usable while one that
 * renders "order_type_..." or crashes is not.
 */
export type OrderSideVariant = "buy" | "sell" | "neutral";
export type OrderStateVariant = "ok" | "warn" | "bad" | "info" | "neutral";

export interface OrderTypeDisplay {
  label: string;
  variant: OrderSideVariant;
  /** Pending orders render outlined; market orders render solid. */
  outline: boolean;
}

export interface OrderStateDisplay {
  label: string;
  variant: OrderStateVariant;
}

const TYPE_MAP: Readonly<Record<string, OrderTypeDisplay>> = {
  order_type_buy: { label: "Buy", variant: "buy", outline: false },
  order_type_sell: { label: "Sell", variant: "sell", outline: false },
  order_type_buy_limit: { label: "Buy Limit", variant: "buy", outline: true },
  order_type_sell_limit: { label: "Sell Limit", variant: "sell", outline: true },
  order_type_buy_stop: { label: "Buy Stop", variant: "buy", outline: true },
  order_type_sell_stop: { label: "Sell Stop", variant: "sell", outline: true },
  order_type_buy_stop_limit: { label: "Buy Stop Limit", variant: "buy", outline: true },
  order_type_sell_stop_limit: { label: "Sell Stop Limit", variant: "sell", outline: true },
  order_type_close_by: { label: "Close By", variant: "neutral", outline: false },
};

const STATE_MAP: Readonly<Record<string, OrderStateDisplay>> = {
  order_state_filled: { label: "Filled", variant: "ok" },
  order_state_canceled: { label: "Canceled", variant: "neutral" },
  order_state_partial: { label: "Partial", variant: "warn" },
  order_state_placed: { label: "Pending", variant: "info" },
  order_state_rejected: { label: "Rejected", variant: "bad" },
  order_state_expired: { label: "Expired", variant: "neutral" },
};

function titleCase(value: string): string {
  return value
    .replace(/^order_(type|state)_/, "")
    .split("_")
    .filter((w) => w !== "")
    .map((w) => `${w[0]!.toUpperCase()}${w.slice(1).toLowerCase()}`)
    .join(" ");
}

export function humanizeOrderType(raw: string): OrderTypeDisplay {
  return TYPE_MAP[raw] ?? { label: titleCase(raw), variant: "neutral", outline: false };
}

export function humanizeOrderState(raw: string): OrderStateDisplay {
  return STATE_MAP[raw] ?? { label: titleCase(raw), variant: "neutral" };
}
```

- [ ] **Step 7: Create the two remaining test files**

`lib/compound/journal/order-filters.test.ts`:

```typescript
import {
  applyOrderFilters,
  applyPositionSort,
  classifyOrderState,
  ORDER_SPEC,
  POSITION_SPEC,
} from "./order-filters";
import { parseTableState } from "./table-state";
import type { OpenPosition, OrderRow } from "./rows";

const O = (ticket: number, symbol: string, type: string, stateRaw: string, setup: string): OrderRow => ({
  ticket,
  symbol,
  type,
  state: stateRaw,
  volumeInitialMilliLots: 50,
  volumeCurrentMilliLots: 0,
  priceOpen: "1.09341",
  priceCurrent: null,
  slPrice: null,
  tpPrice: null,
  timeSetup: setup,
  timeDone: null,
  comment: null,
});

const ORDERS: OrderRow[] = [
  O(7702, "XAUUSD", "order_type_sell_limit", "order_state_placed", "2026-05-09T08:00:00.000Z"),
  O(7701, "EURUSD", "order_type_buy", "order_state_filled", "2026-05-08T06:59:00.000Z"),
  O(7704, "EURUSD", "order_type_buy", "order_state_rejected", "2026-05-08T06:59:00.000Z"),
  O(7703, "BTCUSD", "order_type_buy_stop", "order_state_expired", "2026-05-10T23:45:00.000Z"),
];

const P = (ticket: number, symbol: string, side: "buy" | "sell", profit: bigint, opened: string): OpenPosition => ({
  ticket,
  symbol,
  side,
  volumeMilliLots: 50,
  openPrice: "1.09341",
  currentPrice: "1.09507",
  slPrice: null,
  tpPrice: null,
  profitCents: profit,
  swapCents: -205n,
  commissionCents: -29n,
  openTime: opened,
  comment: null,
});

const POSITIONS: OpenPosition[] = [
  P(8802, "XAUUSD", "sell", -2940n, "2026-05-08T09:15:00.000Z"),
  P(8801, "EURUSD", "buy", 8300n, "2026-05-08T07:00:00.000Z"),
];

describe("classifyOrderState", () => {
  // Mutation caught: bucketing rejected or expired as "other", which drops
  // them out of the Canceled filter and makes the summary understate.
  it.each([
    ["order_state_filled", "filled"],
    ["order_state_canceled", "canceled"],
    ["order_state_expired", "canceled"],
    ["order_state_rejected", "canceled"],
    ["order_state_partial", "partial"],
    ["order_state_placed", "open"],
    ["order_state_something_new", "other"],
  ])("buckets %s as %s", (raw, bucket) => {
    expect(classifyOrderState(raw)).toBe(bucket);
  });
});

describe("applyOrderFilters", () => {
  const st = (p: Record<string, string> = {}) => parseTableState(p, ORDER_SPEC);

  it("defaults to newest setup first, ties broken on ticket", () => {
    const r = applyOrderFilters(ORDERS, st());
    expect(r.rows.map((o) => o.ticket)).toEqual([7703, 7702, 7704, 7701]);
  });

  it("filters by bucket and counts three groups", () => {
    const r = applyOrderFilters(ORDERS, st({ state: "canceled" }));
    expect(r.rows.map((o) => o.ticket).sort()).toEqual([7703, 7704]);
    const all = applyOrderFilters(ORDERS, st());
    expect(all.summary).toEqual({ count: 4, filled: 1, canceled: 2, open: 1 });
  });

  it("filters by exact type and by symbol", () => {
    expect(applyOrderFilters(ORDERS, st({ type: "order_type_buy" })).total).toBe(2);
    expect(applyOrderFilters(ORDERS, st({ symbol: "EURUSD" })).total).toBe(2);
  });

  it("does not reorder the input", () => {
    const before = ORDERS.map((o) => o.ticket);
    applyOrderFilters(ORDERS, st({ sort: "symbol_asc" }));
    expect(ORDERS.map((o) => o.ticket)).toEqual(before);
  });
});

describe("applyPositionSort", () => {
  const st = (p: Record<string, string> = {}) => parseTableState(p, POSITION_SPEC);

  // Mutation caught: summing profitCents alone. Two positions carrying -205
  // swap and -29 commission each make the difference 468 cents.
  it("sums floating P/L including swap and commission", () => {
    const r = applyPositionSort(POSITIONS, st());
    expect(r.summary.floatingCents).toBe(4892n);
    expect(r.summary.longs).toBe(1);
    expect(r.summary.shorts).toBe(1);
  });

  it("sorts by profit exactly", () => {
    const r = applyPositionSort(POSITIONS, st({ sort: "profit_asc" }));
    expect(r.rows.map((p) => p.ticket)).toEqual([8802, 8801]);
  });

  it("defaults to newest open first", () => {
    expect(applyPositionSort(POSITIONS, st()).rows.map((p) => p.ticket)).toEqual([8802, 8801]);
  });
});
```

`lib/compound/journal/order-display.test.ts`:

```typescript
import { humanizeOrderState, humanizeOrderType } from "./order-display";

describe("humanizeOrderType", () => {
  it("labels a market order solid and a pending order outlined", () => {
    expect(humanizeOrderType("order_type_buy")).toEqual({
      label: "Buy",
      variant: "buy",
      outline: false,
    });
    expect(humanizeOrderType("order_type_sell_stop_limit")).toEqual({
      label: "Sell Stop Limit",
      variant: "sell",
      outline: true,
    });
  });

  // Mutation caught: throwing or echoing the raw constant. MT5 adds order
  // types between builds and a journal must survive one it has not seen.
  it("title-cases an unknown constant instead of failing", () => {
    expect(humanizeOrderType("order_type_future_thing")).toEqual({
      label: "Future Thing",
      variant: "neutral",
      outline: false,
    });
    expect(humanizeOrderState("order_state_who_knows").label).toBe("Who Knows");
  });

  // Mutation caught: `Object.prototype` lookup leaking through the map. A raw
  // value of "constructor" must not return a function.
  it("does not resolve a prototype key", () => {
    expect(humanizeOrderType("constructor").label).toBe("Constructor");
    expect(humanizeOrderState("toString").variant).toBe("neutral");
  });
});

describe("humanizeOrderState", () => {
  it.each([
    ["order_state_filled", "Filled", "ok"],
    ["order_state_placed", "Pending", "info"],
    ["order_state_rejected", "Rejected", "bad"],
    ["order_state_partial", "Partial", "warn"],
  ])("maps %s to %s", (raw, label, variant) => {
    expect(humanizeOrderState(raw)).toEqual({ label, variant });
  });
});
```

- [ ] **Step 8: Extend the purity module list**

Add `"order-display.ts"`, `"order-filters.ts"`, `"table-state.ts"` and `"trade-filters.ts"` to the array in `purity.test.ts`, keeping it alphabetical. Twelve entries.

- [ ] **Step 9: Run the gates**

```bash
pnpm typecheck && pnpm test -- lib/compound/journal
```

- [ ] **Step 10: Prove these tests bite**

1. **Accept any `sort` value.** Expected red: all three `"falls back on"` cases.
2. **Drop the size allowlist** and use `parseInt` directly. Expected red: three of the four `"handles"` cases.
3. **Ignore the prefix** in `parseTableState`. Expected red: `"reads only its own prefix"`.
4. **Replace the query string in `hrefWith`** instead of merging. Expected red: `"preserves parameters it is not changing"`.
5. **Split the sort on the first underscore.** Expected red: `"splits on the last underscore"`, and — record whether it also reddens the orders table's `"defaults to newest setup first"`, since `setup_desc` has only one underscore and may survive.
6. **Compute the trade summary after `paginate`.** Expected red: `"summarises the whole filtered set, not the visible page"`.
7. **Use `Number(a.profitCents - b.profitCents)` as the comparator.** Expected red: the second half of `"sorts by profit exactly"` — the two values either side of 2^53 compare equal. Record that the first half stays green; a small fixture cannot detect this.
8. **Remove the ticket tie-break from `applyTradeFilters`.** Expected red: `"breaks ties on ticket"`. If it stays green because `Array.sort` was stable for this input, add a fifth EURUSD deal until it discriminates, and record that you did.
9. **Sum `profitCents` alone in `applyPositionSort`.** Expected red: `"sums floating P/L including swap and commission"`.
10. **Filter wins on `dealNetCents`.** Expected red: `"filters wins on gross profit"`.

- [ ] **Step 11: Commit**

```bash
git add lib/compound/journal/table-state.ts lib/compound/journal/table-state.test.ts \
        lib/compound/journal/trade-filters.ts lib/compound/journal/trade-filters.test.ts \
        lib/compound/journal/order-filters.ts lib/compound/journal/order-filters.test.ts \
        lib/compound/journal/order-display.ts lib/compound/journal/order-display.test.ts \
        lib/compound/journal/purity.test.ts
git commit -m "feat(journal): URL-driven table state, filters, and order display"
```

---

### Task 9: `present/figures.ts` and the shared table chrome

The boundary where a `bigint` becomes something a person reads, and the four server components every table on these pages is built from.

> **Coordinate with plan 4 before writing `figures.ts`.** Plan 4 also owns `lib/compound/present/`. If it has already shipped a money formatter there, **use it and delete this module** — two money formatters is exactly the defect this plan exists to prevent, arriving through the presentation layer instead of through the accounting one. Whichever plan lands first owns the file; the second reconciles. What must not happen is `formatMoney` in one and `money` in the other, rounding differently.

**Files:**
- Create: `lib/compound/present/figures.ts`
- Create: `lib/compound/present/figures.test.ts`
- Create: `lib/compound/ui/journal/sort-header.tsx`
- Create: `lib/compound/ui/journal/pager.tsx`
- Create: `lib/compound/ui/journal/filter-bar.tsx`
- Create: `lib/compound/ui/journal/chrome.test.tsx`
- Modify: `app/globals.css` — the `.filters` family

**Interfaces:**
- Consumes: `Cents` from `@/lib/compound/engine/money`; `formatCents` from the same; `hrefWith`, `toggleSort`, `splitSort`, `Params`, `TableState` from `@/lib/compound/journal/table-state`
- Produces:
  - `MINUS`, `money`, `signedMoney`, `pctFromBps`, `ratioFromMilli`, `lots`, `utcStamp`, `utcDate`, `toneOf`
  - `<SortHeader />`, `<Pager />`, `<FilterBar />`

- [ ] **Step 1: Create `lib/compound/present/figures.ts`**

```typescript
/**
 * Cents to strings. The only place a money value is turned into something a
 * person reads, and it never stops being an integer on the way.
 *
 * Intl.NumberFormat is deliberately not used. It takes a `number`, so calling
 * it on a cent value means dividing by 100 into a float first — which is the
 * side door spec section 4 closes. Grouping three digits at a time is a regex
 * over a string that formatCents already produced exactly.
 *
 * The minus sign is U+2212, not a hyphen. It aligns with a digit in a tabular
 * mono face; a hyphen does not, and spec section 8.3 requires that columns of
 * money never shift width.
 */
import { formatCents, type Cents } from "@/lib/compound/engine/money";

export const MINUS = "−";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Magnitude only: "12,630.61". No sign, no currency symbol. */
export function money(c: Cents): string {
  const abs = c < 0n ? -c : c;
  const [whole, frac] = formatCents(abs).split(".") as [string, string];
  return `${group(whole)}.${frac}`;
}

/** "+1,237.00", "−409.00", "0.00". */
export function signedMoney(c: Cents): string {
  if (c === 0n) return "0.00";
  return `${c > 0n ? "+" : MINUS}${money(c)}`;
}

/** Basis points to a percentage: 5555 becomes "55.55%". */
export function pctFromBps(bps: number): string {
  if (!Number.isInteger(bps)) throw new RangeError(`bps must be an integer, got ${bps}`);
  const neg = bps < 0;
  const abs = neg ? -bps : bps;
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  return `${neg ? MINUS : ""}${whole}.${frac < 10 ? "0" : ""}${frac}%`;
}

/** Thousandths to a ratio: 2247n becomes "2.247". Null becomes an em dash. */
export function ratioFromMilli(milli: bigint | null): string {
  if (milli === null) return "—";
  const neg = milli < 0n;
  const abs = neg ? -milli : milli;
  const frac = (abs % 1_000n).toString().padStart(3, "0");
  return `${neg ? MINUS : ""}${group((abs / 1_000n).toString())}.${frac}`;
}

/** Milli-lots to lots: 50 becomes "0.05", 1200 becomes "1.20". */
export function lots(milliLots: number): string {
  if (!Number.isInteger(milliLots) || milliLots < 0) {
    throw new RangeError(`milliLots must be a non-negative integer, got ${milliLots}`);
  }
  const whole = Math.trunc(milliLots / 1000);
  const frac = (milliLots % 1000).toString().padStart(3, "0").slice(0, 2);
  return `${whole}.${frac}`;
}

/**
 * "2026-05-08 14:15" from an ISO instant.
 *
 * Requires the trailing Z. Every timestamp in this product is rendered by
 * db/sql.ts's utcIsoExpr and arrives as UTC; slicing a string carrying a
 * different offset would print a local wall-clock time labelled as UTC, and
 * nothing downstream could tell.
 */
export function utcStamp(iso: string): string {
  if (!iso.endsWith("Z")) {
    throw new RangeError(`expected a UTC instant ending in Z, got ${JSON.stringify(iso)}`);
  }
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** "8 May 2026" from a YYYY-MM-DD key. */
export function utcDate(dateKey: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) throw new RangeError(`not a date key: ${JSON.stringify(dateKey)}`);
  const month = MONTHS[Number.parseInt(m[2]!, 10) - 1];
  if (month === undefined) throw new RangeError(`month out of range: ${dateKey}`);
  return `${Number.parseInt(m[3]!, 10)} ${month} ${m[1]}`;
}

/** The existing globals.css utility class for a P/L sign. */
export function toneOf(c: Cents): "pos" | "neg" | "" {
  return c > 0n ? "pos" : c < 0n ? "neg" : "";
}
```

- [ ] **Step 2: Create `lib/compound/present/figures.test.ts`**

```typescript
import {
  MINUS,
  lots,
  money,
  pctFromBps,
  ratioFromMilli,
  signedMoney,
  toneOf,
  utcDate,
  utcStamp,
} from "./figures";

describe("money", () => {
  // Mutation caught: dividing by 100 into a float. 9007199254740993n cannot
  // survive that trip, and the assertion names the exact string it must give.
  it("groups thousands and never loses a cent", () => {
    expect(money(1_263_061n)).toBe("12,630.61");
    expect(money(7n)).toBe("0.07");
    expect(money(100_000n)).toBe("1,000.00");
    expect(money(-409n)).toBe("4.09");
    expect(money(9_007_199_254_740_993n)).toBe("90,071,992,547,409.93");
  });

  // Mutation caught: `\B(?=(\d{3})+)` without the negative lookahead, which
  // inserts a comma inside the decimal part.
  it("does not group the decimal part", () => {
    expect(money(123_456_789n)).toBe("1,234,567.89");
  });
});

describe("signedMoney", () => {
  // Mutation caught: using a hyphen. Spec section 8.3 needs a glyph that is
  // digit-width in the mono face.
  it("uses a real minus sign and no sign at zero", () => {
    expect(signedMoney(1237n)).toBe("+12.37");
    expect(signedMoney(-409n)).toBe(`${MINUS}4.09`);
    expect(signedMoney(0n)).toBe("0.00");
    expect(MINUS).toBe("−");
    expect(signedMoney(-409n)).not.toContain("-");
  });
});

describe("pctFromBps", () => {
  // Mutation caught: `(bps / 100).toFixed(2)`, which is a float path and
  // renders 5555 as "55.55" by luck and 1 as "0.01" by luck, but is banned.
  it("renders basis points with two decimals", () => {
    expect(pctFromBps(5555)).toBe("55.55%");
    expect(pctFromBps(10_000)).toBe("100.00%");
    expect(pctFromBps(1)).toBe("0.01%");
    expect(pctFromBps(0)).toBe("0.00%");
    expect(pctFromBps(-250)).toBe(`${MINUS}2.50%`);
  });

  // Mutation caught: no zero-pad, which renders 5505 as "55.5%".
  it("zero-pads a single-digit remainder", () => {
    expect(pctFromBps(5505)).toBe("55.05%");
  });

  it("rejects a fractional value rather than rounding it silently", () => {
    expect(() => pctFromBps(55.5)).toThrow(/integer/);
  });
});

describe("ratioFromMilli", () => {
  it("renders thousandths and an em dash for null", () => {
    expect(ratioFromMilli(2247n)).toBe("2.247");
    expect(ratioFromMilli(20n)).toBe("0.020");
    expect(ratioFromMilli(1_000_000n)).toBe("1,000.000");
    expect(ratioFromMilli(null)).toBe("—");
  });
});

describe("lots", () => {
  it("renders milli-lots as two decimals", () => {
    expect(lots(50)).toBe("0.05");
    expect(lots(1200)).toBe("1.20");
    expect(lots(0)).toBe("0.00");
    expect(lots(120)).toBe("0.12");
  });

  it("rejects a fractional milli-lot", () => {
    expect(() => lots(50.5)).toThrow(/integer/);
  });
});

describe("utcStamp and utcDate", () => {
  it("slices a UTC instant to date and minute", () => {
    expect(utcStamp("2026-05-08T14:15:00.000Z")).toBe("2026-05-08 14:15");
  });

  // Mutation caught: dropping the Z guard, which would print "2026-05-08
  // 23:30" for a +03:00 timestamp whose UTC time is 20:30 — a wall clock in
  // the wrong zone with nothing on screen to say so.
  it("refuses a timestamp that is not UTC", () => {
    expect(() => utcStamp("2026-05-08T23:30:00+03:00")).toThrow(/ending in Z/);
    expect(() => utcStamp("2026-05-08 14:15:00")).toThrow(/ending in Z/);
  });

  it("renders a date key without a leading zero on the day", () => {
    expect(utcDate("2026-05-08")).toBe("8 May 2026");
    expect(utcDate("2026-12-25")).toBe("25 Dec 2026");
    expect(() => utcDate("2026-13-01")).toThrow(/out of range/);
    expect(() => utcDate("8 May 2026")).toThrow(/not a date key/);
  });
});

describe("toneOf", () => {
  it("returns the existing utility classes, and nothing at zero", () => {
    expect(toneOf(1n)).toBe("pos");
    expect(toneOf(-1n)).toBe("neg");
    expect(toneOf(0n)).toBe("");
  });
});
```

- [ ] **Step 3: Create the three chrome components**

`lib/compound/ui/journal/sort-header.tsx`:

```tsx
/**
 * A sortable column header. A link, not a button — there is no client
 * JavaScript on these pages, so the sort is a navigation.
 *
 * aria-sort is set on the th so a screen reader announces the current sort;
 * spec section 8.4 forbids colour or a glyph being the sole carrier.
 */
import { hrefWith, splitSort, toggleSort, type Params } from "@/lib/compound/journal/table-state";

export function SortHeader({
  label,
  column,
  sort,
  prefix,
  basePath,
  params,
  numeric = false,
}: {
  label: string;
  column: string;
  sort: string;
  prefix: string;
  basePath: string;
  params: Params;
  numeric?: boolean;
}) {
  const [active, dir] = splitSort(sort);
  const isActive = active === column;
  const next = toggleSort(sort, column);
  const href = hrefWith(basePath, params, {
    [`${prefix}.sort`]: next,
    // Any change to the ordering invalidates the page number.
    [`${prefix}.page`]: null,
  });
  const ariaSort = isActive ? (dir === "asc" ? "ascending" : "descending") : "none";
  return (
    <th scope="col" aria-sort={ariaSort} style={numeric ? undefined : { textAlign: "left" }}>
      <a href={href} className="sortlink">
        {label}
        <span aria-hidden="true">{isActive ? (dir === "asc" ? " ↑" : " ↓") : ""}</span>
      </a>
    </th>
  );
}
```

`lib/compound/ui/journal/pager.tsx`:

```tsx
import { hrefWith, type Params } from "@/lib/compound/journal/table-state";

export function Pager({
  page,
  pageCount,
  total,
  prefix,
  basePath,
  params,
  noun,
}: {
  page: number;
  pageCount: number;
  total: number;
  prefix: string;
  basePath: string;
  params: Params;
  noun: string;
}) {
  const to = (p: number) => hrefWith(basePath, params, { [`${prefix}.page`]: String(p) });
  return (
    <nav className="filters-pager" aria-label={`${noun} pagination`}>
      <span className="num">
        {total} {noun}
        {total === 1 ? "" : "s"} · page {page} of {pageCount}
      </span>
      {page > 1 ? (
        <a className="btn" href={to(page - 1)} rel="prev">
          Previous
        </a>
      ) : (
        <span className="btn" aria-disabled="true">
          Previous
        </span>
      )}
      {page < pageCount ? (
        <a className="btn" href={to(page + 1)} rel="next">
          Next
        </a>
      ) : (
        <span className="btn" aria-disabled="true">
          Next
        </span>
      )}
    </nav>
  );
}
```

`lib/compound/ui/journal/filter-bar.tsx`:

```tsx
/**
 * Filter chips and a search box. Every control is a link or a GET form, so
 * the whole table state stays in the URL and the page never hydrates.
 *
 * Hidden inputs carry every other parameter through the form, which is what
 * stops searching the trades table from resetting the orders table.
 */
import { hrefWith, type Params } from "@/lib/compound/journal/table-state";

export interface ChipGroup {
  /** The parameter name, without the prefix. */
  name: string;
  label: string;
  options: readonly { value: string; label: string }[];
}

export function FilterBar({
  groups,
  active,
  search,
  prefix,
  basePath,
  params,
}: {
  groups: readonly ChipGroup[];
  active: Readonly<Record<string, string>>;
  search: string;
  prefix: string;
  basePath: string;
  params: Params;
}) {
  const key = (name: string) => `${prefix}.${name}`;
  const anyActive = Object.keys(active).length > 0 || search !== "";
  const clearPatch: Record<string, string | null> = { [`${prefix}.page`]: null, [`${prefix}.q`]: null };
  for (const g of groups) clearPatch[key(g.name)] = null;

  return (
    <div className="filters">
      {groups.map((g) => (
        <div className="filters-group" key={g.name} role="group" aria-label={g.label}>
          <span className="filters-label">{g.label}</span>
          {g.options.map((o) => {
            const on = active[g.name] === o.value;
            const href = hrefWith(basePath, params, {
              [key(g.name)]: on ? null : o.value,
              [`${prefix}.page`]: null,
            });
            return (
              <a
                key={o.value}
                className={`chip${on ? " chip-on" : ""}`}
                href={href}
                aria-pressed={on}
              >
                {o.label}
              </a>
            );
          })}
        </div>
      ))}

      <form className="filters-search" method="get" action={basePath}>
        {Object.entries(params)
          .filter(([k, v]) => v !== undefined && v !== "" && k !== `${prefix}.q` && k !== `${prefix}.page`)
          .map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
        <label className="filters-label" htmlFor={`${prefix}-q`}>
          Search
        </label>
        <input
          id={`${prefix}-q`}
          className="field"
          type="search"
          name={`${prefix}.q`}
          defaultValue={search}
          placeholder="Symbol or ticket"
        />
        <button className="btn" type="submit">
          Apply
        </button>
      </form>

      {anyActive ? (
        <a className="btn" href={hrefWith(basePath, params, clearPatch)}>
          Clear
        </a>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Add the `.filters` family to `app/globals.css`**

```css
/* Filter bar and pagination. Plan 4 owns .chip, .btn and .field; these are
   the layout around them. */
.filters {
  display: flex; flex-wrap: wrap; align-items: center; gap: 14px;
  padding: 12px 16px; border-bottom: 1px solid var(--rule-soft);
}
.filters-group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.filters-label {
  font-size: 9.5px; text-transform: uppercase; letter-spacing: .14em;
  color: var(--ink-3); font-weight: 600;
}
.filters-search { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.filters-pager {
  display: flex; align-items: center; gap: 10px; justify-content: flex-end;
  padding: 10px 16px; border-top: 1px solid var(--rule-soft);
  font-size: 11.5px; color: var(--ink-2);
}
.filters-pager [aria-disabled="true"] { opacity: .4; pointer-events: none; }
.chip-on { background: var(--ink); color: var(--card); border-color: var(--ink); }
.sortlink { color: inherit; text-decoration: none; }
.sortlink:hover { text-decoration: underline; }
.sortlink:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
@media (max-width: 640px) {
  .filters-search { margin-left: 0; width: 100%; }
}
```

- [ ] **Step 5: Create `lib/compound/ui/journal/chrome.test.tsx`**

`renderToStaticMarkup` needs no DOM, so these run in whichever Jest project picks the file up.

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { FilterBar } from "./filter-bar";
import { Pager } from "./pager";
import { SortHeader } from "./sort-header";

const BASE = "/a/7/journal";

describe("SortHeader", () => {
  const render = (sort: string, column: string, params = {}) =>
    renderToStaticMarkup(
      <table><thead><tr>
        <SortHeader label="Profit" column={column} sort={sort} prefix="t" basePath={BASE} params={params} numeric />
      </tr></thead></table>,
    );

  // Mutation caught: rendering the CURRENT sort in the href, so clicking the
  // active column does nothing.
  it("links to the flipped direction on the active column", () => {
    expect(render("profit_desc", "profit")).toContain("t.sort=profit_asc");
    expect(render("profit_asc", "profit")).toContain("t.sort=profit_desc");
  });

  it("links to descending on an inactive column", () => {
    expect(render("closed_desc", "profit")).toContain("t.sort=profit_desc");
  });

  // Mutation caught: dropping aria-sort, which leaves the arrow glyph as the
  // sole carrier of the sort state — spec section 8.4 forbids that.
  it("announces the sort state to assistive technology", () => {
    expect(render("profit_desc", "profit")).toContain('aria-sort="descending"');
    expect(render("profit_asc", "profit")).toContain('aria-sort="ascending"');
    expect(render("closed_desc", "profit")).toContain('aria-sort="none"');
  });

  // Mutation caught: keeping the page number across a re-sort, which shows
  // page 4 of a differently ordered table.
  it("drops the page number when the sort changes", () => {
    expect(render("profit_desc", "profit", { "t.page": "4" })).not.toContain("t.page");
  });
});

describe("Pager", () => {
  const render = (page: number, pageCount: number) =>
    renderToStaticMarkup(
      <Pager page={page} pageCount={pageCount} total={9} prefix="t" basePath={BASE} params={{}} noun="trade" />,
    );

  // Mutation caught: rendering a live link at the ends, which produces
  // ?t.page=0 and ?t.page=4 on a three-page table.
  it("disables previous on the first page and next on the last", () => {
    const first = render(1, 3);
    expect(first).toContain('aria-disabled="true"');
    expect(first).not.toContain("t.page=0");
    expect(first).toContain("t.page=2");

    const last = render(3, 3);
    expect(last).not.toContain("t.page=4");
    expect(last).toContain("t.page=2");
  });

  it("states the position in words as well as in controls", () => {
    expect(render(2, 3)).toContain("page 2 of 3");
    expect(render(2, 3)).toContain("9 trades");
  });
});

describe("FilterBar", () => {
  const GROUPS = [
    {
      name: "outcome",
      label: "Outcome",
      options: [
        { value: "wins", label: "Wins" },
        { value: "losses", label: "Losses" },
      ],
    },
  ];
  const render = (active: Record<string, string>, params = {}, search = "") =>
    renderToStaticMarkup(
      <FilterBar groups={GROUPS} active={active} search={search} prefix="t" basePath={BASE} params={params} />,
    );

  // Mutation caught: always setting the value, so an active chip cannot be
  // switched off by clicking it again.
  it("toggles an active chip off and an inactive chip on", () => {
    expect(render({})).toContain("t.outcome=wins");
    const on = render({ outcome: "wins" }, { "t.outcome": "wins" });
    expect(on).toContain('aria-pressed="true"');
    // The Wins chip now clears itself, so its href carries no t.outcome.
    expect(on).not.toContain("t.outcome=wins&amp;");
    expect(on).toContain("t.outcome=losses");
  });

  // Mutation caught: a form with no hidden inputs, which drops every other
  // table's state the moment anyone searches.
  it("carries the other tables' parameters through the search form", () => {
    const html = render({}, { "o.sort": "setup_asc", "t.page": "3" });
    expect(html).toContain('name="o.sort"');
    expect(html).toContain('value="setup_asc"');
    // Its own page and query are excluded — the form sets those.
    expect(html).not.toContain('name="t.page"');
  });

  // Mutation caught: always rendering Clear, so the control is present when
  // there is nothing to clear.
  it("offers Clear only when something is filtering", () => {
    expect(render({})).not.toContain(">Clear<");
    expect(render({ outcome: "wins" })).toContain(">Clear<");
    expect(render({}, {}, "xau")).toContain(">Clear<");
  });
});
```

- [ ] **Step 6: Run the gates**

```bash
pnpm typecheck && pnpm test
```

- [ ] **Step 7: Prove these tests bite**

1. **Format money with `Intl.NumberFormat` over `Number(c) / 100`.** Expected red: `"groups thousands and never loses a cent"` on the 2^53 value. Record what it prints — this is the single clearest demonstration of why the constraint exists.
2. **Use a hyphen in `signedMoney`.** Expected red: `"uses a real minus sign and no sign at zero"`.
3. **Drop the zero-pad in `pctFromBps`.** Expected red: `"zero-pads a single-digit remainder"` only. The main percentage cases all have two-digit remainders, which is why 5505 is in the suite.
4. **Remove the `Z` guard from `utcStamp`.** Expected red: `"refuses a timestamp that is not UTC"`.
5. **Render the current sort in `SortHeader`'s href.** Expected red: `"links to the flipped direction on the active column"`.
6. **Remove `aria-sort`.** Expected red: `"announces the sort state to assistive technology"`.
7. **Render live links at both pager ends.** Expected red: `"disables previous on the first page and next on the last"`.
8. **Delete the hidden inputs from `FilterBar`'s form.** Expected red: `"carries the other tables' parameters through the search form"`.
9. **Make every chip href set its value unconditionally.** Expected red: `"toggles an active chip off and an inactive chip on"`.

- [ ] **Step 8: Commit**

```bash
git add lib/compound/present/figures.ts lib/compound/present/figures.test.ts \
        lib/compound/ui/journal/ app/globals.css
git commit -m "feat(ui): integer-safe figure formatting and URL-driven table chrome"
```

---

### Task 10: `/a/[id]/journal`

Closed trades, open positions and orders — spec §7's contents for this route. Three tables in three panels on one page, each with its own parameter prefix (`t.`, `p.`, `o.`) so they do not reset each other.

**Files:**
- Create: `lib/compound/ui/journal/trades-table.tsx`
- Create: `lib/compound/ui/journal/positions-table.tsx`
- Create: `lib/compound/ui/journal/orders-table.tsx`
- Create: `lib/compound/ui/journal/guard-notice.tsx`
- Create: `lib/compound/ui/journal/tables.test.tsx`
- Create: `app/a/[id]/journal/page.tsx`
- Modify: `lib/compound/journal/table-state.ts` — add `flattenParams`
- Modify: `lib/compound/journal/table-state.test.ts`

**Interfaces:**
- Consumes: `requireAccount` from `@/lib/compound/load/account` (plan 4); `loadTradeHistory`, `loadOpenPositions`, `loadOrders` from `@/lib/compound/load/trades`; everything from `@/lib/compound/journal/*` and `@/lib/compound/present/figures`
- Produces: `flattenParams(sp): Params`; `<TradesTable />`, `<PositionsTable />`, `<OrdersTable />`, `<GuardNotice />`; the route

- [ ] **Step 1: Add `flattenParams` to `lib/compound/journal/table-state.ts`**

```typescript
/**
 * Next.js hands searchParams as string | string[] | undefined, because a
 * parameter can repeat. Every control here writes a parameter once, so a
 * repeat is either a hand-edited URL or an attack; taking the FIRST value is
 * the choice that cannot be surprised by an appended duplicate.
 */
export function flattenParams(
  sp: Readonly<Record<string, string | string[] | undefined>>,
): Params {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && typeof v[0] === "string") out[k] = v[0];
  }
  return out;
}
```

Add to `table-state.test.ts`:

```typescript
describe("flattenParams", () => {
  // Mutation caught: taking the LAST value, so appending &t.sort=<anything>
  // to a link overrides what the page itself put there.
  it("takes the first value of a repeated parameter and drops undefined", () => {
    expect(flattenParams({ a: ["1", "2"], b: "x", c: undefined, d: [] })).toEqual({
      a: "1",
      b: "x",
    });
  });
});
```

- [ ] **Step 2: Create `lib/compound/ui/journal/guard-notice.tsx`**

```tsx
/**
 * The visible half of the duplicate-deal guard.
 *
 * When broker_offset_hours is not configured the guard cannot run (spec
 * section 6.3's defect is a timezone shift, and a zero-hour shift moves
 * nothing), so the page says so. Rendering nothing would recreate the exact
 * failure this product is built to avoid: numbers that look protected and are
 * not.
 *
 * When the guard did run and dropped rows, that is also stated. A manager
 * comparing this page against the terminal needs to know the counts differ on
 * purpose.
 */
import type { TradeHistory } from "@/lib/compound/journal/history";

export function GuardNotice({ history }: { history: TradeHistory }) {
  if (history.guard === "not-configured") {
    return (
      <p className="filters-notice" role="status">
        <strong>Duplicate-deal protection is inactive.</strong> This account has no broker UTC
        offset set, so the guard against duplicated deals cannot run. Trade counts and P/L may be
        inflated. Set the offset on the account to enable it.
      </p>
    );
  }
  if (history.dropped.length === 0) return null;
  const tickets = history.dropped.map((d) => d.deal.ticket).join(", ");
  return (
    <p className="filters-notice" role="status">
      <strong>
        {history.dropped.length} duplicate {history.dropped.length === 1 ? "deal" : "deals"} excluded
      </strong>{" "}
      from {history.rawCount} rows. Ticket{history.dropped.length === 1 ? "" : "s"}{" "}
      <span className="num">{tickets}</span> repeat an earlier trade under a shifted timestamp — a
      known upstream defect. Counts below exclude them.
    </p>
  );
}
```

Add to `globals.css`:

```css
.filters-notice {
  margin: 0; padding: 11px 16px; font-size: 12px; line-height: 1.55;
  color: var(--fee-ink); background: var(--fee-bg);
  border-bottom: 1px solid var(--rule-soft);
}
```

- [ ] **Step 3: Create `lib/compound/ui/journal/trades-table.tsx`**

```tsx
import type { Params, TableState } from "@/lib/compound/journal/table-state";
import type { TradeFilterResult } from "@/lib/compound/journal/trade-filters";
import { lots, signedMoney, toneOf, utcStamp } from "@/lib/compound/present/figures";
import { FilterBar, type ChipGroup } from "./filter-bar";
import { Pager } from "./pager";
import { SortHeader } from "./sort-header";

export function TradesTable({
  result,
  state,
  symbols,
  basePath,
  params,
}: {
  result: TradeFilterResult;
  state: TableState;
  symbols: readonly string[];
  basePath: string;
  params: Params;
}) {
  const groups: ChipGroup[] = [
    {
      name: "outcome",
      label: "Outcome",
      options: [
        { value: "wins", label: "Wins" },
        { value: "losses", label: "Losses" },
        { value: "flat", label: "Flat" },
      ],
    },
    {
      name: "side",
      label: "Side",
      options: [
        { value: "buy", label: "Buy" },
        { value: "sell", label: "Sell" },
      ],
    },
    {
      name: "symbol",
      label: "Symbol",
      options: symbols.map((s) => ({ value: s, label: s })),
    },
  ];
  const head = { sort: state.sort, prefix: "t", basePath, params };

  return (
    <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "16px 16px 0" }}>
        <span className="eyebrow">Closed trades</span>
      </div>
      <FilterBar
        groups={groups}
        active={state.filters}
        search={state.search}
        prefix="t"
        basePath={basePath}
        params={params}
      />
      <div className="scroller">
        <table>
          <caption className="sr-only">
            Closed trades, {result.total} matching, page {result.page} of {result.pageCount}
          </caption>
          <thead>
            <tr>
              <SortHeader label="Closed (UTC)" column="closed" {...head} />
              <SortHeader label="Ticket" column="ticket" {...head} numeric />
              <SortHeader label="Symbol" column="symbol" {...head} />
              <SortHeader label="Side" column="side" {...head} />
              <SortHeader label="Lots" column="vol" {...head} numeric />
              <SortHeader label="Gross" column="profit" {...head} numeric />
              <th scope="col">Swap</th>
              <th scope="col">Commission</th>
              <th scope="col">Net</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ textAlign: "center", color: "var(--ink-3)" }}>
                  No trades match these filters.
                </td>
              </tr>
            ) : (
              result.rows.map((d) => {
                const net = d.profitCents + d.swapCents + d.commissionCents;
                return (
                  <tr key={d.ticket}>
                    <td className="num" style={{ textAlign: "left" }}>{utcStamp(d.closeTime)}</td>
                    <td className="num">{d.ticket}</td>
                    <td style={{ textAlign: "left" }}>{d.symbol}</td>
                    <td style={{ textAlign: "left" }}>{d.side === "buy" ? "Buy" : "Sell"}</td>
                    <td className="num">{lots(d.volumeMilliLots)}</td>
                    <td className={`num ${toneOf(d.profitCents)}`}>{signedMoney(d.profitCents)}</td>
                    <td className="num">{signedMoney(d.swapCents)}</td>
                    <td className="num">{signedMoney(d.commissionCents)}</td>
                    <td className={`num ${toneOf(net)}`}>{signedMoney(net)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ textAlign: "left" }}>
                {result.summary.count} trades · {result.summary.wins}W / {result.summary.losses}L
              </td>
              <td colSpan={4} />
              <td className={`num ${toneOf(result.summary.grossCents)}`}>
                {signedMoney(result.summary.grossCents)}
              </td>
              <td colSpan={2} className="num">
                {signedMoney(result.summary.netCents - result.summary.grossCents)}
              </td>
              <td className={`num ${toneOf(result.summary.netCents)}`}>
                {signedMoney(result.summary.netCents)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Pager
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        prefix="t"
        basePath={basePath}
        params={params}
        noun="trade"
      />
      <p className="filters-footnote">
        Figures are net of swap and commission. Wins and losses are counted on gross profit, so a
        trade whose fees exceed a small gain still counts as a win. Times are UTC.
      </p>
    </section>
  );
}
```

`.filters-footnote` and `.sr-only` in `globals.css`:

```css
.filters-footnote {
  margin: 0; padding: 10px 16px 14px; font-size: 11px; line-height: 1.6;
  color: var(--ink-3); border-top: 1px solid var(--rule-soft);
}
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
```

- [ ] **Step 4: Create `positions-table.tsx` and `orders-table.tsx`**

Both follow the same shape as `TradesTable`. The differences that matter:

`PositionsTable` takes a `PositionResult`, renders columns **Opened (UTC) · Ticket · Symbol · Side · Lots · Open · Current · SL · TP · Floating**, renders `slPrice`/`tpPrice` as `—` when null, has **no `FilterBar`** (`POSITION_SPEC.filterKeys` is empty and the open book is small), and its footer states `summary.floatingCents` with `toneOf`. It also carries the live-versus-committed label from plan 4's `lib/compound/ui/banner.tsx` above the table, because floating P/L is a live figure by definition — spec §5.2.

`OrdersTable` takes an `OrderFilterResult`, renders **Set up (UTC) · Done (UTC) · Ticket · Symbol · Type · State · Initial · Remaining · Price**, uses `humanizeOrderType` and `humanizeOrderState` for the two constant columns, renders `timeDone` as `—` when null, and its `FilterBar` groups are `state` (Filled / Pending / Canceled / Partial) and `symbol`. Prefix `o`. Its footer states `summary.filled`, `summary.open` and `summary.canceled`.

Neither table renders a money column that is not a `bigint` at source, and neither parses a price.

- [ ] **Step 5: Create `app/a/[id]/journal/page.tsx`**

```tsx
/**
 * Closed trades, open positions and orders for one pooled account.
 *
 * The account, and with it broker_offset_hours, comes from plan 4's
 * requireAccount. Deals come from loadTradeHistory, which is the only path
 * that produces a DedupedDeals — a page cannot reach the raw query, by type
 * and by chokepoint.test.ts.
 *
 * No client component and no useState: table state is search parameters, so
 * every filter and sort is a link and every view is shareable.
 */
import { requireAccount } from "@/lib/compound/load/account";
import { loadOpenPositions, loadOrders, loadTradeHistory } from "@/lib/compound/load/trades";
import { applyOrderFilters, applyPositionSort, ORDER_SPEC, POSITION_SPEC } from "@/lib/compound/journal/order-filters";
import { applyTradeFilters, symbolsOf, TRADE_SPEC } from "@/lib/compound/journal/trade-filters";
import { flattenParams, parseTableState } from "@/lib/compound/journal/table-state";
import { GuardNotice } from "@/lib/compound/ui/journal/guard-notice";
import { OrdersTable } from "@/lib/compound/ui/journal/orders-table";
import { PositionsTable } from "@/lib/compound/ui/journal/positions-table";
import { TradesTable } from "@/lib/compound/ui/journal/trades-table";

export const dynamic = "force-dynamic";

export default async function JournalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const account = await requireAccount(id);
  const sp = flattenParams(await searchParams);
  const basePath = `/a/${account.id}/journal`;

  const [history, positions, orders] = await Promise.all([
    loadTradeHistory(account.mt5Account, account.brokerOffsetHours),
    loadOpenPositions(account.mt5Account),
    loadOrders(account.mt5Account),
  ]);

  const tradeState = parseTableState(sp, TRADE_SPEC, "t");
  const positionState = parseTableState(sp, POSITION_SPEC, "p");
  const orderState = parseTableState(sp, ORDER_SPEC, "o");

  return (
    <>
      <GuardNotice history={history} />
      <TradesTable
        result={applyTradeFilters(history.deals, tradeState)}
        state={tradeState}
        symbols={symbolsOf(history.deals)}
        basePath={basePath}
        params={sp}
      />
      <PositionsTable
        result={applyPositionSort(positions, positionState)}
        state={positionState}
        basePath={basePath}
        params={sp}
      />
      <OrdersTable
        result={applyOrderFilters(orders, orderState)}
        state={orderState}
        symbols={[...new Set(orders.map((o) => o.symbol))].sort()}
        basePath={basePath}
        params={sp}
      />
    </>
  );
}
```

- [ ] **Step 6: Create `lib/compound/ui/journal/tables.test.tsx`**

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { applyTradeFilters, symbolsOf, TRADE_SPEC } from "@/lib/compound/journal/trade-filters";
import { parseTableState } from "@/lib/compound/journal/table-state";
import { buildTradeHistory } from "@/lib/compound/journal/history";
import { RAW_DEALS, fixtureHistory } from "@/lib/compound/journal/__fixtures__/deals";
import { GuardNotice } from "./guard-notice";
import { TradesTable } from "./trades-table";

const BASE = "/a/7/journal";
const HISTORY = fixtureHistory();
const state = parseTableState({}, TRADE_SPEC, "t");
const html = renderToStaticMarkup(
  <TradesTable
    result={applyTradeFilters(HISTORY.deals, state)}
    state={state}
    symbols={symbolsOf(HISTORY.deals)}
    basePath={BASE}
    params={{}}
  />,
);

describe("TradesTable", () => {
  // Mutation caught: rendering fewer rows than the page holds, or rendering
  // the planted duplicate. Counting <tr> in tbody is the only assertion that
  // notices a row silently dropped by a key collision.
  it("renders one row per trade on the page", () => {
    const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    expect(body.split("<tr>").length - 1).toBe(9);
    expect(html).not.toContain(">5092<");
  });

  // Mutation caught: rendering a money value through a float. 1,237.00 with
  // the grouping comma is the exact string the formatter must produce.
  it("renders signed money with tabular figures", () => {
    expect(html).toContain("+12.37");
    expect(html).toContain("−4.09");
    expect(html).toContain('class="num pos"');
    expect(html).toContain('class="num neg"');
  });

  // Mutation caught: a footer computed from the visible rows. The footer must
  // state the filtered totals, which for the whole fixture are 3458 gross,
  // 3163 net and -295 in fees.
  it("states the filtered totals in the footer", () => {
    const foot = html.slice(html.indexOf("<tfoot>"));
    expect(foot).toContain("+34.58");
    expect(foot).toContain("+31.63");
    expect(foot).toContain("−2.95");
    expect(foot).toContain("9 trades");
    expect(foot).toContain("5W / 3L");
  });

  // Mutation caught: colour as the sole carrier. Spec section 8.4.
  it("carries the sign in the text, not only in the class", () => {
    expect(html).toContain("−15.11");
    expect(html.replace(/class="[^"]*"/g, "")).toContain("−15.11");
  });

  it("offers a symbol chip for every symbol in the history", () => {
    for (const s of ["BTCUSD", "EURUSD", "GBPUSD", "XAUUSD"]) {
      expect(html).toContain(`t.symbol=${s}`);
    }
  });

  it("says so plainly when a filter matches nothing", () => {
    const empty = parseTableState({ "t.symbol": "NOPE" }, TRADE_SPEC, "t");
    const out = renderToStaticMarkup(
      <TradesTable
        result={applyTradeFilters(HISTORY.deals, empty)}
        state={empty}
        symbols={symbolsOf(HISTORY.deals)}
        basePath={BASE}
        params={{ "t.symbol": "NOPE" }}
      />,
    );
    expect(out).toContain("No trades match these filters.");
  });
});

describe("GuardNotice", () => {
  // Mutation caught: rendering nothing when the guard did not run, which
  // shows inflated counts with no indication.
  it("says the guard is inactive when no offset is configured", () => {
    const out = renderToStaticMarkup(
      <GuardNotice history={buildTradeHistory(RAW_DEALS, null)} />,
    );
    expect(out).toContain("Duplicate-deal protection is inactive");
  });

  // Mutation caught: silently dropping rows with no notice, so a manager
  // comparing against the terminal sees a different count and no reason.
  it("names the excluded tickets when the guard dropped rows", () => {
    const out = renderToStaticMarkup(<GuardNotice history={HISTORY} />);
    expect(out).toContain("1 duplicate deal excluded");
    expect(out).toContain("5092");
    expect(out).toContain("10 rows");
  });

  it("renders nothing when the guard ran and found nothing", () => {
    const clean = buildTradeHistory(RAW_DEALS.filter((d) => d.ticket !== 5092), 3);
    expect(renderToStaticMarkup(<GuardNotice history={clean} />)).toBe("");
  });
});
```

- [ ] **Step 7: Run the gates and look at the page**

```bash
pnpm typecheck && pnpm test && pnpm build
```

Then start the app and open `/a/1/journal` against the local Supabase. Confirm by eye: three panels, monospaced figures that do not shift width when a filter changes, a filter link that keeps the other two tables' state, and the guard notice if the seed account has no offset.

- [ ] **Step 8: Prove these tests bite**

1. **Render `result.summary` from `result.rows`** instead of the filtered set. Expected red: `"states the filtered totals in the footer"` — reproduce by setting `t.size=4`, where the page holds four of nine rows.
2. **Have `JournalPage` call `getClosedDeals` directly.** Expected: `tsc` fails (the tables require `DedupedDeals`) **and** `chokepoint.test.ts` fails. Two independent failures.
3. **Return `null` from `GuardNotice` for `not-configured`.** Expected red: `"says the guard is inactive when no offset is configured"`.
4. **Drop the sign from `signedMoney` and rely on the class.** Expected red: `"carries the sign in the text, not only in the class"`.
5. **Give every `<tr>` the same `key`.** Expected red: `"renders one row per trade on the page"` — record the row count React produces, and note that a snapshot test would have accepted it.
6. **Pass `sp` to one table and `{}` to another.** Expected red: `FilterBar`'s `"carries the other tables' parameters"` stays green (it is a unit test), so this must be caught by eye in Step 7. Record it as a gap: there is no automated test that the *page* threads params to all three tables, and adding one would need a render of the async page. Decide whether to add one, and say why either way.

- [ ] **Step 9: Commit**

```bash
git add lib/compound/ui/journal/ app/a/\[id\]/journal/ \
        lib/compound/journal/table-state.ts lib/compound/journal/table-state.test.ts \
        app/globals.css
git commit -m "feat(journal): the closed trades, positions and orders route"
```

---

### Task 11: `/a/[id]/calendar`

A month grid of UTC trading days with a day drill-down. Entirely server-rendered: `?month=2026-05` moves the grid, `?day=2026-05-07` opens the panel underneath it. Both are links, both are shareable, and neither needs a modal.

**The default month is derived from the data, not from the clock.** `new Date()` in a page makes the render non-deterministic and untestable, and it opens the calendar on an empty month whenever the account has been quiet. The calendar opens on the latest month that has a trade in it, falling back to the account's inception month.

**Files:**
- Create: `lib/compound/ui/calendar/month-grid.tsx`
- Create: `lib/compound/ui/calendar/day-panel.tsx`
- Create: `lib/compound/ui/calendar/calendar.test.tsx`
- Create: `app/a/[id]/calendar/page.tsx`
- Modify: `lib/compound/journal/calendar-aggregate.ts` — add `latestMonth` and `dayIntensity`
- Modify: `lib/compound/journal/calendar-aggregate.test.ts`
- Modify: `app/globals.css` — the `.cal` family

**Interfaces:**
- Consumes: everything from `@/lib/compound/journal/calendar-aggregate`; `applyTradeFilters` for the day panel; `requireAccount`, `loadTradeHistory`
- Produces: `latestMonth(days, fallback): string`, `dayIntensity(days, month): (d: CalendarDay) => 0 | 1 | 2`, `<MonthGrid />`, `<DayPanel />`, the route

- [ ] **Step 1: Add `latestMonth` and `dayIntensity` to `calendar-aggregate.ts`**

```typescript
/**
 * The month the calendar opens on: the latest month containing a trade, or
 * the fallback when there are none. Deliberately not "this month" — a clock
 * read makes the render non-deterministic, and an account that has been quiet
 * for a fortnight would open on an empty grid.
 */
export function latestMonth(days: Map<string, CalendarDay>, fallback: string): string {
  let latest: string | null = null;
  for (const key of days.keys()) {
    const month = key.slice(0, 7);
    if (latest === null || month > latest) latest = month;
  }
  return latest ?? fallback;
}

/**
 * Shading tier for a day cell: 0 ordinary, 1 notable, 2 strong.
 *
 * The threshold is the month's upper-quartile magnitude, so shading is
 * relative to the month being looked at rather than to a fixed cash figure
 * that means nothing across accounts of different sizes. Shading is never the
 * only signal — every cell carries its figure as text.
 */
export function dayIntensity(
  days: Map<string, CalendarDay>,
  month: string,
): (day: CalendarDay) => 0 | 1 | 2 {
  const magnitudes: bigint[] = [];
  for (const [key, day] of days) {
    if (key.startsWith(`${month}-`)) {
      magnitudes.push(day.netCents < 0n ? -day.netCents : day.netCents);
    }
  }
  if (magnitudes.length === 0) return () => 0;
  magnitudes.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const upper = magnitudes[Math.floor(magnitudes.length * 3 / 4)] ?? magnitudes[magnitudes.length - 1]!;
  const median = magnitudes[Math.floor(magnitudes.length / 2)] ?? 0n;
  return (day) => {
    const mag = day.netCents < 0n ? -day.netCents : day.netCents;
    if (mag >= upper && upper > 0n) return 2;
    if (mag >= median && median > 0n) return 1;
    return 0;
  };
}
```

Tests to add to `calendar-aggregate.test.ts`:

```typescript
describe("latestMonth", () => {
  // Mutation caught: returning the FIRST key, which on a Map is insertion
  // order — the order deals happened to arrive in, not chronological.
  it("returns the latest month that has a trade", () => {
    expect(latestMonth(aggregateCalendar(fixtureHistory().deals), "2020-01")).toBe("2026-05");
  });

  it("falls back when nothing has traded", () => {
    expect(latestMonth(new Map(), "2026-01")).toBe("2026-01");
  });
});

describe("dayIntensity", () => {
  const days = aggregateCalendar(fixtureHistory().deals);
  const tier = dayIntensity(days, "2026-05");

  // Magnitudes in the fixture month, sorted: 451, 644, 769, 1522, 2821.
  // Upper quartile index floor(5*3/4)=3 -> 1522. Median index 2 -> 769.
  // Mutation caught: a threshold computed with a float index or with
  // Math.round, which picks 2821 and leaves only one strong day.
  it("tiers days against the month's own distribution", () => {
    expect(tier(days.get("2026-05-05")!)).toBe(2); // 2821
    expect(tier(days.get("2026-05-06")!)).toBe(2); // 1522
    expect(tier(days.get("2026-05-04")!)).toBe(1); // 769
    expect(tier(days.get("2026-05-08")!)).toBe(0); // 451
  });

  // Mutation caught: comparing signed values, which would tier a large loss
  // as ordinary because it is the smallest number.
  it("tiers on magnitude, so a large loss is as strong as a large gain", () => {
    expect(tier(days.get("2026-05-06")!)).toBe(2);
    expect(days.get("2026-05-06")!.netCents).toBeLessThan(0n);
  });

  it("returns zero for a month with no trading", () => {
    expect(dayIntensity(days, "2026-06")(days.get("2026-05-05")!)).toBe(0);
  });
});
```

- [ ] **Step 2: Create `lib/compound/ui/calendar/month-grid.tsx`**

```tsx
import type { CalendarDay, MonthSummary } from "@/lib/compound/journal/calendar-aggregate";
import { monthGrid, shiftMonth } from "@/lib/compound/journal/calendar-aggregate";
import { hrefWith, type Params } from "@/lib/compound/journal/table-state";
import { signedMoney, toneOf, utcDate } from "@/lib/compound/present/figures";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function MonthGrid({
  month,
  days,
  summary,
  tierOf,
  selectedDay,
  latest,
  basePath,
  params,
}: {
  month: string;
  days: Map<string, CalendarDay>;
  summary: MonthSummary;
  tierOf: (d: CalendarDay) => 0 | 1 | 2;
  selectedDay: string | null;
  /** The newest month with data; Next is disabled beyond it. */
  latest: string;
  basePath: string;
  params: Params;
}) {
  const rows = monthGrid(month);
  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const monthHref = (m: string) => hrefWith(basePath, params, { month: m, day: null });

  return (
    <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
      <div className="cal-head">
        <div className="cal-nav">
          <a className="btn" href={monthHref(prev)} rel="prev" aria-label={`Previous month, ${prev}`}>
            ‹
          </a>
          <h2 className="cal-title">{month}</h2>
          {next <= latest ? (
            <a className="btn" href={monthHref(next)} rel="next" aria-label={`Next month, ${next}`}>
              ›
            </a>
          ) : (
            <span className="btn" aria-disabled="true">
              ›
            </span>
          )}
        </div>
        <p className="cal-summary num">
          {summary.tradingDays} trading days · {summary.tradeCount} trades ·{" "}
          {summary.wins}W / {summary.losses}L · net{" "}
          <span className={toneOf(summary.netCents)}>{signedMoney(summary.netCents)}</span>
        </p>
      </div>

      <table className="cal">
        <caption className="sr-only">
          Trading calendar for {month}. Days are UTC days. Each cell shows net profit and loss
          including swap and commission.
        </caption>
        <thead>
          <tr>
            {WEEKDAYS.map((w) => (
              <th key={w} scope="col">
                {w}
              </th>
            ))}
            <th scope="col">Week</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((week, wi) => {
            let weekNet = 0n;
            for (const key of week) {
              const cell = key === null ? undefined : days.get(key);
              if (cell) weekNet += cell.netCents;
            }
            return (
              <tr key={week.find((d) => d !== null) ?? `w${wi}`}>
                {week.map((key, di) => {
                  if (key === null) return <td key={`b${wi}-${di}`} className="cal-blank" />;
                  const cell = days.get(key);
                  const dayNumber = Number.parseInt(key.slice(8), 10);
                  if (cell === undefined) {
                    return (
                      <td key={key} className="cal-cell">
                        <span className="cal-day num">{dayNumber}</span>
                      </td>
                    );
                  }
                  const tone = toneOf(cell.netCents);
                  const cls = `cal-cell cal-t${tierOf(cell)} ${tone === "pos" ? "cal-win" : tone === "neg" ? "cal-loss" : ""}`;
                  return (
                    <td key={key} className={cls} aria-current={key === selectedDay ? "true" : undefined}>
                      <a className="cal-link" href={hrefWith(basePath, params, { month, day: key })}>
                        <span className="cal-day num">{dayNumber}</span>
                        <span className={`cal-pnl num ${tone}`}>{signedMoney(cell.netCents)}</span>
                        <span className="cal-count num">
                          {cell.tradeCount} {cell.tradeCount === 1 ? "trade" : "trades"}
                        </span>
                        <span className="sr-only">
                          {utcDate(key)}: {cell.wins} wins, {cell.losses} losses
                        </span>
                      </a>
                    </td>
                  );
                })}
                <td className={`cal-week num ${toneOf(weekNet)}`}>
                  {weekNet === 0n ? "—" : signedMoney(weekNet)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="filters-footnote">
        Days are <strong>UTC days</strong>, matching how deals are keyed everywhere in Compound. A
        trade closing near midnight UTC may sit on the previous day here and on the next day in the
        broker terminal. Figures are net of swap and commission.
      </p>
    </section>
  );
}
```

- [ ] **Step 3: Create `lib/compound/ui/calendar/day-panel.tsx`**

A `<section className="panel">` that renders the day's trades. It takes the `CalendarDay` and the `ClosedDeal[]` for that day (filtered by the page), and renders a compact table — Closed · Ticket · Symbol · Side · Lots · Gross · Net — plus a heading `utcDate(day)`, the day's `wins`/`losses`/`flat` counts, its `netCents` with `toneOf`, and a `Close` link back to `hrefWith(basePath, params, { day: null })`. It renders a plain sentence when the day has no trades, which is reachable through a hand-edited `?day=`.

- [ ] **Step 4: Create `app/a/[id]/calendar/page.tsx`**

```tsx
import { requireAccount } from "@/lib/compound/load/account";
import { loadTradeHistory } from "@/lib/compound/load/trades";
import {
  aggregateCalendar,
  dayIntensity,
  latestMonth,
  monthSummary,
  parseMonth,
} from "@/lib/compound/journal/calendar-aggregate";
import { flattenParams } from "@/lib/compound/journal/table-state";
import { utcDateKey } from "@/lib/compound/reconcile/date-key";
import { GuardNotice } from "@/lib/compound/ui/journal/guard-notice";
import { DayPanel } from "@/lib/compound/ui/calendar/day-panel";
import { MonthGrid } from "@/lib/compound/ui/calendar/month-grid";

export const dynamic = "force-dynamic";

const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const account = await requireAccount(id);
  const sp = flattenParams(await searchParams);
  const basePath = `/a/${account.id}/calendar`;

  const history = await loadTradeHistory(account.mt5Account, account.brokerOffsetHours);
  const days = aggregateCalendar(history.deals);
  const latest = latestMonth(days, account.inceptionDate.slice(0, 7));

  // Untrusted input: validate the shape, then validate that parseMonth accepts
  // it, before it reaches monthGrid.
  const requested = sp.month;
  let month = latest;
  if (requested !== undefined && MONTH_RE.test(requested)) {
    try {
      parseMonth(requested);
      month = requested;
    } catch {
      month = latest;
    }
  }

  const requestedDay = sp.day;
  const day =
    requestedDay !== undefined && DAY_RE.test(requestedDay) && requestedDay.startsWith(`${month}-`)
      ? requestedDay
      : null;

  const dayDeals =
    day === null ? [] : history.deals.filter((d) => utcDateKey(d.closeTime) === day);

  return (
    <>
      <GuardNotice history={history} />
      <MonthGrid
        month={month}
        days={days}
        summary={monthSummary(days, month)}
        tierOf={dayIntensity(days, month)}
        selectedDay={day}
        latest={latest}
        basePath={basePath}
        params={sp}
      />
      {day === null ? null : (
        <DayPanel
          day={day}
          cell={days.get(day) ?? null}
          deals={dayDeals}
          basePath={basePath}
          params={sp}
        />
      )}
    </>
  );
}
```

- [ ] **Step 5: Add the `.cal` family to `app/globals.css`**

```css
.cal-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; flex-wrap: wrap; padding: 16px;
  border-bottom: 1px solid var(--rule-soft);
}
.cal-nav { display: flex; align-items: center; gap: 8px; }
.cal-title { font-family: var(--mono); font-size: 16px; margin: 0; font-weight: 500; }
.cal-summary { margin: 0; font-size: 11.5px; color: var(--ink-2); }

table.cal { table-layout: fixed; }
table.cal th { text-align: center; }
table.cal td { padding: 0; vertical-align: top; text-align: left; height: 76px; }
.cal-blank { background: var(--rule-soft); }
.cal-cell { border-bottom: 1px solid var(--rule-soft); }
.cal-link {
  display: flex; flex-direction: column; gap: 2px;
  padding: 7px 9px; height: 100%; text-decoration: none; color: inherit;
}
.cal-link:focus-visible { outline: 2px solid var(--ink); outline-offset: -2px; }
.cal-day { font-size: 10.5px; color: var(--ink-3); }
.cal-pnl { font-size: 12.5px; font-weight: 500; }
.cal-count { font-size: 10px; color: var(--ink-3); }
.cal-win  { background: color-mix(in srgb, var(--gain) 6%, var(--card)); }
.cal-loss { background: color-mix(in srgb, var(--loss) 6%, var(--card)); }
.cal-win.cal-t1  { background: color-mix(in srgb, var(--gain) 13%, var(--card)); }
.cal-loss.cal-t1 { background: color-mix(in srgb, var(--loss) 13%, var(--card)); }
.cal-win.cal-t2  { background: color-mix(in srgb, var(--gain) 22%, var(--card)); }
.cal-loss.cal-t2 { background: color-mix(in srgb, var(--loss) 22%, var(--card)); }
.cal-week { text-align: right; padding: 7px 9px; font-size: 11.5px; background: #fbfcfd; }
td[aria-current="true"] { box-shadow: inset 0 0 0 2px var(--ink); }

@media (max-width: 640px) {
  table.cal td { height: 62px; }
  .cal-pnl { font-size: 11px; }
  .cal-count { display: none; }
}
```

- [ ] **Step 6: Create `lib/compound/ui/calendar/calendar.test.tsx`**

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import {
  aggregateCalendar,
  dayIntensity,
  latestMonth,
  monthSummary,
} from "@/lib/compound/journal/calendar-aggregate";
import { fixtureHistory, fixtureHistoryUnguarded } from "@/lib/compound/journal/__fixtures__/deals";
import { MonthGrid } from "./month-grid";

const BASE = "/a/7/calendar";
const DAYS = aggregateCalendar(fixtureHistory().deals);

const render = (month = "2026-05", selectedDay: string | null = null, params = {}) =>
  renderToStaticMarkup(
    <MonthGrid
      month={month}
      days={DAYS}
      summary={monthSummary(DAYS, month)}
      tierOf={dayIntensity(DAYS, month)}
      selectedDay={selectedDay}
      latest={latestMonth(DAYS, "2026-05")}
      basePath={BASE}
      params={params}
    />,
  );

describe("MonthGrid", () => {
  const html = render();

  // Mutation caught: a grid built from local Date objects. Under a non-UTC TZ
  // the leading blanks shift and 2026-05-01 lands in the wrong column.
  it("puts the first of the month in the Friday column", () => {
    const firstRow = html.slice(html.indexOf("<tbody>"), html.indexOf("</tr>", html.indexOf("<tbody>")));
    expect(firstRow.split("cal-blank").length - 1).toBe(5);
    expect(firstRow).toContain("day=2026-05-01");
  });

  // Mutation caught: rendering only one trade's figure per day. 2026-05-08
  // has three trades netting 451 cents; a keep-the-last bug shows −0.26.
  it("shows the accumulated day total, not one trade's", () => {
    expect(html).toContain("+4.51");
    expect(html).toContain("3 trades");
    expect(html).not.toContain("+18.04"); // the undeduplicated total
  });

  // THE DEDUPE ASSERTION at the render layer.
  it("renders the deduplicated day totals", () => {
    const bad = renderToStaticMarkup(
      <MonthGrid
        month="2026-05"
        days={aggregateCalendar(fixtureHistoryUnguarded().deals)}
        summary={monthSummary(aggregateCalendar(fixtureHistoryUnguarded().deals), "2026-05")}
        tierOf={() => 0}
        selectedDay={null}
        latest="2026-05"
        basePath={BASE}
        params={{}}
      />,
    );
    expect(bad).toContain("4 trades");
    expect(html).not.toContain("4 trades");
  });

  // Mutation caught: summing the week across the whole month, or resetting it
  // per cell. Week of 04–08 nets 3163; every other week is empty.
  it("totals each week row separately", () => {
    expect(html).toContain("+31.63");
    const dashCount = html.split(">—<").length - 1;
    expect(dashCount).toBeGreaterThanOrEqual(4); // the other week rows
  });

  // Mutation caught: colour as the sole carrier of win or loss. Spec 8.4.
  it("prints the figure and the counts as text", () => {
    const stripped = html.replace(/class="[^"]*"/g, "");
    expect(stripped).toContain("−15.22"); // 2026-05-06
    expect(stripped).toContain("8 May 2026: 2 wins, 1 losses");
  });

  // Mutation caught: enabling Next past the newest month with data, which
  // walks the user into an infinite run of empty grids.
  it("disables Next beyond the latest month with data", () => {
    expect(render("2026-05")).toContain('aria-disabled="true"');
    expect(render("2026-04")).toContain("month=2026-05");
  });

  // Mutation caught: dropping the other page parameters when the month
  // changes, and keeping ?day when it does.
  it("keeps other parameters and clears the day when the month changes", () => {
    const out = render("2026-05", null, { day: "2026-05-04", x: "1" });
    const prevHref = out.slice(out.indexOf('href="'), out.indexOf('"', out.indexOf('href="') + 6));
    expect(prevHref).toContain("month=2026-04");
    expect(prevHref).toContain("x=1");
    expect(prevHref).not.toContain("day=");
  });

  it("marks the selected day for assistive technology", () => {
    expect(render("2026-05", "2026-05-04")).toContain('aria-current="true"');
  });

  it("renders an empty month without crashing", () => {
    expect(render("2026-06")).toContain("0 trading days");
  });
});
```

- [ ] **Step 7: Run the gates**

```bash
pnpm typecheck && pnpm test && TZ=Pacific/Kiritimati pnpm test && pnpm build
```

Then open `/a/1/calendar`, click a day, confirm the URL carries `?month=&day=` and the panel appears; use browser back.

- [ ] **Step 8: Prove these tests bite**

1. **Compute leading blanks with `new Date(month + "-01").getDay()`.** Expected red under `TZ=Pacific/Kiritimati`: `"puts the first of the month in the Friday column"`, plus the `journal purity` guard if the change lands in `calendar-aggregate.ts`. Record whether the default-TZ run stays green — it likely does, which is the argument for running the suite under a second timezone at all.
2. **Reset `weekNet` inside the cell loop.** Expected red: `"totals each week row separately"`.
3. **Render the day cell from the last trade** rather than the aggregate. Expected red: `"shows the accumulated day total, not one trade's"`.
4. **Use `parseMonth(sp.month!)` in the page without the regex and try-catch**, then request `?month=%2E%2E%2F`. Expected: a 500 rather than a fallback. There is no automated test for this; verify by hand and record it.
5. **Enable Next unconditionally.** Expected red: `"disables Next beyond the latest month with data"`.
6. **Keep `day` in the month-navigation href.** Expected red: `"keeps other parameters and clears the day when the month changes"`.

- [ ] **Step 9: Commit**

```bash
git add lib/compound/ui/calendar/ app/a/\[id\]/calendar/ \
        lib/compound/journal/calendar-aggregate.ts lib/compound/journal/calendar-aggregate.test.ts \
        app/globals.css
git commit -m "feat(calendar): server-rendered UTC month grid with day drill-down"
```

---

### Task 12: `/a/[id]/performance` — two curves, capital events marked

Spec **R4**. The page stacks three charts and two panels:

1. **Account equity**, from `account_snapshots_daily`, with a second line for **cumulative contributed capital** and a marker at every capital event. On a deposit both lines step by the same amount and the gap between them does not move.
2. **Trading P/L**, from Task 5 — capital-neutral by construction, so it is flat across that same deposit.
3. **P/L distribution**, from Task 5's histogram.
4. **Statistics** from `computeTradeStats` and **streaks** from `computeStreaks`.

Every chart is server-rendered SVG. There is no charting library, no tooltip script and no hydration: hover text is a `<title>` element, which browsers and screen readers both handle, and each chart is followed by a visually hidden table of its own data so the figures are reachable without seeing the shape.

**Files:**
- Create: `lib/compound/ui/scale.ts`
- Create: `lib/compound/ui/scale.test.ts`
- Create: `lib/compound/ui/performance/equity-chart.tsx`
- Create: `lib/compound/ui/performance/pnl-curve.tsx`
- Create: `lib/compound/ui/performance/histogram-chart.tsx`
- Create: `lib/compound/ui/performance/stats-panel.tsx`
- Create: `lib/compound/ui/performance/charts.test.tsx`
- Create: `app/a/[id]/performance/page.tsx`
- Modify: `app/globals.css` — the `.curve` and `.hist` families

**Interfaces:**
- Consumes: `buildAccountEquitySeries`, `computeTradeEquity`, `computeTradeStats`, `computeStreaks`, `binNetPnl`; `loadLedger`, `loadInterlock` and `capitalMarks` and `InterlockBanner` from plan 4; `loadDailySnapshots`, `loadTradeHistory`
- Produces: `verticalScale`, `horizontalScale`, `<EquityChart />`, `<PnlCurve />`, `<HistogramChart />`, `<StatsPanel />`, the route

- [ ] **Step 1: Create `lib/compound/ui/scale.ts`**

```typescript
/**
 * Cents to pixels. THE ONLY PLACE IN THE PRODUCT WHERE A MONEY VALUE BECOMES
 * A NUMBER, and the number it becomes is a coordinate that never returns to
 * an accounting path.
 *
 * Even here the float never holds a money magnitude. The position is computed
 * as an integer ratio out of PRECISION using bigint arithmetic, and only that
 * small ratio — bounded by 0..100000 — is converted. A balance of
 * 90,071,992,547,409.93 therefore plots exactly, where
 * `Number(cents) / Number(span)` would already have lost the value before the
 * division.
 */
const PRECISION = 100_000n;
const PRECISION_F = 100_000;

export interface VerticalScale {
  minCents: bigint;
  maxCents: bigint;
  /** SVG y for a cent value. Larger values sit higher. */
  y(v: bigint): number;
  /** y of the zero line, or null when zero is outside the domain. */
  zeroY: number | null;
  /** True when every value was identical and the line is horizontal. */
  flat: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function verticalScale(
  values: readonly bigint[],
  height: number,
  pad: number,
): VerticalScale {
  if (values.length === 0) {
    const mid = round2(height / 2);
    return { minCents: 0n, maxCents: 0n, y: () => mid, zeroY: mid, flat: true };
  }

  let minCents = values[0]!;
  let maxCents = values[0]!;
  for (const v of values) {
    if (v < minCents) minCents = v;
    if (v > maxCents) maxCents = v;
  }

  const span = maxCents - minCents;
  const usable = height - 2 * pad;

  if (span === 0n) {
    const mid = round2(height / 2);
    return { minCents, maxCents, y: () => mid, zeroY: minCents === 0n ? mid : null, flat: true };
  }

  const y = (v: bigint): number => {
    const clamped = v < minCents ? minCents : v > maxCents ? maxCents : v;
    // Integer ratio first. The float only ever holds 0..100000.
    const ratio = Number(((clamped - minCents) * PRECISION) / span) / PRECISION_F;
    return round2(pad + usable * (1 - ratio));
  };

  return {
    minCents,
    maxCents,
    y,
    zeroY: minCents <= 0n && maxCents >= 0n ? y(0n) : null,
    flat: false,
  };
}

/** Evenly spaced x for index i of count points. A single point sits at the left pad. */
export function horizontalScale(count: number, width: number, pad: number): (i: number) => number {
  const usable = width - 2 * pad;
  return (i) => (count <= 1 ? round2(pad) : round2(pad + (usable * i) / (count - 1)));
}

/** "x,y x,y ..." for a polyline. */
export function polylinePoints(
  values: readonly bigint[],
  scale: VerticalScale,
  x: (i: number) => number,
): string {
  return values.map((v, i) => `${x(i)},${scale.y(v)}`).join(" ");
}
```

- [ ] **Step 2: Create `lib/compound/ui/scale.test.ts`**

```typescript
import { horizontalScale, polylinePoints, verticalScale } from "./scale";

describe("verticalScale", () => {
  const s = verticalScale([0n, 50n, 100n], 200, 10);

  it("puts the maximum at the top pad and the minimum at the bottom", () => {
    expect(s.y(100n)).toBe(10);
    expect(s.y(0n)).toBe(190);
    expect(s.y(50n)).toBe(100);
  });

  // Mutation caught: `Number(v) / Number(span)`. Both of these values are past
  // 2^53, so a float path collapses them to the same coordinate and the two
  // points plot on top of each other.
  it("plots values past the safe integer range distinctly", () => {
    const big = verticalScale(
      [9_007_199_254_740_992n, 9_007_199_254_740_993n],
      200,
      10,
    );
    expect(big.flat).toBe(false);
    expect(big.y(9_007_199_254_740_993n)).toBe(10);
    expect(big.y(9_007_199_254_740_992n)).toBe(190);
    expect(big.y(9_007_199_254_740_993n)).not.toBe(big.y(9_007_199_254_740_992n));
  });

  // Mutation caught: dividing by a zero span, which produces NaN and a path
  // attribute of "M10,NaN" that renders as nothing at all.
  it("centres a flat series instead of dividing by zero", () => {
    const flat = verticalScale([500n, 500n, 500n], 200, 10);
    expect(flat.flat).toBe(true);
    expect(flat.y(500n)).toBe(100);
    expect(Number.isNaN(flat.y(500n))).toBe(false);
  });

  it("handles an empty series", () => {
    const none = verticalScale([], 200, 10);
    expect(none.y(0n)).toBe(100);
    expect(none.flat).toBe(true);
  });

  // Mutation caught: reporting a zero line for a domain that does not contain
  // zero, which draws a baseline in the wrong place on an all-positive curve.
  it("reports a zero line only when zero is inside the domain", () => {
    expect(verticalScale([-100n, 100n], 200, 10).zeroY).toBe(100);
    expect(verticalScale([100n, 300n], 200, 10).zeroY).toBeNull();
    expect(verticalScale([-300n, -100n], 200, 10).zeroY).toBeNull();
  });

  // Mutation caught: no clamp, so a value outside the domain plots off-canvas
  // and silently stretches the viewBox.
  it("clamps a value outside the domain to the edge", () => {
    expect(s.y(500n)).toBe(10);
    expect(s.y(-500n)).toBe(190);
  });
});

describe("horizontalScale", () => {
  it("spreads points across the usable width", () => {
    const x = horizontalScale(5, 210, 5);
    expect(x(0)).toBe(5);
    expect(x(4)).toBe(205);
    expect(x(2)).toBe(105);
  });

  // Mutation caught: dividing by (count - 1) with count 1, which is NaN.
  it("puts a single point at the left pad", () => {
    expect(horizontalScale(1, 210, 5)(0)).toBe(5);
  });
});

describe("polylinePoints", () => {
  it("emits one vertex per value and never a NaN", () => {
    const values = [0n, 50n, 100n];
    const out = polylinePoints(values, verticalScale(values, 200, 10), horizontalScale(3, 210, 5));
    expect(out.split(" ")).toHaveLength(3);
    expect(out).not.toContain("NaN");
    expect(out).toBe("5,190 105,100 205,10");
  });
});
```

- [ ] **Step 3: Create `lib/compound/ui/performance/equity-chart.tsx`**

```tsx
/**
 * Account equity, contributed capital, and a marker at every capital event.
 * Spec R4.
 *
 * The two lines are the point. Equity alone cannot distinguish a deposit from
 * a good week; equity next to contributed capital can, because on a deposit
 * both step by the same amount and the vertical gap between them — which is
 * performance — does not change. The markers name the event; the second line
 * is what makes the shape read correctly even without looking at them.
 *
 * Both series share ONE vertical scale. Scaling them independently would make
 * the gap between them meaningless, which is the only thing the chart is for.
 */
import type { AccountEquitySeries } from "@/lib/compound/journal/equity-series";
import { horizontalScale, polylinePoints, verticalScale } from "../scale";
import { money, signedMoney, utcDate } from "@/lib/compound/present/figures";

const W = 900;
const H = 300;
const PAD = 18;

export function EquityChart({ series }: { series: AccountEquitySeries }) {
  const { points } = series;
  if (points.length === 0) {
    return (
      <p className="curve-empty">No equity readings yet for this account.</p>
    );
  }

  const equity = points.map((p) => p.equityCents);
  const contributed = points.map((p) => p.contributedCents);
  const scale = verticalScale([...equity, ...contributed], H, PAD);
  const x = horizontalScale(points.length, W, PAD);

  const marked = points
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.marks.length > 0);

  return (
    <figure className="curve">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-labelledby="equity-chart-title equity-chart-desc"
      >
        <title id="equity-chart-title">Account equity and contributed capital</title>
        <desc id="equity-chart-desc">
          Equity from {money(scale.minCents)} to {money(scale.maxCents)} over {points.length}{" "}
          readings, with {marked.length} capital {marked.length === 1 ? "event" : "events"} marked.
          Where both lines step together, money moved in or out rather than being earned.
        </desc>

        {scale.zeroY === null ? null : (
          <line className="curve-zero" x1={PAD} y1={scale.zeroY} x2={W - PAD} y2={scale.zeroY} />
        )}

        {marked.map(({ p, i }) => (
          <g className="curve-mark" key={p.date}>
            <line x1={x(i)} y1={PAD} x2={x(i)} y2={H - PAD} />
            <circle cx={x(i)} cy={scale.y(p.equityCents)} r={3.5} />
            <title>
              {utcDate(p.date)}:{" "}
              {p.marks
                .map((m) => `${m.direction === "in" ? "capital in" : "capital out"} ${money(m.amountCents)}`)
                .join(", ")}
            </title>
          </g>
        ))}

        <polyline className="curve-contributed" points={polylinePoints(contributed, scale, x)} />
        <polyline className="curve-equity" points={polylinePoints(equity, scale, x)} />
      </svg>

      <figcaption className="curve-legend">
        <span className="curve-key curve-key-equity">Account equity</span>
        <span className="curve-key curve-key-contributed">Capital contributed</span>
        <span className="curve-key curve-key-mark">Capital event</span>
        {series.points.some((p) => p.incompleteMarks) ? (
          <span className="curve-key curve-key-warn">
            Capital events after {series.marksCompleteThrough ?? "the start"} may be incomplete
          </span>
        ) : null}
      </figcaption>

      <table className="sr-only">
        <caption>Account equity, contributed capital and performance by reading date</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Equity</th>
            <th scope="col">Contributed</th>
            <th scope="col">Performance</th>
            <th scope="col">Capital events</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <td>{utcDate(p.date)}</td>
              <td>{money(p.equityCents)}</td>
              <td>{money(p.contributedCents)}</td>
              <td>{signedMoney(p.performanceCents)}</td>
              <td>
                {p.marks.length === 0
                  ? "none"
                  : p.marks
                      .map((m) => `${m.direction === "in" ? "in" : "out"} ${money(m.amountCents)}`)
                      .join("; ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {series.trailingMarks.length === 0 ? null : (
        <p className="filters-footnote">
          {series.trailingMarks.length} capital{" "}
          {series.trailingMarks.length === 1 ? "event is" : "events are"} dated after the last
          equity reading and {series.trailingMarks.length === 1 ? "is" : "are"} not yet on the
          curve.
        </p>
      )}
    </figure>
  );
}
```

- [ ] **Step 4: Create `pnl-curve.tsx`, `histogram-chart.tsx` and `stats-panel.tsx`**

`PnlCurve` takes a `TradeEquityResult` and renders one polyline of `curve.map(p => p.cumCents)` on a `verticalScale` that always includes `0n` — the trading curve starts at zero and a chart that omitted it would exaggerate a small move. It draws the zero line, shades nothing, and carries a `<desc>` stating the final total, the peak and the maximum drawdown. Its hidden table lists ticket, close time, that trade's net and the running total. **Its `<desc>` states in words that this curve excludes capital movements**, which is the sentence that makes the pairing with `EquityChart` legible.

`HistogramChart` takes a `HistogramResult` and renders one `<rect>` per bin, class `hist-win` / `hist-loss` / `hist-zero` from `bin.sign`, height proportional to `count` (an integer — `horizontalScale` is not involved and no cents are converted), each with a `<title>` naming the range via `signedMoney(bin.startCents)` and `signedMoney(bin.endCents)` and the count. An empty bin renders a zero-height rect so the axis stays even. Its hidden table lists every bin including the empty ones.

`StatsPanel` takes `TradeStats` and `StreakStats` and renders a two-column definition list of: trades, wins/losses/flat, win rate via `pctFromBps`, profit factor via `ratioFromMilli`, gross profit, gross loss, net after fees, total fees, average win, average loss, expected payoff, best, worst, maximum win streak, maximum loss streak, current streak. Every figure uses `.num`; every signed figure uses `signedMoney` and `toneOf`.

- [ ] **Step 5: Create `app/a/[id]/performance/page.tsx`**

```tsx
import { requireAccount } from "@/lib/compound/load/account";
import { loadDailySnapshots, loadTradeHistory } from "@/lib/compound/load/trades";
import { loadLedger } from "@/lib/compound/load/ledger";
import { loadInterlock } from "@/lib/compound/load/interlock";
import { capitalMarks } from "@/lib/compound/present/capital-marks";
import { InterlockBanner } from "@/lib/compound/ui/banner";
import { buildAccountEquitySeries } from "@/lib/compound/journal/equity-series";
import { binNetPnl } from "@/lib/compound/journal/histogram";
import { computeStreaks } from "@/lib/compound/journal/streaks";
import { computeTradeEquity } from "@/lib/compound/journal/trade-equity";
import { computeTradeStats } from "@/lib/compound/journal/trade-stats";
import { GuardNotice } from "@/lib/compound/ui/journal/guard-notice";
import { EquityChart } from "@/lib/compound/ui/performance/equity-chart";
import { HistogramChart } from "@/lib/compound/ui/performance/histogram-chart";
import { PnlCurve } from "@/lib/compound/ui/performance/pnl-curve";
import { StatsPanel } from "@/lib/compound/ui/performance/stats-panel";

export const dynamic = "force-dynamic";

const BIN_COUNT = 12;

export default async function PerformancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = await requireAccount(id);

  const [history, snapshots, ledger, interlock] = await Promise.all([
    loadTradeHistory(account.mt5Account, account.brokerOffsetHours),
    loadDailySnapshots(account.mt5Account),
    loadLedger(account.id),
    loadInterlock(account.id),
  ]);

  const series = buildAccountEquitySeries({
    snapshots,
    marks: capitalMarks(ledger),
    marksCompleteThrough: interlock.frozenAt,
  });
  const equity = computeTradeEquity(history.deals);
  const stats = computeTradeStats(history.deals);
  const streaks = computeStreaks(history.deals);
  const distribution = binNetPnl(equity.curve.map((p) => p.netCents), BIN_COUNT);

  return (
    <>
      {interlock.pendingCandidateDate === null ? null : (
        <InterlockBanner
          frozenAt={interlock.frozenAt}
          candidateDate={interlock.pendingCandidateDate}
          reviewHref={`/a/${account.id}/review`}
        />
      )}
      <GuardNotice history={history} />

      <section className="panel">
        <span className="eyebrow">Account equity and capital</span>
        <EquityChart series={series} />
      </section>

      <section className="panel">
        <span className="eyebrow">Trading profit and loss — capital excluded</span>
        <PnlCurve result={equity} />
      </section>

      <section className="panel">
        <span className="eyebrow">Distribution of trade results</span>
        <HistogramChart result={distribution} />
      </section>

      <StatsPanel stats={stats} streaks={streaks} />
    </>
  );
}
```

> **If plan 4 has not landed**, replace the three plan-4 imports with local stand-ins: `capitalMarks` filtering `ledger` to `deposit`/`payout`/`exit` with `reversesId === null` and no entry voided by a later reversal, `loadInterlock` returning `{ frozenAt: null, pendingCandidateDate: null, pendingCount: 0 }`, and `InterlockBanner` returning `null`. **Mark each with `// PLAN 4 STAND-IN — delete on merge`** and re-check them at merge, because the voiding rule is subtle and plan 4's version has a test for it that a stand-in will not.

- [ ] **Step 6: Add the `.curve` and `.hist` families to `app/globals.css`**

```css
.curve { margin: 12px 0 0; }
.curve svg { width: 100%; height: 300px; display: block; }
.curve-empty { color: var(--ink-3); font-size: 12px; margin: 12px 0 0; }
.curve-zero { stroke: var(--rule); stroke-width: 1; stroke-dasharray: 3 3; }
.curve-equity { fill: none; stroke: var(--ink); stroke-width: 1.75; vector-effect: non-scaling-stroke; }
.curve-contributed {
  fill: none; stroke: var(--ink-3); stroke-width: 1.5;
  stroke-dasharray: 5 4; vector-effect: non-scaling-stroke;
}
.curve-mark line { stroke: var(--fee); stroke-width: 1; }
.curve-mark circle { fill: var(--fee); stroke: var(--ink); stroke-width: 1; }
.curve-legend {
  display: flex; gap: 18px; flex-wrap: wrap; margin-top: 10px;
  font-size: 11px; color: var(--ink-2);
}
.curve-key::before {
  content: ""; display: inline-block; width: 14px; height: 0;
  border-top: 2px solid currentColor; margin-right: 7px; vertical-align: middle;
}
.curve-key-equity { color: var(--ink); }
.curve-key-contributed { color: var(--ink-3); }
.curve-key-mark { color: var(--fee-ink); }
.curve-key-warn { color: var(--fee-ink); font-weight: 600; }
.curve-key-warn::before { content: none; }

.hist svg { width: 100%; height: 200px; display: block; }
.hist rect { stroke: var(--card); stroke-width: 1; }
.hist .hist-win { fill: var(--gain); }
.hist .hist-loss { fill: var(--loss); }
.hist .hist-zero { fill: var(--ink-3); }

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
@media (max-width: 640px) {
  .curve svg { height: 220px; }
}
```

- [ ] **Step 7: Create `lib/compound/ui/performance/charts.test.tsx`**

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import type { DailySnapshot } from "@/lib/compound/reconcile/types";
import { buildAccountEquitySeries, type CapitalMarkInput } from "@/lib/compound/journal/equity-series";
import { binNetPnl } from "@/lib/compound/journal/histogram";
import { computeTradeEquity } from "@/lib/compound/journal/trade-equity";
import { fixtureHistory, fixtureHistoryUnguarded } from "@/lib/compound/journal/__fixtures__/deals";
import { EquityChart } from "./equity-chart";
import { HistogramChart } from "./histogram-chart";
import { PnlCurve } from "./pnl-curve";

const S = (d: string, e: bigint): DailySnapshot => ({
  tradeDate: d,
  balanceCloseCents: e,
  equityCloseCents: e,
});

const SNAPSHOTS = [
  S("2026-05-04", 999_413n),
  S("2026-05-05", 1_002_234n),
  S("2026-05-06", 1_000_712n),
  S("2026-05-08", 1_051_363n),
  S("2026-05-11", 1_047_119n),
];

const MARKS: CapitalMarkInput[] = [
  { occurredOn: "2026-05-01", amountCents: 900_000n, direction: "in" },
  { occurredOn: "2026-05-07", amountCents: 50_000n, direction: "in" },
];

const series = buildAccountEquitySeries({
  snapshots: SNAPSHOTS,
  marks: MARKS,
  marksCompleteThrough: "2026-05-11",
});
const html = renderToStaticMarkup(<EquityChart series={series} />);

function attr(source: string, name: string): string[] {
  return [...source.matchAll(new RegExp(`${name}="([^"]*)"`, "g"))].map((m) => m[1]!);
}

describe("EquityChart", () => {
  // Mutation caught: any float division producing NaN — a "d" or "points"
  // attribute containing NaN renders as an empty chart with no error anywhere.
  it("emits no NaN in any coordinate", () => {
    expect(html).not.toContain("NaN");
  });

  // Mutation caught: dropping the first or last point, which shortens the
  // curve without changing anything else visible in a snapshot.
  it("plots one vertex per reading on both lines", () => {
    const lines = attr(html, "points");
    expect(lines).toHaveLength(2);
    for (const p of lines) expect(p.split(" ")).toHaveLength(SNAPSHOTS.length);
  });

  // Mutation caught: scaling the two series independently, which makes the gap
  // between them — the only thing this chart is for — meaningless. Both lines
  // share a scale, so the contributed line at 950000 must sit BELOW the equity
  // line at 1051363 on 2026-05-08 (larger y is lower on screen).
  it("plots both series on one scale", () => {
    const [contributed, equity] = attr(html, "points") as [string, string];
    const yAt = (p: string, i: number) => Number(p.split(" ")[i]!.split(",")[1]);
    expect(yAt(contributed, 3)).toBeGreaterThan(yAt(equity, 3));
    expect(yAt(contributed, 0)).toBeGreaterThan(yAt(equity, 0));
  });

  // THE R4 ASSERTION at the render layer. Two capital events, one before the
  // window and one in a snapshot gap, must both produce a mark.
  it("marks every day carrying a capital event", () => {
    expect(html.split("curve-mark").length - 1).toBe(2);
    expect(html).toContain("capital in 9,000.00");
    expect(html).toContain("capital in 500.00");
  });

  // Mutation caught: a chart with no text alternative. Spec 8.4 forbids shape
  // being the sole carrier, and the hidden table is what makes the deposit
  // legible to a reader who cannot see the step.
  it("carries a text alternative with the performance column", () => {
    expect(html).toContain('role="img"');
    expect(html).toContain("Contributed");
    expect(html).toContain("Performance");
    // 2026-05-06 performance 100712, 2026-05-08 performance 101363.
    expect(html).toContain("+1,007.12");
    expect(html).toContain("+1,013.63");
  });

  it("says so when there are no readings", () => {
    const empty = renderToStaticMarkup(
      <EquityChart
        series={buildAccountEquitySeries({ snapshots: [], marks: [], marksCompleteThrough: null })}
      />,
    );
    expect(empty).toContain("No equity readings yet");
    expect(empty).not.toContain("NaN");
  });

  // Mutation caught: a flat series dividing by a zero span.
  it("renders a flat series without NaN", () => {
    const flat = renderToStaticMarkup(
      <EquityChart
        series={buildAccountEquitySeries({
          snapshots: [S("2026-05-04", 500n), S("2026-05-05", 500n)],
          marks: [],
          marksCompleteThrough: "2026-05-05",
        })}
      />,
    );
    expect(flat).not.toContain("NaN");
    expect(attr(flat, "points")[0]!.split(" ")).toHaveLength(2);
  });

  it("warns when marks past the cursor may be incomplete", () => {
    const partial = renderToStaticMarkup(
      <EquityChart
        series={buildAccountEquitySeries({
          snapshots: SNAPSHOTS,
          marks: MARKS,
          marksCompleteThrough: "2026-05-06",
        })}
      />,
    );
    expect(partial).toContain("may be incomplete");
    expect(html).not.toContain("may be incomplete");
  });
});

describe("PnlCurve", () => {
  const result = computeTradeEquity(fixtureHistory().deals);
  const out = renderToStaticMarkup(<PnlCurve result={result} />);

  it("plots one vertex per trade and no NaN", () => {
    expect(out).not.toContain("NaN");
    expect(attr(out, "points")[0]!.split(" ")).toHaveLength(9);
  });

  // Mutation caught: a scale that omits zero, which turns a 31-dollar gain on
  // a 3,000-dollar account into a chart that looks like a doubling.
  it("always includes zero in the domain", () => {
    expect(out).toContain("curve-zero");
  });

  // Mutation caught: dropping the sentence that makes the pairing legible.
  it("states in words that capital movements are excluded", () => {
    expect(out.toLowerCase()).toContain("capital");
  });

  // THE DEDUPE ASSERTION at the render layer.
  it("plots the deduplicated curve", () => {
    const bad = renderToStaticMarkup(
      <PnlCurve result={computeTradeEquity(fixtureHistoryUnguarded().deals)} />,
    );
    expect(attr(bad, "points")[0]!.split(" ")).toHaveLength(10);
    expect(bad).toContain("+45.16");
    expect(out).toContain("+31.63");
  });
});

describe("HistogramChart", () => {
  const values = computeTradeEquity(fixtureHistory().deals).curve.map((p) => p.netCents);
  const out = renderToStaticMarkup(<HistogramChart result={binNetPnl(values, 8)} />);

  // Mutation caught: dropping empty bins, which compresses the axis and moves
  // every remaining bar.
  it("renders a rect for every bin including the empty ones", () => {
    expect(attr(out, "class").filter((c) => c.startsWith("hist-"))).toHaveLength(8);
  });

  it("names each bin's range and count in a title", () => {
    expect(out).toContain("<title>");
    expect(out).not.toContain("NaN");
  });

  it("colours bins by sign", () => {
    expect(out).toContain("hist-loss");
    expect(out).toContain("hist-win");
  });
});
```

- [ ] **Step 8: Run the gates**

```bash
pnpm typecheck && pnpm test && pnpm build
```

Open `/a/1/performance`. Confirm by eye that the deposit in the seed data produces a visible step in **both** top lines and no step in the bottom curve. That is the whole feature; if it does not read that way at a glance, the chart is wrong even if the tests are green.

- [ ] **Step 9: Prove these tests bite**

1. **Scale the two series independently** — `verticalScale(equity, ...)` and `verticalScale(contributed, ...)`. Expected red: `"plots both series on one scale"`. Record what the chart looks like: the two lines will appear to converge and diverge for no reason, which is exactly the misreading R4 exists to prevent.
2. **Drop the capital marks from the chart** (render the polylines only). Expected red: `"marks every day carrying a capital event"` and, at the pure layer, `equity-series.test.ts`'s R4 assertion stays green — which is the point: the arithmetic can be right while the render hides it, so both layers assert it.
3. **Convert with `Number(v) / Number(span)`.** Expected red: `scale.test.ts`'s `"plots values past the safe integer range distinctly"`. The chart tests stay green on the ordinary fixture. Record that.
4. **Delete the `span === 0n` branch.** Expected red: `"centres a flat series"` and `"renders a flat series without NaN"`.
5. **Remove the hidden table from `EquityChart`.** Expected red: `"carries a text alternative with the performance column"`.
6. **Build `PnlCurve`'s scale from the curve values alone**, without seeding `0n`. Expected red: `"always includes zero in the domain"`.
7. **Drop zero-count bins in `HistogramChart`.** Expected red: `"renders a rect for every bin including the empty ones"`.

- [ ] **Step 10: Commit**

```bash
git add lib/compound/ui/scale.ts lib/compound/ui/scale.test.ts \
        lib/compound/ui/performance/ app/a/\[id\]/performance/ app/globals.css
git commit -m "feat(performance): equity curve with capital events marked, P/L curve, histogram (R4)"
```

---

### Task 13: Verification — accessibility, breakpoints, and one last dedupe proof

Nothing new is built here. This task exists because three things in this plan are only true if someone checks them: the accessibility floor in spec §8.4, the four breakpoints in §8.4, and the claim that *every* journal surface deduplicates.

**Files:**
- Create: `lib/compound/journal/dedupe-coverage.test.ts`
- Modify: whatever the checks find

- [ ] **Step 1: Write the cross-surface dedupe proof**

Task 2's `chokepoint.test.ts` proves nothing reaches around the guard. This proves the guard is actually load-bearing for every figure a surface shows — one place, one list, so a new surface added later without a dedupe assertion is visible.

```typescript
import { aggregateCalendar, monthSummary } from "./calendar-aggregate";
import { binNetPnl } from "./histogram";
import { computeStreaks } from "./streaks";
import { computeTradeEquity } from "./trade-equity";
import { computeTradeStats } from "./trade-stats";
import { fixtureHistory, fixtureHistoryUnguarded } from "./__fixtures__/deals";

const good = fixtureHistory().deals;
const bad = fixtureHistoryUnguarded().deals;

/**
 * One row per figure a surface puts on screen. If a figure is added to a
 * surface and its aggregate is not listed here, nobody has checked that the
 * duplicate guard changes it — and the sibling product's live defect is
 * exactly that gap.
 */
const FIGURES: Array<[string, (d: typeof good) => string]> = [
  ["journal · trade count", (d) => String(computeTradeStats(d).totalTrades)],
  ["journal · net after fees", (d) => String(computeTradeStats(d).netAfterFeesCents)],
  ["journal · win rate", (d) => String(computeTradeStats(d).winRateBps)],
  ["journal · profit factor", (d) => String(computeTradeStats(d).profitFactorMilli)],
  ["calendar · month net", (d) => String(monthSummary(aggregateCalendar(d), "2026-05").netCents)],
  ["calendar · month trades", (d) => String(monthSummary(aggregateCalendar(d), "2026-05").tradeCount)],
  ["calendar · 2026-05-08 count", (d) => String(aggregateCalendar(d).get("2026-05-08")!.tradeCount)],
  ["performance · final P/L", (d) => String(computeTradeEquity(d).netCents)],
  ["performance · curve length", (d) => String(computeTradeEquity(d).curve.length)],
  ["performance · max win streak", (d) => String(computeStreaks(d).maxWinStreak)],
  [
    "performance · histogram total",
    (d) => String(binNetPnl(computeTradeEquity(d).curve.map((p) => p.netCents), 8).total),
  ],
];

describe("the duplicate guard changes every figure on every surface", () => {
  it("checks a plausible number of figures", () => {
    // Mutation caught: the list being emptied or the loop being skipped.
    expect(FIGURES.length).toBeGreaterThanOrEqual(11);
  });

  it.each(FIGURES)("%s differs with and without the guard", (_label, compute) => {
    expect(compute(good)).not.toBe(compute(bad));
  });
});
```

- [ ] **Step 2: Run the whole suite, twice, and the build**

```bash
supabase db reset
pnpm typecheck
pnpm test
TZ=Pacific/Kiritimati pnpm test
pnpm test:db
TZ=Pacific/Kiritimati pnpm test:db
pnpm build
pnpm check:secrets
```

Record any test whose result differs between the two timezone runs. A difference is a bug, not a curiosity.

- [ ] **Step 3: Check the accessibility floor by hand**

Against `/a/1/journal`, `/a/1/calendar` and `/a/1/performance`, on the local stack. Record the result of each.

- [ ] Every figure and body text at 4.5:1 or better against its background. The `.cal-win`/`.cal-loss` tints are new — measure `--gain` and `--loss` text on each of the three tint levels, not just on `--card`. If any tint fails, lighten the tint; do not darken the text away from the spec's token.
- [ ] Tab through each page. Every link and the search field take focus, focus is visible, and the order follows the reading order.
- [ ] Every table has a `<caption>` (visible or `.sr-only`) and `scope` on its headers.
- [ ] Every chart has `role="img"` and an `aria-labelledby` pointing at a `<title>` and `<desc>` that state the actual figures, plus a hidden data table.
- [ ] No colour is a sole carrier: every P/L figure has a sign, every calendar cell has its figure as text, `aria-sort` is present on sortable headers, `aria-pressed` on filter chips.
- [ ] With CSS disabled the pages still read in a sensible order.

- [ ] **Step 4: Check the four breakpoints**

At 375, 768, 1024 and 1440 (spec §8.4), on all three routes:

- [ ] No horizontal scroll on `<body>`. Wide tables scroll inside `.scroller` only.
- [ ] Money columns do not change width when a filter changes the visible rows — this is what `tabular-nums` is for and it is easy to lose by putting a figure outside `.num`.
- [ ] The calendar grid is usable at 375: the day figure is still legible with `.cal-count` hidden.
- [ ] Both charts fit without clipping; the legend wraps rather than overflowing.

- [ ] **Step 5: Confirm the plan-4 seam**

- [ ] The sub-nav includes Journal, Calendar and Performance, and each is highlighted when active.
- [ ] No `// PLAN 4 STAND-IN` comment remains anywhere. Grep for it.
- [ ] Only one money formatter exists under `lib/compound/present/`. Grep for a second one.
- [ ] `broker_offset_hours` is nullable with no default, and an account with it unset renders the `GuardNotice`, not a crash.

- [ ] **Step 6: Commit**

```bash
git add lib/compound/journal/dedupe-coverage.test.ts
git commit -m "test(journal): prove the duplicate guard moves every figure on every surface"
```

---

## Plan self-review

**Spec coverage.** Every clause of the spec this plan is responsible for maps to a task.

| Spec | Task |
|---|---|
| §1 — reads `deals`, `orders`, `positions` for the journal surfaces | 2, 7 |
| §4 — money as integer cents, no float on money | 1, 3, 5, 9, 12 (`ui/scale.ts` is the single named crossing) |
| §4 — rounding direction, floor | 1 (`divFloor`), 3 |
| §5.3 — the interlock's effect on what can be shown | 6 (`marksCompleteThrough`), 12 (`InterlockBanner`, the incomplete-marks warning) |
| §6.3 — the duplicate-deal defect | 2 (branded type, choke point), 3–5 (a dedupe assertion per module), 10 (`GuardNotice`), 13 (cross-surface proof) |
| §7 — `/a/[id]/journal`: closed trades, open positions, orders | 10 |
| §7 — `/a/[id]/calendar`: month calendar with day drill-down | 11 |
| §7 — `/a/[id]/performance`: equity curve with capital events marked, streaks, histogram | 12 |
| R4 — a step-up reads as money in, not a good week | 6 (arithmetic), 12 (render); asserted at both layers |
| §8.1 — tokens | Reused from `app/globals.css`; no new custom properties |
| §8.3 — every figure monospaced and tabular | `.num` on every figure; verified in 13 |
| §8.4 — contrast, colour never sole carrier, focus, reduced motion, four breakpoints | 13 |
| §10 — public repository, fictional fixtures | Every fixture in this plan; `pnpm check:secrets` in 13 |
| §11 — UI component tests | 9, 10, 11, 12 — all via `renderToStaticMarkup`, no snapshots |
| D6 — copy the pure functions, rebuild the components | The disposition table above |

Not covered here by design: the desk, ledger, review queue, holder statement, modals and account list (plan 4); the schema, RLS and writer (plan 3); the accounting engine (plan 1); the reconciler (plan 2).

**Type consistency.** `DedupedDeals`, `TradeHistory`, `CalendarDay`, `MonthSummary`, `StreakStats`, `TradeStats`, `CumulativePoint`, `TradeEquityResult`, `HistogramBin`, `HistogramResult`, `CapitalMarkInput`, `EquityPoint`, `AccountEquitySeries`, `TableState`, `TableSpec`, `Params`, `Paged`, `OpenPosition`, `OrderRow`, `VerticalScale` are each defined in exactly one task and referenced by the same name after it. `ClosedDeal`, `DailySnapshot`, `Cents`, `LedgerEntry`, `Queryable` are imported from plans 1–3 and never redefined. `CapitalMark` belongs to plan 4 and is consumed structurally through the narrower `CapitalMarkInput`, which is the one place this plan deliberately does not import a peer's type — and the reason is stated where it happens.

**Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Two steps describe components by their differences from a fully written sibling rather than repeating three hundred near-identical lines — Task 10 Step 4 (`PositionsTable`, `OrdersTable`) and Task 12 Step 4 (`PnlCurve`, `HistogramChart`, `StatsPanel`). Both name every column, every class, every helper and every accessibility requirement, and both siblings are written out in full. That is a deliberate density choice, not an omission; if an executor would rather have them spelled out, they are mechanical.

**Every test names its mutation.** Grep for `Mutation caught` — it appears in every test file this plan creates. Every task ends with a step that breaks the code and records which tests go red, including the cases where a mutation is expected to stay **green**, because those are the ones that tell you which test is actually holding the line.

---

## Deviations from the spec, for the record

Five. Each is a change to the spec, not only to the plan, and each should be folded back before the spec is next read as authoritative.

1. **`compound_account.broker_offset_hours` does not exist in §6's schema sketch.** The journal cannot deduplicate without it and `reconcile/interlock.ts` already takes it as an argument. Plan 4 adds it as `int` **NULL, no default** — nullable rather than defaulted to zero, because a default of zero is indistinguishable from "this broker is on UTC" and would silently disable the guard on every new account. Agreed between plans 4 and 5 in writing.

2. **The calendar day is a UTC day.** §4 says `occurred_on` is a broker-server date, and `account_snapshots_daily.trade_date` is one. The calendar keys on UTC instead, matching `reconcile/date-key.ts`. The spec does not choose; this plan does, and states the visible consequence in the UI.

3. **§7's `/performance` row says "equity curve with capital events marked".** This plan renders **two** curves and a derived contributed-capital line, because a capital event does not move closed-trade P/L and marking one there says nothing. The spec's requirement is met; the shape is larger than the sentence implies.

4. **Trade counts use gross profit, money figures use net.** The upstream applies this rule in one module and not another, and the spec does not mention it. It is applied consistently here and tested; a trade whose fees exceed a small gain is a win that loses money, and both facts are shown.

5. **`export`, `baseline`, `objectives`, `passer-progress` and `dashboard-drawdown` are not brought across.** §7 lists neither an export route nor any challenge surface, but D6's "copy `lib/journal/`" reads as though the whole directory comes over. It does not, and the disposition table above records why for each.

---

## Open questions for whoever executes this

Three, none blocking, all cheap to settle at execution time.

1. **Does plan 4's `present/` already contain a money formatter?** If so, Task 9's `figures.ts` must use it rather than adding a second. Task 13 Step 5 greps for exactly this.
2. **Is `pnpm test` running one Jest project or two?** Plan 4 adds a jsdom project rooted at `lib/compound/ui`, so this plan's `.test.tsx` files will land in it. `renderToStaticMarkup` is unaffected either way; nothing here needs a config change, and nothing here should make one.
3. **Should `/journal` offer a CSV export after all?** It is excluded above on the grounds that §7 does not list it. A fund administrator reconciling a dispute plausibly wants one. If it comes back, it comes back with `formatCents` serialisation and without `computePips` — and it is one task, not a redesign.
