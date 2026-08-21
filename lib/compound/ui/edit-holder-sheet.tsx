/**
 * Editing a holder: name, email, split. Identity and terms only — no ledger
 * entry, the same reason InvestorSheet (adding a holder) has none.
 *
 * Unlike InvestorSheet, every field starts pre-filled from the holder's
 * CURRENT row rather than an account default, and the confirm step shows a
 * before/after for anything that actually changed rather than just the
 * submitted values — the point of a rename is to see what it replaces.
 *
 * The manager's own row never renders a split field at all, rather than a
 * disabled one: quote() forces splitBpsApplied to 0 whenever isManager, and
 * compound_update_holder's CX304 refuses any other value on that row, so an
 * editable-looking field that can only ever be submitted as one value would
 * be worse than no field. commitAction still enforces this server-side
 * (holder.isManager on the loaded row, not anything read back from the
 * form) — hiding the field is UX, not the boundary; see this sheet's route
 * and CX304 for the boundary itself.
 *
 * "Split" here is a percentage typed by a person, exactly like
 * InvestorSheet's own field — same name ("split"), same
 * Math.round(Number(...) * 100) conversion, so a manager who has already
 * used one sheet finds the same convention on the other.
 */
import { formatSplit, formatSplitWords } from "@/lib/compound/present/format";
import { PAYOUT_WORDS } from "@/lib/compound/present/wording";
import { Receipt, ReceiptLine } from "./receipt";
import { Field, FieldError, Sheet, SheetActions } from "./sheet";

export interface EditHolderIdentity {
  id: number;
  name: string;
  email: string | null;
  isManager: boolean;
  splitBps: number;
}

/** "a → b", or just "a" when nothing changed — used for every line below. */
function changeLine(before: string, after: string) {
  return before === after ? before : <>{before} <span aria-hidden="true">→</span> {after}</>;
}

export function EditHolderSheet({
  accountId, holder, form, error, backHref, commitAction,
}: {
  accountId: number;
  holder: EditHolderIdentity;
  form: { name?: string; email?: string; split?: string; step?: string };
  error?: string;
  backHref: string;
  commitAction: (formData: FormData) => Promise<void>;
}) {
  const defaultSplitPct = String(holder.splitBps / 100);

  if (form.step !== "confirm") {
    return (
      <Sheet
        title={`Edit ${holder.name}`}
        lede="Name and email are identity only. A split change applies from here forward — every payout already posted keeps the split it was paid at."
        backHref={backHref}
      >
        {error ? <FieldError>{error}</FieldError> : null}
        <form method="get">
          <input type="hidden" name="step" value="confirm" />
          <Field name="name" label="Name">
            <input id="name" name="name" required defaultValue={form.name ?? holder.name} />
          </Field>
          <Field
            name="email" label="Email"
            hint="Optional. Used only for their statement when the portal lands."
          >
            <input
              id="email" name="email" type="email"
              defaultValue={form.email ?? holder.email ?? ""}
            />
          </Field>
          {holder.isManager ? null : (
            <Field name="split" label="Your share of their profit, percent" hint={PAYOUT_WORDS.managerFeeHint}>
              <input
                id="split" name="split" inputMode="decimal" required
                defaultValue={form.split ?? defaultSplitPct}
              />
            </Field>
          )}
          <SheetActions>
            <button className="btn btn-primary" type="submit">Review</button>
          </SheetActions>
        </form>
      </Sheet>
    );
  }

  const name = form.name ?? holder.name;
  const email = form.email ?? "";
  // Percent-to-basis-points, matching InvestorSheet's identical conversion.
  // Forced to 0 for the manager regardless of what the query string carries
  // — the field was never rendered for them in step 1, and this is the
  // application-side half of the same refusal CX304 makes the database's.
  const splitBps = holder.isManager ? 0 : Math.round(Number(form.split ?? defaultSplitPct) * 100);
  const splitChanged = !holder.isManager && splitBps !== holder.splitBps;

  return (
    <Sheet title={`Edit ${holder.name}`} backHref={backHref} backLabel="Back">
      {error ? <FieldError>{error}</FieldError> : null}

      <Receipt label={`Changes to ${holder.name}`}>
        <ReceiptLine label="Name">{changeLine(holder.name, name)}</ReceiptLine>
        <ReceiptLine label="Email">{changeLine(holder.email || "—", email || "—")}</ReceiptLine>
        {holder.isManager ? null : (
          <ReceiptLine label="Split" hint={PAYOUT_WORDS.managerFeeHint}>
            {changeLine(formatSplit(holder.splitBps), formatSplit(splitBps))}
          </ReceiptLine>
        )}
      </Receipt>

      {splitChanged ? <p className="split-note">{formatSplitWords(splitBps, name)}</p> : null}
      {holder.isManager ? null : (
        <p className="split-note">
          Every payout {name} has already received keeps the split it was paid at — this
          changes only what applies from here forward.
        </p>
      )}

      <form action={commitAction}>
        <input type="hidden" name="accountId" value={accountId} />
        <input type="hidden" name="holderId" value={holder.id} />
        <input type="hidden" name="name" value={name} />
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="split" value={holder.isManager ? "0" : (form.split ?? defaultSplitPct)} />
        <SheetActions>
          <button className="btn btn-primary" type="submit">Save changes</button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
