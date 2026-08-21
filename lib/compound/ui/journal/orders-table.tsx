/**
 * The orders panel — every order CopyTraderX has ever set up for this
 * account, filled, pending, partial or canceled.
 *
 * humanizeOrderType/humanizeOrderState (order-display.ts) supply the label
 * text for Type and State. Only `.label` is used: the design spec forbids
 * colour as the sole carrier of meaning (section 8.4), and this table
 * already satisfies that with plain, legible text — the same choice
 * TradesTable makes for its own Side column. Their `variant`/`outline`
 * fields are for a richer badge treatment this task's sanctioned class
 * families (.filters*) do not provide a token for; adding one would be a
 * new class family this task does not own (agreement A9).
 *
 * `type` is a real filter key (ORDER_SPEC.filterKeys) with no chip here —
 * nine MT5 order-type constants would crowd the bar past what `state` and
 * `symbol` already cover. It stays reachable by a hand-built or bookmarked
 * link; applyOrderFilters still honours it.
 */
import type { Params, TableState } from "@/lib/compound/journal/table-state";
import type { OrderFilterResult } from "@/lib/compound/journal/order-filters";
import { humanizeOrderState, humanizeOrderType } from "@/lib/compound/journal/order-display";
import { lots, utcStamp } from "@/lib/compound/present/figures";
import { Eyebrow, Panel } from "../primitives";
import { FilterBar, type ChipGroup } from "./filter-bar";
import { Pager } from "./pager";
import { SortHeader } from "./sort-header";

export function OrdersTable({
  result,
  state,
  symbols,
  basePath,
  params,
}: {
  result: OrderFilterResult;
  state: TableState;
  symbols: readonly string[];
  basePath: string;
  params: Params;
}) {
  const groups: ChipGroup[] = [
    {
      name: "state",
      label: "State",
      options: [
        { value: "filled", label: "Filled" },
        { value: "open", label: "Pending" },
        { value: "canceled", label: "Canceled" },
        { value: "partial", label: "Partial" },
      ],
    },
    {
      name: "symbol",
      label: "Symbol",
      options: symbols.map((s) => ({ value: s, label: s })),
    },
  ];
  const head = { sort: state.sort, prefix: "o", basePath, params };

  return (
    <Panel flush>
      <div style={{ padding: "16px 16px 0" }}>
        <Eyebrow>Orders</Eyebrow>
      </div>
      <FilterBar
        groups={groups}
        active={state.filters}
        search={state.search}
        prefix="o"
        basePath={basePath}
        params={params}
      />
      <div className="scroller">
        <table>
          <caption className="sr-only">
            Orders, {result.total} matching, page {result.page} of {result.pageCount}
          </caption>
          <thead>
            <tr>
              <SortHeader label="Set up (UTC)" column="setup" {...head} />
              <th scope="col">Done (UTC)</th>
              <SortHeader label="Ticket" column="ticket" {...head} numeric />
              <SortHeader label="Symbol" column="symbol" {...head} />
              <SortHeader label="Type" column="type" {...head} />
              <SortHeader label="State" column="state" {...head} />
              <th scope="col">Initial</th>
              <th scope="col">Remaining</th>
              <th scope="col">Price</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ textAlign: "center", color: "var(--ink-3)" }}>
                  No orders match these filters.
                </td>
              </tr>
            ) : (
              result.rows.map((o) => (
                <tr key={o.ticket}>
                  <td className="num" style={{ textAlign: "left" }}>{utcStamp(o.timeSetup)}</td>
                  <td className="num" style={{ textAlign: "left" }}>
                    {o.timeDone === null ? "—" : utcStamp(o.timeDone)}
                  </td>
                  <td className="num">{o.ticket}</td>
                  <td style={{ textAlign: "left" }}>{o.symbol}</td>
                  <td style={{ textAlign: "left" }}>{humanizeOrderType(o.type).label}</td>
                  <td style={{ textAlign: "left" }}>{humanizeOrderState(o.state).label}</td>
                  <td className="num">{lots(o.volumeInitialMilliLots)}</td>
                  <td className="num">{lots(o.volumeCurrentMilliLots)}</td>
                  <td className="num">{o.priceOpen ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={9} style={{ textAlign: "left" }}>
                {result.summary.count} orders · {result.summary.filled} filled ·{" "}
                {result.summary.open} pending · {result.summary.canceled} canceled
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Pager
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        prefix="o"
        basePath={basePath}
        params={params}
        noun="order"
      />
      <p className="filters-footnote">
        Initial and Remaining are lots. Price is the order&rsquo;s own set price, never a parsed
        figure. Times are UTC.
      </p>
    </Panel>
  );
}
