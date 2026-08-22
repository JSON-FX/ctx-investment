import { withAuthenticatedDb } from "@/lib/compound/db/client";
import { listHolders } from "@/lib/compound/db/holders";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { requireAccount } from "@/lib/compound/load/account";
import { loadInterlock } from "@/lib/compound/load/interlock";
import { loadLedger, loadSeeds } from "@/lib/compound/load/ledger";
import { previewEntry } from "@/lib/compound/present/derive";
import { CapitalSheet, type HolderOption } from "@/lib/compound/ui/capital-sheet";
import { deskHref, reviewHref } from "@/lib/compound/ui/routes";
import { addCapital } from "../investor-actions";

export const dynamic = "force-dynamic";

export default async function CapitalPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const account = await requireAccount((await params).id);
  const q = await searchParams;
  const [holders, entries, seeds, interlock] = await Promise.all([
    withAuthenticatedDb(account.managerUserId, (c) => listHolders(c, account.id)),
    loadLedger(account.managerUserId, account.id),
    loadSeeds(account.managerUserId, account.id),
    loadInterlock(account.managerUserId, account.id),
  ]);

  let preview = null;
  if (q.step === "confirm" && q.holderId && q.amount && q.occurredOn) {
    try {
      preview = previewEntry({
        accountId: account.id, entries, seeds,
        proposed: {
          holderId: Number(q.holderId),
          occurredOn: q.occurredOn,
          type: "deposit",
          amountCents: centsFromDecimal(q.amount),
          feeSettlement: null,
          splitBpsApplied: null,
        },
      });
    } catch {
      preview = null;
    }
  }

  const holderOptions: HolderOption[] = holders.map((h) => ({
    id: h.id, name: h.name, isManager: h.isManager,
  }));

  return (
    <CapitalSheet
      accountId={account.id}
      holders={holderOptions}
      currency={account.currency}
      preview={preview}
      form={q}
      error={q.error}
      backHref={deskHref(account.id)}
      commitAction={addCapital}
      blocked={interlock.pendingCandidateDate === null ? undefined : {
        candidateDate: interlock.pendingCandidateDate,
        reviewHref: reviewHref(account.id),
      }}
    />
  );
}
