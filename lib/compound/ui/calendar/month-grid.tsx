/**
 * The month grid. Every cell is a link (`?month=&day=`); there is no client
 * state here at all — Prev/Next and a day click are all plain navigation.
 *
 * Renders through Panel's `flush` mode, the same pattern journal/trades-table
 * uses: a full-bleed table needs its own edge, not the .panel default 20px
 * padding, so the heading gets its own padded div instead (see .cal-head).
 */
import type { CalendarDay, MonthSummary } from "@/lib/compound/journal/calendar-aggregate";
import { monthGrid, shiftMonth } from "@/lib/compound/journal/calendar-aggregate";
import { hrefWith, type Params } from "@/lib/compound/journal/table-state";
import { signedMoney, toneOf, utcDate } from "@/lib/compound/present/figures";
import { Panel } from "../primitives";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function MonthGrid({
  month,
  days,
  summary,
  tierOf,
  selectedDay,
  latest,
  basePath,
  params,
}: {
  month: string;
  days: Map<string, CalendarDay>;
  summary: MonthSummary;
  tierOf: (d: CalendarDay) => 0 | 1 | 2;
  selectedDay: string | null;
  /** The newest month with data; Next is disabled beyond it. */
  latest: string;
  basePath: string;
  params: Params;
}) {
  const rows = monthGrid(month);
  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const monthHref = (m: string) => hrefWith(basePath, params, { month: m, day: null });

  return (
    <Panel flush>
      <div className="cal-head">
        <div className="cal-nav">
          <a className="btn" href={monthHref(prev)} rel="prev" aria-label={`Previous month, ${prev}`}>
            ‹
          </a>
          <h2 className="cal-title">{month}</h2>
          {next <= latest ? (
            <a className="btn" href={monthHref(next)} rel="next" aria-label={`Next month, ${next}`}>
              ›
            </a>
          ) : (
            <span className="btn" aria-disabled="true">
              ›
            </span>
          )}
        </div>
        <p className="cal-summary num">
          {summary.tradingDays} trading days · {summary.tradeCount} trades ·{" "}
          {summary.wins}W / {summary.losses}L · net{" "}
          <span className={toneOf(summary.netCents)}>{signedMoney(summary.netCents)}</span>
        </p>
      </div>

      <table className="cal">
        <caption className="sr-only">
          Trading calendar for {month}. Days are UTC days. Each cell shows net profit and loss
          including swap and commission.
        </caption>
        <thead>
          <tr>
            {WEEKDAYS.map((w) => (
              <th key={w} scope="col">
                {w}
              </th>
            ))}
            {/* "Week" itself does not fit this fixed-width column at 375px —
                found by rendering the real component at that width, spec
                8.4's floor (see the task report). abbr keeps the full word
                available to assistive tech and on hover/focus. */}
            <th scope="col">
              <abbr title="Week total">Wk</abbr>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((week, wi) => {
            let weekNet = 0n;
            for (const key of week) {
              const cell = key === null ? undefined : days.get(key);
              if (cell) weekNet += cell.netCents;
            }
            return (
              <tr key={week.find((d) => d !== null) ?? `w${wi}`}>
                {week.map((key, di) => {
                  if (key === null) return <td key={`b${wi}-${di}`} className="cal-blank" />;
                  const cell = days.get(key);
                  const dayNumber = Number.parseInt(key.slice(8), 10);
                  if (cell === undefined) {
                    return (
                      <td key={key} className="cal-cell">
                        <span className="cal-day num">{dayNumber}</span>
                      </td>
                    );
                  }
                  const tone = toneOf(cell.netCents);
                  const cls = `cal-cell cal-t${tierOf(cell)} ${tone === "pos" ? "cal-win" : tone === "neg" ? "cal-loss" : ""}`;
                  return (
                    <td key={key} className={cls} aria-current={key === selectedDay ? "true" : undefined}>
                      <a className="cal-link" href={hrefWith(basePath, params, { month, day: key })}>
                        <span className="cal-day num">{dayNumber}</span>
                        <span className={`cal-pnl num ${tone}`}>{signedMoney(cell.netCents)}</span>
                        <span className="cal-count num">
                          {cell.tradeCount} {cell.tradeCount === 1 ? "trade" : "trades"}
                        </span>
                        <span className="sr-only">
                          {utcDate(key)}: {cell.wins} wins, {cell.losses} losses
                        </span>
                      </a>
                    </td>
                  );
                })}
                <td className={`cal-week num ${toneOf(weekNet)}`}>
                  {weekNet === 0n ? "—" : signedMoney(weekNet)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="filters-footnote">
        Days are <strong>UTC days</strong>, matching how deals are keyed everywhere in Compound. A
        trade closing near midnight UTC may sit on the previous day here and on the next day in the
        broker terminal. Figures are net of swap and commission.
      </p>
    </Panel>
  );
}
