/**
 * Filtering, sorting and pagination for the closed-trades table.
 *
 * The summary is computed over the FILTERED set and before pagination, so the
 * line above the table describes what the filter selected rather than what
 * happens to be on the current page.
 *
 * Money comparisons use cmpBig rather than subtraction. A comparator must
 * return a number, and `Number(a - b)` on two cent values a long way apart
 * loses precision above 2^53 — the same failure spec section 4 forbids
 * everywhere else, arriving through a sort.
 *
 * Filter VALUES (outcome, side) are matched by exact string equality against
 * a fixed literal ("wins", "buy", ...). That equality check is itself the
 * allowlist for these fields: table-state.ts only bounds which KEYS survive
 * and how long a value may be, not what an enum-shaped value must equal, so
 * an unrecognised value here (wrong case, numeric, garbage) matches none of
 * the branches below and the filter is silently not applied — the same
 * fail-open-to-unfiltered default every other rejection in this plan falls
 * back to, never a thrown error and never a misapplied filter.
 */
import type { Cents } from "@/lib/compound/engine/money";
import { dealNetCents, type ClosedDeal } from "@/lib/compound/reconcile/types";
import type { DedupedDeals } from "./history";
import { paginate, splitSort, type Paged, type TableSpec, type TableState } from "./table-state";

export const TRADE_SPEC: TableSpec = {
  sorts: [
    "closed_desc", "closed_asc",
    "symbol_desc", "symbol_asc",
    "side_desc", "side_asc",
    "vol_desc", "vol_asc",
    "profit_desc", "profit_asc",
    "ticket_desc", "ticket_asc",
  ],
  defaultSort: "closed_desc",
  filterKeys: ["outcome", "symbol", "side"],
};

export interface TradeSummary {
  count: number;
  /** profit + swap + commission over the filtered set. */
  netCents: Cents;
  /** profit only. */
  grossCents: Cents;
  wins: number;
  losses: number;
}

export interface TradeFilterResult extends Paged<ClosedDeal> {
  summary: TradeSummary;
}

function cmpBig(a: Cents, b: Cents): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function applyTradeFilters(
  input: DedupedDeals,
  state: TableState,
): TradeFilterResult {
  const { outcome, symbol, side } = state.filters;

  let rows: ClosedDeal[] = [...input];
  if (outcome === "wins") rows = rows.filter((d) => d.profitCents > 0n);
  if (outcome === "losses") rows = rows.filter((d) => d.profitCents < 0n);
  if (outcome === "flat") rows = rows.filter((d) => d.profitCents === 0n);
  if (symbol) rows = rows.filter((d) => d.symbol === symbol);
  if (side === "buy" || side === "sell") rows = rows.filter((d) => d.side === side);
  if (state.search !== "") {
    const q = state.search.toLowerCase();
    rows = rows.filter(
      (d) => d.symbol.toLowerCase().includes(q) || String(d.ticket).includes(q),
    );
  }

  const summary: TradeSummary = {
    count: rows.length,
    netCents: rows.reduce<Cents>((a, d) => a + dealNetCents(d), 0n),
    grossCents: rows.reduce<Cents>((a, d) => a + d.profitCents, 0n),
    wins: rows.reduce((a, d) => a + (d.profitCents > 0n ? 1 : 0), 0),
    losses: rows.reduce((a, d) => a + (d.profitCents < 0n ? 1 : 0), 0),
  };

  const [column, dir] = splitSort(state.sort);
  rows.sort((a, b) => {
    let cmp = 0;
    switch (column) {
      case "closed": cmp = cmpStr(a.closeTime, b.closeTime); break;
      case "symbol": cmp = cmpStr(a.symbol, b.symbol); break;
      case "side":   cmp = cmpStr(a.side, b.side); break;
      case "vol":    cmp = a.volumeMilliLots - b.volumeMilliLots; break;
      case "profit": cmp = cmpBig(a.profitCents, b.profitCents); break;
      default:       cmp = 0;
    }
    // Ticket breaks every tie, so the order does not depend on what the
    // database returned or on whether Array.sort happened to be stable.
    if (cmp === 0) cmp = a.ticket - b.ticket;
    return dir === "asc" ? cmp : -cmp;
  });

  return { ...paginate(rows, state), summary };
}

/** Distinct symbols in the history, for the filter bar. Sorted. */
export function symbolsOf(input: DedupedDeals): string[] {
  return [...new Set(input.map((d) => d.symbol))].sort();
}
