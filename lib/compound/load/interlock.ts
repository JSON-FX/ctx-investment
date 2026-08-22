/**
 * One loader for one question: has the reconciler stopped, and where?
 *
 * The sub-nav badge, the frozen-figures banner and plan 5's /performance
 * notice all need this. Two loaders would be two answers.
 *
 * managerUserId is an explicit parameter, not resolved internally via
 * requireManager() — see load/ledger.ts's module doc for why: requireManager
 * needs a live Next.js request (next/headers cookies, a real Supabase
 * session), and a loader that reached for it internally could never be
 * called from a context that does not have one, Jest included.
 */
import { cache } from "react";
import { withAuthenticatedDb } from "@/lib/compound/db/client";
import { getReconcileCursor, listCandidates } from "@/lib/compound/db/compound";

export interface InterlockState {
  /** compound_reconcile_cursor.last_reading_date. Null before the first run. */
  frozenAt: string | null;
  /** The earliest pending candidate's trade date, or null when nothing is pending. */
  pendingCandidateDate: string | null;
  pendingCount: number;
}

export const loadInterlock = cache(
  async (managerUserId: string, accountId: number): Promise<InterlockState> => {
    const [cursor, pending] = await withAuthenticatedDb(managerUserId, async (c) => [
      await getReconcileCursor(c, accountId),
      await listCandidates(c, accountId, "pending"),
    ] as const);

    const earliest = [...pending].sort((a, b) =>
      a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0,
    )[0];

    return {
      frozenAt: cursor.lastReadingDate,
      pendingCandidateDate: earliest?.tradeDate ?? null,
      pendingCount: pending.length,
    };
  },
);
