/**
 * A second, focused fixture. Additive: the shared fixture in ./deals.ts is
 * unmodified, and no existing assertion anywhere changes because of this
 * file existing.
 *
 * WHY THIS EXISTS. The shared fixture's one planted duplicate (ticket 5092)
 * is win-side, so trade-stats.test.ts documents, correctly, that
 * bestTradeCents and worstTradeCents have no dedupe protection from it: the
 * duplicate's value (1409) is neither the fixture's best (2903) nor its
 * worst (-1511), so the max/min is unaffected whether or not it survives.
 * That test's comment speculates a fix: "this fixture cannot exercise
 * dedupe protection for bestTradeCents; that would need a duplicate planted
 * on the best trade itself."
 *
 * THIS FIXTURE TRIES EXACTLY THAT, on the loss side, and the speculation
 * does not hold up. TICKET 6099 is a planted duplicate of ticket 6003 —
 * identical symbol, side, volume, profit, swap and commission, both
 * timestamps shifted by exactly +5h, under a higher ticket — and ticket
 * 6003 is THIS fixture's worst trade, planted on deliberately, as the most
 * favourable placement possible for creating dedupe sensitivity.
 *
 * It still does not move worstTradeCents. See trade-stats.test.ts for the
 * proof: a duplicate is by definition a value-copy of a trade already in
 * the set (dedupeDeals groups on symbol+side+volume+profit+swap+commission
 * before it ever looks at timestamps), so the original alone already
 * supplies that value to the max/min reduction. Removing the copy removes
 * a repetition, never a value. This is not a property of this fixture or
 * of the shared one — no planted duplicate, on either side, at any
 * position, can move a min/max statistic. Confirmed against the real
 * computeTradeStats before this file was written, not assumed.
 *
 * What this fixture DOES protect, and is scoped to protect: nothing beyond
 * bestTradeCents and worstTradeCents. It is deliberately not exercised by
 * any other trade-stats.test.ts assertion — see that file for where it is
 * used.
 */
import type { ClosedDeal } from "@/lib/compound/reconcile/types";
import { buildTradeHistory, type TradeHistory } from "../history";

export const LOSS_FIXTURE_OFFSET_HOURS = 5;

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

export const LOSS_DUPLICATE_RAW_DEALS: readonly ClosedDeal[] = [
  // The fixture's best trade. Untouched by the duplicate; included so the
  // fixture can also pin bestTradeCents, not only prove worstTradeCents.
  D(6001, "EURUSD", "buy", 40, "2026-07-02T08:00:00.000Z", "2026-07-02T10:00:00.000Z", 620n, -5n, -15n),
  // A loss, but not the worst one — present so grossLossCents has more than
  // one contributor, matching the shared fixture's own convention.
  D(6002, "GBPUSD", "sell", 20, "2026-07-03T08:00:00.000Z", "2026-07-03T10:00:00.000Z", -741n, -8n, -12n),
  // THE FIXTURE'S WORST TRADE. Duplicated below, deliberately, on itself.
  D(6003, "XAUUSD", "sell", 30, "2026-07-04T08:00:00.000Z", "2026-07-04T10:00:00.000Z", -1330n, 0n, -20n),
  // THE PLANTED DUPLICATE: 6003 with both ends moved +5h, higher ticket.
  D(6099, "XAUUSD", "sell", 30, "2026-07-04T13:00:00.000Z", "2026-07-04T15:00:00.000Z", -1330n, 0n, -20n),
  D(6004, "BTCUSD", "buy", 5, "2026-07-05T08:00:00.000Z", "2026-07-05T10:00:00.000Z", 215n, -3n, -9n),
];

/** The deduplicated history the best/worst-trade tests start from. */
export function lossDuplicateHistory(): TradeHistory {
  return buildTradeHistory(LOSS_DUPLICATE_RAW_DEALS, LOSS_FIXTURE_OFFSET_HOURS);
}

/**
 * The same deals with the guard disabled, so a test can compare against the
 * deduplicated answer. Used only to prove the max/min invariance above.
 */
export function lossDuplicateHistoryUnguarded(): TradeHistory {
  return buildTradeHistory(LOSS_DUPLICATE_RAW_DEALS, null);
}
