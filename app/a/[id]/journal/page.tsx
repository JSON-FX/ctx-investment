/**
 * Closed trades, open positions and orders for one pooled account.
 *
 * The account, and with it broker_offset_hours, comes from plan 4's
 * requireAccount. Deals come from loadTradeHistory, which is the only path
 * that produces a DedupedDeals — a page cannot reach the raw query, by type
 * and by chokepoint.test.ts.
 *
 * No client component and no useState: table state is search parameters, so
 * every filter and sort is a link and every view is shareable.
 *
 * Renders only its own <section> content (agreement A1) — no masthead, no
 * account resolution beyond requireAccount, no navigation. Plan 4's
 * app/a/[id]/layout.tsx supplies all of that once it lands.
 */
import { requireAccount } from "@/lib/compound/load/account";
import { loadOpenPositions, loadOrders, loadTradeHistory } from "@/lib/compound/load/trades";
import {
  applyOrderFilters,
  applyPositionSort,
  ORDER_SPEC,
  POSITION_SPEC,
} from "@/lib/compound/journal/order-filters";
import { applyTradeFilters, symbolsOf, TRADE_SPEC } from "@/lib/compound/journal/trade-filters";
import { flattenParams, parseTableState } from "@/lib/compound/journal/table-state";
import { GuardNotice } from "@/lib/compound/ui/journal/guard-notice";
import { OrdersTable } from "@/lib/compound/ui/journal/orders-table";
import { PositionsTable } from "@/lib/compound/ui/journal/positions-table";
import { TradesTable } from "@/lib/compound/ui/journal/trades-table";
import { journalHref } from "@/lib/compound/ui/routes";

export const dynamic = "force-dynamic";

export default async function JournalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const account = await requireAccount(id);
  const sp = flattenParams(await searchParams);
  const basePath = journalHref(account.id);

  const [history, positions, orders] = await Promise.all([
    loadTradeHistory(account.mt5Account, account.brokerOffsetHours),
    loadOpenPositions(account.mt5Account),
    loadOrders(account.mt5Account),
  ]);

  const tradeState = parseTableState(sp, TRADE_SPEC, "t");
  const positionState = parseTableState(sp, POSITION_SPEC, "p");
  const orderState = parseTableState(sp, ORDER_SPEC, "o");

  return (
    <>
      <GuardNotice history={history} />
      <TradesTable
        result={applyTradeFilters(history.deals, tradeState)}
        state={tradeState}
        symbols={symbolsOf(history.deals)}
        basePath={basePath}
        params={sp}
      />
      <PositionsTable
        result={applyPositionSort(positions, positionState)}
        state={positionState}
        basePath={basePath}
        params={sp}
      />
      <OrdersTable
        result={applyOrderFilters(orders, orderState)}
        state={orderState}
        symbols={[...new Set(orders.map((o) => o.symbol))].sort()}
        basePath={basePath}
        params={sp}
      />
    </>
  );
}
