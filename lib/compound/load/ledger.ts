/**
 * Request-scoped reads. Each is cache()d, so the layout, the page and any
 * component that needs the same data pay for one query between them.
 *
 * There is no PoolState context provider, by agreement with plan 5: two of its
 * three surfaces need no ledger at all, and a provider would make them pay for
 * a replay they do not use.
 */
import { cache } from "react";
import { withDb } from "@/lib/compound/db/client";
import { getHolderSeeds, getLedgerEntries } from "@/lib/compound/db/compound";
import { listHolders } from "@/lib/compound/db/holders";
import { getLiveSnapshot } from "@/lib/compound/db/copytraderx";
import { fold, type HolderSeed, type LedgerEntry, type PoolState } from "@/lib/compound/engine/replay";
import type { LiveFigures } from "@/lib/compound/ui/statement";

export const loadLedger = cache(
  async (accountId: number): Promise<LedgerEntry[]> =>
    withDb((c) => getLedgerEntries(c, accountId)),
);

export const loadSeeds = cache(
  async (accountId: number): Promise<HolderSeed[]> =>
    withDb((c) => getHolderSeeds(c, accountId)),
);

export const loadHolderNames = cache(async (accountId: number): Promise<Record<number, string>> => {
  const holders = await withDb((c) => listHolders(c, accountId));
  return Object.fromEntries(holders.map((h) => [h.id, h.name]));
});

export const loadPoolState = cache(async (accountId: number): Promise<PoolState> => {
  const [entries, seeds] = await Promise.all([loadLedger(accountId), loadSeeds(accountId)]);
  return fold(entries, seeds);
});

export const loadLive = cache(async (mt5Account: number): Promise<LiveFigures | null> => {
  const snap = await withDb((c) => getLiveSnapshot(c, mt5Account));
  return snap === null
    ? null
    : {
        equityCents: snap.equityCents,
        floatingPnlCents: snap.floatingPnlCents,
        pushedAt: snap.pushedAt,
      };
});
