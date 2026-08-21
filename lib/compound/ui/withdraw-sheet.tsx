/**
 * The partial withdrawal receipt (P6).
 *
 * Structurally a sibling of payout-sheet.tsx, not a third mode bolted onto
 * it: a partial withdrawal asks for an AMOUNT first (payout and exit both
 * derive their own), and its receipt has to show a split payout-sheet.tsx
 * never needed to — how much of THIS withdrawal is capital, how much is
 * profit, and what fee the profit slice bears (see quote.ts's
 * capitalPortionCents / withdrawalProfitCents). Keeping it separate means
 * payout-sheet.tsx and its own tests are untouched by this change.
 *
 * Same rules as payout-sheet.tsx otherwise:
 *  - Every figure that goes into the answer is on the page.
 *  - The fee line is the only amber on the page (spec section 8.2).
 *  - Every figure comes from quote() and previewEntry()'s fold. Nothing on
 *    this page is computed here.
 */
import type { Cents } from "@/lib/compound/engine/money";
import { valueOfUnits } from "@/lib/compound/engine/nav";
import type { Quote } from "@/lib/compound/engine/quote";
import { totalsOf } from "@/lib/compound/engine/replay";
import type { Preview } from "@/lib/compound/present/derive";
import type { HolderPosition } from "@/lib/compound/present/holder";
import {
  formatDate, formatMoney, formatNav, formatSplit, formatUnitsDp,
} from "@/lib/compound/present/format";
import { fingerprintToFields } from "@/lib/compound/present/fingerprint";
import { WITHDRAW_WORDS as W } from "@/lib/compound/present/wording";
import { DeltaMoney, FeeMoney, Money } from "./primitives";
import { Receipt, ReceiptLine, ReceiptTotal } from "./receipt";
import { Field, FieldError, Sheet, SheetActions } from "./sheet";

export interface WithdrawForm {
  fee?: "units" | "cash";
  occurredOn?: string;
  equity?: string;
  amount?: string;
  note?: string;
}

/** Same identity shape payout-sheet.tsx takes — see its own doc comment for why. */
export interface WithdrawHolderIdentity {
  id: number;
  name: string;
  splitBps: number;
}

export function WithdrawSheet({
  accountId, holder, position, quote, preview, form, currency, error, backHref, commitAction,
  liveEquityCents, blocked,
}: {
  accountId: number;
  holder: WithdrawHolderIdentity;
  position: HolderPosition;
  /** The mode:"partial" quote for form.amount against the SETTLEMENT totals. Null until step two. */
  quote: Quote | null;
  /** Null on step one. */
  preview: Preview | null;
  form: WithdrawForm;
  currency: string;
  error?: string;
  backHref: string;
  commitAction: (formData: FormData) => Promise<void>;
  liveEquityCents: Cents | null;
  blocked?: { candidateDate: string; reviewHref: string };
}) {
  const name = holder.name;
  const money = (c: Cents) => formatMoney(c, { currency });
  const managerPct = formatSplit(holder.splitBps).split(" / ")[1]!;
  const feeSettlement = form.fee ?? "units";

  if (blocked) {
    return (
      <Sheet title={`Withdraw — ${name}`} backHref={backHref}>
        <div className="banner-halt" role="status">
          <strong>Not while a capital event is unclassified.</strong>
          <p style={{ margin: "6px 0 0" }}>
            There is an unexplained balance move on {formatDate(blocked.candidateDate)}. NAV
            must not cross it, and a withdrawal settles at NAV.
          </p>
          <p style={{ margin: "6px 0 0" }}><a href={blocked.reviewHref}>Review it</a></p>
        </div>
      </Sheet>
    );
  }

  if (position.holder.units === 0n) {
    return (
      <Sheet title={`Withdraw — ${name}`} backHref={backHref}>
        <div className="banner-halt" role="status">
          <strong>{name} holds no units.</strong>
          <p style={{ margin: "6px 0 0" }}>
            There is nothing to withdraw. Add capital for {name} first, or check you picked
            the right holder.
          </p>
        </div>
      </Sheet>
    );
  }

  // --- step one -------------------------------------------------------------
  if (preview === null || quote === null) {
    return (
      <Sheet
        title={`Withdraw — ${name}`}
        lede={`This settles at the equity you enter below, written into the ledger as a reading ` +
          `in the same transaction as the withdrawal. Nothing settles against a number that can drift.`}
        backHref={backHref}
      >
        {error ? <FieldError>{error}</FieldError> : null}

        <form method="get">
          <input type="hidden" name="step" value="confirm" />
          <Field name="occurredOn" label="Date" hint="The broker-server date this settles on.">
            <input id="occurredOn" name="occurredOn" type="date" required defaultValue={form.occurredOn} />
          </Field>
          <Field
            name="equity"
            label={`Settlement equity, ${currency}`}
            hint={liveEquityCents === null
              ? "Account equity at the moment this settles. Written into the ledger as a reading."
              : `Account equity at the moment this settles. CopyTraderX's latest live figure is ${money(liveEquityCents)}. Written into the ledger as a reading.`}
          >
            <input
              id="equity" name="equity" inputMode="decimal" required
              defaultValue={form.equity ?? (liveEquityCents === null ? undefined : formatMoney(liveEquityCents).replace(/[^0-9.]/g, ""))}
            />
          </Field>
          <Field
            name="amount"
            label={`Amount to withdraw, ${currency}`}
            hint={W.fullValueHint(money(position.settlementValueCents))}
          >
            <input id="amount" name="amount" inputMode="decimal" required defaultValue={form.amount} />
          </Field>
          <Field name="note" label="Note" hint="Optional. Appears on the ledger.">
            <input id="note" name="note" defaultValue={form.note} />
          </Field>
          <SheetActions>
            <button className="btn btn-primary" type="submit">Work out the figures</button>
          </SheetActions>
        </form>
      </Sheet>
    );
  }

  // --- step two: the receipt -----------------------------------------------
  const q = quote;
  const idx = preview.after.holders.findIndex((h) => h.holderId === holder.id);
  const unitsKept = preview.after.holders[idx]!.units;
  const keptWorth = valueOfUnits(totalsOf(preview.after), unitsKept);
  const fields = fingerprintToFields(preview.fingerprint);
  const settlementNav = formatNav(totalsOf(preview.before));
  const atCap = q.grossCents === q.valueCents;
  const toggleHref = (over: Partial<WithdrawForm>) => {
    const p = new URLSearchParams({
      step: "confirm",
      fee: over.fee ?? feeSettlement,
      occurredOn: form.occurredOn ?? "",
      equity: form.equity ?? "",
      amount: form.amount ?? "",
      note: form.note ?? "",
    });
    return `?${p.toString()}`;
  };

  return (
    <Sheet
      title={`Withdraw — ${name}`}
      lede={`Settling at NAV ${settlementNav} on ${formatDate(form.occurredOn ?? "")}.`}
      backHref={`${backHref}`}
      backLabel="Back"
    >
      {error ? <FieldError>{error}</FieldError> : null}

      {atCap ? (
        <div className="banner-halt" role="status">
          <strong>{W.atCapTitle}</strong>
          <p style={{ margin: "6px 0 0" }}>{W.atCap(name)}</p>
        </div>
      ) : null}

      <Receipt label={`Withdrawal receipt for ${name}`}>
        <ReceiptLine label={W.unitsHeld} hint={W.unitsHeldHint}>
          <span className="num">{formatUnitsDp(position.holder.units)}</span>
        </ReceiptLine>
        <ReceiptLine label={`${W.valueNow} (${settlementNav})`} hint={W.valueNowHint}>
          <span className="num">{money(q.valueCents)}</span>
        </ReceiptLine>
        <ReceiptLine label={W.requested(name)} hint={W.requestedHint}>
          <span className="num">{money(q.grossCents)}</span>
        </ReceiptLine>

        <ReceiptLine label={W.capitalReturned(name)} hint={W.capitalReturnedHint(name)}>
          <span className="num">{money(q.capitalPortionCents)}</span>
        </ReceiptLine>
        <ReceiptLine label={W.profitPortion} hint={W.profitPortionHint}>
          <DeltaMoney cents={q.withdrawalProfitCents} currency={currency} />
        </ReceiptLine>
        <ReceiptLine label={W.managerFee(managerPct)} hint={W.managerFeeHint} tone="fee">
          <FeeMoney cents={q.feeCents} currency={currency} />
        </ReceiptLine>
        <ReceiptLine label={W.newBasis(name)} hint={W.newBasisHint}>
          <span className="num">{money(q.newBasisCents)}</span>
        </ReceiptLine>

        <ReceiptLine label={W.unitsRedeemed(name)}>
          <span className="num">
            {formatUnitsDp(q.unitsRedeemed)}
            {atCap ? <span className="muted"> (all of them)</span> : null}
          </span>
        </ReceiptLine>
        <ReceiptLine
          label={W.unitsKept(name)}
          hint={`${W.unitsKeptHint} ${money(keptWorth)}`}
        >
          <span className="num">{formatUnitsDp(unitsKept)}</span>
        </ReceiptLine>

        <ReceiptTotal label={W.receives(name)}>
          <span className="num">{money(q.toHolderCents)}</span>
        </ReceiptTotal>
      </Receipt>

      <fieldset style={{ border: 0, padding: 0, margin: "18px 0 0" }}>
        <legend><span className="eyebrow">{W.feeSettlement}</span></legend>
        <p className="actions" style={{ marginTop: 8 }}>
          <a
            className={`btn${feeSettlement === "units" ? " btn-primary" : ""}`}
            href={toggleHref({ fee: "units" })}
            aria-current={feeSettlement === "units" ? "true" : undefined}
          >
            {W.feeSettlementUnits}
          </a>
          <a
            className={`btn${feeSettlement === "cash" ? " btn-primary" : ""}`}
            href={toggleHref({ fee: "cash" })}
            aria-current={feeSettlement === "cash" ? "true" : undefined}
          >
            {W.feeSettlementCash}
          </a>
        </p>
        <p className="split-note">
          {feeSettlement === "units" ? W.feeSettlementUnitsHint : W.feeSettlementCashHint}
        </p>
      </fieldset>

      <Receipt label="What this does to the account">
        <ReceiptLine label="Account equity" hint="Before, then after.">
          <span className="num">
            {money(preview.before.equityCents)} → {money(preview.after.equityCents)}
          </span>
        </ReceiptLine>
        <ReceiptLine label="Units in issue" hint="Before, then after.">
          <span className="num">
            {formatUnitsDp(preview.before.units)} → {formatUnitsDp(preview.after.units)}
          </span>
        </ReceiptLine>
        <ReceiptLine label="NAV per unit" hint="A withdrawal settles at constant NAV. It takes value out; it does not move the price of a unit.">
          <span className="num">
            {formatNav(totalsOf(preview.before))} → {formatNav(totalsOf(preview.after))}
          </span>
        </ReceiptLine>
      </Receipt>

      <form action={commitAction}>
        <input type="hidden" name="accountId" value={accountId} />
        <input type="hidden" name="holderId" value={holder.id} />
        <input type="hidden" name="fee" value={feeSettlement} />
        <input type="hidden" name="occurredOn" value={form.occurredOn ?? ""} />
        <input type="hidden" name="equity" value={form.equity ?? ""} />
        <input type="hidden" name="amount" value={form.amount ?? ""} />
        <input type="hidden" name="note" value={form.note ?? ""} />
        <input type="hidden" name="amountCents" value={q.grossCents.toString()} />
        <input type="hidden" name="holderValueCents" value={q.valueCents.toString()} />
        <input type="hidden" name="splitBpsApplied" value={String(q.splitBpsApplied)} />
        {Object.entries(fields).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <SheetActions>
          <button className="btn btn-primary" type="submit">
            Pay {name} {money(q.toHolderCents)}
          </button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
