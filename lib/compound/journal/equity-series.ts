/**
 * The account-equity curve, with capital events made visible. Spec R4.
 *
 * Three lines come out of this, and the relationship between them is the
 * whole point:
 *
 *   equityCents        what the account is worth (from account_snapshots_daily)
 *   contributedCents   cumulative capital put in, less capital taken out
 *   performanceCents   the difference — what trading did, immune to capital
 *
 * On a deposit the first two step by the same amount and the third does not
 * move. An investor looking at a curve that jumps can therefore see, without
 * reading a legend, that it was money in rather than a good week. This is the
 * type-level enforcement of that fact: performanceCents is never assigned
 * independently, it is always equityCents minus contributedCents, so the
 * invariant cannot drift out of sync with the two figures it is derived from.
 *
 * A mark is attributed to the FIRST SNAPSHOT AT OR AFTER its date, not to a
 * snapshot on the same date. Snapshot series have weekend and holiday gaps and
 * a deposit lands on whatever day the manager made it; exact-date matching
 * would silently drop every capital event that fell in a gap, and a dropped
 * deposit is precisely the failure R4 exists to prevent.
 *
 * Marks after the last snapshot are returned in trailingMarks rather than
 * folded into the final point. Attributing an event to a day whose equity
 * reading predates it would show a step in the wrong place.
 *
 * marksCompleteThrough carries the reconcile cursor. Past that date the ledger
 * may be missing an event: the section 5.3 interlock stops advancing readings
 * at an unclassified capital move, and the deposit that explains it is by
 * definition not committed yet. Points past the cursor are flagged rather than
 * silently drawn as if complete.
 *
 * ON KEEPING A MARK OFF THE WRONG CURVE. This module's EquityPoint and
 * trade-equity.ts's CumulativePoint (the capital-neutral trading-P/L curve)
 * share no field name at all — `date` vs `ts`, `equityCents` vs
 * `netCents`/`cumCents`, and `marks` has no counterpart on the other side.
 * Neither type is assignable to the other, so passing a mark, a point, or a
 * whole series to where the other curve belongs is a compile error, not a
 * code-review catch — the same category of guarantee DedupedDeals gives the
 * dedupe choke point, applied here to which curve a capital event can reach.
 * equity-series.test.ts pins this with a `@ts-expect-error` proof rather than
 * only asserting it in prose, so a future edit that gave CumulativePoint a
 * `marks` field would fail the build, not just a review.
 *
 * CapitalMarkInput is deliberately NOT branded the way DedupedDeals is. A
 * brand requires nominal construction through one door, and the whole point
 * of this interface is the opposite: plan 4's CapitalMark (occurredOn,
 * amountCents, direction, plus a `type` field this module never reads) is
 * structurally assignable to it with no conversion, which is what keeps
 * Phase A mergeable without plan 4 existing yet. Defining it structurally
 * here is a narrower view of the same type plan 4 will own, not a second
 * one — branding it would break that bridge for a guarantee this module
 * does not need (nothing here constructs a CapitalMarkInput; it only reads
 * ones the caller already has).
 */
import type { Cents } from "@/lib/compound/engine/money";
import type { DailySnapshot } from "@/lib/compound/reconcile/types";

/**
 * The three fields this module reads from a capital event. Plan 4's
 * CapitalMark is assignable to this; it carries a `type` field as well, which
 * the renderer uses for its label and this module does not need.
 */
export interface CapitalMarkInput {
  /** YYYY-MM-DD. */
  occurredOn: string;
  /** Always positive. Direction carries the sign. */
  amountCents: Cents;
  direction: "in" | "out";
}

export interface EquityPoint {
  /** YYYY-MM-DD. */
  date: string;
  equityCents: Cents;
  /** Cumulative net capital contributed through this date. */
  contributedCents: Cents;
  /** equityCents - contributedCents. */
  performanceCents: Cents;
  /** Marks attributed to this point, in ledger order (spec section 6.2). */
  marks: CapitalMarkInput[];
  /** True when this point is later than marksCompleteThrough. */
  incompleteMarks: boolean;
}

export interface AccountEquitySeries {
  points: EquityPoint[];
  /** Marks dated after the last snapshot. Rendered as pending, never dropped. */
  trailingMarks: CapitalMarkInput[];
  marksCompleteThrough: string | null;
}

function signedDelta(m: CapitalMarkInput): Cents {
  return m.direction === "in" ? m.amountCents : -m.amountCents;
}

export function buildAccountEquitySeries(input: {
  snapshots: readonly DailySnapshot[];
  marks: readonly CapitalMarkInput[];
  /** compound_reconcile_cursor.last_reading_date. Null when nothing posted. */
  marksCompleteThrough: string | null;
}): AccountEquitySeries {
  const { snapshots, marks, marksCompleteThrough } = input;

  const orderedSnapshots = [...snapshots].sort((a, b) =>
    a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0,
  );
  // Stable within a day: two events on the same date keep ledger order, which
  // is seq order (spec section 6.2). Array.prototype.sort is stable in every
  // engine this project targets.
  const orderedMarks = [...marks].sort((a, b) =>
    a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : 0,
  );

  const points: EquityPoint[] = [];
  let contributed: Cents = 0n;
  let cursor = 0;

  for (const snap of orderedSnapshots) {
    const attributed: CapitalMarkInput[] = [];
    // "At or after": a mark exactly on this snapshot's date belongs here,
    // and so does every unconsumed mark from a gap before it (the while loop
    // is a merge-walk, not a per-snapshot lookup, so a run of several marks
    // in one gap all land on the same next snapshot).
    while (cursor < orderedMarks.length && orderedMarks[cursor]!.occurredOn <= snap.tradeDate) {
      const m = orderedMarks[cursor]!;
      contributed += signedDelta(m);
      attributed.push(m);
      cursor += 1;
    }
    points.push({
      date: snap.tradeDate,
      equityCents: snap.equityCloseCents,
      contributedCents: contributed,
      performanceCents: snap.equityCloseCents - contributed,
      marks: attributed,
      incompleteMarks: marksCompleteThrough === null || snap.tradeDate > marksCompleteThrough,
    });
  }

  return {
    points,
    // Whatever the walk never reached: either there were no snapshots at
    // all, or every remaining mark is dated after the last one.
    trailingMarks: orderedMarks.slice(cursor),
    marksCompleteThrough,
  };
}
