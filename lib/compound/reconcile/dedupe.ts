/**
 * Upstream duplicate-deal guard. See the design spec, §6.3.
 *
 * Some trades reach the deals table twice: identical in symbol, side, volume,
 * profit and swap, with both timestamps shifted by the broker's UTC offset
 * (within OFFSET_TOLERANCE_MS — see that constant), under an out-of-sequence
 * ticket. The cause is broker server time being stored as if it were UTC on a
 * subset of pushes.
 *
 * Left in place they inflate trade counts, distort P/L, and — worst — make the
 * reconciler invent capital events that never happened, because the trading
 * P/L it computes no longer matches the balance move it is checking against.
 *
 * The rule is deliberately narrow. BOTH timestamps must be shifted by the
 * same signed amount (openShift === closeShift, exact — no tolerance on this
 * part), and that amount must be within OFFSET_TOLERANCE_MS of the nominal
 * offset, and every value field must match. A pair that matches on values but
 * sits at any other gap is two genuine trades, and dropping one would destroy
 * real P/L — a far worse outcome than leaving a duplicate in.
 */
import { signedGapMs } from "./date-key";
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

/**
 * Slack, in milliseconds, allowed between the observed open/close shift and
 * the nominal broker offset (brokerOffsetHours * 3,600,000).
 *
 * Production evidence: three confirmed duplicate pairs from a restored
 * production account on a 3-hour broker (nominal offsetMs = 10,800,000)
 * measured a shift of 10,799,000 ms on every pair — 1,000ms short, and short
 * by the same amount each time, not scattered — see
 * lib/compound/reconcile/__fixtures__/near-offset-duplicates.ts. An
 * exact-equality comparison rejected the offset match on all three and kept
 * every duplicate, each one double-counting a real trading loss as an
 * unexplained balance move (see that fixture's header for the arithmetic).
 *
 * 2,000ms is chosen to comfortably clear that 1,000ms discrepancy — double
 * it, with room for a little more jitter from whatever upstream rounding or
 * truncation produced it — while staying negligible next to what it is being
 * compared against. For two DISTINCT genuine trades to be mistaken for a
 * shifted twin under this tolerance, they would need: identical values in
 * every valueKey field (already unusual outside a copy-trading EA repeating
 * the same instrument and size); the exact same duration, because
 * openShift === closeShift is still compared exactly, with no tolerance
 * applied to that equality; AND a start-time gap landing within 2 seconds of
 * a whole-hour broker offset somewhere in 1h..14h. A copy-trading EA
 * re-entering the same instrument produces gaps of seconds to minutes, not
 * gaps that coincidentally land within 2 seconds of an exact hour boundary
 * many hours later. 2,000ms is under 0.06% of the smallest offset this
 * module ever compares against (MIN_OFFSET_HOURS * 3,600,000 ms = one hour),
 * so that coincidence is not a realistic risk.
 *
 * A constant, not a parameter: unlike brokerOffsetHours (a real per-account
 * fact — which timezone that broker's server clock uses), this is a
 * statement about how much slack to allow for upstream timestamp rounding.
 * It does not vary per account, there is no config surface for it anywhere
 * in this codebase (compound_account has no such column), and every call
 * site already passes brokerOffsetHours straight through from account
 * config, unmodified, through interlock.ts and history.ts. Threading a
 * second offset-shaped number through three layers for a value nobody has
 * ever needed to set differently would be a knob nobody sets, which is
 * exactly what MIN_OFFSET_HOURS/MAX_OFFSET_HOURS just above already argue
 * against for this file.
 */
const OFFSET_TOLERANCE_MS = 2_000;

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
      const twinOf = survivors.find((s) => {
        // A timezone reinterpretation moves BOTH ends by the same signed
        // amount, so it preserves the trade's duration. Comparing absolute
        // gaps independently would also accept a pair shifted +offset at one
        // end and −offset at the other — which changes duration and cannot
        // come from one push read two ways. That is two genuine trades, and
        // dropping one destroys real P/L silently. This equality is exact —
        // no tolerance — for that reason.
        const openShift = signedGapMs(s.openTime, candidate.openTime);
        const closeShift = signedGapMs(s.closeTime, candidate.closeTime);
        // The offset match, unlike the duration check above, allows
        // OFFSET_TOLERANCE_MS of slack: see that constant for the production
        // evidence (a consistent 1,000ms short of nominal) and the argument
        // for why 2,000ms cannot start matching genuine trades.
        return (
          openShift === closeShift &&
          Math.abs(Math.abs(openShift) - offsetMs) <= OFFSET_TOLERANCE_MS
        );
      });
      if (twinOf) dropped.push({ deal: candidate, duplicateOfTicket: twinOf.ticket });
      else survivors.push(candidate);
    }
    kept.push(...survivors);
  }

  kept.sort((a, b) => a.ticket - b.ticket);
  dropped.sort((a, b) => a.deal.ticket - b.deal.ticket);
  return { kept, dropped };
}
