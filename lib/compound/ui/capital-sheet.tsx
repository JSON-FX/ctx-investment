/**
 * Adding capital.
 *
 * The receipt's job is to make one thing obvious: a deposit dilutes SHARE and
 * does not touch VALUE. Every existing holder's percentage falls and their
 * money does not move, and the two columns sit next to each other so the
 * reader can see that rather than be told it.
 *
 * Every figure here comes from `preview`, and `preview` is `previewEntry()`'s
 * output — the proposed deposit folded through the same `fold()` the commit
 * writer's replay uses (decision D-D). Nothing on this screen is computed a
 * second way, which is what makes it structurally impossible for the receipt
 * to say one thing and the commit to do another.
 *
 * Units issued is a FLOOR. Ceiling them would issue more units than were paid
 * for, which lowers NAV for everyone else — and previewEntry's
 * assertNavDidNotFall refuses to build a receipt that lowers NAV on a
 * deposit, so this cannot render at all if the engine's rounding is ever
 * reversed (proved in this task's report).
 *
 * `HolderOption` is deliberately its own narrow type, not `HolderRow`
 * imported from `db/holders` — ui/ imports no db/, enforced by
 * ui/purity.test.ts ("ui/ renders. It does not read."), the same reason
 * holder-table.tsx takes `DeskFigures`'s `DeskRow` rather than a db row, and
 * the same reason Task 10's holder-statement.tsx (merged to main after this
 * task started) defines its own local `HolderIdentity` mirroring HolderRow
 * rather than importing it. This one carries only the three fields the
 * picker actually renders — id, name, isManager — rather than mirroring
 * every HolderRow field the way HolderIdentity does, since nothing here
 * reads email, splitBps, joinedAt or status. The caller (the capital route)
 * maps whatever it reads down to this shape.
 */
import type { Preview } from "@/lib/compound/present/derive";
import { totalsOf } from "@/lib/compound/engine/replay";
import {
  formatDate, formatMoney, formatNav, formatPpm, formatUnitsDp,
} from "@/lib/compound/present/format";
import { fingerprintToFields } from "@/lib/compound/present/fingerprint";
import { Money } from "./primitives";
import { Receipt, ReceiptLine, ReceiptTotal } from "./receipt";
import { Field, FieldError, Sheet, SheetActions } from "./sheet";

export interface HolderOption {
  id: number;
  name: string;
  isManager: boolean;
}

export function CapitalSheet({
  accountId, holders, currency, preview, form, error, backHref, commitAction, blocked,
}: {
  accountId: number;
  holders: HolderOption[];
  currency: string;
  preview: Preview | null;
  form: { holderId?: string; amount?: string; occurredOn?: string; note?: string };
  error?: string;
  backHref: string;
  commitAction: (formData: FormData) => Promise<void>;
  /** Set when a pending capital event blocks any dated entry. */
  blocked?: { candidateDate: string; reviewHref: string };
}) {
  if (blocked) {
    return (
      <Sheet title="Add capital" backHref={backHref}>
        <div className="banner-halt" role="status">
          <strong>Not while a capital event is unclassified.</strong>
          <p style={{ margin: "6px 0 0" }}>
            There is an unexplained balance move on {formatDate(blocked.candidateDate)}. Until
            it is classified, the account&apos;s value on that date is not known — so neither is
            the NAV a deposit would issue units at, and units issued at the wrong NAV cannot
            be corrected without reversing everything after them.
          </p>
          <p style={{ margin: "6px 0 0" }}><a href={blocked.reviewHref}>Review it</a></p>
        </div>
      </Sheet>
    );
  }

  if (preview === null) {
    return (
      <Sheet
        title="Add capital"
        lede="Units are issued at the NAV on the day the money lands. That is what stops a new investor diluting an existing one."
        backHref={backHref}
      >
        {error ? <FieldError>{error}</FieldError> : null}
        <form method="get">
          <input type="hidden" name="step" value="confirm" />
          <Field name="holderId" label="Holder">
            <select id="holderId" name="holderId" required defaultValue={form.holderId}>
              <option value="">Choose…</option>
              {holders.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}{h.isManager ? " (you)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field name="amount" label={`Amount, ${currency}`}>
            <input id="amount" name="amount" inputMode="decimal" required defaultValue={form.amount} />
          </Field>
          <Field name="occurredOn" label="Date" hint="The broker-server date the money landed.">
            <input id="occurredOn" name="occurredOn" type="date" required defaultValue={form.occurredOn} />
          </Field>
          <Field name="note" label="Note" hint="Optional. Appears on the ledger.">
            <input id="note" name="note" defaultValue={form.note} />
          </Field>
          <SheetActions>
            <button className="btn btn-primary" type="submit">Review</button>
          </SheetActions>
        </form>
      </Sheet>
    );
  }

  const fields = fingerprintToFields(preview.fingerprint);
  const holderId = Number(form.holderId);
  const holder = holders.find((h) => h.id === holderId);
  const idx = preview.after.holders.findIndex((h) => h.holderId === holderId);
  const unitsIssued = preview.after.holders[idx]!.units - preview.before.holders[idx]!.units;
  const navMoved = preview.navResidualX1e4 !== 0n;

  return (
    <Sheet title={`Add capital — ${holder?.name ?? ""}`} backHref={backHref} backLabel="Back">
      {error ? <FieldError>{error}</FieldError> : null}

      <Receipt label="Deposit">
        <ReceiptLine label="Amount">
          <span className="num">{formatMoney(preview.equityDelta, { currency })}</span>
        </ReceiptLine>
        <ReceiptLine label="Date">
          <span className="num">{formatDate(form.occurredOn ?? "")}</span>
        </ReceiptLine>
        <ReceiptLine label="NAV units are issued at" hint="The NAV before this deposit.">
          <span className="num">{formatNav(totalsOf(preview.before))}</span>
        </ReceiptLine>
        <ReceiptLine
          label="Units issued"
          hint="Amount divided by NAV, rounded DOWN — never more units than were paid for."
        >
          <span className="num">{formatUnitsDp(unitsIssued, 10)}</span>
        </ReceiptLine>
        <ReceiptLine label="Units in issue" hint="Before, then after.">
          <span className="num">
            {formatUnitsDp(preview.before.units)} → {formatUnitsDp(preview.after.units)}
          </span>
        </ReceiptLine>
        <ReceiptLine
          label="NAV per unit"
          hint={navMoved
            ? "A deposit cannot lower NAV. The sub-cent rounding residual stays in the pool, which nudges it up."
            : "Unchanged, which is the point: a deposit issues units at the prevailing NAV."}
        >
          <span className="num">
            {formatNav(totalsOf(preview.before))} → {formatNav(totalsOf(preview.after))}
          </span>
        </ReceiptLine>
        <ReceiptTotal label="Account equity after">
          <Money cents={preview.after.equityCents} currency={currency} />
        </ReceiptTotal>
      </Receipt>

      <div className="scroller" style={{ marginTop: 18 }}>
        <table>
          <caption className="eyebrow">What this does to everyone</caption>
          <thead>
            <tr>
              <th scope="col">Holder</th>
              <th scope="col">Share before</th>
              <th scope="col">Share after</th>
              <th scope="col">Value before</th>
              <th scope="col">Value after</th>
            </tr>
          </thead>
          <tbody>
            {preview.after.holders.map((h, i) => (
              <tr key={h.holderId} className={h.holderId === holderId ? "own" : ""}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  {holders.find((x) => x.id === h.holderId)?.name ?? `Holder #${h.holderId}`}
                </th>
                <td className="num">{formatPpm(preview.sharesBefore[i]!)}</td>
                <td className="num">{formatPpm(preview.sharesAfter[i]!)}</td>
                <td><Money cents={preview.valuesBefore[i]!} currency={currency} /></td>
                <td><Money cents={preview.valuesAfter[i]!} currency={currency} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="split-note">
        Every other holder&apos;s share falls and their value does not move. A deposit buys
        units at the NAV that already existed, so it cannot take value from anyone who was
        already in. Where a division does not terminate, the sub-cent residual stays in the
        pool and can move a stated value by one cent — upward, never down.
      </p>

      <form action={commitAction}>
        <input type="hidden" name="accountId" value={accountId} />
        {(["holderId", "amount", "occurredOn", "note"] as const).map((k) => (
          <input key={k} type="hidden" name={k} value={form[k] ?? ""} />
        ))}
        {Object.entries(fields).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <SheetActions>
          <button className="btn btn-primary" type="submit">Record this deposit</button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
