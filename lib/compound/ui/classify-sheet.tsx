/**
 * Classifying one capital event.
 *
 * Three outcomes and no fourth (decision D-J). That still holds: a withdrawal
 * is not a classification, it is a payout, and giving the queue a fourth
 * control would put two ways to record the same money one click apart.
 *
 * What changed is the advice. P6 — partial capital withdrawal — has shipped,
 * so a negative unexplained move that is not already in the ledger can now be
 * recorded for its exact amount through the payout screen rather than only as
 * a full exit. The sheet points there instead of saying it cannot be done.
 *
 * Local `SheetHolder` rather than importing `HolderRow` from this plan's db
 * layer — same reason `ReviewCandidate` is declared in review-queue.tsx
 * instead of importing the candidate row type: the ui/ purity guard scans
 * source text for an import reaching the db layer and does not distinguish a
 * type-only import from a value one. `ReviewCandidate` (already declared for
 * the queue) covers the candidate shape this sheet needs too — same four
 * fields, no reason to duplicate it.
 */
import type { Cents } from "@/lib/compound/engine/money";
import type { LedgerEntry } from "@/lib/compound/engine/replay";
import type { Fingerprint } from "@/lib/compound/present/derive";
import { formatDate, formatMoney } from "@/lib/compound/present/format";
import { fingerprintToFields } from "@/lib/compound/present/fingerprint";
import { DeltaMoney } from "./primitives";
import { Receipt, ReceiptLine, ReceiptTotal } from "./receipt";
import { Field, FieldError, Sheet, SheetActions } from "./sheet";
import type { ReviewCandidate } from "./review-queue";

export interface SheetHolder {
  id: number;
  name: string;
  isManager: boolean;
}

export function ClassifySheet({
  accountId, candidate, holders, matchable, fingerprint, currency, form, error,
  backHref, commitAction,
}: {
  accountId: number;
  candidate: ReviewCandidate;
  holders: SheetHolder[];
  /** Ledger entries whose cash movement could account for this. */
  matchable: { entry: LedgerEntry; cashCents: Cents }[];
  fingerprint: Fingerprint;
  currency: string;
  form: { outcome?: string; holderId?: string; amount?: string; matchEntryId?: string; note?: string };
  error?: string;
  backHref: string;
  commitAction: (formData: FormData) => Promise<void>;
}) {
  const money = (c: Cents) => formatMoney(c, { currency });
  const positive = candidate.unexplainedCents > 0n;
  const fields = fingerprintToFields(fingerprint);
  const defaultAmount = candidate.unexplainedCents < 0n
    ? -candidate.unexplainedCents
    : candidate.unexplainedCents;

  return (
    <Sheet
      title={`Classify — ${formatDate(candidate.tradeDate)}`}
      lede="Readings are frozen until this is resolved. NAV never crosses a capital event nobody has explained."
      backHref={backHref}
    >
      {error ? <FieldError>{error}</FieldError> : null}

      <Receipt label="What happened on this day">
        <ReceiptLine label="The balance moved by">
          <DeltaMoney cents={candidate.balanceDeltaCents} currency={currency} />
        </ReceiptLine>
        <ReceiptLine label="Closed trades explain">
          <DeltaMoney cents={candidate.explainedCents} currency={currency} />
        </ReceiptLine>
        <ReceiptTotal label="Nobody has accounted for">
          <DeltaMoney cents={candidate.unexplainedCents} currency={currency} />
        </ReceiptTotal>
      </Receipt>

      {positive ? null : (
        <p className="split-note">
          Money left the account. If it was a payout you have already recorded here, match
          it below. If it was a withdrawal that is not in the ledger, record it on the
          payout screen — for the exact amount, or as a full exit — and then match it
          here. Do not mark it &ldquo;not a capital event&rdquo;: that would spread the
          loss across every holder pro-rata, charging people for money one person took.
        </p>
      )}

      <form action={commitAction}>
        <input type="hidden" name="accountId" value={accountId} />
        <input type="hidden" name="candidateId" value={candidate.id} />
        {Object.entries(fields).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}

        <fieldset style={{ border: 0, padding: 0, margin: "18px 0 0" }}>
          <legend><span className="eyebrow">What was this</span></legend>

          {positive ? (
            <div style={{ margin: "12px 0", paddingBottom: 12, borderBottom: "1px solid var(--rule-soft)" }}>
              <label>
                <input type="radio" name="outcome" value="deposit" defaultChecked={form.outcome !== "match" && form.outcome !== "ignore"} />{" "}
                <strong>A deposit</strong>
                <small className="muted" style={{ display: "block", marginLeft: 22 }}>
                  Someone put money in. Units are issued to them at the NAV on{" "}
                  {formatDate(candidate.tradeDate)}, which is what makes a late-recorded
                  deposit fair to everyone already in.
                </small>
              </label>
              <div style={{ marginLeft: 22, marginTop: 10 }}>
                <Field name="holderId" label="Whose">
                  <select id="holderId" name="holderId" defaultValue={form.holderId}>
                    <option value="">Choose…</option>
                    {holders.map((h) => (
                      <option key={h.id} value={h.id}>{h.name}{h.isManager ? " (you)" : ""}</option>
                    ))}
                  </select>
                </Field>
                <Field
                  name="amount"
                  label={`Amount, ${currency}`}
                  hint={`Defaults to the unexplained figure, ${money(defaultAmount)}. Change it only if part of the move was something else.`}
                >
                  <input
                    id="amount" name="amount" inputMode="decimal"
                    defaultValue={form.amount ?? money(defaultAmount).replace(/[^0-9.]/g, "")}
                  />
                </Field>
              </div>
            </div>
          ) : null}

          <div style={{ margin: "12px 0", paddingBottom: 12, borderBottom: "1px solid var(--rule-soft)" }}>
            <label>
              <input
                type="radio" name="outcome" value="match"
                defaultChecked={form.outcome === "match" || (!positive && form.outcome !== "ignore")}
                disabled={matchable.length === 0}
              />{" "}
              <strong>Already recorded here</strong>
              <small className="muted" style={{ display: "block", marginLeft: 22 }}>
                {matchable.length === 0
                  ? "No entry in the ledger has a cash movement that could account for this."
                  : "A payout recorded in Compound and then executed at the broker still shows up here, because the reconciler compares balance against closed trades and a withdrawal is neither."}
              </small>
            </label>
            {matchable.length === 0 ? null : (
              <div style={{ marginLeft: 22, marginTop: 10 }}>
                <Field name="matchEntryId" label="Which entry">
                  <select id="matchEntryId" name="matchEntryId" defaultValue={form.matchEntryId}>
                    <option value="">Choose…</option>
                    {matchable.map(({ entry, cashCents }) => (
                      <option key={entry.id} value={entry.id}>
                        #{entry.seq} · {formatDate(entry.occurredOn)} · {entry.type} ·{" "}
                        {money(cashCents)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
          </div>

          <div style={{ margin: "12px 0" }}>
            <label>
              <input type="radio" name="outcome" value="ignore" defaultChecked={form.outcome === "ignore"} />{" "}
              <strong>Not a capital event</strong>
              <small className="muted" style={{ display: "block", marginLeft: 22 }}>
                A broker credit, a rebate, a correction. No ledger entry is written and the
                amount is absorbed into NAV pro-rata by the next reading — which is right for
                money that belongs to every holder, and wrong for money that belongs to one.
              </small>
            </label>
            <div style={{ marginLeft: 22, marginTop: 10 }}>
              <Field
                name="note"
                label="Why (required)"
                hint="This is the only record of the decision. Nothing else will remember it."
              >
                <input id="note" name="note" defaultValue={form.note} />
              </Field>
            </div>
          </div>
        </fieldset>

        <SheetActions>
          <button className="btn btn-primary" type="submit">Classify and unfreeze</button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
