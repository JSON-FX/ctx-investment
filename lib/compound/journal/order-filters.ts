/**
 * Filtering and sorting for the orders and open-positions tables.
 *
 * classifyOrderState buckets MT5's six order states into the four a person
 * cares about. Rejected and expired join canceled because the distinction
 * matters to a post-mortem and not to a filter; the raw state is still shown
 * in the row, so nothing is lost.
 *
 * As in trade-filters.ts, the filter VALUES (state bucket, type, symbol) are
 * matched by exact equality, and that equality is the allowlist: a bucket
 * name that is not one of "filled" | "canceled" | "partial" | "open" matches
 * no row's classifyOrderState result, so the filter silently selects nothing
 * extra rather than throwing — see applyOrderFilters's test for the case
 * where the state param itself does not even correspond to a bucket name.
 */
import type { Cents } from "@/lib/compound/engine/money";
import type { OpenPosition, OrderRow } from "./rows";
import { paginate, splitSort, type Paged, type TableSpec, type TableState } from "./table-state";

export type StateBucket = "filled" | "canceled" | "partial" | "open" | "other";

export function classifyOrderState(raw: string): StateBucket {
  if (raw === "order_state_filled") return "filled";
  if (
    raw === "order_state_canceled" ||
    raw === "order_state_expired" ||
    raw === "order_state_rejected"
  ) {
    return "canceled";
  }
  if (raw === "order_state_partial") return "partial";
  if (raw === "order_state_placed") return "open";
  return "other";
}

export const ORDER_SPEC: TableSpec = {
  sorts: [
    "setup_desc", "setup_asc",
    "symbol_desc", "symbol_asc",
    "type_desc", "type_asc",
    "state_desc", "state_asc",
    "ticket_desc", "ticket_asc",
  ],
  defaultSort: "setup_desc",
  filterKeys: ["state", "type", "symbol"],
};

export const POSITION_SPEC: TableSpec = {
  sorts: [
    "opened_desc", "opened_asc",
    "symbol_desc", "symbol_asc",
    "profit_desc", "profit_asc",
    "ticket_desc", "ticket_asc",
  ],
  defaultSort: "opened_desc",
  filterKeys: [],
  sizes: [100],
};

export interface OrderSummary {
  count: number;
  filled: number;
  canceled: number;
  open: number;
}

export interface OrderFilterResult extends Paged<OrderRow> {
  summary: OrderSummary;
}

export interface PositionSummary {
  count: number;
  /** Floating P/L across the open book, fees included. */
  floatingCents: Cents;
  longs: number;
  shorts: number;
}

export interface PositionResult extends Paged<OpenPosition> {
  summary: PositionSummary;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpBig(a: Cents, b: Cents): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function applyOrderFilters(
  input: readonly OrderRow[],
  state: TableState,
): OrderFilterResult {
  const { state: bucket, type, symbol } = state.filters;

  let rows = [...input];
  // Explicit enumeration, not `if (bucket) rows = rows.filter(... === bucket)`.
  // classifyOrderState can itself return "other" for a raw MT5 state this
  // codebase does not recognise, so a bare truthy check would treat that
  // catch-all, or a raw constant, or a wrong-case bucket name, as a real
  // filter — one that matches nothing and silently empties the table instead
  // of falling back to unfiltered. Mirrors applyTradeFilters's outcome/side
  // handling: only a name from the four buckets a person actually filters by
  // is applied, so a table full of typo'd or bookmarked `?state=` values
  // degrades to "show everything," never to a wrongly-empty table.
  if (bucket === "filled" || bucket === "canceled" || bucket === "partial" || bucket === "open") {
    rows = rows.filter((o) => classifyOrderState(o.state) === bucket);
  }
  if (type) rows = rows.filter((o) => o.type === type);
  if (symbol) rows = rows.filter((o) => o.symbol === symbol);
  if (state.search !== "") {
    const q = state.search.toLowerCase();
    rows = rows.filter(
      (o) => o.symbol.toLowerCase().includes(q) || String(o.ticket).includes(q),
    );
  }

  const summary: OrderSummary = {
    count: rows.length,
    filled: rows.filter((o) => classifyOrderState(o.state) === "filled").length,
    canceled: rows.filter((o) => classifyOrderState(o.state) === "canceled").length,
    open: rows.filter((o) => classifyOrderState(o.state) === "open").length,
  };

  const [column, dir] = splitSort(state.sort);
  rows.sort((a, b) => {
    let cmp = 0;
    switch (column) {
      case "setup":  cmp = cmpStr(a.timeSetup, b.timeSetup); break;
      case "symbol": cmp = cmpStr(a.symbol, b.symbol); break;
      case "type":   cmp = cmpStr(a.type, b.type); break;
      case "state":  cmp = cmpStr(a.state, b.state); break;
      default:       cmp = 0;
    }
    if (cmp === 0) cmp = a.ticket - b.ticket;
    return dir === "asc" ? cmp : -cmp;
  });

  return { ...paginate(rows, state), summary };
}

export function applyPositionSort(
  input: readonly OpenPosition[],
  state: TableState,
): PositionResult {
  const rows = [...input];
  const summary: PositionSummary = {
    count: rows.length,
    floatingCents: rows.reduce<Cents>(
      (a, p) => a + p.profitCents + p.swapCents + p.commissionCents,
      0n,
    ),
    longs: rows.filter((p) => p.side === "buy").length,
    shorts: rows.filter((p) => p.side === "sell").length,
  };

  const [column, dir] = splitSort(state.sort);
  rows.sort((a, b) => {
    let cmp = 0;
    switch (column) {
      case "opened": cmp = cmpStr(a.openTime, b.openTime); break;
      case "symbol": cmp = cmpStr(a.symbol, b.symbol); break;
      case "profit": cmp = cmpBig(a.profitCents, b.profitCents); break;
      default:       cmp = 0;
    }
    if (cmp === 0) cmp = a.ticket - b.ticket;
    return dir === "asc" ? cmp : -cmp;
  });

  return { ...paginate(rows, state), summary };
}
