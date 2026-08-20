/**
 * Deployment shell for the Compound investor desk.
 *
 * This is NOT the desk. It replays a fictional ledger through the accounting
 * engine and renders the resulting PoolState, so that a running container
 * proves two things at once: the deployment works, and the engine computes.
 * Plan 3 replaces this page with the real desk.
 */
import { formatCents, formatUnits, UNIT_SCALE } from "@/lib/compound/engine/money";
import { allocateValues, navTimes1e4 } from "@/lib/compound/engine/nav";
import { fold, totalsOf } from "@/lib/compound/engine/replay";
import { checkInvariants } from "@/lib/compound/engine/invariants";
import { DEMO_HOLDER_NAMES, DEMO_HOLDERS, DEMO_LEDGER } from "@/lib/compound/demo/fixture-ledger";

export const dynamic = "force-dynamic";

function pct4(n: bigint): string {
  // navTimes1e4 is NAV × 10^4. Since-inception growth is (NAV − 1) × 100.
  const basisPoints = n - 10_000n;
  const sign = basisPoints >= 0n ? "+" : "-";
  const abs = basisPoints < 0n ? -basisPoints : basisPoints;
  return `${sign}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}%`;
}

export default function Page() {
  const state = fold(DEMO_LEDGER, DEMO_HOLDERS);
  const totals = totalsOf(state);
  const nav = navTimes1e4(totals);
  const values = allocateValues(totals, state.holders.map((h) => h.units));
  const violations = checkInvariants(state);

  const sumValues = values.reduce((s, c) => s + c, 0n);
  const sumUnits = state.holders.reduce((s, h) => s + h.units, 0n);

  const [whole, cents] = formatCents(state.equityCents).split(".");

  const rows = state.holders.map((h, i) => {
    const value = values[i] ?? 0n;
    const profit = value - h.basisCents;
    const sharePct = state.units > 0n ? Number((h.units * 10_000n) / state.units) / 100 : 0;
    const feeCents = h.isManager || profit <= 0n
      ? 0n
      : (profit * BigInt(h.splitBps)) / 10_000n;
    return { h, value, profit, sharePct, feeCents, name: DEMO_HOLDER_NAMES[h.holderId] ?? `#${h.holderId}` };
  });

  const investors = rows.filter((r) => !r.h.isManager && r.h.units > 0n);
  const investorBasis = investors.reduce((s, r) => s + r.h.basisCents, 0n);
  const investorValue = investors.reduce((s, r) => s + r.value, 0n);
  const investorFee = investors.reduce((s, r) => s + r.feeCents, 0n);

  // Green ramp: the manager takes the darkest segment, investors progressively
  // lighter tints of the same hue. Green means "the pool, divided" — not
  // "yours" and not "gain", both of which are carried by other colours.
  const tints = ["#14532d", "#2e6b46", "#5c9576", "#a7cbb7"];

  return (
    <div className="wrap">
      <div className="mast">
        <div>
          <span className="mark">Compound</span>
          <span className="sub">Investor Desk</span>
        </div>
        <div className="acct">
          <span className="dot" />
          ctxinvestment.lan · deployment shell
        </div>
      </div>

      <div className="banner">
        <strong>Demonstration data.</strong> Every name and figure below is invented. This page
        replays a fixture ledger through the accounting engine to prove the container and the
        engine both work. Plan 3 replaces it with the real desk.
      </div>

      <section className="panel">
        <span className="eyebrow">
          Account equity · derived from {DEMO_LEDGER.length} ledger entries · as of {state.lastReadingOn}
        </span>
        <div className="erow">
          <div className="equity num">
            ${whole}
            <span className="cents">.{cents}</span>
          </div>
          <div className="navbox">
            <div>
              <span className="k">NAV / unit</span>
              <span className="v num">
                {(nav / 10_000n).toString()}.{(nav % 10_000n).toString().padStart(4, "0")}
              </span>
            </div>
            <div>
              <span className="k">Since inception</span>
              <span className={`v num ${nav >= 10_000n ? "pos" : "neg"}`}>{pct4(nav)}</span>
            </div>
            <div>
              <span className="k">Units issued</span>
              <span className="v num">{formatUnits(state.units, 2)}</span>
            </div>
            <div>
              <span className="k">Holders</span>
              <span className="v num">{state.holders.filter((h) => h.units > 0n).length}</span>
            </div>
          </div>
        </div>

        <div className="rail">
          {rows
            .filter((r) => r.h.units > 0n)
            .map((r, i) => (
              <div
                key={r.h.holderId}
                className="seg"
                style={{ width: `${r.sharePct}%`, background: tints[i % tints.length] }}
                title={`${r.name} — ${r.sharePct.toFixed(1)}%`}
              />
            ))}
        </div>
        <div className="leg">
          {rows
            .filter((r) => r.h.units > 0n)
            .map((r, i) => (
              <span key={r.h.holderId}>
                <i style={{ background: tints[i % tints.length] }} />
                {r.name} <b>{r.sharePct.toFixed(1)}%</b>
              </span>
            ))}
        </div>
      </section>

      <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
        <div className="scroller">
          <table>
            <thead>
              <tr>
                <th>Holder</th>
                <th>Capital in</th>
                <th>Units</th>
                <th>Share</th>
                <th>Value now</th>
                <th>Open P/L</th>
                <th>Split</th>
                <th>Fee if paid out</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const closed = r.h.status === "closed";
                return (
                  <tr key={r.h.holderId} className={r.h.isManager ? "own" : closed ? "closed" : ""}>
                    <td>
                      {r.name}
                      {r.h.isManager && <span className="tag">Manager</span>}
                    </td>
                    <td className="num">{formatCents(r.h.basisCents)}</td>
                    <td className="num">{formatUnits(r.h.units, 2)}</td>
                    <td className="num">{r.sharePct.toFixed(1)}%</td>
                    <td className="num">{formatCents(r.value)}</td>
                    <td className={`num ${r.profit >= 0n ? "pos" : "neg"}`}>
                      {r.profit >= 0n ? "+" : ""}
                      {formatCents(r.profit)}
                    </td>
                    <td className="num">
                      {r.h.isManager ? "—" : `${(10_000 - r.h.splitBps) / 100} / ${r.h.splitBps / 100}`}
                    </td>
                    <td className="num fee">{r.feeCents > 0n ? formatCents(r.feeCents) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>Investors, active</td>
                <td className="num">{formatCents(investorBasis)}</td>
                <td />
                <td />
                <td className="num">{formatCents(investorValue)}</td>
                <td className={`num ${investorValue - investorBasis >= 0n ? "pos" : "neg"}`}>
                  {investorValue - investorBasis >= 0n ? "+" : ""}
                  {formatCents(investorValue - investorBasis)}
                </td>
                <td />
                <td className="num fee">{formatCents(investorFee)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section className="panel">
        <span className="eyebrow">Invariants, checked live on this state</span>
        <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.9 }}>
          <div>
            <span className="num">Σ holder units</span> = <span className="num">{formatUnits(sumUnits, 4)}</span>{" "}
            versus units issued <span className="num">{formatUnits(state.units, 4)}</span>{" "}
            {sumUnits === state.units ? <span className="ok">exact</span> : <span className="neg">MISMATCH</span>}
          </div>
          <div>
            <span className="num">Σ holder value</span> = <span className="num">{formatCents(sumValues)}</span>{" "}
            versus equity <span className="num">{formatCents(state.equityCents)}</span>{" "}
            {sumValues === state.equityCents ? <span className="ok">exact</span> : <span className="neg">MISMATCH</span>}
          </div>
          <div>
            checkInvariants:{" "}
            {violations.length === 0 ? (
              <span className="ok">no violations</span>
            ) : (
              <span className="neg">{violations.map((v) => v.code).join(", ")}</span>
            )}
          </div>
        </div>
      </section>

      <div className="foot">
        Units are bigint scaled 1e-10 (UNIT_SCALE {UNIT_SCALE.toString()}); money is integer cents.
        No floating point is used anywhere in the accounting engine. Every figure on this page is
        derived by replaying the ledger — nothing is stored.
      </div>
    </div>
  );
}
