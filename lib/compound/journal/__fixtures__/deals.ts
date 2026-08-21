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
