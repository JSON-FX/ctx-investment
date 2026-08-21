/**
 * Running the reconciler for an account.
 *
 * Three outcomes a caller must handle differently, and one that is easy to get
 * wrong:
 *
 *   not-configured  the broker offset is null. dedupeDeals throws below 1, and
 *                   reconciling undeduplicated inflates the explained figure
 *                   and can hide a real capital event. Refuse, visibly.
 *   error           planReadings threw a RangeError. This is a DATA DEFECT, not
 *                   a state to render as a halt banner: two snapshots share a
 *                   trade date, or the window starts after the cursor. A halt
 *                   banner would say "a capital event needs classifying", which
 *                   is not what happened, and the manager would go looking for
 *                   one that does not exist.
 *   plan            idle, advance or halt. Every variant carries droppedDeals.
 *
 * The idle/advance/halt cases are NOT distinguished with a try/catch on
 * anything — planReadings returns them as ordinary values. Only the two data
 * defects above are exceptions, and only RangeError is caught here; anything
 * else escapes, because a plain Error from this path is a bug this function
 * has no business turning into a quiet outcome value.
 *
 * classifiedDates — closing the classified-cursor deadlock. planReadings is
 * pure and knows nothing of the ledger, so on its own it re-derives the same
 * unexplained balance move from snapshots and deals every single run, even
 * after a manager has classified it — it has no way to learn that a human
 * already resolved that day. compound_classify_candidate deliberately never
 * touches the cursor (only compound_commit_reading_plan does, and only when
 * it has readings to post), so without this, nothing ever tells the planner
 * the day stopped being unclassified: refresh, classify, refresh again halts
 * on the exact same day forever. This is the one place that can tell it —
 * every non-pending candidate (status 'classified' from a deposit/match, or
 * 'ignored' — both are a human decision, recorded either in the ledger or in
 * the candidate row's own audit trail) is read alongside the cursor, on every
 * call, and handed through unchanged. All-time and unfiltered by the snapshot
 * window on purpose: a candidate outside that window cannot match any `day`
 * planReadings evaluates, so an unfiltered read costs nothing and needs no
 * synchronised date-range logic to get wrong.
 */
import { cache } from "react";
import { withDb } from "@/lib/compound/db/client";
import { getReconcileCursor, listCandidates } from "@/lib/compound/db/compound";
import { getClosedDeals, getDailySnapshots } from "@/lib/compound/db/copytraderx";
import type { DroppedDeal } from "@/lib/compound/reconcile/dedupe";
import { planReadings, type ReadingPlan } from "@/lib/compound/reconcile/interlock";
import type { ResolvedAccount } from "./account";

/** Spec 6.3: with dedup applied the residual is exactly zero. Decision D-N. */
export const TOLERANCE_CENTS = 0n;

export type ReconcileOutcome =
  | { kind: "not-configured" }
  | { kind: "error"; message: string }
  | { kind: "plan"; plan: ReadingPlan; lastSnapshotDate: string | null };

export const planFor = cache(async (account: ResolvedAccount): Promise<ReconcileOutcome> => {
  if (account.brokerOffsetHours === null) return { kind: "not-configured" };

  const [cursor, snapshots, deals, candidates] = await withDb(async (c) => {
    const cur = await getReconcileCursor(c, account.id);
    // The window must INCLUDE the cursor date: the first day's balance move is
    // reconciled against the balance at the cursor, and planReadings throws if
    // that row is missing. `WHERE trade_date > cursor` is the natural query and
    // the wrong one.
    const from = cur.lastReadingDate ?? undefined;
    return [
      cur,
      await getDailySnapshots(c, account.mt5Account, { from }),
      await getClosedDeals(c, account.mt5Account, { from }),
      // Unfiltered by status: every outcome classifyCandidate can reach
      // ('classified' or 'ignored') resolves the day, and planReadings does
      // its own filtering by date. See the module doc above.
      await listCandidates(c, account.id),
    ] as const;
  });

  const classifiedDates = candidates
    .filter((k) => k.status !== "pending")
    .map((k) => k.tradeDate);

  try {
    return {
      kind: "plan",
      plan: planReadings({
        snapshots,
        deals,
        cursor,
        brokerOffsetHours: account.brokerOffsetHours,
        toleranceCents: TOLERANCE_CENTS,
        classifiedDates,
      }),
      lastSnapshotDate: snapshots.length === 0
        ? null
        : snapshots.reduce((m, s) => (s.tradeDate > m ? s.tradeDate : m), snapshots[0]!.tradeDate),
    };
  } catch (e) {
    if (e instanceof RangeError) return { kind: "error", message: e.message };
    throw e;
  }
});

/**
 * Carrying droppedDeals through a redirect's query string.
 *
 * Dropped deals are never persisted — dedupeDeals is a pure function of
 * (deals, offset) run fresh on every reconcile, and its own module doc warns
 * that dropping a genuine trade "destroys real P/L silently". This is
 * therefore the only moment anyone can see which tickets a run suppressed and
 * what each was judged a duplicate of; a refresh that discards it silently
 * makes that judgment unauditable. The encoding is deliberately narrow
 * (positive integers only, `:` and `,` separators) because it rides in a URL.
 */
export function encodeDroppedDeals(deals: readonly DroppedDeal[]): string {
  return deals.map((d) => `${d.deal.ticket}:${d.duplicateOfTicket}`).join(",");
}

export interface DecodedDroppedDeal {
  ticket: number;
  duplicateOfTicket: number;
}

const PAIR = /^[0-9]+:[0-9]+$/;

export function decodeDroppedDeals(param: string | null | undefined): DecodedDroppedDeal[] {
  if (param === null || param === undefined || param === "") return [];
  return param
    .split(",")
    .filter((pair) => PAIR.test(pair))
    .map((pair) => {
      const [ticket, duplicateOfTicket] = pair.split(":");
      return { ticket: Number(ticket), duplicateOfTicket: Number(duplicateOfTicket) };
    });
}
