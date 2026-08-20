# Compound Reconciler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the capital-event reconciler — the pure logic that decides which equity readings are safe to post, and refuses to advance past a balance move that closed trades cannot explain.

**Architecture:** Four modules under `lib/compound/reconcile/`, none performing I/O. `dedupe.ts` removes upstream duplicate deals; `detect.ts` reconciles each day's balance move against the closed-trade P/L that should explain it; `interlock.ts` turns that into a plan of readings that stops dead at the first unexplained day. Everything takes plain values and returns plain values, so the whole thing is exercisable without a database.

**Tech Stack:** TypeScript 5 (strict), Jest 29 + ts-jest, fast-check 3, pnpm 10, Node 23. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-21-compound-investor-desk-design.md`](../specs/2026-08-21-compound-investor-desk-design.md) — §5.2 (data flow), §5.3 (the safety interlock), §6.3 (upstream duplicate deals).

## Global Constraints

- **No floating point on money.** Money is integer minor units (cents) as `bigint`. `number` is permitted only for tickets, volumes in milli-lots, hour offsets, and array indices.
- **`reconcile/` performs no I/O.** It must never import from `db/`, `next`, `react`, or `@supabase/*`. Task 1 adds a guard, because `engine/`'s guard only scans `engine/` and will not cover a sibling directory.
- `Date` **is** permitted in `reconcile/` for timestamp handling — it never touches money. `Math.random` and floating-point money arithmetic are not.
- Reconcile on **balance**, post readings on **equity**. Deposits move balance; floating P/L does not.
- **The interlock is the point of this plan:** a planned reading is never dated on or after the first unexplained day.
- TypeScript `strict: true`, `target: "ES2022"`, `noUncheckedIndexedAccess: true`.
- Gates: `pnpm typecheck` and `pnpm test`. Do not add ESLint.
- Repository is public. Fixtures use fictional instruments, tickets and amounts.

## Lessons from the engine build — apply these

The engine plan shipped nine assertions that could not fail. Every task below ends with a step that **proves the test bites** by breaking the code first. Do not skip it, and do not write a fixture whose correct and incorrect implementations agree:

- Never pick round numbers where a boundary matters — use amounts that land one cent either side.
- Never assert `f(x) === f(x)`; that proves purity, not behaviour.
- Never assert a throw by class alone when a deeper guard throws the same class first — match the message.

---

### Task 1: Module scaffold, shared types, and a purity guard for `reconcile/`

`engine/`'s purity test scans only `lib/compound/engine/`. `reconcile/` is a sibling and would be unguarded. This task closes that and establishes the vocabulary the other three use.

**Files:**
- Create: `lib/compound/reconcile/types.ts`
- Create: `lib/compound/reconcile/date-key.ts`
- Create: `lib/compound/reconcile/purity.test.ts`
- Create: `lib/compound/reconcile/date-key.test.ts`

**Interfaces:**
- Consumes: `Cents` from `@/lib/compound/engine/money`
- Produces:
  - `interface DailySnapshot { tradeDate: string; balanceCloseCents: Cents; equityCloseCents: Cents }`
  - `interface ClosedDeal { ticket: number; symbol: string; side: "buy" | "sell"; volumeMilliLots: number; openTime: string; closeTime: string; profitCents: Cents; swapCents: Cents; commissionCents: Cents }`
  - `dealNetCents(d: ClosedDeal): Cents`
  - `utcDateKey(iso: string): string`

- [ ] **Step 1: Write the failing tests**

Create `lib/compound/reconcile/date-key.test.ts`:

```typescript
import { utcDateKey } from "./date-key";
import { dealNetCents } from "./types";
import type { ClosedDeal } from "./types";

describe("utcDateKey", () => {
  it("returns the UTC calendar date of a timestamp", () => {
    expect(utcDateKey("2026-08-19T12:37:37Z")).toBe("2026-08-19");
    expect(utcDateKey("2026-08-19T12:37:37+00:00")).toBe("2026-08-19");
  });

  it("converts a non-UTC offset to the correct UTC date", () => {
    // 01:30 at +03:00 is 22:30 the PREVIOUS day in UTC. Slicing the string
    // would wrongly answer 2026-08-19.
    expect(utcDateKey("2026-08-19T01:30:00+03:00")).toBe("2026-08-18");
  });

  it("handles the other side of midnight too", () => {
    // 23:30 at -05:00 is 04:30 the NEXT day in UTC.
    expect(utcDateKey("2026-08-19T23:30:00-05:00")).toBe("2026-08-20");
  });

  it("rejects a value that is not a timestamp", () => {
    expect(() => utcDateKey("not a date")).toThrow(/not an ISO timestamp/);
  });
});

const DEAL: ClosedDeal = {
  ticket: 1,
  symbol: "GBPUSD",
  side: "buy",
  volumeMilliLots: 50,
  openTime: "2026-08-14T07:00:52Z",
  closeTime: "2026-08-19T12:37:37Z",
  profitCents: 19_750n,
  swapCents: -292n,
  commissionCents: -100n,
};

describe("dealNetCents", () => {
  it("sums profit, swap and commission", () => {
    expect(dealNetCents(DEAL)).toBe(19_358n);
  });

  it("is signed — a loser nets negative", () => {
    expect(dealNetCents({ ...DEAL, profitCents: -4_384n, swapCents: 0n, commissionCents: 0n }))
      .toBe(-4_384n);
  });

  it("does not silently drop swap or commission", () => {
    // Each component must move the answer, or a regression that ignores one
    // would go unnoticed.
    expect(dealNetCents({ ...DEAL, swapCents: 0n })).toBe(19_650n);
    expect(dealNetCents({ ...DEAL, commissionCents: 0n })).toBe(19_458n);
  });
});
```

Create `lib/compound/reconcile/purity.test.ts`:

```typescript
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const RECONCILE_DIR = join(__dirname);
const FORBIDDEN = [
  /from\s+["']@\/lib\/compound\/db/,
  /from\s+["']\.\.\/db/,
  /from\s+["']next/,
  /from\s+["']react/,
  /from\s+["']@supabase/,
];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".test.ts"))
    .map((f) => join(dir, f));
}

describe("reconcile purity", () => {
  it("has at least one source file to check", () => {
    expect(sourceFiles(RECONCILE_DIR).length).toBeGreaterThan(0);
  });

  it("never imports I/O modules", () => {
    for (const file of sourceFiles(RECONCILE_DIR)) {
      const src = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        expect({ file, matched: pattern.test(src) }).toEqual({ file, matched: false });
      }
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test -- reconcile
```

Expected: FAIL — `Cannot find module './date-key'` and `Cannot find module './types'`.

- [ ] **Step 3: Write `types.ts`**

```typescript
/**
 * The vocabulary the reconciler works in.
 *
 * These mirror the CopyTraderX tables Compound reads, reduced to the fields
 * reconciliation actually needs. The db layer maps rows onto these; nothing
 * here knows a database exists.
 */
import type { Cents } from "@/lib/compound/engine/money";

/**
 * One row of account_snapshots_daily.
 *
 * Both figures matter and they are not interchangeable. Deposits and
 * withdrawals move BALANCE; floating P/L does not. Reconciliation therefore
 * reads balanceCloseCents, while a posted reading carries equityCloseCents,
 * because a holder's value includes their share of open positions.
 */
export interface DailySnapshot {
  /** YYYY-MM-DD, broker-server date. */
  tradeDate: string;
  balanceCloseCents: Cents;
  equityCloseCents: Cents;
}

/** One closed trade from the deals table. */
export interface ClosedDeal {
  ticket: number;
  symbol: string;
  side: "buy" | "sell";
  /** Lots × 1000, as an integer. 0.05 lots is 50. Avoids float comparison. */
  volumeMilliLots: number;
  /** ISO 8601. */
  openTime: string;
  /** ISO 8601. */
  closeTime: string;
  profitCents: Cents;
  swapCents: Cents;
  commissionCents: Cents;
}

/** What a trade actually did to the account balance. */
export function dealNetCents(d: ClosedDeal): Cents {
  return d.profitCents + d.swapCents + d.commissionCents;
}
```

- [ ] **Step 4: Write `date-key.ts`**

```typescript
/**
 * Timestamp handling. Date is permitted here — it never touches money.
 *
 * Deliberately parses rather than slicing the string. A timestamp carrying a
 * non-UTC offset slices to the wrong calendar day, and attributing a trade to
 * the wrong day is exactly how a reconciler invents a capital event that never
 * happened.
 */
export function utcDateKey(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    throw new RangeError(`not an ISO timestamp: ${JSON.stringify(iso)}`);
  }
  return new Date(t).toISOString().slice(0, 10);
}

/** Absolute gap between two timestamps, in whole milliseconds. */
export function absGapMs(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta)) throw new RangeError(`not an ISO timestamp: ${JSON.stringify(a)}`);
  if (Number.isNaN(tb)) throw new RangeError(`not an ISO timestamp: ${JSON.stringify(b)}`);
  return Math.abs(ta - tb);
}
```

- [ ] **Step 5: Run to verify they pass**

```bash
pnpm test -- reconcile && pnpm typecheck
```

Expected: all PASS, typecheck clean.

- [ ] **Step 6: Prove the purity guard bites**

Temporarily add `import { createClient } from "@supabase/supabase-js";` to the top of `types.ts` and run `pnpm test -- reconcile/purity`. The guard must FAIL naming `types.ts`. Remove the import and confirm it passes again. Record both outputs in your report.

- [ ] **Step 7: Commit**

```bash
git add lib/compound/reconcile/
git commit -m "feat(reconcile): shared types, UTC date handling, and a purity guard"
```

---

### Task 2: `dedupe.ts` — the upstream duplicate-deal guard

Spec §6.3: some trades appear twice in `deals`, shifted by exactly the broker's UTC offset under an out-of-sequence ticket. Left in place they inflate trade counts, distort P/L, and manufacture false capital events.

**Files:**
- Create: `lib/compound/reconcile/dedupe.ts`
- Test: `lib/compound/reconcile/dedupe.test.ts`

**Interfaces:**
- Consumes: `ClosedDeal` from `./types`; `absGapMs` from `./date-key`
- Produces:
  - `interface DroppedDeal { deal: ClosedDeal; duplicateOfTicket: number }`
  - `interface DedupeResult { kept: ClosedDeal[]; dropped: DroppedDeal[] }`
  - `dedupeDeals(deals: readonly ClosedDeal[], brokerOffsetHours: number): DedupeResult`

- [ ] **Step 1: Write the failing tests**

Create `lib/compound/reconcile/dedupe.test.ts`:

```typescript
import { dedupeDeals } from "./dedupe";
import type { ClosedDeal } from "./types";

function deal(over: Partial<ClosedDeal> = {}): ClosedDeal {
  return {
    ticket: 1000,
    symbol: "GBPUSD",
    side: "sell",
    volumeMilliLots: 50,
    openTime: "2026-05-04T07:09:00Z",
    closeTime: "2026-05-06T08:31:00Z",
    profitCents: -1_545n,
    swapCents: -38n,
    commissionCents: 0n,
    ...over,
  };
}

/** The same trade, shifted forward by `h` hours under a later ticket. */
function shifted(base: ClosedDeal, h: number, ticket: number): ClosedDeal {
  const move = (iso: string) => new Date(Date.parse(iso) + h * 3_600_000).toISOString();
  return { ...base, ticket, openTime: move(base.openTime), closeTime: move(base.closeTime) };
}

describe("dedupeDeals — the duplicate shape", () => {
  it("drops a twin shifted by exactly the broker offset", () => {
    const genuine = deal({ ticket: 1000 });
    const twin = shifted(genuine, 3, 9000);
    const r = dedupeDeals([genuine, twin], 3);
    expect(r.kept.map((d) => d.ticket)).toEqual([1000]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.deal.ticket).toBe(9000);
    expect(r.dropped[0]!.duplicateOfTicket).toBe(1000);
  });

  it("keeps the lowest ticket regardless of input order", () => {
    const genuine = deal({ ticket: 1000 });
    const twin = shifted(genuine, 3, 9000);
    expect(dedupeDeals([twin, genuine], 3).kept.map((d) => d.ticket)).toEqual([1000]);
  });

  it("drops both twins of a three-way duplicate", () => {
    const genuine = deal({ ticket: 1000 });
    const r = dedupeDeals([genuine, shifted(genuine, 3, 9000), shifted(genuine, -3, 9001)], 3);
    expect(r.kept.map((d) => d.ticket)).toEqual([1000]);
    expect(r.dropped.map((x) => x.deal.ticket).sort()).toEqual([9000, 9001]);
  });
});

describe("dedupeDeals — what it must NOT drop", () => {
  it("keeps a matching pair whose gap is not the broker offset", () => {
    // Identical in every field but shifted 2h, where the offset is 3h. Two
    // genuinely separate trades. Dropping this would destroy real P/L.
    const a = deal({ ticket: 1000 });
    const b = shifted(a, 2, 1001);
    const r = dedupeDeals([a, b], 3);
    expect(r.kept.map((d) => d.ticket).sort()).toEqual([1000, 1001]);
    expect(r.dropped).toHaveLength(0);
  });

  it("keeps a pair shifted correctly but differing in profit", () => {
    const a = deal({ ticket: 1000 });
    const b = { ...shifted(a, 3, 9000), profitCents: -1_546n };
    expect(dedupeDeals([a, b], 3).dropped).toHaveLength(0);
  });

  it("keeps a pair shifted correctly but differing in volume", () => {
    const a = deal({ ticket: 1000 });
    const b = { ...shifted(a, 3, 9000), volumeMilliLots: 60 };
    expect(dedupeDeals([a, b], 3).dropped).toHaveLength(0);
  });

  it("keeps a pair where only close time is shifted, not open time", () => {
    // A real duplicate is shifted on BOTH ends. One end only is a different
    // trade that happened to close 3h later.
    const a = deal({ ticket: 1000 });
    const b = {
      ...a,
      ticket: 9000,
      closeTime: new Date(Date.parse(a.closeTime) + 3 * 3_600_000).toISOString(),
    };
    expect(dedupeDeals([a, b], 3).dropped).toHaveLength(0);
  });

  it("returns a lone deal untouched", () => {
    const r = dedupeDeals([deal()], 3);
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  it("returns empty for no deals", () => {
    expect(dedupeDeals([], 3)).toEqual({ kept: [], dropped: [] });
  });
});

describe("dedupeDeals — validation", () => {
  it("rejects a non-positive offset", () => {
    expect(() => dedupeDeals([], 0)).toThrow(/brokerOffsetHours/);
    expect(() => dedupeDeals([], -3)).toThrow(/brokerOffsetHours/);
  });
  it("rejects an implausible offset", () => {
    expect(() => dedupeDeals([], 15)).toThrow(/brokerOffsetHours/);
  });
  it("accepts the boundaries", () => {
    expect(() => dedupeDeals([], 1)).not.toThrow();
    expect(() => dedupeDeals([], 14)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test -- dedupe
```

Expected: FAIL — `Cannot find module './dedupe'`.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Upstream duplicate-deal guard. See the design spec, §6.3.
 *
 * Some trades reach the deals table twice: identical in symbol, side, volume,
 * profit and swap, with both timestamps shifted by exactly the broker's UTC
 * offset, under an out-of-sequence ticket. The cause is broker server time
 * being stored as if it were UTC on a subset of pushes.
 *
 * Left in place they inflate trade counts, distort P/L, and — worst — make the
 * reconciler invent capital events that never happened, because the trading
 * P/L it computes no longer matches the balance move it is checking against.
 *
 * The rule is deliberately narrow. BOTH timestamps must be shifted by exactly
 * the offset, and every value field must match. A pair that matches on values
 * but sits at any other gap is two genuine trades, and dropping one would
 * destroy real P/L — a far worse outcome than leaving a duplicate in.
 */
import { absGapMs } from "./date-key";
import type { ClosedDeal } from "./types";

export interface DroppedDeal {
  deal: ClosedDeal;
  /** The ticket this was judged a duplicate of. */
  duplicateOfTicket: number;
}

export interface DedupeResult {
  kept: ClosedDeal[];
  dropped: DroppedDeal[];
}

const MIN_OFFSET_HOURS = 1;
const MAX_OFFSET_HOURS = 14;

/** Every field that must match for two rows to be candidate duplicates. */
function valueKey(d: ClosedDeal): string {
  return [
    d.symbol,
    d.side,
    d.volumeMilliLots,
    d.profitCents.toString(),
    d.swapCents.toString(),
    d.commissionCents.toString(),
  ].join("|");
}

export function dedupeDeals(
  deals: readonly ClosedDeal[],
  brokerOffsetHours: number,
): DedupeResult {
  if (
    !Number.isInteger(brokerOffsetHours) ||
    brokerOffsetHours < MIN_OFFSET_HOURS ||
    brokerOffsetHours > MAX_OFFSET_HOURS
  ) {
    throw new RangeError(
      `brokerOffsetHours must be an integer ${MIN_OFFSET_HOURS}..${MAX_OFFSET_HOURS}, ` +
        `got ${brokerOffsetHours}`,
    );
  }

  const offsetMs = brokerOffsetHours * 3_600_000;
  const groups = new Map<string, ClosedDeal[]>();
  for (const d of deals) {
    const k = valueKey(d);
    const g = groups.get(k);
    if (g) g.push(d);
    else groups.set(k, [d]);
  }

  const kept: ClosedDeal[] = [];
  const dropped: DroppedDeal[] = [];

  for (const group of groups.values()) {
    // Lowest ticket first: the genuine row is the one in sequence with its
    // close-time neighbours, and the spurious re-push always carries a later
    // ticket.
    const ordered = [...group].sort((a, b) => a.ticket - b.ticket);
    const survivors: ClosedDeal[] = [];

    for (const candidate of ordered) {
      const twinOf = survivors.find(
        (s) =>
          absGapMs(s.closeTime, candidate.closeTime) === offsetMs &&
          absGapMs(s.openTime, candidate.openTime) === offsetMs,
      );
      if (twinOf) dropped.push({ deal: candidate, duplicateOfTicket: twinOf.ticket });
      else survivors.push(candidate);
    }
    kept.push(...survivors);
  }

  kept.sort((a, b) => a.ticket - b.ticket);
  dropped.sort((a, b) => a.deal.ticket - b.deal.ticket);
  return { kept, dropped };
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
pnpm test -- dedupe && pnpm typecheck
```

Expected: all PASS.

- [ ] **Step 5: Prove the tests bite**

Two probes, both reverted before committing.

1. Widen the rule: change the `twinOf` predicate to check `closeTime` only, dropping the `openTime` clause. The test `"keeps a pair where only close time is shifted, not open time"` must FAIL. Restore it.
2. Loosen the gap: change `=== offsetMs` to `<= offsetMs`. The test `"keeps a matching pair whose gap is not the broker offset"` must FAIL. Restore it.

Record both outputs, and note how many other tests still passed under each — that is what shows the coverage was real.

- [ ] **Step 6: Commit**

```bash
git add lib/compound/reconcile/dedupe.ts lib/compound/reconcile/dedupe.test.ts
git commit -m "feat(reconcile): drop broker-offset duplicate deals under a narrow rule"
```

---

### Task 3: `detect.ts` — reconcile each day's balance move against its trades

**Files:**
- Create: `lib/compound/reconcile/detect.ts`
- Test: `lib/compound/reconcile/detect.test.ts`

**Interfaces:**
- Consumes: `DailySnapshot`, `ClosedDeal`, `dealNetCents` from `./types`; `utcDateKey` from `./date-key`; `Cents` from `@/lib/compound/engine/money`
- Produces:
  - `interface DayReconciliation { tradeDate: string; previousDate: string; balanceDeltaCents: Cents; explainedCents: Cents; unexplainedCents: Cents; isExplained: boolean }`
  - `reconcileDays(snapshots: readonly DailySnapshot[], deals: readonly ClosedDeal[], toleranceCents: Cents): DayReconciliation[]`

**Note for the implementer:** `reconcileDays` does **not** deduplicate. It reconciles whatever deals it is handed. Task 4 composes dedupe and detect; keeping them separate is what makes each testable in isolation.

- [ ] **Step 1: Write the failing tests**

Create `lib/compound/reconcile/detect.test.ts`:

```typescript
import { reconcileDays } from "./detect";
import type { ClosedDeal, DailySnapshot } from "./types";

function snap(tradeDate: string, balance: bigint, equity = balance): DailySnapshot {
  return { tradeDate, balanceCloseCents: balance, equityCloseCents: equity };
}

let nextTicket = 1;
beforeEach(() => { nextTicket = 1; });

function closed(closeTime: string, netCents: bigint): ClosedDeal {
  nextTicket += 1;
  return {
    ticket: nextTicket,
    symbol: "GBPUSD",
    side: "buy",
    volumeMilliLots: 10,
    openTime: "2026-05-01T07:00:00Z",
    closeTime,
    profitCents: netCents,
    swapCents: 0n,
    commissionCents: 0n,
  };
}

describe("reconcileDays — the happy path", () => {
  it("returns nothing for a single snapshot, which has no predecessor", () => {
    expect(reconcileDays([snap("2026-05-02", 30_941n)], [], 0n)).toEqual([]);
  });

  it("returns nothing for no snapshots", () => {
    expect(reconcileDays([], [], 0n)).toEqual([]);
  });

  it("explains a day whose balance move matches its closed trades", () => {
    const days = reconcileDays(
      [snap("2026-05-02", 30_941n), snap("2026-05-03", 32_486n)],
      [closed("2026-05-03T14:00:00Z", 1_545n)],
      0n,
    );
    expect(days).toHaveLength(1);
    expect(days[0]!.balanceDeltaCents).toBe(1_545n);
    expect(days[0]!.explainedCents).toBe(1_545n);
    expect(days[0]!.unexplainedCents).toBe(0n);
    expect(days[0]!.isExplained).toBe(true);
  });

  it("names both ends of the interval it reconciled", () => {
    const days = reconcileDays([snap("2026-05-02", 100n), snap("2026-05-05", 100n)], [], 0n);
    expect(days[0]!.previousDate).toBe("2026-05-02");
    expect(days[0]!.tradeDate).toBe("2026-05-05");
  });

  it("sorts snapshots before reconciling, and does not mutate the input", () => {
    const input = [snap("2026-05-03", 32_486n), snap("2026-05-02", 30_941n)];
    const copy = [...input];
    const days = reconcileDays(input, [closed("2026-05-03T14:00:00Z", 1_545n)], 0n);
    expect(days[0]!.tradeDate).toBe("2026-05-03");
    expect(input).toEqual(copy);
  });
});

describe("reconcileDays — gaps in the snapshot series", () => {
  it("attributes trades closing inside a gap to the next available day", () => {
    // Friday to Monday. A trade closes on the Saturday. Counting only Monday's
    // closes would leave the Saturday P/L unexplained and manufacture a
    // capital event that never happened.
    const days = reconcileDays(
      [snap("2026-05-01", 100_000n), snap("2026-05-04", 103_000n)],
      [closed("2026-05-02T10:00:00Z", 1_000n), closed("2026-05-04T10:00:00Z", 2_000n)],
      0n,
    );
    expect(days[0]!.explainedCents).toBe(3_000n);
    expect(days[0]!.isExplained).toBe(true);
  });

  it("does not count a trade that closed before the interval opened", () => {
    const days = reconcileDays(
      [snap("2026-05-03", 100_000n), snap("2026-05-04", 100_000n)],
      [closed("2026-05-03T10:00:00Z", 5_000n)],
      0n,
    );
    // The 05-03 close belongs to the interval ending 05-03, not the one
    // ending 05-04. The 05-04 interval saw no trades and no balance move.
    expect(days[0]!.explainedCents).toBe(0n);
    expect(days[0]!.isExplained).toBe(true);
  });
});

describe("reconcileDays — unexplained moves", () => {
  it("flags a balance move no trade explains", () => {
    const days = reconcileDays(
      [snap("2026-06-24", 35_647n), snap("2026-06-25", 66_647n)],
      [],
      0n,
    );
    expect(days[0]!.balanceDeltaCents).toBe(31_000n);
    expect(days[0]!.explainedCents).toBe(0n);
    expect(days[0]!.unexplainedCents).toBe(31_000n);
    expect(days[0]!.isExplained).toBe(false);
  });

  it("flags a withdrawal — unexplained moves are signed", () => {
    const days = reconcileDays(
      [snap("2026-06-24", 66_647n), snap("2026-06-25", 35_647n)],
      [],
      0n,
    );
    expect(days[0]!.unexplainedCents).toBe(-31_000n);
    expect(days[0]!.isExplained).toBe(false);
  });

  it("flags a deposit that partly hides behind a losing day", () => {
    // Balance rose 29,000 while trading lost 2,000: a 31,000 deposit.
    const days = reconcileDays(
      [snap("2026-06-24", 35_647n), snap("2026-06-25", 64_647n)],
      [closed("2026-06-25T09:00:00Z", -2_000n)],
      0n,
    );
    expect(days[0]!.unexplainedCents).toBe(31_000n);
    expect(days[0]!.isExplained).toBe(false);
  });
});

describe("reconcileDays — the tolerance boundary", () => {
  it("treats a gap exactly at tolerance as explained", () => {
    const days = reconcileDays(
      [snap("2026-05-02", 100_000n), snap("2026-05-03", 100_005n)],
      [],
      5n,
    );
    expect(days[0]!.unexplainedCents).toBe(5n);
    expect(days[0]!.isExplained).toBe(true);
  });

  it("treats one cent past tolerance as unexplained", () => {
    const days = reconcileDays(
      [snap("2026-05-02", 100_000n), snap("2026-05-03", 100_006n)],
      [],
      5n,
    );
    expect(days[0]!.unexplainedCents).toBe(6n);
    expect(days[0]!.isExplained).toBe(false);
  });

  it("applies tolerance to negative gaps too", () => {
    const days = reconcileDays(
      [snap("2026-05-02", 100_000n), snap("2026-05-03", 99_995n)],
      [],
      5n,
    );
    expect(days[0]!.isExplained).toBe(true);
    const past = reconcileDays(
      [snap("2026-05-02", 100_000n), snap("2026-05-03", 99_994n)],
      [],
      5n,
    );
    expect(past[0]!.isExplained).toBe(false);
  });

  it("rejects a negative tolerance", () => {
    expect(() => reconcileDays([], [], -1n)).toThrow(/tolerance/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test -- detect
```

Expected: FAIL — `Cannot find module './detect'`.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Per-day reconciliation: does the balance move between two snapshots match
 * the trades that closed in between?
 *
 * Reconciles on BALANCE, deliberately. Deposits and withdrawals move balance;
 * floating P/L does not. Equity would drift with open positions and produce a
 * false unexplained figure every day the account holds a position overnight.
 *
 * This function does NOT deduplicate. It reconciles the deals it is handed.
 * Callers that read the deals table must run them through dedupeDeals first,
 * or duplicate rows will inflate the explained figure and hide a real capital
 * event. interlock.ts composes the two correctly.
 */
import type { Cents } from "@/lib/compound/engine/money";
import { utcDateKey } from "./date-key";
import { dealNetCents, type ClosedDeal, type DailySnapshot } from "./types";

export interface DayReconciliation {
  /** The snapshot day being explained, YYYY-MM-DD. */
  tradeDate: string;
  /** The previous available snapshot day. The interval is (previousDate, tradeDate]. */
  previousDate: string;
  /** Signed. Balance at tradeDate minus balance at previousDate. */
  balanceDeltaCents: Cents;
  /** Signed. Net of every trade closing inside the interval. */
  explainedCents: Cents;
  /** Signed. balanceDelta − explained. Non-zero means capital moved. */
  unexplainedCents: Cents;
  isExplained: boolean;
}

function abs(n: Cents): Cents {
  return n < 0n ? -n : n;
}

export function reconcileDays(
  snapshots: readonly DailySnapshot[],
  deals: readonly ClosedDeal[],
  toleranceCents: Cents,
): DayReconciliation[] {
  if (toleranceCents < 0n) {
    throw new RangeError(`tolerance must be non-negative, got ${toleranceCents}`);
  }
  if (snapshots.length < 2) return [];

  const ordered = [...snapshots].sort((a, b) =>
    a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0,
  );

  // Bucket trades by the UTC day they closed, once, rather than re-scanning
  // the deal list for every interval.
  const netByDay = new Map<string, Cents>();
  for (const d of deals) {
    const k = utcDateKey(d.closeTime);
    netByDay.set(k, (netByDay.get(k) ?? 0n) + dealNetCents(d));
  }
  const closeDays = [...netByDay.keys()].sort();

  const out: DayReconciliation[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;

    // The interval is (previousDate, tradeDate] — half-open at the start, so a
    // trade is counted exactly once, and closed at the end. Snapshot series
    // have gaps (weekends, holidays), and a trade closing inside a gap belongs
    // to the next available day's balance move.
    let explained: Cents = 0n;
    for (const day of closeDays) {
      if (day > prev.tradeDate && day <= cur.tradeDate) {
        explained += netByDay.get(day) ?? 0n;
      }
    }

    const balanceDelta = cur.balanceCloseCents - prev.balanceCloseCents;
    const unexplained = balanceDelta - explained;

    out.push({
      tradeDate: cur.tradeDate,
      previousDate: prev.tradeDate,
      balanceDeltaCents: balanceDelta,
      explainedCents: explained,
      unexplainedCents: unexplained,
      isExplained: abs(unexplained) <= toleranceCents,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
pnpm test -- detect && pnpm typecheck
```

Expected: all PASS.

- [ ] **Step 5: Prove the tests bite**

Three probes, each reverted before the next.

1. Reconcile on equity: change both `balanceCloseCents` reads to `equityCloseCents`. Several tests still pass because the fixtures default equity to balance — note which ones fail and which do not, and say so in your report. This is a coverage observation worth recording.
2. Break interval attribution: change `day > prev.tradeDate` to `day === cur.tradeDate`. The gap test `"attributes trades closing inside a gap to the next available day"` must FAIL.
3. Break the tolerance boundary: change `<= toleranceCents` to `< toleranceCents`. `"treats a gap exactly at tolerance as explained"` must FAIL.

- [ ] **Step 6: Commit**

```bash
git add lib/compound/reconcile/detect.ts lib/compound/reconcile/detect.test.ts
git commit -m "feat(reconcile): reconcile daily balance moves against closed-trade P/L"
```

---

### Task 4: `interlock.ts` — plan the readings, and stop dead at the first unexplained day

This is the safety property the whole plan exists for. Spec §5.3.

**Files:**
- Create: `lib/compound/reconcile/interlock.ts`
- Test: `lib/compound/reconcile/interlock.test.ts`

**Interfaces:**
- Consumes: `dedupeDeals` from `./dedupe`; `reconcileDays` from `./detect`; `ClosedDeal`, `DailySnapshot` from `./types`; `Cents` from `@/lib/compound/engine/money`
- Produces:
  - `interface ReconcileCursor { lastReadingDate: string | null }`
  - `interface PlannedReading { occurredOn: string; equityCents: Cents }`
  - `interface CapitalEventCandidate { tradeDate: string; previousDate: string; balanceDeltaCents: Cents; explainedCents: Cents; unexplainedCents: Cents }`
  - `type ReadingPlan = { kind: "idle" } | { kind: "advance"; readings: PlannedReading[]; newCursorDate: string } | { kind: "halt"; readings: PlannedReading[]; newCursorDate: string | null; candidate: CapitalEventCandidate }`
  - `planReadings(input: { snapshots; deals; cursor; brokerOffsetHours; toleranceCents }): ReadingPlan`

- [ ] **Step 1: Write the failing tests**

Create `lib/compound/reconcile/interlock.test.ts`:

```typescript
import { planReadings } from "./interlock";
import type { ClosedDeal, DailySnapshot } from "./types";

function snap(tradeDate: string, balance: bigint, equity = balance): DailySnapshot {
  return { tradeDate, balanceCloseCents: balance, equityCloseCents: equity };
}

let nextTicket = 1;
beforeEach(() => { nextTicket = 1; });

function closed(closeTime: string, netCents: bigint): ClosedDeal {
  nextTicket += 1;
  return {
    ticket: nextTicket, symbol: "GBPUSD", side: "buy", volumeMilliLots: 10,
    openTime: "2026-05-01T07:00:00Z", closeTime,
    profitCents: netCents, swapCents: 0n, commissionCents: 0n,
  };
}

const BASE = {
  brokerOffsetHours: 3,
  toleranceCents: 0n,
};

describe("planReadings — nothing to do", () => {
  it("is idle with no snapshots", () => {
    expect(planReadings({ ...BASE, snapshots: [], deals: [], cursor: { lastReadingDate: null } }))
      .toEqual({ kind: "idle" });
  });

  it("is idle when the cursor is already at the last snapshot", () => {
    expect(planReadings({
      ...BASE,
      snapshots: [snap("2026-05-02", 100n), snap("2026-05-03", 100n)],
      deals: [],
      cursor: { lastReadingDate: "2026-05-03" },
    })).toEqual({ kind: "idle" });
  });
});

describe("planReadings — a clean run", () => {
  it("posts the first snapshot as a baseline when the cursor is empty", () => {
    const plan = planReadings({
      ...BASE,
      snapshots: [snap("2026-05-02", 30_941n, 30_941n)],
      deals: [],
      cursor: { lastReadingDate: null },
    });
    expect(plan.kind).toBe("advance");
    if (plan.kind !== "advance") throw new Error("expected advance");
    expect(plan.readings).toEqual([{ occurredOn: "2026-05-02", equityCents: 30_941n }]);
    expect(plan.newCursorDate).toBe("2026-05-02");
  });

  it("posts equity, not balance", () => {
    const plan = planReadings({
      ...BASE,
      snapshots: [snap("2026-05-02", 30_941n, 31_500n)],
      deals: [],
      cursor: { lastReadingDate: null },
    });
    if (plan.kind !== "advance") throw new Error("expected advance");
    expect(plan.readings[0]!.equityCents).toBe(31_500n);
  });

  it("advances through every explained day", () => {
    const plan = planReadings({
      ...BASE,
      snapshots: [
        snap("2026-05-02", 100_000n, 100_000n),
        snap("2026-05-03", 101_000n, 101_200n),
        snap("2026-05-04", 102_500n, 102_500n),
      ],
      deals: [closed("2026-05-03T10:00:00Z", 1_000n), closed("2026-05-04T10:00:00Z", 1_500n)],
      cursor: { lastReadingDate: null },
    });
    if (plan.kind !== "advance") throw new Error("expected advance");
    expect(plan.readings.map((r) => r.occurredOn)).toEqual(["2026-05-02", "2026-05-03", "2026-05-04"]);
    expect(plan.readings.map((r) => r.equityCents)).toEqual([100_000n, 101_200n, 102_500n]);
    expect(plan.newCursorDate).toBe("2026-05-04");
  });

  it("resumes from a cursor without re-posting earlier days", () => {
    const plan = planReadings({
      ...BASE,
      snapshots: [
        snap("2026-05-02", 100_000n), snap("2026-05-03", 101_000n), snap("2026-05-04", 102_500n),
      ],
      deals: [closed("2026-05-03T10:00:00Z", 1_000n), closed("2026-05-04T10:00:00Z", 1_500n)],
      cursor: { lastReadingDate: "2026-05-03" },
    });
    if (plan.kind !== "advance") throw new Error("expected advance");
    expect(plan.readings.map((r) => r.occurredOn)).toEqual(["2026-05-04"]);
  });
});

describe("planReadings — THE INTERLOCK", () => {
  const snapshots = [
    snap("2026-06-22", 100_000n, 100_000n),
    snap("2026-06-23", 101_000n, 101_000n),
    snap("2026-06-24", 102_000n, 102_000n),
    snap("2026-06-25", 133_000n, 133_000n), // +31,000 with no trade — a deposit
    snap("2026-06-26", 134_000n, 134_000n),
    snap("2026-06-27", 135_000n, 135_000n),
  ];
  const deals = [
    closed("2026-06-23T10:00:00Z", 1_000n),
    closed("2026-06-24T10:00:00Z", 1_000n),
    closed("2026-06-26T10:00:00Z", 1_000n),
    closed("2026-06-27T10:00:00Z", 1_000n),
  ];

  function run() {
    return planReadings({ ...BASE, snapshots, deals, cursor: { lastReadingDate: null } });
  }

  it("halts rather than advancing", () => {
    expect(run().kind).toBe("halt");
  });

  it("reports the candidate with both ends and the unexplained amount", () => {
    const plan = run();
    if (plan.kind !== "halt") throw new Error("expected halt");
    expect(plan.candidate.tradeDate).toBe("2026-06-25");
    expect(plan.candidate.previousDate).toBe("2026-06-24");
    expect(plan.candidate.balanceDeltaCents).toBe(31_000n);
    expect(plan.candidate.explainedCents).toBe(0n);
    expect(plan.candidate.unexplainedCents).toBe(31_000n);
  });

  it("posts every day up to the one before, and NOT ONE DAY MORE", () => {
    const plan = run();
    if (plan.kind !== "halt") throw new Error("expected halt");
    expect(plan.readings.map((r) => r.occurredOn)).toEqual([
      "2026-06-22", "2026-06-23", "2026-06-24",
    ]);
    expect(plan.newCursorDate).toBe("2026-06-24");
  });

  it("never posts a reading on or after the unexplained day", () => {
    const plan = run();
    if (plan.kind !== "halt") throw new Error("expected halt");
    for (const r of plan.readings) {
      expect(r.occurredOn < plan.candidate.tradeDate).toBe(true);
    }
  });

  it("stays halted on the same day when re-run after posting", () => {
    // The manager posted what was offered. Running again must halt on the same
    // candidate, not step past it.
    const plan = planReadings({
      ...BASE, snapshots, deals, cursor: { lastReadingDate: "2026-06-24" },
    });
    if (plan.kind !== "halt") throw new Error("expected halt");
    expect(plan.readings).toEqual([]);
    expect(plan.candidate.tradeDate).toBe("2026-06-25");
    expect(plan.newCursorDate).toBe("2026-06-24");
  });

  it("halts on the FIRST unexplained day when there are several", () => {
    const withTwo = [...snapshots, snap("2026-06-28", 200_000n, 200_000n)];
    const plan = planReadings({
      ...BASE, snapshots: withTwo, deals, cursor: { lastReadingDate: null },
    });
    if (plan.kind !== "halt") throw new Error("expected halt");
    expect(plan.candidate.tradeDate).toBe("2026-06-25");
  });
});

describe("planReadings — dedupe is applied", () => {
  it("does not invent a candidate from duplicate deals", () => {
    // One genuine trade and its broker-offset twin. Counting both would double
    // the explained figure and manufacture an unexplained shortfall.
    const genuine = closed("2026-05-03T08:31:00Z", 1_000n);
    const twin: ClosedDeal = {
      ...genuine,
      ticket: 9_000,
      openTime: new Date(Date.parse(genuine.openTime) + 3 * 3_600_000).toISOString(),
      closeTime: new Date(Date.parse(genuine.closeTime) + 3 * 3_600_000).toISOString(),
    };
    const plan = planReadings({
      ...BASE,
      snapshots: [snap("2026-05-02", 100_000n), snap("2026-05-03", 101_000n)],
      deals: [genuine, twin],
      cursor: { lastReadingDate: null },
    });
    expect(plan.kind).toBe("advance");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test -- interlock
```

Expected: FAIL — `Cannot find module './interlock'`.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * The safety interlock. See the design spec, §5.3.
 *
 *   When the reconciler finds a balance move that closed trades do not
 *   explain, it creates a candidate and stops advancing readings past the
 *   preceding day. NAV never crosses an unclassified capital event.
 *
 * One unresolved candidate freezes the figures until it is classified. That is
 * deliberate. The failure it prevents is the most expensive one available in
 * this product: an unrecorded deposit is indistinguishable from profit, and
 * profit gets split. Letting the next reading land would silently redistribute
 * that capital to people who did not contribute it.
 *
 * This module composes dedupe and detect, and is the entry point callers
 * should use. Reconciling without deduplicating first inflates the explained
 * figure and can hide a real capital event.
 */
import type { Cents } from "@/lib/compound/engine/money";
import { dedupeDeals } from "./dedupe";
import { reconcileDays } from "./detect";
import type { ClosedDeal, DailySnapshot } from "./types";

export interface ReconcileCursor {
  /** YYYY-MM-DD of the last posted reading; null when nothing has been posted. */
  lastReadingDate: string | null;
}

export interface PlannedReading {
  occurredOn: string;
  equityCents: Cents;
}

export interface CapitalEventCandidate {
  tradeDate: string;
  previousDate: string;
  balanceDeltaCents: Cents;
  explainedCents: Cents;
  unexplainedCents: Cents;
}

export type ReadingPlan =
  | { kind: "idle" }
  | { kind: "advance"; readings: PlannedReading[]; newCursorDate: string }
  | {
      kind: "halt";
      readings: PlannedReading[];
      newCursorDate: string | null;
      candidate: CapitalEventCandidate;
    };

export interface PlanInput {
  snapshots: readonly DailySnapshot[];
  deals: readonly ClosedDeal[];
  cursor: ReconcileCursor;
  brokerOffsetHours: number;
  toleranceCents: Cents;
}

export function planReadings(input: PlanInput): ReadingPlan {
  const { snapshots, deals, cursor, brokerOffsetHours, toleranceCents } = input;
  if (snapshots.length === 0) return { kind: "idle" };

  const ordered = [...snapshots].sort((a, b) =>
    a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0,
  );
  const equityByDate = new Map(ordered.map((s) => [s.tradeDate, s.equityCloseCents]));

  const { kept } = dedupeDeals(deals, brokerOffsetHours);
  const days = reconcileDays(ordered, kept, toleranceCents);

  const readings: PlannedReading[] = [];
  let cursorDate = cursor.lastReadingDate;

  // With an empty cursor the earliest snapshot is the baseline. Its balance
  // move is unknowable — nothing precedes it — so it cannot be reconciled and
  // is posted as-is. Everything after it is reconciled normally.
  const first = ordered[0]!;
  if (cursorDate === null) {
    readings.push({ occurredOn: first.tradeDate, equityCents: first.equityCloseCents });
    cursorDate = first.tradeDate;
  }

  for (const day of days) {
    if (day.tradeDate <= cursorDate) continue;

    if (!day.isExplained) {
      return {
        kind: "halt",
        readings,
        newCursorDate: readings.length > 0
          ? readings[readings.length - 1]!.occurredOn
          : cursor.lastReadingDate,
        candidate: {
          tradeDate: day.tradeDate,
          previousDate: day.previousDate,
          balanceDeltaCents: day.balanceDeltaCents,
          explainedCents: day.explainedCents,
          unexplainedCents: day.unexplainedCents,
        },
      };
    }

    readings.push({
      occurredOn: day.tradeDate,
      equityCents: equityByDate.get(day.tradeDate) ?? 0n,
    });
  }

  if (readings.length === 0) return { kind: "idle" };
  return {
    kind: "advance",
    readings,
    newCursorDate: readings[readings.length - 1]!.occurredOn,
  };
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
pnpm test -- interlock && pnpm typecheck
```

Expected: all PASS.

- [ ] **Step 5: Prove the interlock bites**

Three probes, each reverted before the next. These are the most important checks in the plan.

1. Remove the halt: change `if (!day.isExplained)` to `if (false)`. `"halts rather than advancing"` and `"never posts a reading on or after the unexplained day"` must both FAIL.
2. Off-by-one the halt: move the `readings.push` above the `isExplained` check, so the unexplained day is posted before halting. `"posts every day up to the one before, and NOT ONE DAY MORE"` must FAIL, and `"never posts a reading on or after the unexplained day"` must FAIL. This is the specific bug the interlock exists to prevent — confirm the suite catches it.
3. Skip dedupe: change `dedupeDeals(deals, brokerOffsetHours)` to `{ kept: deals }`. `"does not invent a candidate from duplicate deals"` must FAIL.

Record each failing output and how many other tests still passed.

- [ ] **Step 6: Commit**

```bash
git add lib/compound/reconcile/interlock.ts lib/compound/reconcile/interlock.test.ts
git commit -m "feat(reconcile): the safety interlock — never post past an unexplained balance move"
```

---

### Task 5: Property suite for the interlock

The unit tests pin specific scenarios. This proves the safety property holds across arbitrary snapshot and deal sequences.

**Files:**
- Create: `lib/compound/reconcile/reconcile.property.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4
- Produces: no exports

- [ ] **Step 1: Write the property suite**

```typescript
import fc from "fast-check";
import { dedupeDeals } from "./dedupe";
import { reconcileDays } from "./detect";
import { planReadings } from "./interlock";
import type { ClosedDeal, DailySnapshot } from "./types";

const OFFSET_HOURS = 3;

/** Sequential trading days from a fixed start, so dates are always ordered. */
function dateAt(i: number): string {
  return new Date(Date.UTC(2026, 4, 2) + i * 86_400_000).toISOString().slice(0, 10);
}

interface Day {
  tradedCents: bigint;
  capitalCents: bigint;
  skipped: boolean;
}

const dayArb: fc.Arbitrary<Day> = fc.record({
  tradedCents: fc.bigInt({ min: -50_000n, max: 50_000n }),
  // Mostly zero: a capital event is the exception, not the rule.
  capitalCents: fc.oneof(
    { arbitrary: fc.constant(0n), weight: 5 },
    { arbitrary: fc.bigInt({ min: -100_000n, max: 100_000n }), weight: 1 },
  ),
  skipped: fc.boolean(),
});

/** Build a consistent snapshot series and matching deals from generated days. */
function build(days: readonly Day[]): { snapshots: DailySnapshot[]; deals: ClosedDeal[] } {
  const snapshots: DailySnapshot[] = [];
  const deals: ClosedDeal[] = [];
  let balance = 100_000n;
  let ticket = 1;

  snapshots.push({ tradeDate: dateAt(0), balanceCloseCents: balance, equityCloseCents: balance });

  days.forEach((d, i) => {
    const date = dateAt(i + 1);
    balance += d.tradedCents + d.capitalCents;
    if (d.tradedCents !== 0n) {
      ticket += 1;
      deals.push({
        ticket, symbol: "GBPUSD", side: "buy", volumeMilliLots: 10,
        openTime: `${date}T07:00:00.000Z`,
        closeTime: `${date}T12:00:00.000Z`,
        profitCents: d.tradedCents, swapCents: 0n, commissionCents: 0n,
      });
    }
    // A skipped day models a weekend: the trade still closes, but no snapshot
    // is written until the next available day.
    if (!d.skipped) {
      snapshots.push({ tradeDate: date, balanceCloseCents: balance, equityCloseCents: balance });
    }
  });

  return { snapshots, deals };
}

describe("reconciler properties", () => {
  it("never plans a reading on or after the day it halted on", () => {
    fc.assert(
      fc.property(fc.array(dayArb, { minLength: 1, maxLength: 30 }), (days) => {
        const { snapshots, deals } = build(days);
        const plan = planReadings({
          snapshots, deals,
          cursor: { lastReadingDate: null },
          brokerOffsetHours: OFFSET_HOURS,
          toleranceCents: 0n,
        });
        if (plan.kind !== "halt") return true;
        for (const r of plan.readings) {
          if (r.occurredOn >= plan.candidate.tradeDate) {
            throw new Error(
              `posted ${r.occurredOn} at or past the unexplained day ${plan.candidate.tradeDate}`,
            );
          }
        }
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("plans readings in strictly ascending date order, with no repeats", () => {
    fc.assert(
      fc.property(fc.array(dayArb, { minLength: 1, maxLength: 30 }), (days) => {
        const { snapshots, deals } = build(days);
        const plan = planReadings({
          snapshots, deals,
          cursor: { lastReadingDate: null },
          brokerOffsetHours: OFFSET_HOURS,
          toleranceCents: 0n,
        });
        if (plan.kind === "idle") return true;
        const dates = plan.readings.map((r) => r.occurredOn);
        for (let i = 1; i < dates.length; i += 1) {
          if (dates[i]! <= dates[i - 1]!) {
            throw new Error(`readings out of order: ${dates[i - 1]} then ${dates[i]}`);
          }
        }
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("a run with no capital events posts every snapshot", () => {
    fc.assert(
      fc.property(fc.array(dayArb, { minLength: 1, maxLength: 30 }), (days) => {
        const clean = days.map((d) => ({ ...d, capitalCents: 0n }));
        const { snapshots, deals } = build(clean);
        const plan = planReadings({
          snapshots, deals,
          cursor: { lastReadingDate: null },
          brokerOffsetHours: OFFSET_HOURS,
          toleranceCents: 0n,
        });
        if (plan.kind !== "advance") {
          throw new Error(`expected advance with no capital events, got ${plan.kind}`);
        }
        if (plan.readings.length !== snapshots.length) {
          throw new Error(`posted ${plan.readings.length} of ${snapshots.length} snapshots`);
        }
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("resuming from the returned cursor never re-posts or skips a day", () => {
    fc.assert(
      fc.property(fc.array(dayArb, { minLength: 1, maxLength: 30 }), (days) => {
        const { snapshots, deals } = build(days);
        const args = { snapshots, deals, brokerOffsetHours: OFFSET_HOURS, toleranceCents: 0n };

        const first = planReadings({ ...args, cursor: { lastReadingDate: null } });
        if (first.kind === "idle") return true;

        const second = planReadings({ ...args, cursor: { lastReadingDate: first.newCursorDate } });
        if (second.kind === "idle") return true;

        for (const r of second.readings) {
          if (first.readings.some((f) => f.occurredOn === r.occurredOn)) {
            throw new Error(`re-posted ${r.occurredOn} on resume`);
          }
        }
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("dedupe never changes the net of the deals it keeps when there are no twins", () => {
    fc.assert(
      fc.property(fc.array(dayArb, { minLength: 1, maxLength: 20 }), (days) => {
        const { deals } = build(days);
        const r = dedupeDeals(deals, OFFSET_HOURS);
        if (r.dropped.length !== 0) {
          throw new Error(`dropped ${r.dropped.length} deals from a twin-free series`);
        }
        if (r.kept.length !== deals.length) {
          throw new Error(`kept ${r.kept.length} of ${deals.length}`);
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("every reconciled interval covers each trade exactly once", () => {
    fc.assert(
      fc.property(fc.array(dayArb, { minLength: 2, maxLength: 30 }), (days) => {
        const { snapshots, deals } = build(days);
        if (snapshots.length < 2) return true;
        const rec = reconcileDays(snapshots, deals, 0n);
        const totalExplained = rec.reduce((s, d) => s + d.explainedCents, 0n);
        // Every trade closes on or after the first snapshot date, so the
        // intervals together must account for all of them.
        const totalNet = deals
          .filter((d) => d.closeTime.slice(0, 10) > snapshots[0]!.tradeDate)
          .reduce((s, d) => s + d.profitCents + d.swapCents + d.commissionCents, 0n);
        if (totalExplained !== totalNet) {
          throw new Error(`intervals explained ${totalExplained}, deals net ${totalNet}`);
        }
        return true;
      }),
      { numRuns: 400 },
    );
  });
});
```

- [ ] **Step 2: Run the suite**

```bash
pnpm test -- reconcile.property
```

Expected: PASS. If fast-check reports a counterexample, it prints the exact day sequence. **Do not weaken an assertion or widen a skip to make it pass** — investigate what the counterexample proves. If the reconciler has a real bug, STOP and report it with the counterexample rather than fixing it here; a change to Tasks 1–4 needs its own review.

- [ ] **Step 3: Prove the safety property bites**

In `interlock.ts`, temporarily move the `readings.push` above the `isExplained` check so the unexplained day gets posted. Run the property suite and confirm `"never plans a reading on or after the day it halted on"` FAILS with a counterexample. Revert and confirm green. Record both outputs, and confirm `git diff lib/compound/reconcile/interlock.ts` is empty before committing.

- [ ] **Step 4: Run every gate**

```bash
pnpm typecheck && pnpm test
```

Expected: typecheck clean, all suites pass including the engine's 125.

- [ ] **Step 5: Commit and push**

```bash
git add lib/compound/reconcile/reconcile.property.test.ts
git commit -m "test(reconcile): property suite for the interlock's safety invariant"
git push origin HEAD
```

---

## Plan self-review

**Spec coverage.**

| Spec | Task |
|---|---|
| §5.2 reconcile on balance, post on equity | 3, 4 |
| §5.2 dedupe before detect | 4 (composition), 2 (rule) |
| §5.3 the safety interlock | 4, 5 |
| §6.3 duplicate-deal rule and its narrowness | 2 |
| §5.1 `reconcile/` is pure | 1 (guard) |
| §4 integer money throughout | 1, 3 |

Not covered here, by design: persistence of candidates and the cursor (plan 3), the review-queue UI (plan 4), and `account_snapshots_current` for live NAV, which is a display concern rather than a reconciliation one.

**Type consistency.** `DailySnapshot`, `ClosedDeal`, `DayReconciliation`, `ReconcileCursor`, `PlannedReading`, `CapitalEventCandidate` and `ReadingPlan` are each defined once and referenced by the same names throughout. `dealNetCents`, `utcDateKey`, `absGapMs`, `dedupeDeals`, `reconcileDays` and `planReadings` are each defined in exactly one task and used consistently after it.

**Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Every code step carries its code.

**Known thin spot, stated rather than hidden.** Task 3's probe 1 (reconciling on equity instead of balance) will leave several tests passing, because the `snap()` helper defaults equity to balance. The implementer is asked to record which tests survive that probe. If the answer is "most of them", the fixtures need an equity/balance divergence and that is worth a ruling during execution.
