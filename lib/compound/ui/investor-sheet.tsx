/**
 * Adding an investor. No money changes hands, so there is no receipt of
 * figures — there is a statement of TERMS, which is the thing that will be
 * argued about later.
 *
 * The confirm step spells the split out in a sentence (formatSplitWords)
 * rather than leaving "63 / 37" to speak for itself, because the question
 * this screen has to answer is "what did I agree to", and a ratio alone does
 * not answer it.
 *
 * The short hint on the Split line reuses PAYOUT_WORDS.managerFeeHint —
 * Task 10's module, merged to main after this task started and pulled in by
 * rebase. It exists precisely so the holder statement's "if you withdrew
 * today" block and the payout receipt (Task 13) say the same sentence about
 * when the fee applies; this sheet is a third reader of the same words,
 * not a fourth author of a near-duplicate.
 */
import { formatDate, formatSplit, formatSplitWords } from "@/lib/compound/present/format";
import { PAYOUT_WORDS } from "@/lib/compound/present/wording";
import { Receipt, ReceiptLine } from "./receipt";
import { Field, FieldError, Sheet, SheetActions } from "./sheet";

export function InvestorSheet({
  accountId, defaultSplitBps, currency, form, error, backHref, commitAction,
}: {
  accountId: number;
  defaultSplitBps: number;
  currency: string;
  form: { name?: string; email?: string; split?: string; joinedAt?: string; step?: string };
  error?: string;
  backHref: string;
  commitAction: (formData: FormData) => Promise<void>;
}) {
  if (form.step !== "confirm") {
    return (
      <Sheet
        title="Add an investor"
        lede="Terms only. Nothing moves until you add capital for them, and their units are issued at the NAV on that day."
        backHref={backHref}
      >
        {error ? <FieldError>{error}</FieldError> : null}
        <form method="get">
          <input type="hidden" name="step" value="confirm" />
          <Field name="name" label="Name">
            <input id="name" name="name" required defaultValue={form.name} />
          </Field>
          <Field name="email" label="Email" hint="Optional. Used only for their statement when the portal lands.">
            <input id="email" name="email" type="email" defaultValue={form.email} />
          </Field>
          <Field
            name="split"
            label="Your share of their profit, percent"
            hint={`The account default is ${defaultSplitBps / 100}%. Set a different figure here if you agreed one.`}
          >
            <input
              id="split" name="split" inputMode="decimal" required
              defaultValue={form.split ?? String(defaultSplitBps / 100)}
            />
          </Field>
          <Field name="joinedAt" label="Joined">
            <input id="joinedAt" name="joinedAt" type="date" required defaultValue={form.joinedAt} />
          </Field>
          <SheetActions>
            <button className="btn btn-primary" type="submit">Review</button>
          </SheetActions>
        </form>
      </Sheet>
    );
  }

  const name = form.name ?? "";
  // Percent-to-basis-points, matching the identical conversion already in
  // app/accounts/new/page.tsx (Task 6) — a UI-input parse, not a money
  // calculation, so it is exempt from this project's no-floating-point rule
  // the same way that precedent is.
  const splitBps = Math.round(Number(form.split ?? "0") * 100);

  return (
    <Sheet title="Add an investor" backHref={`${backHref}`} backLabel="Back">
      {error ? <FieldError>{error}</FieldError> : null}
      <Receipt label="Investor to be added">
        <ReceiptLine label="Name">{name}</ReceiptLine>
        <ReceiptLine label="Email">{form.email || "—"}</ReceiptLine>
        <ReceiptLine label="Joined">
          <span className="num">{form.joinedAt ? formatDate(form.joinedAt) : "—"}</span>
        </ReceiptLine>
        <ReceiptLine label="Split" hint={PAYOUT_WORDS.managerFeeHint}>
          <span className="num">{formatSplit(splitBps)}</span>
        </ReceiptLine>
      </Receipt>

      <p className="split-note">{formatSplitWords(splitBps, name)}</p>
      <p className="split-note">
        {name} holds no units until capital is added for them. Their {currency} goes in at
        the NAV on the day it lands, which is what stops a later investor diluting an
        earlier one.
      </p>

      <form action={commitAction}>
        <input type="hidden" name="accountId" value={accountId} />
        {(["name", "email", "split", "joinedAt"] as const).map((k) => (
          <input key={k} type="hidden" name={k} value={form[k] ?? ""} />
        ))}
        <SheetActions>
          <button className="btn btn-primary" type="submit">Add {name}</button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
