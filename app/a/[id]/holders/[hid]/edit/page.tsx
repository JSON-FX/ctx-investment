/**
 * Editing a holder's identity and terms. Reached from the statement page's
 * new Edit link (holder-statement.tsx's editAction prop).
 *
 * Decision D-F: the database gate is inert here (plan 3's connection carries
 * BYPASSRLS), so requireAccount is what stops one manager's account id from
 * being read by another. It is not what stops a HOLDER id from crossing
 * accounts: hid is looked up only inside listHolders(c, account.id), a query
 * already scoped to the resolved account — the same pattern the statement
 * page (../[hid]/page.tsx) and the payout route both already use.
 */
import { notFound } from "next/navigation";
import { withDb } from "@/lib/compound/db/client";
import { listHolders } from "@/lib/compound/db/holders";
import { requireAccount } from "@/lib/compound/load/account";
import { EditHolderSheet } from "@/lib/compound/ui/edit-holder-sheet";
import { holderHref } from "@/lib/compound/ui/routes";
import { saveHolder } from "./actions";

export const dynamic = "force-dynamic";

export default async function EditHolderPage({
  params, searchParams,
}: {
  params: Promise<{ id: string; hid: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id, hid } = await params;
  const account = await requireAccount(id);

  // Same shape as the statement page's own guard: a plain positive integer,
  // rejected fast, ahead of the lookup that is the actual boundary below.
  if (!/^[1-9][0-9]{0,17}$/.test(hid)) notFound();
  const holderId = Number(hid);

  const holders = await withDb((c) => listHolders(c, account.id));
  const holder = holders.find((h) => h.id === holderId);
  if (holder === undefined) notFound();

  const q = await searchParams;

  return (
    <EditHolderSheet
      accountId={account.id}
      holder={holder}
      form={q}
      error={q.error}
      backHref={holderHref(account.id, holderId)}
      commitAction={saveHolder}
    />
  );
}
