import type { DailySnapshot } from "@/lib/compound/reconcile/types";
import type { CumulativePoint } from "./trade-equity";
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
 *
 * Both arrays are scrambled in their own declaration order (see the inline
 * markers) and buildAccountEquitySeries is the direct entry point under
 * test — nothing upstream pre-sorts either array before it gets here, unlike
 * DedupedDeals (dedupeDeals always returns ticket-sorted output, which is
 * what let a dropped sort go unnoticed in Task 5's trade-equity.ts and
 * Task 4's streaks.ts). Deleting either .sort() call in the implementation
 * must therefore be visible to a test in this file — verified in the report,
 * not just asserted here.
 */
const SNAPSHOTS: DailySnapshot[] = [
  S("2026-05-05", 1_002_234n),
  S("2026-05-04", 999_413n), // out of order on purpose
  S("2026-05-11", 1_047_119n),
  S("2026-05-06", 1_000_712n),
  S("2026-05-08", 1_051_363n),
];

const MARKS: CapitalMarkInput[] = [
  { occurredOn: "2026-05-11", amountCents: 12_500n, direction: "out" }, // "a"
  { occurredOn: "2026-05-01", amountCents: 900_000n, direction: "in" }, // "b"
  { occurredOn: "2026-05-20", amountCents: 700n, direction: "out" }, // "c"
  { occurredOn: "2026-05-11", amountCents: 3_333n, direction: "in" }, // "d"
  { occurredOn: "2026-05-07", amountCents: 50_000n, direction: "in" }, // "e"
];

const build = (completeThrough: string | null = "2026-05-11") =>
  buildAccountEquitySeries({
    snapshots: SNAPSHOTS,
    marks: MARKS,
    marksCompleteThrough: completeThrough,
  });

describe("buildAccountEquitySeries", () => {
  const series = build();

  // Mutation caught: no sort on snapshots. The fixture is scrambled, and
  // nothing upstream of this call sorts it first — see the fixture comment.
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
    const after = series.points[3]!; // 2026-05-08
    expect(after.equityCents - before.equityCents).toBe(50_651n);
    expect(after.performanceCents - before.performanceCents).toBe(651n);
    expect(after.contributedCents - before.contributedCents).toBe(50_000n);
  });

  // Mutation caught: a Map keyed by date, or a `find` that stops at the first
  // match, either of which keeps one of the two 05-11 marks. The second
  // assertion additionally catches a same-day tie-break that reverses
  // input order (e.g. an unstable sort) — the total (940833) is order-
  // independent since addition commutes, so only pinning the sequence
  // itself, not just the sum, actually discriminates order.
  it("attributes both marks dated on the same day, in ledger order", () => {
    const may11 = series.points[4]!;
    expect(may11.marks).toHaveLength(2);
    expect(may11.marks.map((m) => m.amountCents)).toEqual([12_500n, 3_333n]);
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

  it("returns bigints for every money field on every point", () => {
    for (const p of series.points) {
      expect(typeof p.equityCents).toBe("bigint");
      expect(typeof p.contributedCents).toBe("bigint");
      expect(typeof p.performanceCents).toBe("bigint");
    }
  });

  // NOT a correctness check on contributedCents — a definitional-consistency
  // check. equity-series.ts sets performanceCents to
  // `snap.equityCloseCents - contributed` in the same object literal that
  // sets equityCents and contributedCents, so this identity holds by
  // construction for whatever value `contributed` happens to have, right or
  // wrong. Confirmed: forcing `contributed` to stay 0n throughout leaves
  // this assertion green while six other tests in this file (the ones that
  // pin contributedCents/performanceCents to specific numbers) correctly go
  // red. What this test actually guards: a future refactor that computes
  // performanceCents some other way, or from a stale copy of `contributed`,
  // so the three fields quietly drift out of sync with each other — a real
  // bug this would still catch, just not the one its old name implied.
  it("holds performanceCents = equity - contributed by definition (not a correctness check on contributed)", () => {
    for (const p of series.points) {
      expect(p.contributedCents + p.performanceCents).toBe(p.equityCents);
    }
  });
});

/**
 * Type-level proof for the report's "how the type system prevents a mark
 * landing on the wrong series" question, not just a documentation claim.
 *
 * EquityPoint (this module) and CumulativePoint (trade-equity.ts, Task 5's
 * trading-P/L curve) share zero field names — `date` vs `ts`, `equityCents`
 * vs `netCents`/`cumCents`, `marks` has no counterpart at all. Neither is
 * assignable to the other, so passing an equity-with-marks point where a
 * trading-P/L point belongs is a compile error, and there is no field on
 * CumulativePoint to attach a mark to even if one tried.
 *
 * This is checked, not just asserted: `@ts-expect-error` fails the build if
 * the marked line does NOT produce a type error (an unused directive is
 * itself a compiler error), so if trade-equity.ts ever grew a `marks` field
 * — closing the gap this test relies on — this file would stop compiling
 * and both `pnpm typecheck` and `pnpm test` would go red.
 */
function wantsTradingCurve(_curve: readonly CumulativePoint[]): void {
  void _curve;
}

it("cannot pass an equity-with-marks series where the trading P/L curve belongs", () => {
  const series = build();
  // @ts-expect-error — EquityPoint[] is missing ts/netCents/cumCents/
  // drawdownCents and carries fields (marks, contributedCents,
  // performanceCents) that CumulativePoint has no room for.
  wantsTradingCurve(series.points);
  expect(series.points.length).toBeGreaterThan(0);
});

it("cannot attach a mark to a single trading-P/L point either", () => {
  const point: CumulativePoint = {
    ts: "2026-01-01T00:00:00.000Z",
    ticket: 1,
    symbol: "EURUSD",
    netCents: 0n,
    cumCents: 0n,
    drawdownCents: 0n,
    // @ts-expect-error — CumulativePoint has no `marks` field; a capital
    // event cannot be represented on the trading-P/L curve at all.
    marks: [{ occurredOn: "2026-01-01", amountCents: 1n, direction: "in" }],
  };
  expect(point.ticket).toBe(1);
});
