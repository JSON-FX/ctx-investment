import { requireAccount } from "@/lib/compound/load/account";
import { loadHolderNames, loadLedger, loadSeeds } from "@/lib/compound/load/ledger";
import { planFor } from "@/lib/compound/load/reconcile";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { previewEntry } from "@/lib/compound/present/derive";
import { ReadingSheet, type ReadingGate } from "@/lib/compound/ui/reading-sheet";
import { deskHref, reviewHref } from "@/lib/compound/ui/routes";
import { postReading } from "../actions";

export const dynamic = "force-dynamic";

export default async function ReadingPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ step?: string; occurredOn?: string; equity?: string; error?: string }>;
}) {
  const account = await requireAccount((await params).id);
  const q = await searchParams;

  const [outcome, entries, seeds, names] = await Promise.all([
    planFor(account),
    loadLedger(account.id),
    loadSeeds(account.id),
    loadHolderNames(account.id),
  ]);

  let gate: ReadingGate;
  if (outcome.kind === "not-configured") gate = { kind: "not-configured" };
  else if (outcome.kind === "error") gate = { kind: "error", message: outcome.message };
  else if (outcome.plan.kind === "halt") {
    gate = {
      kind: "halted",
      candidateDate: outcome.plan.candidate.tradeDate,
      reviewHref: reviewHref(account.id),
    };
  } else if (outcome.plan.kind === "advance") {
    gate = {
      kind: "unposted",
      count: outcome.plan.readings.length,
      through: outcome.plan.newCursorDate,
    };
  } else {
    gate = { kind: "ready", earliestDate: outcome.lastSnapshotDate ?? account.inceptionDate };
  }

  let preview = null;
  if (q.step === "confirm" && q.occurredOn && q.equity && gate.kind === "ready") {
    try {
      preview = previewEntry({
        accountId: account.id,
        entries,
        seeds,
        proposed: {
          holderId: null,
          occurredOn: q.occurredOn,
          type: "equity_reading",
          amountCents: centsFromDecimal(q.equity),
          feeSettlement: null,
          splitBpsApplied: null,
        },
      });
    } catch {
      preview = null;
    }
  }

  return (
    <ReadingSheet
      accountId={account.id}
      gate={gate}
      currency={account.currency}
      names={names}
      preview={preview}
      form={{ occurredOn: q.occurredOn, equity: q.equity }}
      error={q.error}
      backHref={deskHref(account.id)}
      commitAction={postReading}
    />
  );
}
