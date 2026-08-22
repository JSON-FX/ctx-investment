/**
 * The ledger: every deposit, payout and equity reading, in the order it was
 * applied. Spec §7.
 *
 * Agreement A3: this page loads its own data — no PoolState context provider.
 * loadLedger/loadSeeds/loadHolderNames are already cache()d in
 * lib/compound/load/ledger.ts for the layout and this page to share; the
 * ledger-metadata read (recorded_at, note, created_by) is scoped to this page
 * alone, so it stays a direct withDb call here rather than adding a
 * single-caller export to that shared loader module.
 */
import type { Metadata } from "next";
import { withDb } from "@/lib/compound/db/client";
import { listLedgerMeta } from "@/lib/compound/db/ledger-meta";
import { requireAccount } from "@/lib/compound/load/account";
import { loadHolderNames, loadLedger, loadSeeds } from "@/lib/compound/load/ledger";
import { ledgerSteps } from "@/lib/compound/present/derive";
import { LedgerTable } from "@/lib/compound/ui/ledger-table";
import { Panel } from "@/lib/compound/ui/primitives";
import { routeTitle } from "@/lib/compound/ui/routes";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  { params }: { params: Promise<{ id: string }> },
): Promise<Metadata> {
  const account = await requireAccount((await params).id);
  return { title: routeTitle("Ledger", account.label) };
}

export default async function LedgerPage({ params }: { params: Promise<{ id: string }> }) {
  const account = await requireAccount((await params).id);
  const [entries, seeds, names, meta] = await Promise.all([
    loadLedger(account.id),
    loadSeeds(account.id),
    loadHolderNames(account.id),
    withDb((c) => listLedgerMeta(c, account.id)),
  ]);

  return (
    <Panel flush>
      <LedgerTable
        accountId={account.id}
        steps={ledgerSteps(entries, seeds)}
        meta={new Map(meta.map((m) => [m.id, m]))}
        names={names}
        currency={account.currency}
      />
    </Panel>
  );
}
