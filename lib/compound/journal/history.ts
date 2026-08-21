/**
 * The one door into a journal surface.
 *
 * The design spec's upstream-duplicate-deals section documents the defect:
 * some trades reach the deals table twice, identical in every value field,
 * with both timestamps shifted by exactly the broker's UTC offset, under an
 * out-of-sequence ticket. Left in, they inflate trade counts and distort
 * P/L. The sibling product does not defend against this and shows phantom
 * trades on a real account.
 *
 * The defence here is a branded type. Every aggregate in this layer takes
 * DedupedDeals, which only this module can construct, so forgetting to
 * deduplicate is a compile error rather than a wrong number on a screen. That
 * is deliberately stronger than a test: a test catches the code you wrote, a
 * type catches the code you have not written yet.
 *
 * On the offset argument. dedupeDeals accepts an integer 1..14, because the
 * defect is a timezone reinterpretation and a zero-hour reinterpretation moves
 * nothing. compound_account.broker_offset_hours may legitimately be null (not
 * yet configured) or zero (a broker actually on UTC). In both cases there is
 * nothing to detect, so this returns the deals untouched and says so via
 * `guard`. The journal page renders that state visibly rather than implying a
 * protection that is not running — a silent no-op here would recreate the
 * exact defect this module exists to prevent.
 */
import { dedupeDeals, type DroppedDeal } from "@/lib/compound/reconcile/dedupe";
import type { ClosedDeal } from "@/lib/compound/reconcile/types";

declare const DEDUPED: unique symbol;

/**
 * A deal list that has passed through buildTradeHistory.
 *
 * The brand is a phantom property: it exists in the type system and not at
 * runtime, so this costs nothing at execution time. There is no runtime
 * validator and there should not be one — the guarantee is structural.
 */
export type DedupedDeals = readonly ClosedDeal[] & { readonly [DEDUPED]: true };

export type DedupeGuard = "applied" | "not-configured";

export interface TradeHistory {
  deals: DedupedDeals;
  dropped: readonly DroppedDeal[];
  /** Whether the duplicate guard actually ran. Rendered, not swallowed. */
  guard: DedupeGuard;
  /** Rows read from the database, before deduplication. */
  rawCount: number;
}

function byTicket(deals: readonly ClosedDeal[]): ClosedDeal[] {
  return [...deals].sort((a, b) => a.ticket - b.ticket);
}

export function buildTradeHistory(
  raw: readonly ClosedDeal[],
  brokerOffsetHours: number | null,
): TradeHistory {
  if (brokerOffsetHours === null || brokerOffsetHours === 0) {
    return {
      // Same ordering contract as the dedupe path: dedupeDeals sorts its
      // output by ticket, and a caller must not be able to tell which branch
      // ran by looking at the order.
      deals: byTicket(raw) as unknown as DedupedDeals,
      dropped: [],
      guard: "not-configured",
      rawCount: raw.length,
    };
  }

  // The defect is symmetric in sign: a broker at -5 produces exactly the same
  // shifted twin as a broker at +5. dedupeDeals is documented for 1..14, so
  // the magnitude is what it needs.
  const { kept, dropped } = dedupeDeals(raw, Math.abs(brokerOffsetHours));
  return {
    deals: kept as unknown as DedupedDeals,
    dropped,
    guard: "applied",
    rawCount: raw.length,
  };
}

export const EMPTY_HISTORY: TradeHistory = {
  deals: [] as unknown as DedupedDeals,
  dropped: [],
  guard: "not-configured",
  rawCount: 0,
};
