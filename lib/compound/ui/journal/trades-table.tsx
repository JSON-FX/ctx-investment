/**
 * The closed-trades panel. Sortable, filterable, paginated — all through the
 * URL, per Task 8's TableState. `result` is already the FILTERED, SORTED,
 * PAGINATED view; this component never re-derives it from raw rows, so the
 * footer and the visible rows can never disagree (see tables.test.tsx's
 * "states the filtered totals in the footer").
 *
 * `result.rows` is `ClosedDeal[]` sliced out of a `TradeFilterResult`, whose
 * only constructor (`applyTradeFilters`) takes `DedupedDeals`. A caller
 * cannot hand this component raw deals without going through that chokepoint
 * first — see history.ts and chokepoint.test.ts.
 */
import type { Params, TableState } from "@/lib/compound/journal/table-state";
import type { TradeFilterResult } from "@/lib/compound/journal/trade-filters";
import { lots, signedMoney, toneOf, utcStamp } from "@/lib/compound/present/figures";
import { Eyebrow, Panel } from "../primitives";
import { FilterBar, type ChipGroup } from "./filter-bar";
import { Pager } from "./pager";
import { SortHeader } from "./sort-header";

export function TradesTable({
  result,
  state,
  symbols,
  basePath,
  params,
}: {
  result: TradeFilterResult;
  state: TableState;
  symbols: readonly string[];
  basePath: string;
  params: Params;
}) {
  const groups: ChipGroup[] = [
    {
      name: "outcome",
      label: "Outcome",
      options: [
        { value: "wins", label: "Wins" },
        { value: "losses", label: "Losses" },
        { value: "flat", label: "Flat" },
      ],
    },
    {
      name: "side",
      label: "Side",
      options: [
        { value: "buy", label: "Buy" },
        { value: "sell", label: "Sell" },
      ],
    },
    {
      name: "symbol",
      label: "Symbol",
      options: symbols.map((s) => ({ value: s, label: s })),
    },
  ];
  const head = { sort: state.sort, prefix: "t", basePath, params };

  return (
    <Panel flush>
      <div style={{ padding: "16px 16px 0" }}>
        <Eyebrow>Closed trades</Eyebrow>
      </div>
      <FilterBar
        groups={groups}
        active={state.filters}
        search={state.search}
        prefix="t"
        basePath={basePath}
        params={params}
      />
      <div className="scroller">
        <table>
          <caption className="sr-only">
            Closed trades, {result.total} matching, page {result.page} of {result.pageCount}
          </caption>
          <thead>
            <tr>
              <SortHeader label="Closed (UTC)" column="closed" {...head} />
              <SortHeader label="Ticket" column="ticket" {...head} numeric />
              <SortHeader label="Symbol" column="symbol" {...head} />
              <SortHeader label="Side" column="side" {...head} />
              <SortHeader label="Lots" column="vol" {...head} numeric />
              <SortHeader label="Gross" column="profit" {...head} numeric />
              <th scope="col">Swap</th>
              <th scope="col">Commission</th>
              <th scope="col">Net</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ textAlign: "center", color: "var(--ink-3)" }}>
                  No trades match these filters.
                </td>
              </tr>
            ) : (
              result.rows.map((d) => {
                const net = d.profitCents + d.swapCents + d.commissionCents;
                return (
                  <tr key={d.ticket}>
                    <td className="num" style={{ textAlign: "left" }}>{utcStamp(d.closeTime)}</td>
                    <td className="num">{d.ticket}</td>
                    <td style={{ textAlign: "left" }}>{d.symbol}</td>
                    <td style={{ textAlign: "left" }}>{d.side === "buy" ? "Buy" : "Sell"}</td>
                    <td className="num">{lots(d.volumeMilliLots)}</td>
                    <td className={`num ${toneOf(d.profitCents)}`}>{signedMoney(d.profitCents)}</td>
                    <td className="num">{signedMoney(d.swapCents)}</td>
                    <td className="num">{signedMoney(d.commissionCents)}</td>
                    <td className={`num ${toneOf(net)}`}>{signedMoney(net)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ textAlign: "left" }}>
                {result.summary.count} trades · {result.summary.wins}W / {result.summary.losses}L
              </td>
              <td colSpan={4} />
              <td className={`num ${toneOf(result.summary.grossCents)}`}>
                {signedMoney(result.summary.grossCents)}
              </td>
              <td colSpan={2} className="num">
                {signedMoney(result.summary.netCents - result.summary.grossCents)}
              </td>
              <td className={`num ${toneOf(result.summary.netCents)}`}>
                {signedMoney(result.summary.netCents)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Pager
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        prefix="t"
        basePath={basePath}
        params={params}
        noun="trade"
      />
      <p className="filters-footnote">
        Figures are net of swap and commission. Wins and losses are counted on gross profit, so a
        trade whose fees exceed a small gain still counts as a win. Times are UTC.
      </p>
    </Panel>
  );
}
