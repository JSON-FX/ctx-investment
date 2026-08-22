/**
 * Request-scoped reads. Each is cache()d, so the layout, the page and any
 * component that needs the same data pay for one query between them.
 *
 * There is no PoolState context provider, by agreement with plan 5: two of its
 * three surfaces need no ledger at all, and a provider would make them pay for
 * a replay they do not use.
 *
 * The compound_* loaders below take managerUserId as an explicit parameter
 * rather than resolving it internally via requireManager(). That looked like
 * the more convenient shape at first — every caller already has a
 * ResolvedAccount (or has just called requireManager() itself) by the time it
 * reaches one of these — but requireManager() calls into next/headers'
 * cookies() and a live Supabase session, neither of which exists outside a
 * real request. capital-staleness.db.test.ts calls loadPoolState directly,
 * with no request context at all, specifically to exercise the staleness
 * guard against a real writer without going through a Server Action Jest
 * cannot run — an internal requireManager() call would have made that
 * impossible, silently, for every future test written the same way. A scalar
 * managerUserId keeps these loaders callable from anywhere that has an
 * identity to give them, request or not, and still costs nothing extra in
 * production: every real call site already has account.managerUserId (from
 * requireAccount) or user.id (from its own requireManager() call) sitting
 * right there.
 *
 * loadLive is the one loader in this file that reads a CopyTraderX table
 * (account_snapshots_current) instead of a compound_* one, so it runs on
 * withElevatedCopyTraderXRead and takes no identity at all — service_role
 * ignores it.
 */
import { cache } from "react";
import { withAuthenticatedDb, withElevatedCopyTraderXRead } from "@/lib/compound/db/client";
import { getHolderSeeds, getLedgerEntries } from "@/lib/compound/db/compound";
import { listHolders } from "@/lib/compound/db/holders";
import { getLiveSnapshot } from "@/lib/compound/db/copytraderx";
import { fold, type HolderSeed, type LedgerEntry, type PoolState } from "@/lib/compound/engine/replay";
import type { LiveFigures } from "@/lib/compound/ui/statement";

export const loadLedger = cache(
  async (managerUserId: string, accountId: number): Promise<LedgerEntry[]> =>
    withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId)),
);

export const loadSeeds = cache(
  async (managerUserId: string, accountId: number): Promise<HolderSeed[]> =>
    withAuthenticatedDb(managerUserId, (c) => getHolderSeeds(c, accountId)),
);

export const loadHolderNames = cache(
  async (managerUserId: string, accountId: number): Promise<Record<number, string>> => {
    const holders = await withAuthenticatedDb(managerUserId, (c) => listHolders(c, accountId));
    return Object.fromEntries(holders.map((h) => [h.id, h.name]));
  },
);

export const loadPoolState = cache(
  async (managerUserId: string, accountId: number): Promise<PoolState> => {
    const [entries, seeds] = await Promise.all([
      loadLedger(managerUserId, accountId),
      loadSeeds(managerUserId, accountId),
    ]);
    return fold(entries, seeds);
  },
);

export const loadLive = cache(async (mt5Account: number): Promise<LiveFigures | null> => {
  const snap = await withElevatedCopyTraderXRead((c) => getLiveSnapshot(c, mt5Account));
  return snap === null
    ? null
    : {
        equityCents: snap.equityCents,
        floatingPnlCents: snap.floatingPnlCents,
        pushedAt: snap.pushedAt,
      };
});
