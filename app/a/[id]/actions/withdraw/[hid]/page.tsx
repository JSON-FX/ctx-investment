import { notFound } from "next/navigation";
import { withAuthenticatedDb } from "@/lib/compound/db/client";
import { listHolders } from "@/lib/compound/db/holders";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { quote as computeQuote, type Quote } from "@/lib/compound/engine/quote";
import { fold, totalsOf } from "@/lib/compound/engine/replay";
import { requireAccount } from "@/lib/compound/load/account";
import { loadInterlock } from "@/lib/compound/load/interlock";
import { loadLedger, loadLive, loadSeeds } from "@/lib/compound/load/ledger";
import { fingerprintOf, previewEntry, type Preview } from "@/lib/compound/present/derive";
import { holderPosition } from "@/lib/compound/present/holder";
import { WithdrawSheet } from "@/lib/compound/ui/withdraw-sheet";
import { holderHref, reviewHref } from "@/lib/compound/ui/routes";
import { withdraw } from "./actions";

export const dynamic = "force-dynamic";

export default async function WithdrawPage({
  params, searchParams,
}: {
  params: Promise<{ id: string; hid: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id, hid } = await params;
  const account = await requireAccount(id);
  if (!/^[1-9][0-9]{0,17}$/.test(hid)) notFound();
  const holderId = Number(hid);
  const q = await searchParams;

  const [holders, entries, seeds, live, interlock] = await Promise.all([
    withAuthenticatedDb(account.managerUserId, (c) => listHolders(c, account.id)),
    loadLedger(account.managerUserId, account.id),
    loadSeeds(account.managerUserId, account.id),
    loadLive(account.mt5Account),
    loadInterlock(account.managerUserId, account.id),
  ]);
  const holder = holders.find((h) => h.id === holderId);
  if (holder === undefined) notFound();

  const fee = q.fee === "cash" ? "cash" : "units";

  // Quoted against the SETTLEMENT equity, matching payout-sheet's own
  // reasoning: the settlement reading is what this withdrawal will apply at,
  // so the receipt must be worked out at that NAV, not the last committed one.
  let preview: Preview | null = null;
  let quote: Quote | null = null;
  let position = holderPosition(fold(entries, seeds), holderId);
  let quoteError: string | null = null;

  if (q.step === "confirm" && q.occurredOn && q.equity && q.amount) {
    try {
      const settlement = centsFromDecimal(q.equity);
      const amountCents = centsFromDecimal(q.amount);
      const withReading = [
        ...entries,
        {
          id: Math.max(0, ...entries.map((e) => e.id)) + 1,
          seq: Math.max(0, ...entries.map((e) => e.seq)) + 1,
          holderId: null, occurredOn: q.occurredOn, type: "equity_reading" as const,
          amountCents: settlement, feeSettlement: null, splitBpsApplied: null, reversesId: null,
        },
      ];
      const settledState = fold(withReading, seeds);
      position = holderPosition(settledState, holderId);

      // Computed here, and re-derived by previewEntry's own fold below — see
      // decision D-D. Calling it directly first is what lets a cap violation
      // (or a non-positive amount) surface as a RangeError with a specific
      // sentence, rather than previewEntry's own fold silently producing a
      // preview nobody asked for.
      quote = computeQuote({
        totals: totalsOf(settledState),
        holderUnits: position.holder.units,
        basisCents: position.holder.basisCents,
        splitBps: position.holder.splitBps,
        isManager: position.holder.isManager,
        mode: "partial",
        amountCents,
      });

      preview = previewEntry({
        accountId: account.id,
        entries: withReading,
        seeds,
        proposed: {
          holderId, occurredOn: q.occurredOn, type: "withdrawal",
          amountCents: quote.grossCents, feeSettlement: fee,
          splitBpsApplied: quote.splitBpsApplied,
        },
      });

      // Same fix payout-sheet's page.tsx documents at length: previewEntry's
      // fingerprint carries `before.seq` for whatever `entries` array it was
      // given — here, withReading, whose synthetic reading is one seq AHEAD
      // of what is actually sitting in compound_ledger_entry right now. The
      // reading is never written until compound_commit_withdrawal's own
      // transaction does it, so the fingerprint (checked against the
      // database, never shown to the reader) must carry the PRE-reading
      // state, not withReading's.
      preview = { ...preview, fingerprint: fingerprintOf(account.id, fold(entries, seeds)) };
    } catch (e) {
      preview = null;
      quote = null;
      // A RangeError here is quote.ts's own cap/positivity check (or a
      // malformed decimal from centsFromDecimal) — worth showing verbatim,
      // rather than silently dropping back to step one with no explanation.
      quoteError = e instanceof RangeError ? e.message : null;
    }
  }

  return (
    <WithdrawSheet
      accountId={account.id}
      holder={holder}
      position={position}
      quote={quote}
      preview={preview}
      form={{ fee, occurredOn: q.occurredOn, equity: q.equity, amount: q.amount, note: q.note }}
      currency={account.currency}
      error={q.error ?? quoteError ?? undefined}
      backHref={holderHref(account.id, holderId)}
      commitAction={withdraw}
      liveEquityCents={live?.equityCents ?? null}
      blocked={interlock.pendingCandidateDate === null ? undefined : {
        candidateDate: interlock.pendingCandidateDate,
        reviewHref: reviewHref(account.id),
      }}
    />
  );
}
