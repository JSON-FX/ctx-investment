/**
 * Creating an account. Two steps, like every other flow in this product.
 *
 * Step two does one thing beyond echoing the form back: it says what
 * CopyTraderX has for that MT5 account. A typo in an eight-digit account number
 * produces an account that reads a table with nothing in it, and the desk then
 * shows a correct-looking empty statement forever. Naming the snapshot count
 * before commit turns a silent typo into a visible one.
 *
 * It is a WARNING and not a refusal. A brand-new account may legitimately have
 * pushed nothing yet.
 */
import { redirect } from "next/navigation";
import { withDb } from "@/lib/compound/db/client";
import { getAccountOwnerUserId, getDailySnapshots, getLiveSnapshot } from "@/lib/compound/db/copytraderx";
import { createAccount } from "@/lib/compound/db/write-account";
import { requireManager } from "@/lib/compound/load/session";
import { formatMoney, formatSplit, formatUtcStamp } from "@/lib/compound/present/format";
import { Notice } from "@/lib/compound/ui/banner";
import { Receipt, ReceiptLine } from "@/lib/compound/ui/receipt";
import { Field, FieldError, Sheet, SheetActions } from "@/lib/compound/ui/sheet";
import { deskHref } from "@/lib/compound/ui/routes";
import { maskMt5 } from "@/lib/compound/ui/account-list";

export const dynamic = "force-dynamic";

interface Params {
  step?: string; mt5?: string; label?: string; broker?: string; currency?: string;
  split?: string; inception?: string; managerName?: string; offset?: string; error?: string;
}

async function commit(formData: FormData) {
  "use server";
  const user = await requireManager();
  const offsetRaw = String(formData.get("offset") ?? "").trim();
  try {
    const { accountId } = await withDb((c) =>
      createAccount(c, {
        mt5Account: Number(formData.get("mt5")),
        label: String(formData.get("label")),
        broker: String(formData.get("broker") ?? "") || null,
        currency: String(formData.get("currency") ?? "USD"),
        defaultSplitBps: Math.round(Number(formData.get("split")) * 100),
        inceptionDate: String(formData.get("inception")),
        managerUserId: user.id,
        managerName: String(formData.get("managerName")),
        brokerOffsetHours: offsetRaw === "" ? null : Number(offsetRaw),
      }),
    );
    redirect(deskHref(accountId));
  } catch (e) {
    if (e instanceof Error && "digest" in e) throw e;   // a redirect, not a failure
    const code = (e as { code?: string }).code;
    const message =
      code === "CX101"
        ? "That MT5 account already has a Compound account."
        : (e as Error).message;
    redirect(`/accounts/new?error=${encodeURIComponent(message)}`);
  }
}

export default async function NewAccountPage({
  searchParams,
}: { searchParams: Promise<Params> }) {
  const p = await searchParams;

  if (p.step !== "confirm") {
    return (
      <Sheet title="Add an account" backHref="/" lede="Compound reads an MT5 account CopyTraderX is already pushing. It never writes to it and never places a trade.">
        {p.error ? <FieldError>{p.error}</FieldError> : null}
        <form method="get">
          <input type="hidden" name="step" value="confirm" />
          <Field name="label" label="Account name">
            <input id="label" name="label" required defaultValue={p.label} />
          </Field>
          <Field name="mt5" label="MT5 account number">
            <input id="mt5" name="mt5" inputMode="numeric" pattern="[0-9]+" required defaultValue={p.mt5} />
          </Field>
          <Field name="managerName" label="Your name, as it appears on statements">
            <input id="managerName" name="managerName" required defaultValue={p.managerName} />
          </Field>
          <Field name="broker" label="Broker" hint="Optional.">
            <input id="broker" name="broker" defaultValue={p.broker} />
          </Field>
          <Field name="currency" label="Currency">
            <input id="currency" name="currency" defaultValue={p.currency ?? "USD"} required />
          </Field>
          <Field name="split" label="Default manager split, percent" hint="30 / 70 is written as 70 here — the manager's share of an investor's profit. Each investor can override it, and changing it later never rewrites a payout already taken.">
            <input id="split" name="split" inputMode="decimal" defaultValue={p.split ?? "70"} required />
          </Field>
          <Field name="inception" label="Inception date">
            <input id="inception" name="inception" type="date" required defaultValue={p.inception} />
          </Field>
          <Field
            name="offset"
            label="Broker server UTC offset, hours (1–14)"
            hint="Leave blank if you do not know it. Reconciliation stays switched off until it is set, because the duplicate-deal guard needs it and running it at a zero offset does nothing."
          >
            <input id="offset" name="offset" inputMode="numeric" defaultValue={p.offset} />
          </Field>
          <SheetActions>
            <button className="btn btn-primary" type="submit">Review</button>
          </SheetActions>
        </form>
      </Sheet>
    );
  }

  const mt5 = Number(p.mt5);
  const [snapshots, live, ownerUserId] = await withDb(async (c) => [
    await getDailySnapshots(c, mt5),
    await getLiveSnapshot(c, mt5),
    await getAccountOwnerUserId(c, mt5),
  ] as const);

  return (
    <Sheet title="Add an account" backHref="/accounts/new" backLabel="Back">
      {snapshots.length === 0 ? (
        <Notice>
          <strong>CopyTraderX has no daily snapshots for {maskMt5(mt5)}.</strong> Check the
          account number. If it is right, the EA has not pushed yet and the desk will be
          empty until it does.
        </Notice>
      ) : null}
      {ownerUserId === null ? (
        <Notice>
          <strong>No licence is registered against {maskMt5(mt5)}.</strong> That is not a
          blocker, but it usually means the account number is wrong.
        </Notice>
      ) : null}

      <Receipt label="Account to be created">
        <ReceiptLine label="Account name">{p.label}</ReceiptLine>
        <ReceiptLine label="MT5 account">
          <span className="num">{maskMt5(mt5)}</span>
        </ReceiptLine>
        <ReceiptLine label="Broker">{p.broker || "—"}</ReceiptLine>
        <ReceiptLine label="Currency"><span className="num">{p.currency}</span></ReceiptLine>
        <ReceiptLine
          label="Default split"
          hint="Investor keeps the first figure; you keep the second."
        >
          <span className="num">{formatSplit(Math.round(Number(p.split) * 100))}</span>
        </ReceiptLine>
        <ReceiptLine label="Inception"><span className="num">{p.inception}</span></ReceiptLine>
        <ReceiptLine
          label="Broker UTC offset"
          hint={p.offset ? undefined : "Not set — reconciliation stays off."}
        >
          <span className="num">{p.offset ? `±${p.offset}h` : "—"}</span>
        </ReceiptLine>
        <ReceiptLine label="Daily snapshots CopyTraderX has">
          <span className="num">{snapshots.length}</span>
        </ReceiptLine>
        {live === null ? null : (
          <ReceiptLine label="Live equity" hint={`pushed ${formatUtcStamp(live.pushedAt)}`}>
            <span className="num">{formatMoney(live.equityCents, { currency: p.currency })}</span>
          </ReceiptLine>
        )}
        <ReceiptLine label="Manager holder" hint="Created with the account. You cannot have an account without one.">
          {p.managerName}
        </ReceiptLine>
      </Receipt>

      <form action={commit}>
        {(["mt5", "label", "broker", "currency", "split", "inception", "managerName", "offset"] as const)
          .map((k) => <input key={k} type="hidden" name={k} value={p[k] ?? ""} />)}
        <SheetActions>
          <button className="btn btn-primary" type="submit">Create account</button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
