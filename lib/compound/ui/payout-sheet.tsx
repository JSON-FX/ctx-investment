/**
 * The payout receipt.
 *
 * This is the screen an investor reads back in a dispute, so:
 *
 *  - Every figure that goes into the answer is on the page. Not a summary of
 *    them, not a total with the workings hidden behind a disclosure.
 *  - Every accounting term appears with the sentence that defines it. "Cost
 *    basis, their high-water mark" is precise and is jargon; what is rendered
 *    is "What Ada has put in", with the mechanism underneath.
 *  - The fee line is the only amber on the page, per spec section 8.2, and it
 *    uses --fee-ink rather than --fee, which is 2.15:1 and cannot carry text.
 *  - Below the high-water mark, profit-only is DISABLED WITH THE RECOVERY
 *    FIGURE STATED, and exit stays available at current value with zero fee.
 *    A disabled control with no number is a dead end; a disabled control that
 *    says "$1,364.84 of recovery is needed" is an answer.
 *
 * Every figure comes from quote() and from previewEntry()'s fold. Nothing on
 * this page is computed here.
 */
import type { Cents } from "@/lib/compound/engine/money";
import { valueOfUnits } from "@/lib/compound/engine/nav";
import { totalsOf } from "@/lib/compound/engine/replay";
import type { Preview } from "@/lib/compound/present/derive";
import type { HolderPosition } from "@/lib/compound/present/holder";
import {
  formatDate, formatMoney, formatNav, formatSplit, formatUnitsDp,
} from "@/lib/compound/present/format";
import { fingerprintToFields } from "@/lib/compound/present/fingerprint";
import { PAYOUT_WORDS as W } from "@/lib/compound/present/wording";
import { DeltaMoney, FeeMoney, Money } from "./primitives";
import { Receipt, ReceiptLine, ReceiptTotal } from "./receipt";
import { Field, FieldError, Sheet, SheetActions } from "./sheet";

export interface PayoutForm {
  mode?: "payout" | "exit";
  fee?: "units" | "cash";
  occurredOn?: string;
  equity?: string;
  note?: string;
}

/**
 * Just the identity fields this receipt renders — not the HolderRow type the
 * database reader module exports.
 * BUG FOUND WHILE BUILDING TASK 13: the plan's text has `holder: HolderRow`
 * imported straight from that db reader module, but ui/ may import no db
 * layer at all (Global Constraints; enforced by purity.test.ts, Task 4) —
 * confirmed by running it: purity.test.ts failed with payout-sheet.tsx as
 * the one offender, and no other component in ui/ imports that type either.
 * A real HolderRow satisfies this structurally, so page.tsx needs no change.
 */
export interface PayoutHolderIdentity {
  id: number;
  name: string;
  splitBps: number;
}

export function PayoutSheet({
  accountId, holder, position, preview, form, currency, error, backHref, commitAction,
  liveEquityCents, blocked,
}: {
  accountId: number;
  holder: PayoutHolderIdentity;
  position: HolderPosition;
  /** Null on step one. */
  preview: Preview | null;
  form: PayoutForm;
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
  const holderPct = formatSplit(holder.splitBps).split(" / ")[0]!;
  const mode = form.mode ?? "payout";
  const feeSettlement = form.fee ?? "units";

  if (blocked) {
    return (
      <Sheet title={`Pay out — ${name}`} backHref={backHref}>
        <div className="banner-halt" role="status">
          <strong>Not while a capital event is unclassified.</strong>
          <p style={{ margin: "6px 0 0" }}>
            There is an unexplained balance move on {formatDate(blocked.candidateDate)}. NAV
            must not cross it, and a payout settles at NAV.
          </p>
          <p style={{ margin: "6px 0 0" }}><a href={blocked.reviewHref}>Review it</a></p>
        </div>
      </Sheet>
    );
  }

  if (position.holder.units === 0n) {
    return (
      <Sheet title={`Pay out — ${name}`} backHref={backHref}>
        <div className="banner-halt" role="status">
          <strong>{name} holds no units.</strong>
          <p style={{ margin: "6px 0 0" }}>
            There is nothing to pay out. Add capital for {name} first, or check you picked
            the right holder.
          </p>
        </div>
      </Sheet>
    );
  }

  // --- step one -------------------------------------------------------------
  if (preview === null) {
    const canTakeProfit = position.markState === "above";
    return (
      <Sheet
        title={`Pay out — ${name}`}
        lede={`This payout settles at the equity you enter below, and that figure is written into the ledger as a reading in the same transaction. Nothing settles against a number that can drift.`}
        backHref={backHref}
      >
        {error ? <FieldError>{error}</FieldError> : null}

        {canTakeProfit ? null : (
          <div className="banner-halt" role="status">
            <strong>
              {position.markState === "below" ? W.belowMarkTitle : W.atMarkTitle}
            </strong>
            <p style={{ margin: "6px 0 0" }}>
              {position.markState === "below"
                ? W.belowMark(
                    name,
                    money(position.holder.basisCents),
                    money(position.settlementValueCents),
                    money(position.recoveryCents),
                  )
                : W.atMark(name)}
            </p>
            <p style={{ margin: "6px 0 0" }}>
              {W.exitStillAvailable(money(position.exitQuote.toHolderCents))}
            </p>
          </div>
        )}

        <form method="get">
          <input type="hidden" name="step" value="confirm" />
          <fieldset className="field" style={{ border: 0, padding: 0, margin: "0 0 14px" }}>
            <legend><span className="eyebrow">What kind of withdrawal</span></legend>
            <label style={{ display: "block", margin: "8px 0" }}>
              <input
                type="radio" name="mode" value="payout"
                // BUG FOUND WHILE BUILDING TASK 13 — fixed here. The plan's
                // text has this as `defaultChecked={mode === "payout"}`,
                // matching only on the requested mode. When mode defaults to
                // "payout" (its ?? fallback, a few lines up) on an account
                // that is below or at the high-water mark, canTakeProfit is
                // false, this control is disabled — and BOTH radios in the
                // group end up rendered with defaultChecked=true at once,
                // since the exit radio's own condition already reads
                // `|| !canTakeProfit`. A radio group with two simultaneously
                // "checked" options is not just untidy markup: confirmed by
                // running payout-sheet.test.tsx, the exit radio (the one
                // that should win, since it is the only enabled option)
                // comes back NOT checked by testing-library's toBeChecked().
                // Gating this one on canTakeProfit too keeps the two radios
                // mutually exclusive at every markState, not only when a
                // caller happens to pass mode: "exit" explicitly.
                defaultChecked={mode === "payout" && canTakeProfit} disabled={!canTakeProfit}
                aria-describedby="profit-only-hint"
              />{" "}
              {W.profitOnly}
              {canTakeProfit ? null : " — unavailable"}
              <small id="profit-only-hint" className="muted" style={{ display: "block", marginLeft: 22 }}>
                {canTakeProfit
                  ? W.profitOnlyHint(name)
                  : position.markState === "below"
                  ? `${money(position.recoveryCents)} of recovery is needed first.`
                  : `There is no profit above what ${name} has put in.`}
              </small>
            </label>
            <label style={{ display: "block", margin: "8px 0" }}>
              <input type="radio" name="mode" value="exit" defaultChecked={mode === "exit" || !canTakeProfit} />{" "}
              {W.exitInFull}
              <small className="muted" style={{ display: "block", marginLeft: 22 }}>
                {W.exitInFullHint(name)}
              </small>
            </label>
          </fieldset>

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
  const q = mode === "exit" ? position.exitQuote : position.profitQuote;
  const idx = preview.after.holders.findIndex((h) => h.holderId === holder.id);
  const unitsKept = preview.after.holders[idx]!.units;
  const keptWorth = valueOfUnits(totalsOf(preview.after), unitsKept);
  const fields = fingerprintToFields(preview.fingerprint);
  const settlementNav = formatNav(totalsOf(preview.before));
  const toggleHref = (over: Partial<PayoutForm>) => {
    const p = new URLSearchParams({
      step: "confirm",
      mode: over.mode ?? mode,
      fee: over.fee ?? feeSettlement,
      occurredOn: form.occurredOn ?? "",
      equity: form.equity ?? "",
      note: form.note ?? "",
    });
    return `?${p.toString()}`;
  };

  return (
    <Sheet
      title={`Pay out — ${name}`}
      lede={`${mode === "exit" ? W.exitInFull : W.profitOnly}. Settling at NAV ${settlementNav} on ${formatDate(form.occurredOn ?? "")}.`}
      backHref={`${backHref}`}
      backLabel="Back"
    >
      {error ? <FieldError>{error}</FieldError> : null}

      <p className="actions" style={{ marginTop: 0 }}>
        <a
          className={`btn${mode === "payout" ? " btn-primary" : ""}`}
          href={toggleHref({ mode: "payout" })}
          aria-disabled={position.markState !== "above" ? "true" : undefined}
          aria-current={mode === "payout" ? "true" : undefined}
        >
          {W.profitOnly}
        </a>
        <a
          className={`btn${mode === "exit" ? " btn-primary" : ""}`}
          href={toggleHref({ mode: "exit" })}
          aria-current={mode === "exit" ? "true" : undefined}
        >
          {W.exitInFull}
        </a>
      </p>

      <Receipt label={`Payout receipt for ${name}`}>
        <ReceiptLine label={W.unitsHeld} hint={W.unitsHeldHint}>
          <span className="num">{formatUnitsDp(position.holder.units)}</span>
        </ReceiptLine>
        <ReceiptLine label={`${W.valueNow} (${settlementNav})`} hint={W.valueNowHint}>
          <span className="num">{money(q.valueCents)}</span>
        </ReceiptLine>
        <ReceiptLine label={W.capitalIn(name)} hint={W.capitalInHint(name)}>
          <span className="num">{money(position.holder.basisCents)}</span>
        </ReceiptLine>
        <ReceiptLine label={W.profit} hint={W.profitHint}>
          <DeltaMoney cents={q.profitCents} currency={currency} />
        </ReceiptLine>

        <ReceiptLine label={W.holderShare(name, holderPct)}>
          <span className="num">{money(q.profitCents > 0n ? q.profitCents - q.feeCents : 0n)}</span>
        </ReceiptLine>
        <ReceiptLine label={W.managerFee(managerPct)} hint={W.managerFeeHint} tone="fee">
          <FeeMoney cents={q.feeCents} currency={currency} />
        </ReceiptLine>

        <ReceiptLine label={W.unitsRedeemed(name)}>
          <span className="num">
            {formatUnitsDp(q.unitsRedeemed)}
            {mode === "exit" ? <span className="muted"> (all of them)</span> : null}
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
        <ReceiptLine label="NAV per unit" hint="A payout settles at constant NAV. It takes value out; it does not move the price of a unit.">
          <span className="num">
            {formatNav(totalsOf(preview.before))} → {formatNav(totalsOf(preview.after))}
          </span>
        </ReceiptLine>
      </Receipt>

      <form action={commitAction}>
        <input type="hidden" name="accountId" value={accountId} />
        <input type="hidden" name="holderId" value={holder.id} />
        <input type="hidden" name="mode" value={mode === "exit" ? "exit" : "payout"} />
        <input type="hidden" name="fee" value={feeSettlement} />
        <input type="hidden" name="occurredOn" value={form.occurredOn ?? ""} />
        <input type="hidden" name="equity" value={form.equity ?? ""} />
        <input type="hidden" name="note" value={form.note ?? ""} />
        <input type="hidden" name="grossCents" value={q.grossCents.toString()} />
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
