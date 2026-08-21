/**
 * Posting an equity reading by hand.
 *
 * Fenced, deliberately. A reading moves the reconcile cursor, and a cursor that
 * jumps past days nobody reconciled absorbs any capital event in them into NAV.
 * That is the loss section 5.3 exists to prevent, arriving through the one door
 * the interlock does not watch. So: only when the reconciler has nothing left
 * to post, and only dated after the last snapshot CopyTraderX has.
 *
 * The receipt shows every holder's value before and after, because that is what
 * a reading actually does — it does not move cash and it does not move units,
 * it revalues everyone at once.
 */
import type { Cents } from "@/lib/compound/engine/money";
import { totalsOf } from "@/lib/compound/engine/replay";
import type { Preview } from "@/lib/compound/present/derive";
import { formatDate, formatMoney, formatNav } from "@/lib/compound/present/format";
import { fingerprintToFields } from "@/lib/compound/present/fingerprint";
import { DeltaMoney } from "./primitives";
import { Receipt, ReceiptLine, ReceiptTotal } from "./receipt";
import { Field, FieldError, Sheet, SheetActions } from "./sheet";

export type ReadingGate =
  | { kind: "ready"; earliestDate: string }
  | { kind: "not-configured" }
  | { kind: "error"; message: string }
  | { kind: "unposted"; count: number; through: string }
  | { kind: "halted"; candidateDate: string; reviewHref: string };

export function ReadingSheet({
  accountId, gate, currency, names, preview, form, error, backHref, commitAction,
}: {
  accountId: number;
  gate: ReadingGate;
  currency: string;
  names: Record<number, string>;
  /** Absent on step one. */
  preview: Preview | null;
  form: { occurredOn?: string; equity?: string };
  error?: string;
  backHref: string;
  commitAction: (formData: FormData) => Promise<void>;
}) {
  if (gate.kind !== "ready") {
    return (
      <Sheet title="Post an equity reading" backHref={backHref}>
        <div className="banner-halt" role="status">
          <strong>Not yet.</strong>
          <p style={{ margin: "6px 0 0" }}>
            {gate.kind === "not-configured"
              ? "The broker UTC offset is not set for this account, so nothing has been reconciled. Set it on the account before posting readings by hand."
              : gate.kind === "error"
              ? gate.message
              : gate.kind === "unposted"
              ? `CopyTraderX has ${gate.count} ${gate.count === 1 ? "day" : "days"} up to ${formatDate(gate.through)} that are not posted yet. Refresh readings first: a hand-posted reading moves the cursor past them, and any capital event in those days would be absorbed into NAV without anyone seeing it.`
              : `An unexplained balance move on ${formatDate(gate.candidateDate)} is waiting to be classified. NAV must not cross it.`}
          </p>
          {gate.kind === "halted" ? (
            <p style={{ margin: "6px 0 0" }}><a href={gate.reviewHref}>Review it</a></p>
          ) : null}
        </div>
      </Sheet>
    );
  }

  if (preview === null) {
    return (
      <Sheet
        title="Post an equity reading"
        lede="A reading is what the account was worth on a given day. It moves NAV, and it is the only thing that does."
        backHref={backHref}
      >
        {error ? <FieldError>{error}</FieldError> : null}
        <form method="get">
          <input type="hidden" name="step" value="confirm" />
          <Field
            name="occurredOn"
            label="Date"
            hint={`Broker-server date. Must be after ${formatDate(gate.earliestDate)}, the last day already posted.`}
          >
            <input
              id="occurredOn" name="occurredOn" type="date" required
              min={gate.earliestDate} defaultValue={form.occurredOn}
            />
          </Field>
          <Field name="equity" label={`Account equity, ${currency}`} hint="Equity, not balance. A holder's value includes their share of open positions.">
            <input id="equity" name="equity" inputMode="decimal" required defaultValue={form.equity} />
          </Field>
          <SheetActions>
            <button className="btn btn-primary" type="submit">Review</button>
          </SheetActions>
        </form>
      </Sheet>
    );
  }

  const fields = fingerprintToFields(preview.fingerprint);
  const change = (i: number): Cents => preview.valuesAfter[i]! - preview.valuesBefore[i]!;

  return (
    <Sheet title="Post an equity reading" backHref={backHref} backLabel="Back">
      {error ? <FieldError>{error}</FieldError> : null}
      <Receipt label="Equity reading">
        <ReceiptLine label="Date">
          <span className="num">{formatDate(form.occurredOn ?? "")}</span>
        </ReceiptLine>
        <ReceiptLine label="Account equity" hint="Before, then after this reading.">
          <span className="num">
            {formatMoney(preview.before.equityCents, { currency })} →{" "}
            {formatMoney(preview.after.equityCents, { currency })}
          </span>
        </ReceiptLine>
        <ReceiptLine label="NAV per unit" hint="Units do not change. A reading revalues them.">
          <span className="num">
            {formatNav(totalsOf(preview.before))} → {formatNav(totalsOf(preview.after))}
          </span>
        </ReceiptLine>
        {preview.after.holders.map((h, i) => (
          <ReceiptLine
            key={h.holderId}
            label={names[h.holderId] ?? `Holder #${h.holderId}`}
            hint={`${formatMoney(preview.valuesBefore[i]!, { currency })} → ${formatMoney(preview.valuesAfter[i]!, { currency })}`}
          >
            <DeltaMoney cents={change(i)} currency={currency} />
          </ReceiptLine>
        ))}
        <ReceiptTotal label="Total change in value" hint="Sums to the change in equity, exactly.">
          <DeltaMoney
            cents={preview.after.equityCents - preview.before.equityCents}
            currency={currency}
          />
        </ReceiptTotal>
      </Receipt>

      <form action={commitAction}>
        <input type="hidden" name="accountId" value={accountId} />
        <input type="hidden" name="occurredOn" value={form.occurredOn ?? ""} />
        <input type="hidden" name="equity" value={form.equity ?? ""} />
        {Object.entries(fields).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <SheetActions>
          <button className="btn btn-primary" type="submit">Post this reading</button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
