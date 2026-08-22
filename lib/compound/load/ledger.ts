/**
 * Request-scoped reads. Each is cache()d, so the layout, the page and any
 * component that needs the same data pay for one query between them.
 *
 * There is no PoolState context provider, by agreement with plan 5: two of its
 * three surfaces need no ledger at all, and a provider would make them pay for
 * a replay they do not use.
 *
 * The compound_* loaders below call requireManager() themselves rather than
 * taking a userId parameter. That is safe, not just convenient: every caller
 * of these loaders already resolved and validated the account through
 * requireAccount before it had an accountId to pass in at all (see
 * load/account.ts), and requireManager is cache()d — resolving it again here
 * costs nothing beyond the first call in this request. loadLive is the one
 * loader in this file that reads a CopyTraderX table (account_snapshots_
 * current) instead of a compound_* one, so it runs on
 * withElevatedCopyTraderXRead and needs no identity at all.
 */
import { cache } from "react";
import { withAuthenticatedDb, withElevatedCopyTraderXRead } from "@/lib/compound/db/client";
import { getHolderSeeds, getLedgerEntries } from "@/lib/compound/db/compound";
import { listHolders } from "@/lib/compound/db/holders";
import { getLiveSnapshot } from "@/lib/compound/db/copytraderx";
import { fold, type HolderSeed, type LedgerEntry, type PoolState } from "@/lib/compound/engine/replay";
import type { LiveFigures } from "@/lib/compound/ui/statement";
import { requireManager } from "./session";

export const loadLedger = cache(async (accountId: number): Promise<LedgerEntry[]> => {
  const user = await requireManager();
  return withAuthenticatedDb(user.id, (c) => getLedgerEntries(c, accountId));
});

export const loadSeeds = cache(async (accountId: number): Promise<HolderSeed[]> => {
  const user = await requireManager();
  return withAuthenticatedDb(user.id, (c) => getHolderSeeds(c, accountId));
});

export const loadHolderNames = cache(async (accountId: number): Promise<Record<number, string>> => {
  const user = await requireManager();
  const holders = await withAuthenticatedDb(user.id, (c) => listHolders(c, accountId));
  return Object.fromEntries(holders.map((h) => [h.id, h.name]));
});

export const loadPoolState = cache(async (accountId: number): Promise<PoolState> => {
  const [entries, seeds] = await Promise.all([loadLedger(accountId), loadSeeds(accountId)]);
  return fold(entries, seeds);
});

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
