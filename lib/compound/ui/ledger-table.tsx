/**
 * The ledger, one row per entry, with the pool's state after each one.
 *
 * Every "after" figure comes from folding the prefix (decision D-E). It is
 * O(n^2) and it is the only construction under which this page cannot
 * disagree with the desk: the last row's state IS fold(everything), by
 * construction rather than by care.
 *
 * The CASH column is the equity delta, not entry.amountCents. For a deposit the
 * two agree. For a payout they do not — replay.ts recomputes the payout from
 * quote() and never reads amountCents, so the stored figure is what was asked
 * for and the delta is what left the account. A ledger that prints the request
 * where the reader expects the movement is a ledger that will be argued with.
 *
 * A reading moves no cash, so its cash cell is a dash rather than a zero. Zero
 * would claim a movement of nothing happened; a dash says the column does not
 * apply. A voided entry's delta is also a genuine zero — fold() skips a voided
 * entry's id entirely rather than netting it against its reversal — so it
 * renders the same dash, on top of the "voided" strike-through and label that
 * carry the actual audit signal.
 *
 * The `meta` prop is typed structurally here rather than imported from
 * lib/compound/db/ledger-meta. ui/purity.test.ts forbids ui/ sources from
 * importing anything under "@/lib/compound/db", including a type-only import
 * — the regex matches the module specifier regardless of the `type` keyword,
 * and the point of that rule is that this file renders what it is handed and
 * never gains a reason to reach for the data layer, not even for a shape. A
 * real LedgerEntryMeta from db/ledger-meta.ts satisfies this shape structurally,
 * so the page can pass one straight through with no cast.
 */
import { totalsOf } from "@/lib/compound/engine/replay";
import type { LedgerStep } from "@/lib/compound/present/derive";
import {
  formatDate, formatNav, formatUnitsDp, formatUtcStamp,
} from "@/lib/compound/present/format";
import { DeltaMoney, EmptyState, Money } from "./primitives";
import { holderHref } from "./routes";

export interface LedgerRowMeta {
  id: number;
  /** ISO 8601, UTC. */
  recordedAt: string;
  note: string | null;
  createdBy: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  deposit: "Deposit",
  payout: "Payout",
  exit: "Exit",
  equity_reading: "Equity reading",
  adjustment: "Adjustment",
};

export function LedgerTable({
  accountId, steps, meta, names, currency,
}: {
  accountId: number;
  steps: LedgerStep[];
  meta: Map<number, LedgerRowMeta>;
  names: Record<number, string>;
  currency: string;
}) {
  if (steps.length === 0) {
    return (
      <EmptyState title="No entries yet">
        Every deposit, payout and equity reading appears here, in the order it was
        applied. Nothing else moves a figure on this account.
      </EmptyState>
    );
  }

  const voidedBy = new Map<number, number>();
  for (const s of steps) {
    if (s.entry.reversesId !== null) voidedBy.set(s.entry.reversesId, s.entry.id);
  }

  return (
    <div className="scroller">
      <table>
        <caption className="eyebrow">
          Ledger · {steps.length} {steps.length === 1 ? "entry" : "entries"} ·
          append-only, ordered by seq
        </caption>
        <thead>
          <tr>
            <th scope="col">Seq</th>
            <th scope="col">Occurred</th>
            <th scope="col">Type</th>
            <th scope="col">Holder</th>
            <th scope="col">Cash</th>
            <th scope="col">Units</th>
            <th scope="col">Equity after</th>
            <th scope="col">Units after</th>
            <th scope="col">NAV after</th>
            <th scope="col">Recorded</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => {
            const m = meta.get(s.entry.id);
            const holderId = s.entry.holderId;
            const reversedBy = voidedBy.get(s.entry.id);
            return (
              <tr key={s.entry.id} className={s.voided ? "voided" : ""}>
                <th scope="row" className="num" style={{ fontWeight: 400 }}>{s.entry.seq}</th>
                <td className="num">{formatDate(s.entry.occurredOn)}</td>
                <td>
                  {TYPE_LABELS[s.entry.type] ?? s.entry.type}
                  {s.entry.feeSettlement === null ? null : (
                    <span className="muted"> · fee as {s.entry.feeSettlement}</span>
                  )}
                  {s.voided ? (
                    <span className="muted">
                      {" "}· voided{reversedBy === undefined ? "" : ` by #${reversedBy}`}
                    </span>
                  ) : null}
                  {s.entry.reversesId === null ? null : (
                    <span className="muted"> · reverses #{s.entry.reversesId}</span>
                  )}
                </td>
                <td>
                  {holderId === null ? "—" : (
                    <a href={holderHref(accountId, holderId)}>
                      {names[holderId] ?? `Holder #${holderId}`}
                    </a>
                  )}
                </td>
                <td>
                  {s.entry.type === "equity_reading" || s.equityDelta === 0n
                    ? <span className="num">—</span>
                    : <DeltaMoney cents={s.equityDelta} currency={currency} />}
                </td>
                <td className="num">
                  {s.unitsDelta === 0n
                    ? "—"
                    : `${s.unitsDelta > 0n ? "+" : "-"}${formatUnitsDp(
                        s.unitsDelta < 0n ? -s.unitsDelta : s.unitsDelta,
                      )}`}
                </td>
                <td><Money cents={s.after.equityCents} currency={currency} /></td>
                <td className="num">{formatUnitsDp(s.after.units)}</td>
                <td className="num">{formatNav(totalsOf(s.after))}</td>
                <td className="num muted">
                  {m === undefined ? "—" : formatUtcStamp(m.recordedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="foot" style={{ padding: "14px 16px" }}>
        The ledger is append-only. There is no edit and no delete on this screen or
        anywhere else, and none is granted in the database. A correction is a
        reversing entry, which voids both itself and the entry it reverses.
      </p>
    </div>
  );
}
