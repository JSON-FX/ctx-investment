import { requireAccount } from "@/lib/compound/load/account";
import { loadHolderNames, loadLedger, loadLive, loadPoolState } from "@/lib/compound/load/ledger";
import { deskFigures } from "@/lib/compound/present/derive";
import { railSegments } from "@/lib/compound/present/rail";
import { Desk } from "@/lib/compound/ui/desk";

export const dynamic = "force-dynamic";

export default async function DeskPage({ params }: { params: Promise<{ id: string }> }) {
  const account = await requireAccount((await params).id);
  const [state, names, live, entries] = await Promise.all([
    loadPoolState(account.id),
    loadHolderNames(account.id),
    loadLive(account.mt5Account),
    loadLedger(account.id),
  ]);

  return (
    <Desk
      accountId={account.id}
      state={state}
      figures={deskFigures(state, names)}
      segments={railSegments(state, names)}
      currency={account.currency}
      entryCount={entries.length}
      live={live}
    />
  );
}
