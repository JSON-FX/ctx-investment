import { computeTradeEquity } from "./trade-equity";
import { buildTradeHistory } from "./history";
import { dealNetCents, type ClosedDeal } from "@/lib/compound/reconcile/types";
import type { DedupedDeals } from "./history";
import {
  FIXTURE_OFFSET_HOURS,
  RAW_DEALS,
  fixtureHistory,
  fixtureHistoryUnguarded,
} from "./__fixtures__/deals";

/**
 * A minimal ClosedDeal for tests that construct DedupedDeals directly,
 * bypassing buildTradeHistory so the input order is under the test's
 * control. swap and commission are zero, so profitCents === dealNetCents.
 */
function D(ticket: number, closeTime: string, profitCents: bigint): ClosedDeal {
  return {
    ticket,
    symbol: "EURUSD",
    side: "buy",
    volumeMilliLots: 10,
    openTime: closeTime,
    closeTime,
    profitCents,
    swapCents: 0n,
    commissionCents: 0n,
  };
}

describe("computeTradeEquity", () => {
  const r = computeTradeEquity(fixtureHistory().deals);

  // NOT a sort mutation catcher, despite appearances — see the dedicated
  // "sorts by close time itself" test below for why, and for the test that
  // actually catches it. `RAW_DEALS`'s own declaration is scrambled, but
  // `fixtureHistory()` runs it through `buildTradeHistory`, whose dedupe path
  // (`dedupeDeals`) always returns `kept` sorted by ticket, and in this
  // fixture ticket order already equals close-time order (5001..5009 close
  // in that order). So `computeTradeEquity` receives already-correctly-
  // ordered input before its own `.sort()` ever runs, and dropping that sort
  // is invisible against this input — confirmed by actually running that
  // mutation (see the report's probe table). This test still pins the
  // correct order and is not decorative for anything else that could shuffle
  // it (e.g. a `Map` keyed on ticket, iterated in insertion order).
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

  // A curve that only rises has zero drawdown at every point, not undefined
  // and not negative. Mutation caught: a peak seeded from the final value, or
  // any drawdown formula that goes negative when the curve is still climbing
  // (e.g. cum - peak instead of peak - cum).
  //
  // Filtered on dealNetCents, not profitCents. Ticket 5009 has gross profit
  // +5 but net -26 (fixture property 4) — filtering on gross would let a
  // net-negative deal into a fixture meant to be strictly rising, and the
  // curve would dip. dealNetCents(d) > 0n is what "monotonically rising"
  // actually requires. The filtered raw set still contains ticket 5092 (the
  // planted duplicate of 5008, also net-positive); buildTradeHistory dedupes
  // it away via the real pipeline, the same as every other test here.
  it("returns zero drawdown throughout a monotonically rising curve", () => {
    const winners = buildTradeHistory(
      RAW_DEALS.filter((d) => dealNetCents(d) > 0n),
      FIXTURE_OFFSET_HOURS,
    );
    expect(winners.deals.map((d) => d.ticket)).toEqual([5001, 5003, 5006, 5008]);
    const w = computeTradeEquity(winners.deals);
    expect(w.curve.map((p) => p.cumCents)).toEqual([1195n, 4016n, 4667n, 6020n]);
    expect(w.curve.every((p) => p.drawdownCents === 0n)).toBe(true);
    expect(w.maxDrawdownCents).toBe(0n);
    expect(w.currentDrawdownCents).toBe(0n);
    expect(w.peakCents).toBe(w.netCents);
    expect(w.netCents).toBe(6020n);
  });

  // THE ACTUAL sort-mutation catcher. Constructs DedupedDeals directly — a
  // legitimate cast in a .test.ts file; chokepoint.test.ts's brand-cast ban
  // scans only non-test sources — so the array computeTradeEquity receives
  // is under this test's control, not buildTradeHistory's ticket-normalized
  // output. Three deals, fed in an order that is neither close-time-
  // ascending nor ticket-ascending.
  it("sorts by close time itself, not by the order it happens to arrive in", () => {
    const raw: ClosedDeal[] = [
      D(9003, "2026-01-03T00:00:00.000Z", 300n),
      D(9001, "2026-01-01T00:00:00.000Z", 100n),
      D(9002, "2026-01-02T00:00:00.000Z", -50n),
    ];
    const out = computeTradeEquity(raw as unknown as DedupedDeals);
    expect(out.curve.map((p) => p.ticket)).toEqual([9001, 9002, 9003]);
    expect(out.curve.map((p) => p.cumCents)).toEqual([100n, 50n, 350n]);
  });

  // THE TIE-BREAK catcher, same technique. Two deals share one closeTime
  // exactly and are fed ticket-descending. Array.prototype.sort has been
  // stable since ES2019 (Node has honoured this since Node 11), so a
  // comparator that returns 0 for equal close times — i.e. the tie-break
  // removed — leaves stable-sort input order untouched and this would still
  // read [9202, 9201], not the tie-broken [9201, 9202]. Also unreachable
  // through the production entry point today, for the same structural reason
  // Task 4 found for streaks.ts: every real DedupedDeals is ticket-sorted by
  // dedupeDeals before computeTradeEquity ever sees it, and a same-second tie
  // in ticket-sorted input is already ticket-ascending. Correct and currently
  // unexercised by anything except this test — worth knowing, not worth
  // changing (a future caller building DedupedDeals from a source that is
  // not ticket-pre-sorted would need exactly this).
  it("breaks a same-instant tie by ticket ascending", () => {
    const raw: ClosedDeal[] = [
      D(9202, "2026-02-01T00:00:00.000Z", 70n),
      D(9201, "2026-02-01T00:00:00.000Z", 30n),
    ];
    const out = computeTradeEquity(raw as unknown as DedupedDeals);
    expect(out.curve.map((p) => p.ticket)).toEqual([9201, 9202]);
    expect(out.curve.map((p) => p.cumCents)).toEqual([30n, 100n]);
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
