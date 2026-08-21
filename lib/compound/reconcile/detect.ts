/**
 * Per-day reconciliation: does the balance move between two snapshots match
 * the trades that closed in between?
 *
 * Reconciles on BALANCE, deliberately. Deposits and withdrawals move balance;
 * floating P/L does not. Equity would drift with open positions and produce a
 * false unexplained figure every day the account holds a position overnight.
 *
 * This function does NOT deduplicate. It reconciles the deals it is handed.
 * Callers that read the deals table must run them through dedupeDeals first,
 * or duplicate rows will inflate the explained figure and hide a real capital
 * event. interlock.ts composes the two correctly.
 */
import type { Cents } from "@/lib/compound/engine/money";
import { utcDateKey } from "./date-key";
import { dealNetCents, type ClosedDeal, type DailySnapshot } from "./types";

export interface DayReconciliation {
  /** The snapshot day being explained, YYYY-MM-DD. */
  tradeDate: string;
  /** The previous available snapshot day. The interval is (previousDate, tradeDate]. */
  previousDate: string;
  /** Signed. Balance at tradeDate minus balance at previousDate. */
  balanceDeltaCents: Cents;
  /** Signed. Net of every trade closing inside the interval. */
  explainedCents: Cents;
  /** Signed. balanceDelta − explained. Non-zero means capital moved. */
  unexplainedCents: Cents;
  isExplained: boolean;
}

function abs(n: Cents): Cents {
  return n < 0n ? -n : n;
}

export function reconcileDays(
  snapshots: readonly DailySnapshot[],
  deals: readonly ClosedDeal[],
  toleranceCents: Cents,
): DayReconciliation[] {
  if (toleranceCents < 0n) {
    throw new RangeError(`tolerance must be non-negative, got ${toleranceCents}`);
  }
  if (snapshots.length < 2) return [];

  const ordered = [...snapshots].sort((a, b) =>
    a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0,
  );

  // Bucket trades by the UTC day they closed, once, rather than re-scanning
  // the deal list for every interval.
  const netByDay = new Map<string, Cents>();
  for (const d of deals) {
    const k = utcDateKey(d.closeTime);
    netByDay.set(k, (netByDay.get(k) ?? 0n) + dealNetCents(d));
  }
  const closeDays = [...netByDay.keys()].sort();

  const out: DayReconciliation[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;

    // Two rows dated the same day make the interval (previousDate, tradeDate]
    // a zero-width lie: no close day is both > prev and <= cur, so explained
    // silently comes out 0n regardless of which balance is "real." Whichever
    // of the two rows the caller intended as authoritative, this function
    // cannot tell — and guessing is how a reconciler invents or hides a
    // capital event. Refuse instead.
    if (cur.tradeDate === prev.tradeDate) {
      throw new RangeError(
        `duplicate snapshot for tradeDate ${cur.tradeDate}: two rows both claim to close ` +
          `that day, so the interval (previousDate, tradeDate] is ambiguous. Collapse to ` +
          `one snapshot per trade date before calling reconcileDays.`,
      );
    }

    // The interval is (previousDate, tradeDate] — half-open at the start, so a
    // trade is counted exactly once, and closed at the end. Snapshot series
    // have gaps (weekends, holidays), and a trade closing inside a gap belongs
    // to the next available day's balance move.
    let explained: Cents = 0n;
    for (const day of closeDays) {
      if (day > prev.tradeDate && day <= cur.tradeDate) {
        explained += netByDay.get(day) ?? 0n;
      }
    }

    const balanceDelta = cur.balanceCloseCents - prev.balanceCloseCents;
    const unexplained = balanceDelta - explained;

    out.push({
      tradeDate: cur.tradeDate,
      previousDate: prev.tradeDate,
      balanceDeltaCents: balanceDelta,
      explainedCents: explained,
      unexplainedCents: unexplained,
      isExplained: abs(unexplained) <= toleranceCents,
    });
  }
  return out;
}
