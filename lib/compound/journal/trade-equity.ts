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
import { maxBig } from "./int";

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
  /** Largest peak-to-trough decline anywhere on the curve. Zero for a curve
   * that only rises, or for no deals at all — never undefined, never negative. */
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
    // The peak is the running maximum of the curve, not the starting value
    // and not the final value — a curve that rises, falls, rises higher, then
    // falls further has its worst drawdown measured from this second peak.
    peak = maxBig(peak, cum);
    const dd = peak - cum;
    maxDd = maxBig(maxDd, dd);
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
