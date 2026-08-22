/**
 * The per-holder statement. Spec §7, the last read surface in Phase A.
 *
 * Agreement A2: there is no Holders nav entry — the desk's own holder table
 * (lib/compound/ui/holder-table.tsx) links here, and routes.ts's
 * activeNavKey already treats a "holders" path segment as belonging to the
 * Desk tab.
 *
 * Decision D-F (updated): compound_holder's own RLS policy now runs for
 * real (withAuthenticatedDb), scoped to account.managerUserId — the database
 * itself refuses to return a holder row belonging to a different manager's
 * account. `requireAccount` — called by the layout and, cache()d, again here
 * — remains the defence-in-depth layer, and is still what stops a HOLDER id
 * from crossing accounts WITHIN one manager's own rows: `hid` is looked up
 * only inside `listHolders(c, account.id)`, a query already scoped to the
 * resolved account, so a holder id that belongs to a different account
 * simply is not in that list and falls through to notFound() below.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { withAuthenticatedDb } from "@/lib/compound/db/client";
import { listHolders } from "@/lib/compound/db/holders";
import { totalsOf } from "@/lib/compound/engine/replay";
import { requireAccount } from "@/lib/compound/load/account";
import { loadHolderNames, loadLedger, loadPoolState, loadSeeds } from "@/lib/compound/load/ledger";
import { ledgerSteps } from "@/lib/compound/present/derive";
import { holderPosition, holderStatement } from "@/lib/compound/present/holder";
import { HolderStatement } from "@/lib/compound/ui/holder-statement";
import { editHolderHref, payoutHref, routeTitle } from "@/lib/compound/ui/routes";

export const dynamic = "force-dynamic";

// Same shape resolveOwnedAccount (load/account.ts) holds a path param to,
// before it does any work: a plain positive integer, nothing parseInt would
// coerce from garbage. Not itself the security boundary (holderId never
// reaches SQL directly below) — just a fast, clear rejection ahead of the
// loads that a malformed id would otherwise still fail safely on, one line
// later. Shared by generateMetadata and the page below so the two cannot
// silently drift onto different rules for the same param.
const HID_RE = /^[1-9][0-9]{0,17}$/;

export async function generateMetadata(
  { params }: { params: Promise<{ id: string; hid: string }> },
): Promise<Metadata> {
  const { id, hid } = await params;
  const account = await requireAccount(id);
  if (!HID_RE.test(hid)) notFound();
  // loadHolderNames, not listHolders: this route's own page component below
  // needs the full HolderRow (split, status, joinedAt…) and reads it
  // uncached — see that call's own reasoning. A <title> needs only the
  // name, and loadHolderNames is the cache()d loader desk and ledger
  // already share for exactly that, so this adds no second full-record
  // query beside the page's.
  const names = await loadHolderNames(account.id);
  const name = names[Number(hid)];
  if (name === undefined) notFound();
  return { title: routeTitle(name, account.label) };
}

export default async function HolderPage({
  params,
}: {
  params: Promise<{ id: string; hid: string }>;
}) {
  const { id, hid } = await params;
  const account = await requireAccount(id);

  if (!HID_RE.test(hid)) notFound();
  const holderId = Number(hid);

  const [state, entries, seeds, holders] = await Promise.all([
    loadPoolState(account.id),
    loadLedger(account.id),
    loadSeeds(account.id),
    withAuthenticatedDb(account.managerUserId, (c) => listHolders(c, account.id)),
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
      editAction={
        <a className="btn" href={editHolderHref(account.id, holderId)}>
          Edit
        </a>
      }
    />
  );
}
