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
