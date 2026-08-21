/**
 * The day drill-down. A route target (`?day=2026-05-07`), not a modal —
 * plan 5's decision 3: a read-only list of one day's trades needs no confirm
 * step and no JavaScript, unlike plan 4's .modal flows that move money.
 *
 * `cell` is null exactly when the day has no trades: aggregateCalendar only
 * ever puts a day in its Map when at least one deal closed on it, and the
 * page constructs `cell` with `days.get(day) ?? null`. That happens whenever
 * a manager hand-edits `?day=` to a real date in the displayed month that
 * simply did not trade — reachable, not an error, so it renders a sentence
 * rather than an empty table.
 *
 * Rows are ordered chronologically (ascending, ticket tie-break) rather than
 * TradesTable's newest-first: TradesTable scans a whole account for what
 * happened recently, this panel narrates how one day's session unfolded from
 * open to close. The Closed column shows only the time — the date is already
 * this panel's heading — sliced from present/figures.ts's utcStamp rather
 * than a second date-time formatter.
 */
import type { CalendarDay } from "@/lib/compound/journal/calendar-aggregate";
import { hrefWith, type Params } from "@/lib/compound/journal/table-state";
import type { ClosedDeal } from "@/lib/compound/reconcile/types";
import { lots, signedMoney, toneOf, utcDate, utcStamp } from "@/lib/compound/present/figures";
import { Panel } from "../primitives";

function byCloseTimeAscending(a: ClosedDeal, b: ClosedDeal): number {
  if (a.closeTime < b.closeTime) return -1;
  if (a.closeTime > b.closeTime) return 1;
  return a.ticket - b.ticket;
}

export function DayPanel({
  day,
  cell,
  deals,
  basePath,
  params,
}: {
  day: string;
  cell: CalendarDay | null;
  deals: readonly ClosedDeal[];
  basePath: string;
  params: Params;
}) {
  const closeHref = hrefWith(basePath, params, { day: null });

  if (cell === null) {
    return (
      <Panel>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <h2 className="cal-title">{utcDate(day)}</h2>
          <a className="btn" href={closeHref}>
            Close
          </a>
        </div>
        <p className="muted" style={{ margin: "12px 0 0" }}>
          No trades closed on {utcDate(day)}.
        </p>
      </Panel>
    );
  }

  const rows = [...deals].sort(byCloseTimeAscending);

  return (
    <Panel flush>
      <div className="cal-head">
        <div className="cal-nav">
          <h2 className="cal-title">{utcDate(day)}</h2>
          <a className="btn" href={closeHref}>
            Close
          </a>
        </div>
        <p className="cal-summary num">
          {cell.wins}W / {cell.losses}L{cell.flat > 0 ? ` / ${cell.flat} flat` : ""} · net{" "}
          <span className={toneOf(cell.netCents)}>{signedMoney(cell.netCents)}</span>
        </p>
      </div>
      <div className="scroller">
        <table>
          <caption className="sr-only">
            Trades closed on {utcDate(day)}, {rows.length} in total.
          </caption>
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: "left" }}>
                Closed
              </th>
              <th scope="col">Ticket</th>
              <th scope="col" style={{ textAlign: "left" }}>
                Symbol
              </th>
              <th scope="col" style={{ textAlign: "left" }}>
                Side
              </th>
              <th scope="col">Lots</th>
              <th scope="col">Gross</th>
              <th scope="col">Net</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const net = d.profitCents + d.swapCents + d.commissionCents;
              return (
                <tr key={d.ticket}>
                  <td className="num" style={{ textAlign: "left" }}>
                    {utcStamp(d.closeTime).slice(11)}
                  </td>
                  <td className="num">{d.ticket}</td>
                  <td style={{ textAlign: "left" }}>{d.symbol}</td>
                  <td style={{ textAlign: "left" }}>{d.side === "buy" ? "Buy" : "Sell"}</td>
                  <td className="num">{lots(d.volumeMilliLots)}</td>
                  <td className={`num ${toneOf(d.profitCents)}`}>{signedMoney(d.profitCents)}</td>
                  <td className={`num ${toneOf(net)}`}>{signedMoney(net)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
