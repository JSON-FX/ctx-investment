import { computeStreaks } from "./streaks";
import { buildTradeHistory } from "./history";
import type { DedupedDeals } from "./history";
import {
  FIXTURE_OFFSET_HOURS,
  RAW_DEALS,
  fixtureHistory,
  fixtureHistoryUnguarded,
} from "./__fixtures__/deals";

describe("computeStreaks", () => {
  const s = computeStreaks(fixtureHistory().deals);

  // Chronologically the deduplicated fixture is W L W L [flat] W L W W. This
  // pins the exact numbers on the shared fixture, which is worth having on
  // its own, but it is NOT the test that catches "no sort at all" — see the
  // probe note on the next test for why, and "sorts by close time..." below
  // for the assertion that actually does.
  it("reads the fixture in close-time order", () => {
    expect(s.maxWinStreak).toBe(2);
    expect(s.maxLossStreak).toBe(1);
    expect(s.currentStreak).toBe(2);
    expect(s.currentStreakKind).toBe("win");
  });

  // THE PROBE FOUND A GAP HERE, recorded rather than hidden. dedupeDeals
  // always returns `kept` ticket-sorted (reconcile/dedupe.ts's final
  // `kept.sort`), and in this fixture ticket order already equals
  // close-time order (5001..5009 were assigned in the order they close).
  // Deleting computeStreaks' `.sort()` entirely was tried against
  // `fixtureHistory().deals` during this task's mutation probe and left
  // every test in this file green — the test above included — because the
  // array it receives is already in the right order before computeStreaks
  // ever runs. That is exactly the "fixture too thin to discriminate"
  // shape the plan warns about, just one pipeline stage removed from where
  // it is usually found.
  //
  // This test closes the gap by constructing deals directly and casting to
  // DedupedDeals, bypassing buildTradeHistory's ticket-sort so the array
  // computeStreaks receives is in neither ticket nor close-time order.
  // Mutation caught: dropping the `.sort()` call (or any part of it) in
  // computeStreaks. Verified against the actual mutation, not predicted:
  // dropping the sort entirely turns W L W (maxWinStreak 1, current "win")
  // into W W L by array position (maxWinStreak 2, current "loss").
  it("sorts by close time, not by the order DedupedDeals happens to arrive in", () => {
    const base = RAW_DEALS[2]!;
    const d1 = { ...base, ticket: 501, closeTime: "2026-06-10T10:00:00.000Z", profitCents: 10n };
    const d2 = { ...base, ticket: 503, closeTime: "2026-06-08T10:00:00.000Z", profitCents: 20n };
    const d3 = { ...base, ticket: 502, closeTime: "2026-06-09T10:00:00.000Z", profitCents: -5n };
    // Array order is neither ticket order (501, 503, 502) nor close-time
    // order (d2, d3, d1) — only a real sort inside computeStreaks reads the
    // chronological sequence W(d2) L(d3) W(d1).
    const deals = [d1, d2, d3] as unknown as DedupedDeals;
    const out = computeStreaks(deals);
    expect(out.maxWinStreak).toBe(1);
    expect(out.maxLossStreak).toBe(1);
    expect(out.currentStreak).toBe(1);
    expect(out.currentStreakKind).toBe("win");
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

  // Real, but weaker than the comment used to claim: buildTradeHistory's own
  // final ticket-sort (reconcile/dedupe.ts) makes `[a, b]` and `[b, a]`
  // arrive at computeStreaks in the SAME ticket-sorted order either way, so
  // this cannot tell "has a tie-break" from "has none" — verified during
  // this task's mutation probe, which left it green with the tie-break
  // deleted. Kept because it still checks a real property (this module
  // produces one answer, not one that depends on caller-supplied order into
  // buildTradeHistory). The isolated tie-break test follows.
  it("is order-independent for trades closing in the same second", () => {
    const same = "2026-06-01T12:00:00.000Z";
    const a = { ...RAW_DEALS[2]!, ticket: 7001, closeTime: same, profitCents: 100n };
    const b = { ...RAW_DEALS[2]!, ticket: 7002, closeTime: same, profitCents: -100n };
    const forward = computeStreaks(buildTradeHistory([a, b], FIXTURE_OFFSET_HOURS).deals);
    const backward = computeStreaks(buildTradeHistory([b, a], FIXTURE_OFFSET_HOURS).deals);
    expect(forward).toEqual(backward);
    expect(forward.currentStreakKind).toBe("loss");
  });

  // THE PROBE FOUND A SECOND GAP HERE. Every legitimate DedupedDeals is
  // ticket-sorted before computeStreaks ever sees it (both branches of
  // buildTradeHistory guarantee it), so the test above can never present
  // same-second deals out of ticket order — the very case the tie-break
  // exists for. This test bypasses buildTradeHistory and casts directly, so
  // three same-second deals arrive in ticket-DESCENDING array order
  // (9003, 9002, 9001), which only an explicit `a.ticket - b.ticket`
  // tie-break can restore to ascending. All three share one closeTime, so
  // the primary comparator branch never fires and every ordering decision
  // is the tie-break alone. Mutation caught: `return 0` in place of the
  // ticket tie-break. Verified against the actual mutation, not predicted:
  // dropping just the tie-break (sort stays otherwise intact) leaves
  // maxWinStreak and maxLossStreak unchanged but flips currentStreak from
  // 2/"win" to 1/"loss", because JS's stable sort then preserves the
  // ticket-descending input order instead of correcting it.
  it("ticket tie-break reorders same-second deals that arrive ticket-descending", () => {
    const base = RAW_DEALS[2]!;
    const same = "2026-06-01T12:00:00.000Z";
    const high = { ...base, ticket: 9003, closeTime: same, profitCents: 10n };
    const mid = { ...base, ticket: 9002, closeTime: same, profitCents: 20n };
    const low = { ...base, ticket: 9001, closeTime: same, profitCents: -5n };
    // Correct ticket-ascending read is low(L) mid(W) high(W): current streak
    // is 2 wins. Handed in ticket-descending order on purpose.
    const deals = [high, mid, low] as unknown as DedupedDeals;
    const out = computeStreaks(deals);
    expect(out.currentStreak).toBe(2);
    expect(out.currentStreakKind).toBe("win");
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
