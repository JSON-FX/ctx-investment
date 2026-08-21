/**
 * P/L distribution. One <rect> per bin from histogram.ts's integer edges —
 * horizontalScale is deliberately not used here: a histogram's x axis is
 * binCount evenly sized SLOTS, not one point per value, and count is already
 * a plain number (never cents), so no bigint conversion belongs on this axis
 * either. The only cents-to-pixel conversion in this file is on the label
 * text, through signedMoney, which never returns a number.
 *
 * An empty bin still renders its <rect>, at zero height, so a reader
 * comparing bar positions never has to wonder whether a gap is an omitted
 * bin or a bin nobody landed in — spec 8.4's "colour is never the sole
 * carrier of meaning" extends here to "absence is never the sole carrier
 * of a zero".
 */
import type { HistogramResult } from "@/lib/compound/journal/histogram";
import { signedMoney } from "@/lib/compound/present/figures";

const W = 900;
const H = 200;
const PAD = 18;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function HistogramChart({ result }: { result: HistogramResult }) {
  const { bins } = result;
  if (bins.length === 0) {
    return <p className="hist-empty">No closed trades yet for this account.</p>;
  }

  const usableW = W - 2 * PAD;
  const usableH = H - 2 * PAD;
  const baseline = H - PAD;
  const maxCount = Math.max(...bins.map((b) => b.count));
  const barW = usableW / bins.length;

  return (
    <figure className="hist">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-labelledby="hist-title">
        <title id="hist-title">
          Distribution of {result.total} closed trade {result.total === 1 ? "result" : "results"}
        </title>
        <line className="hist-base" x1={PAD} y1={baseline} x2={W - PAD} y2={baseline} />
        {bins.map((bin, i) => {
          const height = maxCount === 0 ? 0 : round2((bin.count / maxCount) * usableH);
          return (
            <rect
              key={`${bin.startCents}-${bin.endCents}`}
              className={`hist-${bin.sign}`}
              x={round2(PAD + i * barW)}
              y={round2(baseline - height)}
              width={round2(barW)}
              height={height}
            >
              <title>
                {signedMoney(bin.startCents)} to {signedMoney(bin.endCents)}: {bin.count}{" "}
                {bin.count === 1 ? "trade" : "trades"}
              </title>
            </rect>
          );
        })}
      </svg>

      <table className="sr-only">
        <caption>P/L distribution by bin</caption>
        <thead>
          <tr>
            <th scope="col">From</th>
            <th scope="col">To</th>
            <th scope="col">Count</th>
            <th scope="col">Sign</th>
          </tr>
        </thead>
        <tbody>
          {bins.map((bin) => (
            <tr key={`${bin.startCents}-${bin.endCents}`}>
              <td>{signedMoney(bin.startCents)}</td>
              <td>{signedMoney(bin.endCents)}</td>
              <td>{bin.count}</td>
              <td>{bin.sign}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
