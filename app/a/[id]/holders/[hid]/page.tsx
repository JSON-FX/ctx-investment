/**
 * The per-holder statement. Spec §7, the last read surface in Phase A.
 *
 * Agreement A2: there is no Holders nav entry — the desk's own holder table
 * (lib/compound/ui/holder-table.tsx) links here, and routes.ts's
 * activeNavKey already treats a "holders" path segment as belonging to the
 * Desk tab.
 *
 * Decision D-F: the database gate is inert here (plan 3's connection carries
 * BYPASSRLS), so `requireAccount` — called by the layout and, cache()d,
 * again here — is what stops one manager's account id from being read by
 * another. It is not what stops a HOLDER id from crossing accounts: `hid` is
 * looked up only inside `listHolders(c, account.id)`, a query already scoped
 * to the resolved account, so a holder id that belongs to a different
 * account simply is not in that list and falls through to notFound() below.
 */
import { notFound } from "next/navigation";
import { withDb } from "@/lib/compound/db/client";
import { listHolders } from "@/lib/compound/db/holders";
import { totalsOf } from "@/lib/compound/engine/replay";
import { requireAccount } from "@/lib/compound/load/account";
import { loadLedger, loadPoolState, loadSeeds } from "@/lib/compound/load/ledger";
import { ledgerSteps } from "@/lib/compound/present/derive";
import { holderPosition, holderStatement } from "@/lib/compound/present/holder";
import { HolderStatement } from "@/lib/compound/ui/holder-statement";
import { payoutHref } from "@/lib/compound/ui/routes";

export const dynamic = "force-dynamic";

export default async function HolderPage({
  params,
}: {
  params: Promise<{ id: string; hid: string }>;
}) {
  const { id, hid } = await params;
  const account = await requireAccount(id);

  // Same shape resolveOwnedAccount (load/account.ts) holds a path param to,
  // before it does any work: a plain positive integer, nothing parseInt
  // would coerce from garbage. Not itself the security boundary (holderId
  // never reaches SQL directly below) — just a fast, clear rejection ahead
  // of four parallel loads that a malformed id would otherwise still fail
  // safely on, one line later.
  if (!/^[1-9][0-9]{0,17}$/.test(hid)) notFound();
  const holderId = Number(hid);

  const [state, entries, seeds, holders] = await Promise.all([
    loadPoolState(account.id),
    loadLedger(account.id),
    loadSeeds(account.id),
    withDb((c) => listHolders(c, account.id)),
  ]);

  const holder = holders.find((h) => h.id === holderId);
  if (holder === undefined) notFound();

  return (
    <HolderStatement
      holder={holder}
      position={holderPosition(state, holderId)}
      rows={holderStatement(ledgerSteps(entries, seeds), holderId)}
      totals={totalsOf(state)}
      currency={account.currency}
      withdrawAction={
        <a className="btn btn-primary" href={payoutHref(account.id, holderId)}>
          Pay out
        </a>
      }
    />
  );
}
