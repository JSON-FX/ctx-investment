/**
 * Request-scoped loaders for the trading surfaces.
 *
 * THIS FILE IS THE ONLY CALLER OF getClosedDeals OUTSIDE db/. Every page gets
 * its deals through loadTradeHistory, which runs the section 6.3 duplicate
 * guard before anything counts them. chokepoint.test.ts fails the build if a
 * page reaches around it.
 *
 * Arguments are scalars, deliberately. React's cache() keys on argument
 * identity, and an options object built fresh at each call site would produce
 * a cache miss every time — three queries per page instead of one.
 */
import { cache } from "react";
import { withElevatedCopyTraderXRead } from "@/lib/compound/db/client";
import {
  getClosedDeals,
  getDailySnapshots,
  getOpenPositions,
  getOrders,
  type OpenPosition,
  type OrderRow,
} from "@/lib/compound/db/copytraderx";
import type { DailySnapshot } from "@/lib/compound/reconcile/types";
import { buildTradeHistory, type TradeHistory } from "@/lib/compound/journal/history";

export const loadTradeHistory = cache(
  async (
    mt5Account: number,
    brokerOffsetHours: number | null,
    from: string | null = null,
    to: string | null = null,
  ): Promise<TradeHistory> => {
    const deals = await withElevatedCopyTraderXRead((c) =>
      getClosedDeals(c, mt5Account, { from: from ?? undefined, to: to ?? undefined }),
    );
    return buildTradeHistory(deals, brokerOffsetHours);
  },
);

export const loadOpenPositions = cache(
  async (mt5Account: number): Promise<OpenPosition[]> =>
    withElevatedCopyTraderXRead((c) => getOpenPositions(c, mt5Account)),
);

export const loadOrders = cache(
  async (
    mt5Account: number,
    from: string | null = null,
    to: string | null = null,
  ): Promise<OrderRow[]> =>
    withElevatedCopyTraderXRead((c) =>
      getOrders(c, mt5Account, { from: from ?? undefined, to: to ?? undefined }),
    ),
);

export const loadDailySnapshots = cache(
  async (
    mt5Account: number,
    from: string | null = null,
    to: string | null = null,
  ): Promise<DailySnapshot[]> =>
    withElevatedCopyTraderXRead((c) =>
      getDailySnapshots(c, mt5Account, { from: from ?? undefined, to: to ?? undefined }),
    ),
);
