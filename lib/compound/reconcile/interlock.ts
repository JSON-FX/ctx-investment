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
 */
import type { Cents } from "@/lib/compound/engine/money";
import { dedupeDeals } from "./dedupe";
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

export type ReadingPlan =
  | { kind: "idle" }
  | { kind: "advance"; readings: PlannedReading[]; newCursorDate: string }
  | {
      kind: "halt";
      readings: PlannedReading[];
      newCursorDate: string | null;
      candidate: CapitalEventCandidate;
    };

export interface PlanInput {
  snapshots: readonly DailySnapshot[];
  deals: readonly ClosedDeal[];
  cursor: ReconcileCursor;
  brokerOffsetHours: number;
  toleranceCents: Cents;
}

export function planReadings(input: PlanInput): ReadingPlan {
  const { snapshots, deals, cursor, brokerOffsetHours, toleranceCents } = input;
  if (snapshots.length === 0) return { kind: "idle" };

  const ordered = [...snapshots].sort((a, b) =>
    a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0,
  );
  const equityByDate = new Map(ordered.map((s) => [s.tradeDate, s.equityCloseCents]));

  const { kept } = dedupeDeals(deals, brokerOffsetHours);
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
      };
    }

    readings.push({
      occurredOn: day.tradeDate,
      equityCents: equityByDate.get(day.tradeDate) ?? 0n,
    });
  }

  if (readings.length === 0) return { kind: "idle" };
  return {
    kind: "advance",
    readings,
    newCursorDate: readings[readings.length - 1]!.occurredOn,
  };
}
