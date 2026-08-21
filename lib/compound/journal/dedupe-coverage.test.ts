/**
 * chokepoint.test.ts proves nothing reaches around DedupedDeals' brand. This
 * proves the guard is actually load-bearing for every figure a surface shows
 * — one place, one list, so a new surface added later without a dedupe
 * assertion here is visible as a gap rather than a silent hope.
 *
 * `good` is the fixture run through buildTradeHistory with the guard active;
 * `bad` is the same raw deals with the guard disabled (brokerOffsetHours:
 * null), which is the "not-configured" branch in history.ts — the only way
 * to get an undeduplicated DedupedDeals value without bypassing the brand.
 * The planted duplicate (ticket 5092, see __fixtures__/deals.ts's header)
 * is what makes the two differ.
 */
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
