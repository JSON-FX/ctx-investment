/**
 * The capital-event queue, and the suppressed-duplicates audit beneath it.
 *
 * Four states, and keeping them apart is most of this component's job:
 *
 *   clear           nothing pending. Readings are advancing.
 *   halted          the reconciler stopped. There is a candidate to classify.
 *   defect          planReadings threw. Upstream data is wrong — a duplicate
 *                   trade date, or a window that starts after the cursor. This
 *                   is NOT a halt and must not be dressed as one: telling a
 *                   manager to classify a capital event that does not exist
 *                   sends them looking in the wrong place while the real
 *                   problem, which the duplicate date may be hiding, stays put.
 *   not-configured  no broker offset, so nothing has been reconciled at all.
 *
 * The arithmetic on a candidate is rendered through Receipt/ReceiptLine, not
 * hand-rolled <dl>/<dt>/<dd> markup. An earlier draft of this file put the id
 * `aria-labelledby` points at on the same <dt> that also held the hint
 * <small> — receipt.tsx's own history documents that mistake: aria-labelledby
 * takes the FULL text content of the element it points at, so the label and
 * the hint collapse into one accessible name and `getByLabelText("The
 * balance moved by")` stops matching. Receipt/ReceiptLine already keep the
 * label and the hint in separate elements (aria-labelledby vs
 * aria-describedby); reusing them here means this file cannot reintroduce a
 * bug that was already found and fixed once in this same plan.
 */
import type { Cents } from "@/lib/compound/engine/money";
import type { ReadingPlan } from "@/lib/compound/reconcile/interlock";
import type { DroppedDeal } from "@/lib/compound/reconcile/dedupe";
import { dealNetCents } from "@/lib/compound/reconcile/types";
import { formatDate, formatLots, formatUtcStamp } from "@/lib/compound/present/format";
import { DeltaMoney, EmptyState, Eyebrow, Panel } from "./primitives";
import { Receipt, ReceiptLine, ReceiptTotal } from "./receipt";
import { classifyHref } from "./routes";

/**
 * Declared here rather than importing the candidate row type from this
 * plan's db layer, even as a type-only import — the ui/ purity guard scans
 * source text for an import path reaching into that layer and does not
 * distinguish a type-only import from a value one, matching the Global
 * Constraint that ui/ imports no db/ at all. (Writing that import path
 * literally, even inside this comment, is what the guard would flag — hence
 * the roundabout phrasing.) The plan's own Step 3 draft imports the db row
 * type directly here; running the purity suite against that fails
 * immediately, offenders: [review-queue.tsx]. Every field below already
 * exists on that row, so the caller (app/a/[id]/review/page.tsx, outside
 * ui/ and free to import the db layer) can pass its rows straight through —
 * structurally compatible, no mapping needed.
 */
export interface ReviewCandidate {
  id: number;
  /** YYYY-MM-DD. */
  tradeDate: string;
  balanceDeltaCents: Cents;
  explainedCents: Cents;
  unexplainedCents: Cents;
}

export function SuppressedDeals({
  dropped, currency,
}: { dropped: DroppedDeal[]; currency: string }) {
  return (
    <Panel flush>
      <div className="scroller">
        <table>
          <caption className="eyebrow">
            Suppressed as duplicates · {dropped.length}
          </caption>
          <thead>
            <tr>
              <th scope="col">Ticket</th>
              <th scope="col">Symbol</th>
              <th scope="col">Side</th>
              <th scope="col">Volume</th>
              <th scope="col">Closed</th>
              <th scope="col">Net</th>
              <th scope="col">Judged a copy of</th>
            </tr>
          </thead>
          <tbody>
            {dropped.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "left" }} className="muted">
                  Nothing was suppressed in this run.
                </td>
              </tr>
            ) : (
              dropped.map((d) => (
                <tr key={d.deal.ticket}>
                  <th scope="row" className="num" style={{ fontWeight: 400 }}>
                    {d.deal.ticket}
                  </th>
                  <td>{d.deal.symbol}</td>
                  <td>{d.deal.side}</td>
                  <td className="num">{formatLots(d.deal.volumeMilliLots)}</td>
                  <td className="num">{formatUtcStamp(d.deal.closeTime)}</td>
                  <td><DeltaMoney cents={dealNetCents(d.deal)} currency={currency} /></td>
                  <td className="num">{d.duplicateOfTicket}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="foot" style={{ padding: "14px 16px" }}>
        These rows were excluded from reconciliation as time-shifted copies of the ticket
        named beside them. Check each pair really is one trade recorded twice. A genuine
        trade wrongly suppressed makes the explained figure too small, so it shows up here
        as a capital event that is not one — loud, and safe. A duplicate wrongly kept makes
        the explained figure too large and can mask a real capital event entirely — silent,
        and the reason this list exists at all.
      </p>
    </Panel>
  );
}

export function ReviewQueue({
  accountId, currency, plan, pending, frozenAt, defect, notConfigured, refreshAction,
}: {
  accountId: number;
  currency: string;
  /** Null when planReadings could not run. */
  plan: ReadingPlan | null;
  pending: ReviewCandidate[];
  frozenAt: string | null;
  defect: string | null;
  notConfigured: boolean;
  refreshAction: React.ReactNode;
}) {
  return (
    <>
      {notConfigured ? (
        <Panel>
          <div className="banner-halt" role="status">
            <strong>Reconciliation is switched off for this account.</strong>
            <p style={{ margin: "6px 0 0" }}>
              The broker&apos;s UTC offset is not set. Without it the duplicate-deal guard
              cannot run, and reconciling with duplicates left in inflates the explained
              figure and can hide a real capital event. Set the offset on the account to
              switch reconciliation on.
            </p>
          </div>
        </Panel>
      ) : null}

      {defect !== null ? (
        <Panel>
          <div className="banner-halt" role="alert">
            <strong>The data upstream is wrong, and this is not a capital event.</strong>
            <p style={{ margin: "6px 0 0" }}>{defect}</p>
            <p style={{ margin: "6px 0 0" }} className="muted">
              Nothing here needs classifying. Reconciliation cannot run until the snapshot
              rows are fixed at the source — and note that a duplicated trade date can be
              concealing a real capital event, so this is worth fixing rather than working
              around.
            </p>
          </div>
        </Panel>
      ) : null}

      {pending.length === 0 && defect === null && !notConfigured ? (
        <Panel>
          <EmptyState title="Nothing waiting">
            Every balance move CopyTraderX has reported is explained by closed trades or by
            an entry in the ledger. Readings are advancing
            {frozenAt === null ? "" : `, last posted ${formatDate(frozenAt)}`}.
          </EmptyState>
          <div className="actions" style={{ justifyContent: "center" }}>{refreshAction}</div>
        </Panel>
      ) : null}

      {pending.length > 0 ? (
        <div className="queue">
          {pending.map((k) => (
            <article className="queue-item" key={k.id} aria-labelledby={`cand-${k.id}`}>
              <Eyebrow>Unexplained balance move</Eyebrow>
              <h2
                id={`cand-${k.id}`}
                style={{ fontFamily: "var(--serif)", fontWeight: 400, fontSize: 24, margin: "4px 0 10px" }}
              >
                {formatDate(k.tradeDate)}
              </h2>

              <Receipt label={`Arithmetic for ${k.tradeDate}`}>
                <ReceiptLine
                  label="The balance moved by"
                  hint="Close-to-close, against the previous snapshot."
                >
                  <DeltaMoney cents={k.balanceDeltaCents} currency={currency} />
                </ReceiptLine>
                <ReceiptLine
                  label="Closed trades explain"
                  hint="Profit, swap and commission on every deal that closed in between, duplicates removed."
                >
                  <DeltaMoney cents={k.explainedCents} currency={currency} />
                </ReceiptLine>
                <ReceiptTotal
                  label="Nobody has accounted for"
                  hint="The difference. Capital moved, or something upstream is wrong."
                >
                  <DeltaMoney cents={k.unexplainedCents} currency={currency} />
                </ReceiptTotal>
              </Receipt>

              <p className="split-note">
                Readings are frozen at{" "}
                {frozenAt === null ? "inception" : formatDate(frozenAt)} and NAV will not
                advance past it until this is classified. That is deliberate: an unrecorded
                deposit is indistinguishable from profit, and profit gets split.
              </p>

              <div className="actions">
                <a className="btn btn-primary" href={classifyHref(accountId, k.id)}>
                  Classify this
                </a>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {plan === null ? null : (
        <SuppressedDeals dropped={plan.droppedDeals} currency={currency} />
      )}
    </>
  );
}
