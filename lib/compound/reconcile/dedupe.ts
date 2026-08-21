/**
 * Upstream duplicate-deal guard. See the design spec, §6.3.
 *
 * Some trades reach the deals table twice: identical in symbol, side, volume,
 * profit and swap, with both timestamps shifted by exactly the broker's UTC
 * offset, under an out-of-sequence ticket. The cause is broker server time
 * being stored as if it were UTC on a subset of pushes.
 *
 * Left in place they inflate trade counts, distort P/L, and — worst — make the
 * reconciler invent capital events that never happened, because the trading
 * P/L it computes no longer matches the balance move it is checking against.
 *
 * The rule is deliberately narrow. BOTH timestamps must be shifted by exactly
 * the offset, and every value field must match. A pair that matches on values
 * but sits at any other gap is two genuine trades, and dropping one would
 * destroy real P/L — a far worse outcome than leaving a duplicate in.
 */
import { absGapMs } from "./date-key";
import type { ClosedDeal } from "./types";

export interface DroppedDeal {
  deal: ClosedDeal;
  /** The ticket this was judged a duplicate of. */
  duplicateOfTicket: number;
}

export interface DedupeResult {
  kept: ClosedDeal[];
  dropped: DroppedDeal[];
}

const MIN_OFFSET_HOURS = 1;
const MAX_OFFSET_HOURS = 14;

/** Every field that must match for two rows to be candidate duplicates. */
function valueKey(d: ClosedDeal): string {
  return [
    d.symbol,
    d.side,
    d.volumeMilliLots,
    d.profitCents.toString(),
    d.swapCents.toString(),
    d.commissionCents.toString(),
  ].join("|");
}

export function dedupeDeals(
  deals: readonly ClosedDeal[],
  brokerOffsetHours: number,
): DedupeResult {
  if (
    !Number.isInteger(brokerOffsetHours) ||
    brokerOffsetHours < MIN_OFFSET_HOURS ||
    brokerOffsetHours > MAX_OFFSET_HOURS
  ) {
    throw new RangeError(
      `brokerOffsetHours must be an integer ${MIN_OFFSET_HOURS}..${MAX_OFFSET_HOURS}, ` +
        `got ${brokerOffsetHours}`,
    );
  }

  const offsetMs = brokerOffsetHours * 3_600_000;
  const groups = new Map<string, ClosedDeal[]>();
  for (const d of deals) {
    const k = valueKey(d);
    const g = groups.get(k);
    if (g) g.push(d);
    else groups.set(k, [d]);
  }

  const kept: ClosedDeal[] = [];
  const dropped: DroppedDeal[] = [];

  for (const group of groups.values()) {
    // Lowest ticket first: the genuine row is the one in sequence with its
    // close-time neighbours, and the spurious re-push always carries a later
    // ticket.
    const ordered = [...group].sort((a, b) => a.ticket - b.ticket);
    const survivors: ClosedDeal[] = [];

    for (const candidate of ordered) {
      const twinOf = survivors.find(
        (s) =>
          absGapMs(s.closeTime, candidate.closeTime) === offsetMs &&
          absGapMs(s.openTime, candidate.openTime) === offsetMs,
      );
      if (twinOf) dropped.push({ deal: candidate, duplicateOfTicket: twinOf.ticket });
      else survivors.push(candidate);
    }
    kept.push(...survivors);
  }

  kept.sort((a, b) => a.ticket - b.ticket);
  dropped.sort((a, b) => a.deal.ticket - b.deal.ticket);
  return { kept, dropped };
}
