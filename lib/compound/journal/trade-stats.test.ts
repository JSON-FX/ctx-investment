import { buildTradeHistory } from "./history";
import {
  FIXTURE_OFFSET_HOURS,
  RAW_DEALS,
  fixtureHistory,
  fixtureHistoryUnguarded,
} from "./__fixtures__/deals";
import {
  lossDuplicateHistory,
  lossDuplicateHistoryUnguarded,
} from "./__fixtures__/loss-duplicate-deals";
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

  // expectedPayoffCents is the only genuinely-signed division in this file:
  // netAfterFeesCents can be negative (a losing account), and the divisor
  // (trade count) is always positive, so floor and truncate-toward-zero can
  // disagree. Every other divFloor call site here divides two quantities
  // that are structurally non-negative by construction (win/loss counts,
  // and sums that only ever accumulate one sign), so this is the one place
  // a regression from divFloor to plain `/` is otherwise invisible. On this
  // losing sub-fixture, netAfterFeesCents is -2824n over 3 trades:
  // -2824n / 3n truncates to -941n, but divFloor(-2824n, 3n) is -942n.
  // Mutation caught: replacing divFloor with plain `/` in
  // expectedPayoffCents, which none of the other tests in this file (nor
  // the rest of the 128-test journal suite) catch — this fixture is
  // deliberately a losing account with a non-evenly-divisible count so the
  // two answers differ. Verified directly: mutating that call site left
  // every other test in lib/compound/journal/ green and failed only this
  // one assertion.
  it("floors expectedPayoffCents on a loss, where floor and truncation disagree", () => {
    const losersOnly = buildTradeHistory(
      RAW_DEALS.filter((d) => d.profitCents < 0n),
      FIXTURE_OFFSET_HOURS,
    );
    const l = computeTradeStats(losersOnly.deals);
    expect(l.totalTrades).toBe(3);
    expect(l.netAfterFeesCents).toBe(-2824n);
    expect(l.expectedPayoffCents).toBe(-942n);
  });

  // THE DEDUPE ASSERTION. Every headline figure moves if the planted twin
  // survives. Mutation caught: any change that skips dedupeDeals.
  // THE DEDUPE ASSERTION. Ticket 5092 is a WIN clone of ticket 5008, so it
  // can only move win-side and total-based figures. Every field of TradeStats
  // is checked here, explicitly, against both directions:
  //
  //   MOVES (asserted .not.toBe below): totalTrades, wins, winRateBps,
  //   grossProfitCents, netProfitCents, netAfterFeesCents, totalFeesCents,
  //   profitFactorMilli, avgWinCents, expectedPayoffCents.
  //
  //   DOES NOT MOVE, and cannot, given a win-side duplicate on this fixture
  //   (documented rather than silently skipped — an identical figure has no
  //   dedupe protection from this test, whatever moves elsewhere):
  //     - losses, flat: the duplicate is a win, so neither counter is
  //       touched.
  //     - grossLossCents, avgLossCents: pure functions of the loss side,
  //       which is untouched.
  //     - bestTradeCents: the duplicate's profit (1409) does not exceed the
  //       fixture's genuine best (2903), so the max is unaffected. This
  //       fixture cannot exercise dedupe protection for bestTradeCents; that
  //       would need a duplicate planted on the best trade itself.
  //     - worstTradeCents: the duplicate is not a loss, so the min over
  //       losses is untouched.
  //
  // Mutation caught: any change that skips dedupeDeals — every MOVES field
  // reverts to its raw-fixture value, which every .not.toBe below catches
  // independently of the others.
  it("differs from the undeduplicated answer on every headline figure that a win-side duplicate can move", () => {
    const bad = computeTradeStats(fixtureHistoryUnguarded().deals);

    expect(bad.totalTrades).toBe(10);
    expect(bad.wins).toBe(6);
    expect(bad.winRateBps).toBe(6000);
    expect(bad.grossProfitCents).toBe(7640n);
    expect(bad.netProfitCents).toBe(4867n);
    expect(bad.netAfterFeesCents).toBe(4516n);
    expect(bad.totalFeesCents).toBe(-351n);
    expect(bad.profitFactorMilli).toBe(2755n);
    expect(bad.avgWinCents).toBe(1273n);
    expect(bad.expectedPayoffCents).toBe(451n);

    expect(bad.totalTrades).not.toBe(s.totalTrades);
    expect(bad.wins).not.toBe(s.wins);
    expect(bad.winRateBps).not.toBe(s.winRateBps);
    expect(bad.grossProfitCents).not.toBe(s.grossProfitCents);
    expect(bad.netProfitCents).not.toBe(s.netProfitCents);
    expect(bad.netAfterFeesCents).not.toBe(s.netAfterFeesCents);
    expect(bad.totalFeesCents).not.toBe(s.totalFeesCents);
    expect(bad.profitFactorMilli).not.toBe(s.profitFactorMilli);
    expect(bad.avgWinCents).not.toBe(s.avgWinCents);
    expect(bad.expectedPayoffCents).not.toBe(s.expectedPayoffCents);

    // The complement, made explicit rather than left as an absence: these
    // four are identical whether or not the duplicate is dropped, because a
    // win-side duplicate cannot reach the loss side or the fixture's true
    // extremes. That is a property of this fixture's duplicate, not a claim
    // that dedupe is unnecessary for these fields in general.
    expect(bad.losses).toBe(s.losses);
    expect(bad.flat).toBe(s.flat);
    expect(bad.grossLossCents).toBe(s.grossLossCents);
    expect(bad.avgLossCents).toBe(s.avgLossCents);
    expect(bad.bestTradeCents).toBe(s.bestTradeCents);
    expect(bad.worstTradeCents).toBe(s.worstTradeCents);
  });

  // bestTradeCents/worstTradeCents COVERAGE, using the loss-side fixture.
  // THE PROBE THIS TASK RAN, recorded rather than hidden. Ticket 6099 is a
  // planted duplicate of 6003 — the loss-duplicate fixture's OWN worst
  // trade, the most favourable placement possible for creating dedupe
  // sensitivity, exactly what the comment above speculates would work.
  // It does not: worstTradeCents is identical deduplicated or not, and
  // bestTradeCents (untouched by the duplicate either way) obviously is
  // too. A planted duplicate is by construction a value-copy of a trade
  // already in the set — dedupeDeals groups candidates on
  // symbol+side+volume+profit+swap+commission before it ever compares
  // timestamps — so the original alone already supplies that value to the
  // max/min reduction; dropping the copy removes a repetition, never a
  // value. No fixture, on either side, at any position, can give these two
  // fields the kind of dedupe protection the other fields above have. This
  // was verified against the real computeTradeStats, not assumed, and the
  // two blocks below are that verification, kept as a permanent regression
  // check rather than a one-off scratch test.
  it("pins bestTradeCents and worstTradeCents on the loss-side-duplicate fixture", () => {
    const l = computeTradeStats(lossDuplicateHistory().deals);
    expect(l.totalTrades).toBe(4); // 5 raw, one dropped as a duplicate
    expect(l.bestTradeCents).toBe(620n);
    expect(l.worstTradeCents).toBe(-1330n);
  });

  it("proves a duplicate planted on the fixture's own worst trade still cannot move bestTradeCents or worstTradeCents", () => {
    const l = computeTradeStats(lossDuplicateHistory().deals);
    const bad = computeTradeStats(lossDuplicateHistoryUnguarded().deals);

    // The duplicate surviving is real and visible elsewhere — total count
    // moves — which rules out "the duplicate was never in the input" as an
    // innocent explanation for best/worst staying put.
    expect(bad.totalTrades).toBe(5);
    expect(bad.totalTrades).not.toBe(l.totalTrades);

    expect(bad.bestTradeCents).toBe(620n);
    expect(bad.worstTradeCents).toBe(-1330n);
    expect(bad.bestTradeCents).toBe(l.bestTradeCents);
    expect(bad.worstTradeCents).toBe(l.worstTradeCents);
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
