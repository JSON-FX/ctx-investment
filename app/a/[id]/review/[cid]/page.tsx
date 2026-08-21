/**
 * Classifying one capital event. Spec §5.3, decision D-J.
 *
 * Agreement A3: this page loads its own data. The candidate is looked up by
 * id among the account's PENDING candidates specifically, not any candidate
 * on the account — a classified or ignored one has nothing left to decide,
 * and notFound() here (rather than a stale sheet) is what sends a manager
 * back to the queue when they follow a link to something someone else, or
 * they in another tab, already resolved.
 */
import { notFound } from "next/navigation";
import { withDb } from "@/lib/compound/db/client";
import { listCandidates } from "@/lib/compound/db/compound";
import { listHolders } from "@/lib/compound/db/holders";
import { requireAccount } from "@/lib/compound/load/account";
import { loadLedger, loadPoolState, loadSeeds } from "@/lib/compound/load/ledger";
import { fingerprintOf, ledgerSteps } from "@/lib/compound/present/derive";
import { ClassifySheet } from "@/lib/compound/ui/classify-sheet";
import { reviewHref } from "@/lib/compound/ui/routes";
import { classify } from "../../actions/actions";

export const dynamic = "force-dynamic";

export default async function ClassifyPage({
  params, searchParams,
}: {
  params: Promise<{ id: string; cid: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id, cid } = await params;
  const account = await requireAccount(id);
  if (!/^[1-9][0-9]{0,17}$/.test(cid)) notFound();
  const q = await searchParams;

  const [candidates, holders, entries, seeds, state] = await Promise.all([
    withDb((c) => listCandidates(c, account.id, "pending")),
    withDb((c) => listHolders(c, account.id)),
    loadLedger(account.id),
    loadSeeds(account.id),
    loadPoolState(account.id),
  ]);
  const candidate = candidates.find((k) => k.id === Number(cid));
  if (candidate === undefined) notFound();

  // An entry can account for this move when its cash movement matches the
  // unexplained figure. The cash movement is the EQUITY DELTA, not the
  // stored amount_cents — replay.ts recomputes a payout from quote() and
  // never reads that column back, so amount_cents is a record of what was
  // asked for, not what actually settled.
  const matchable = ledgerSteps(entries, seeds)
    .filter((s) => !s.voided && s.equityDelta !== 0n)
    .filter((s) => s.equityDelta === candidate.unexplainedCents)
    .map((s) => ({ entry: s.entry, cashCents: s.equityDelta }));

  return (
    <ClassifySheet
      accountId={account.id}
      candidate={candidate}
      holders={holders.map((h) => ({ id: h.id, name: h.name, isManager: h.isManager }))}
      matchable={matchable}
      fingerprint={fingerprintOf(account.id, state)}
      currency={account.currency}
      form={q}
      error={q.error}
      backHref={reviewHref(account.id)}
      commitAction={classify}
    />
  );
}
