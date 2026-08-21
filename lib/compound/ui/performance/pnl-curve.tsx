/**
 * The trading-P/L curve: cumulative net of every closed trade. Capital-
 * neutral by construction (trade-equity.ts never reads a snapshot or a
 * ledger entry), which is what makes it the honest half of the R4 pairing —
 * see equity-chart.tsx for the half that a deposit DOES move.
 *
 * The vertical scale always includes 0n even though every value in
 * `result.curve` is already relative to a start of zero. Seeding it
 * explicitly rather than trusting the curve to reach zero on its own matters
 * for a curve that opens with a loss: without the seed, the scale's domain
 * would start at the first (negative) point rather than at zero, and the
 * chart would draw as if the account started already down — the exact
 * exaggeration spec 8.4's "colour is never the sole carrier of meaning" rule
 * exists to prevent one level up (a shape carrying a false meaning, here
 * rather than a colour).
 */
import type { TradeEquityResult } from "@/lib/compound/journal/trade-equity";
import { horizontalScale, polylinePoints, verticalScale } from "../scale";
import { money, signedMoney, utcStamp } from "@/lib/compound/present/figures";

const W = 900;
const H = 300;
const PAD = 18;

export function PnlCurve({ result }: { result: TradeEquityResult }) {
  const { curve } = result;
  if (curve.length === 0) {
    return <p className="curve-empty">No closed trades yet for this account.</p>;
  }

  const cum = curve.map((p) => p.cumCents);
  const scale = verticalScale([0n, ...cum], H, PAD);
  const x = horizontalScale(curve.length, W, PAD);

  return (
    <figure className="curve">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-labelledby="pnl-curve-title pnl-curve-desc"
      >
        <title id="pnl-curve-title">Trading profit and loss, capital excluded</title>
        <desc id="pnl-curve-desc">
          Cumulative trading result over {curve.length} closed{" "}
          {curve.length === 1 ? "trade" : "trades"}: {signedMoney(result.netCents)} net, a peak of{" "}
          {money(result.peakCents)} and a maximum drawdown of {money(result.maxDrawdownCents)}.
          This curve excludes every capital movement — deposits and payouts — showing only what
          trading itself did.
        </desc>

        {scale.zeroY === null ? null : (
          <line className="curve-zero" x1={PAD} y1={scale.zeroY} x2={W - PAD} y2={scale.zeroY} />
        )}

        <polyline className="curve-equity" points={polylinePoints(cum, scale, x)} />
      </svg>

      <figcaption className="curve-legend">
        <span className="curve-key curve-key-equity">Trading P/L, capital excluded</span>
      </figcaption>

      <table className="sr-only">
        <caption>Trading profit and loss by closed trade</caption>
        <thead>
          <tr>
            <th scope="col">Ticket</th>
            <th scope="col">Closed</th>
            <th scope="col">Net</th>
            <th scope="col">Running total</th>
          </tr>
        </thead>
        <tbody>
          {curve.map((p) => (
            <tr key={p.ticket}>
              <td>{p.ticket}</td>
              <td>{utcStamp(p.ts)}</td>
              <td>{signedMoney(p.netCents)}</td>
              <td>{signedMoney(p.cumCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
