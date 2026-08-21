/**
 * The safety interlock. See the design spec, §5.3.
 *
 *   When the reconciler finds a balance move that closed trades do not
 *   explain, it creates a candidate and stops advancing readings past the
 *   preceding day. NAV never crosses an unclassified capital event.
 *
 * One unresolved candidate freezes the figures until it is classified. That is
 * deliberate. The failure it prevents is the most expensive one available in
 * this product: an unrecorded deposit is indistinguishable from profit, and
 * profit gets split. Letting the next reading land would silently redistribute
 * that capital to people who did not contribute it.
 *
 * This module composes dedupe and detect, and is the entry point callers
 * should use. Reconciling without deduplicating first inflates the explained
 * figure and can hide a real capital event.
 *
 * dedupeDeals' own module doc warns that dropping a genuine trade "destroys
 * real P/L silently." Every plan therefore carries the deals dedupe judged as
 * duplicates back out in `droppedDeals`, so a run is auditable — a manager
 * can see exactly which tickets were suppressed and what each was judged a
 * duplicate of, instead of that decision vanishing inside this function.
 */
import type { Cents } from "@/lib/compound/engine/money";
import { dedupeDeals, type DroppedDeal } from "./dedupe";
import { reconcileDays } from "./detect";
import type { ClosedDeal, DailySnapshot } from "./types";

export interface ReconcileCursor {
  /** YYYY-MM-DD of the last posted reading; null when nothing has been posted. */
  lastReadingDate: string | null;
}

export interface PlannedReading {
  occurredOn: string;
  equityCents: Cents;
}

export interface CapitalEventCandidate {
  tradeDate: string;
  previousDate: string;
  balanceDeltaCents: Cents;
  explainedCents: Cents;
  unexplainedCents: Cents;
}

/**
 * Every variant carries `droppedDeals`: the deals dedupeDeals judged as
 * duplicates and excluded from reconciliation, regardless of what the plan
 * otherwise did. It is `[]`, not omitted, when nothing was dropped — the
 * field is always present so a caller never has to guess whether the absence
 * of dropped deals means "none" or "not computed."
 */
export type ReadingPlan =
  | { kind: "idle"; droppedDeals: DroppedDeal[] }
  | { kind: "advance"; readings: PlannedReading[]; newCursorDate: string; droppedDeals: DroppedDeal[] }
  | {
      kind: "halt";
      readings: PlannedReading[];
      newCursorDate: string | null;
      candidate: CapitalEventCandidate;
      droppedDeals: DroppedDeal[];
    };

export interface PlanInput {
  /**
   * Precondition: whenever `cursor.lastReadingDate` is non-null, this window
   * must include a snapshot at or before that date. Without one, the earliest
   * snapshot's balance move cannot be reconciled against anything, and
   * `planReadings` throws rather than posting past an unclassified day.
   */
  snapshots: readonly DailySnapshot[];
  deals: readonly ClosedDeal[];
  cursor: ReconcileCursor;
  brokerOffsetHours: number;
  toleranceCents: Cents;
}

export function planReadings(input: PlanInput): ReadingPlan {
  const { snapshots, deals, cursor, brokerOffsetHours, toleranceCents } = input;
  if (snapshots.length === 0) return { kind: "idle", droppedDeals: [] };

  const ordered = [...snapshots].sort((a, b) =>
    a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0,
  );

  // A window that begins after the cursor cannot reconcile its own first day:
  // that day's balance move needs the balance at the cursor date, and it is not
  // here. Advancing anyway posts readings straight past an unclassified capital
  // event — the exact loss the interlock exists to prevent. The natural caller
  // query `WHERE trade_date > $cursor` produces this window, so it fails loudly
  // rather than silently dropping the day.
  const firstDate = ordered[0]!.tradeDate;
  if (cursor.lastReadingDate !== null && firstDate > cursor.lastReadingDate) {
    throw new RangeError(
      `snapshots begin at ${firstDate}, after the cursor at ${cursor.lastReadingDate}. ` +
        `The window must include a snapshot at or before the cursor date, or the ` +
        `first day's balance move cannot be reconciled.`,
    );
  }

  // A duplicated tradeDate is silent poison here specifically: the baseline
  // branch below picks ordered[0] and sets cursorDate to its date, so the
  // cursor skip a few lines down (`day.tradeDate <= cursorDate`) discards
  // ANY later row sharing that same date — including a halt-worthy
  // unexplained interval reconcileDays correctly detected. The candidate the
  // caller sees ends up dated a day later than reality, carrying whatever
  // smaller figure that day's move happens to be, while the true unexplained
  // amount is silently absorbed below the cursor. Refuse before that can
  // happen, rather than let the interlock look like it fired when it did not.
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]!.tradeDate === ordered[i - 1]!.tradeDate) {
      throw new RangeError(
        `duplicate snapshot for tradeDate ${ordered[i]!.tradeDate} in the reading window: ` +
          `two rows both claim to close that day, and the interlock cannot tell which ` +
          `balance is authoritative. Collapse to one snapshot per trade date before ` +
          `calling planReadings.`,
      );
    }
  }

  const equityByDate = new Map(ordered.map((s) => [s.tradeDate, s.equityCloseCents]));

  const { kept, dropped } = dedupeDeals(deals, brokerOffsetHours);
  const days = reconcileDays(ordered, kept, toleranceCents);

  const readings: PlannedReading[] = [];
  let cursorDate = cursor.lastReadingDate;

  // With an empty cursor the earliest snapshot is the baseline. Its balance
  // move is unknowable — nothing precedes it — so it cannot be reconciled and
  // is posted as-is. Everything after it is reconciled normally.
  const first = ordered[0]!;
  if (cursorDate === null) {
    readings.push({ occurredOn: first.tradeDate, equityCents: first.equityCloseCents });
    cursorDate = first.tradeDate;
  }

  for (const day of days) {
    if (day.tradeDate <= cursorDate) continue;

    if (!day.isExplained) {
      return {
        kind: "halt",
        readings,
        newCursorDate: readings.length > 0
          ? readings[readings.length - 1]!.occurredOn
          : cursor.lastReadingDate,
        candidate: {
          tradeDate: day.tradeDate,
          previousDate: day.previousDate,
          balanceDeltaCents: day.balanceDeltaCents,
          explainedCents: day.explainedCents,
          unexplainedCents: day.unexplainedCents,
        },
        droppedDeals: dropped,
      };
    }

    readings.push({
      occurredOn: day.tradeDate,
      equityCents: equityByDate.get(day.tradeDate) ?? 0n,
    });
  }

  if (readings.length === 0) return { kind: "idle", droppedDeals: dropped };
  return {
    kind: "advance",
    readings,
    newCursorDate: readings[readings.length - 1]!.occurredOn,
    droppedDeals: dropped,
  };
}
