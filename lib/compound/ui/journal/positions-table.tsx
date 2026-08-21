/**
 * The open-positions panel.
 *
 * No FilterBar: POSITION_SPEC.filterKeys is empty and the open book is small
 * enough that filtering buys nothing applyPositionSort doesn't already give
 * for free (sort + the one-size pagination POSITION_SPEC declares).
 *
 * Floating P/L is a live figure by construction — it is read fresh from
 * public.positions on every request, never from a committed daily reading
 * (account_snapshots_daily has no row for an open position). The Chip below
 * states that plainly rather than letting a number that moves every push
 * sit next to the desk's committed figures with no visual distinction —
 * spec section 5.2's live-vs-committed distinction, in this table's own
 * words: there is no per-position pushedAt this page loads (loadOpenPositions
 * returns OpenPosition[], not a LiveSnapshot), so this is a plain Chip
 * rather than plan 4's banner.tsx LiveChip, which requires one.
 *
 * SL/TP and the two price columns are rendered verbatim strings — see
 * rows.ts: prices are never parsed here, only shown.
 */
import type { Params, TableState } from "@/lib/compound/journal/table-state";
import type { PositionResult } from "@/lib/compound/journal/order-filters";
import { lots, signedMoney, toneOf, utcStamp } from "@/lib/compound/present/figures";
import { Chip, Eyebrow, Panel } from "../primitives";
import { Pager } from "./pager";
import { SortHeader } from "./sort-header";

export function PositionsTable({
  result,
  state,
  basePath,
  params,
}: {
  result: PositionResult;
  state: TableState;
  basePath: string;
  params: Params;
}) {
  const head = { sort: state.sort, prefix: "p", basePath, params };

  return (
    <Panel flush>
      <div
        style={{
          padding: "16px 16px 0",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <Eyebrow>Open positions</Eyebrow>
        <Chip tone="live">Live — not part of a committed daily reading</Chip>
      </div>
      <div className="scroller">
        <table>
          <caption className="sr-only">
            Open positions, {result.total} matching, page {result.page} of {result.pageCount}
          </caption>
          <thead>
            <tr>
              <SortHeader label="Opened (UTC)" column="opened" {...head} />
              <SortHeader label="Ticket" column="ticket" {...head} numeric />
              <SortHeader label="Symbol" column="symbol" {...head} />
              <th scope="col">Side</th>
              <th scope="col">Lots</th>
              <th scope="col">Open</th>
              <th scope="col">Current</th>
              <th scope="col">SL</th>
              <th scope="col">TP</th>
              <SortHeader label="Floating" column="profit" {...head} numeric />
            </tr>
          </thead>
          <tbody>
            {result.rows.length === 0 ? (
              <tr>
                <td colSpan={10} style={{ textAlign: "center", color: "var(--ink-3)" }}>
                  No open positions.
                </td>
              </tr>
            ) : (
              result.rows.map((p) => {
                const floating = p.profitCents + p.swapCents + p.commissionCents;
                return (
                  <tr key={p.ticket}>
                    <td className="num" style={{ textAlign: "left" }}>{utcStamp(p.openTime)}</td>
                    <td className="num">{p.ticket}</td>
                    <td style={{ textAlign: "left" }}>{p.symbol}</td>
                    <td style={{ textAlign: "left" }}>{p.side === "buy" ? "Buy" : "Sell"}</td>
                    <td className="num">{lots(p.volumeMilliLots)}</td>
                    <td className="num">{p.openPrice}</td>
                    <td className="num">{p.currentPrice}</td>
                    <td className="num">{p.slPrice ?? "—"}</td>
                    <td className="num">{p.tpPrice ?? "—"}</td>
                    <td className={`num ${toneOf(floating)}`}>{signedMoney(floating)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ textAlign: "left" }}>
                {result.summary.count} open · {result.summary.longs} long / {result.summary.shorts} short
              </td>
              <td colSpan={8} />
              <td className={`num ${toneOf(result.summary.floatingCents)}`}>
                {signedMoney(result.summary.floatingCents)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Pager
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        prefix="p"
        basePath={basePath}
        params={params}
        noun="position"
      />
      <p className="filters-footnote">
        Floating P/L updates with the market and is never part of a committed daily reading. SL
        and TP show an em dash when not set. Times are UTC.
      </p>
    </Panel>
  );
}
