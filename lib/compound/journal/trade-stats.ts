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
