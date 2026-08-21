/**
 * Account equity, contributed capital, and a marker at every capital event.
 * Spec R4.
 *
 * The two lines are the point. Equity alone cannot distinguish a deposit from
 * a good week; equity next to contributed capital can, because on a deposit
 * both step by the same amount and the vertical gap between them — which is
 * performance — does not change. The markers name the event; the second line
 * is what makes the shape read correctly even without looking at them.
 *
 * Both series share ONE vertical scale. Scaling them independently would make
 * the gap between them meaningless, which is the only thing the chart is for.
 */
import type { AccountEquitySeries } from "@/lib/compound/journal/equity-series";
import { horizontalScale, polylinePoints, verticalScale } from "../scale";
import { money, signedMoney, utcDate } from "@/lib/compound/present/figures";

const W = 900;
const H = 300;
const PAD = 18;

export function EquityChart({ series }: { series: AccountEquitySeries }) {
  const { points } = series;
  if (points.length === 0) {
    return (
      <p className="curve-empty">No equity readings yet for this account.</p>
    );
  }

  const equity = points.map((p) => p.equityCents);
  const contributed = points.map((p) => p.contributedCents);
  const scale = verticalScale([...equity, ...contributed], H, PAD);
  const x = horizontalScale(points.length, W, PAD);

  const marked = points
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.marks.length > 0);

  return (
    <figure className="curve">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-labelledby="equity-chart-title equity-chart-desc"
      >
        <title id="equity-chart-title">Account equity and contributed capital</title>
        <desc id="equity-chart-desc">
          Equity from {money(scale.minCents)} to {money(scale.maxCents)} over {points.length}{" "}
          readings, with {marked.length} capital {marked.length === 1 ? "event" : "events"} marked.
          Where both lines step together, money moved in or out rather than being earned.
        </desc>

        {scale.zeroY === null ? null : (
          <line className="curve-zero" x1={PAD} y1={scale.zeroY} x2={W - PAD} y2={scale.zeroY} />
        )}

        {marked.map(({ p, i }) => (
          <g className="curve-mark" key={p.date}>
            <line x1={x(i)} y1={PAD} x2={x(i)} y2={H - PAD} />
            <circle cx={x(i)} cy={scale.y(p.equityCents)} r={3.5} />
            <title>
              {utcDate(p.date)}:{" "}
              {p.marks
                .map((m) => `${m.direction === "in" ? "capital in" : "capital out"} ${money(m.amountCents)}`)
                .join(", ")}
            </title>
          </g>
        ))}

        <polyline className="curve-contributed" points={polylinePoints(contributed, scale, x)} />
        <polyline className="curve-equity" points={polylinePoints(equity, scale, x)} />
      </svg>

      <figcaption className="curve-legend">
        <span className="curve-key curve-key-equity">Account equity</span>
        <span className="curve-key curve-key-contributed">Capital contributed</span>
        <span className="curve-key curve-key-mark">Capital event</span>
        {series.points.some((p) => p.incompleteMarks) ? (
          <span className="curve-key curve-key-warn">
            Capital events after {series.marksCompleteThrough ?? "the start"} may be incomplete
          </span>
        ) : null}
      </figcaption>

      <table className="sr-only">
        <caption>Account equity, contributed capital and performance by reading date</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Equity</th>
            <th scope="col">Contributed</th>
            <th scope="col">Performance</th>
            <th scope="col">Capital events</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <td>{utcDate(p.date)}</td>
              <td>{money(p.equityCents)}</td>
              <td>{money(p.contributedCents)}</td>
              <td>{signedMoney(p.performanceCents)}</td>
              <td>
                {p.marks.length === 0
                  ? "none"
                  : p.marks
                      .map((m) => `${m.direction === "in" ? "in" : "out"} ${money(m.amountCents)}`)
                      .join("; ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {series.trailingMarks.length === 0 ? null : (
        <p className="filters-footnote">
          {series.trailingMarks.length} capital{" "}
          {series.trailingMarks.length === 1 ? "event is" : "events are"} dated after the last
          equity reading and {series.trailingMarks.length === 1 ? "is" : "are"} not yet on the
          curve.
        </p>
      )}
    </figure>
  );
}
