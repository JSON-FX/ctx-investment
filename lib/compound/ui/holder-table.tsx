/**
 * The holder table. Every figure here is ALLOCATED (decision D-A): the value
 * column sums to account equity exactly, because invariant 2 says it does.
 *
 * A holder's payout receipt shows a floored value that can be one cent lower.
 * That is correct on both screens and the holder statement page explains it in
 * words. Do not make them agree here.
 *
 * Real table semantics throughout: scope="col" on headers, scope="row" on the
 * holder name. That is how a screen reader associates $12,630.61 with "Ada
 * Lovelace, Value now", and it is how the tests find it too.
 *
 * The footer's P/L reads `figures.investorProfitCents` — present/derive.ts's
 * own precomputed field — rather than subtracting basis from value locally.
 * An earlier draft of this file did the subtraction here instead; the two
 * are numerically identical for bigints (sum of differences equals
 * difference of sums exactly, with no rounding step to disagree over), so no
 * test would ever have caught it as a wrong number, but it is still the
 * "figure computed in two places" shape this kit is specifically not
 * supposed to contain. deskFigures already carries the answer; this
 * component's job is to render it, not re-derive it.
 */
import type { DeskFigures } from "@/lib/compound/present/derive";
import { formatSplit, formatUnitsDp } from "@/lib/compound/present/format";
import { DeltaMoney, FeeMoney, Money, Share, Tag } from "./primitives";
import { holderHref, payoutHref } from "./routes";

export function HolderTable({
  accountId, figures, currency, showActions = true,
}: {
  accountId: number;
  figures: DeskFigures;
  currency: string;
  showActions?: boolean;
}) {
  return (
    <div className="scroller">
      <table>
        <caption className="eyebrow">Holders</caption>
        <thead>
          <tr>
            <th scope="col">Holder</th>
            <th scope="col">Capital in</th>
            <th scope="col">Units</th>
            <th scope="col">Share</th>
            <th scope="col">Value now</th>
            <th scope="col">P/L</th>
            <th scope="col">Split</th>
            <th scope="col">Fee if paid out</th>
            {showActions ? <th scope="col"> </th> : null}
          </tr>
        </thead>
        <tbody>
          {figures.rows.map((r) => (
            <tr
              key={r.holderId}
              className={r.isManager ? "own" : r.status === "closed" ? "closed" : ""}
            >
              <th scope="row" style={{ fontWeight: 400 }}>
                <a href={holderHref(accountId, r.holderId)}>{r.name}</a>
                {r.isManager ? <Tag>Manager</Tag> : null}
                {r.status === "closed" ? <Tag>Closed</Tag> : null}
              </th>
              <td><Money cents={r.basisCents} currency={currency} /></td>
              <td className="num">{r.units === 0n ? "—" : formatUnitsDp(r.units)}</td>
              <td><Share ppm={r.ppm} /></td>
              <td><Money cents={r.valueCents} currency={currency} /></td>
              <td><DeltaMoney cents={r.profitCents} currency={currency} /></td>
              <td className="num">{r.isManager ? "—" : formatSplit(r.splitBps)}</td>
              <td><FeeMoney cents={r.feeIfExitCents} currency={currency} zeroAs="dash" /></td>
              {showActions ? (
                <td>
                  {r.status === "active" && r.units > 0n ? (
                    <a className="btn" href={payoutHref(accountId, r.holderId)}>Pay out</a>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" style={{ fontWeight: 600 }}>Investors, active</th>
            <td><Money cents={figures.investorBasisCents} currency={currency} /></td>
            <td />
            <td />
            <td><Money cents={figures.investorValueCents} currency={currency} /></td>
            <td><DeltaMoney cents={figures.investorProfitCents} currency={currency} /></td>
            <td />
            <td><FeeMoney cents={figures.feeIfAllExitCents} currency={currency} /></td>
            {showActions ? <td /> : null}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
