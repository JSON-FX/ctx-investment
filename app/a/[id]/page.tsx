import { requireAccount } from "@/lib/compound/load/account";
import { loadHolderNames, loadLedger, loadLive, loadPoolState } from "@/lib/compound/load/ledger";
import { decodeDroppedDeals } from "@/lib/compound/load/reconcile";
import { deskFigures } from "@/lib/compound/present/derive";
import { railSegments } from "@/lib/compound/present/rail";
import { Notice } from "@/lib/compound/ui/banner";
import { Desk } from "@/lib/compound/ui/desk";
import { capitalHref, readingHref } from "@/lib/compound/ui/routes";
import { refreshReadings } from "./actions/actions";

export const dynamic = "force-dynamic";

interface DeskSearchParams {
  posted?: string;
  halted?: string;
  dropped?: string;
  error?: string;
}

export default async function DeskPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<DeskSearchParams>;
}) {
  const account = await requireAccount((await params).id);
  const [state, names, live, entries] = await Promise.all([
    loadPoolState(account.id),
    loadHolderNames(account.id),
    loadLive(account.mt5Account),
    loadLedger(account.id),
  ]);
  const q = await searchParams;
  const dropped = decodeDroppedDeals(q.dropped);

  return (
    <>
      {q.error ? (
        <Notice>
          <strong>Nothing was committed.</strong> {q.error}
        </Notice>
      ) : null}
      {q.posted !== undefined ? (
        <Notice>
          {q.posted === "0"
            ? "Nothing to reconcile — readings are already up to date."
            : `Posted ${q.posted} ${q.posted === "1" ? "reading" : "readings"}.`}{" "}
          {q.halted === "1"
            ? "The reconciler stopped at an unexplained balance move — see the banner below."
            : null}
        </Notice>
      ) : null}
      {dropped.length > 0 ? (
        <Notice>
          <strong>
            Excluded {dropped.length} duplicate {dropped.length === 1 ? "trade" : "trades"} from
            reconciliation
          </strong>{" "}
          (broker double-push, both timestamps shifted by the account's UTC offset):{" "}
          {dropped.map((d, i) => (
            <span key={d.ticket}>
              {i > 0 ? ", " : ""}
              #{d.ticket} (duplicate of #{d.duplicateOfTicket})
            </span>
          ))}
          . Trading P/L was not double-counted; nothing here changed the ledger.
        </Notice>
      ) : null}

      <Desk
        accountId={account.id}
        state={state}
        figures={deskFigures(state, names)}
        segments={railSegments(state, names)}
        currency={account.currency}
        entryCount={entries.length}
        live={live}
        actions={
          <>
            <form action={refreshReadings}>
              <input type="hidden" name="accountId" value={account.id} />
              <button className="btn" type="submit">Refresh readings</button>
            </form>
            <a className="btn" href={readingHref(account.id)}>Post a reading by hand</a>
            <a className="btn" href={capitalHref(account.id)}>Add capital (yours or a holder&apos;s)</a>
          </>
        }
      />
    </>
  );
}
