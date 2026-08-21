import { notFound } from "next/navigation";
import { withDb } from "@/lib/compound/db/client";
import { listHolders } from "@/lib/compound/db/holders";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { fold } from "@/lib/compound/engine/replay";
import { requireAccount } from "@/lib/compound/load/account";
import { loadInterlock } from "@/lib/compound/load/interlock";
import { loadLedger, loadLive, loadSeeds } from "@/lib/compound/load/ledger";
import { fingerprintOf, previewEntry } from "@/lib/compound/present/derive";
import { holderPosition } from "@/lib/compound/present/holder";
import { PayoutSheet } from "@/lib/compound/ui/payout-sheet";
import { holderHref, reviewHref } from "@/lib/compound/ui/routes";
// PARALLEL-WORKTREE NOTE: the plan (Task 13, ~line 9589) has this import as
// `from "../../actions"` — Task 11 (the seam)'s shared actions.ts. This repo
// keeps payOut in a co-located module instead; see ./actions.ts's header
// comment for why.
import { payOut } from "./actions";

export const dynamic = "force-dynamic";

export default async function PayoutPage({
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
    withDb((c) => listHolders(c, account.id)),
    loadLedger(account.id),
    loadSeeds(account.id),
    loadLive(account.mt5Account),
    loadInterlock(account.id),
  ]);
  const holder = holders.find((h) => h.id === holderId);
  if (holder === undefined) notFound();

  const mode = q.mode === "exit" ? "exit" : "payout";
  const fee = q.fee === "cash" ? "cash" : "units";

  // The position is quoted against the SETTLEMENT equity, not against the last
  // committed reading — the settlement reading is what this payout will apply
  // at, so the receipt must be worked out at that NAV.
  let preview = null;
  let position = holderPosition(fold(entries, seeds), holderId);

  if (q.step === "confirm" && q.occurredOn && q.equity) {
    try {
      const settlement = centsFromDecimal(q.equity);
      const withReading = [
        ...entries,
        {
          id: Math.max(0, ...entries.map((e) => e.id)) + 1,
          seq: Math.max(0, ...entries.map((e) => e.seq)) + 1,
          holderId: null, occurredOn: q.occurredOn, type: "equity_reading" as const,
          amountCents: settlement, feeSettlement: null, splitBpsApplied: null, reversesId: null,
        },
      ];
      position = holderPosition(fold(withReading, seeds), holderId);
      const quoted = mode === "exit" ? position.exitQuote : position.profitQuote;
      preview = previewEntry({
        accountId: account.id,
        entries: withReading,
        seeds,
        proposed: {
          holderId, occurredOn: q.occurredOn, type: mode,
          amountCents: quoted.grossCents, feeSettlement: fee,
          splitBpsApplied: quoted.splitBpsApplied,
        },
      });

      // BUG FOUND WHILE BUILDING TASK 13 — fixed here, see
      // .superpowers/desk-task-13-report.md for the full trace.
      //
      // previewEntry's fingerprint is fingerprintOf(accountId, before), and
      // `before` is fold(entries, seeds) over whatever `entries` this call
      // was given — here, `withReading`. That makes `before.seq` (and hence
      // the fingerprint's seq) the SYNTHETIC settlement reading's seq
      // (max(seq)+1), not the seq actually sitting in compound_ledger_entry
      // right now (max(seq)). The plan's own text claims the opposite
      // ("its fingerprint carries the pre-reading state's seq"), but that
      // is not what previewEntry does when handed a 7-entry `withReading` —
      // confirmed by running it: fingerprint.seq comes back 7, not 6, on the
      // canonical fixture. The reading is never written to the ledger until
      // compound_commit_payout's own transaction does it, so `p_expected_seq`
      // (and this action's own staleness() pre-check, which re-folds the
      // REAL committed ledger) must be compared against max(seq) as it
      // stands right now — the pre-reading seq. Left as `withReading`'s
      // fingerprint, this action would refuse EVERY payout as "stale" on the
      // very first attempt, since 7 can never equal the database's real 6.
      //
      // `before`/`after` (the display figures — units, equity, NAV) are left
      // alone: showing the settlement-adjusted "before" is correct there,
      // since that is genuinely what the account will be worth the instant
      // before the payout applies. Only the fingerprint — the field checked
      // against the database, not shown to the reader — needs the earlier
      // state.
      preview = { ...preview, fingerprint: fingerprintOf(account.id, fold(entries, seeds)) };
    } catch {
      preview = null;
    }
  }

  return (
    <PayoutSheet
      accountId={account.id}
      holder={holder}
      position={position}
      preview={preview}
      form={{ mode, fee, occurredOn: q.occurredOn, equity: q.equity, note: q.note }}
      currency={account.currency}
      error={q.error}
      backHref={holderHref(account.id, holderId)}
      commitAction={payOut}
      liveEquityCents={live?.equityCents ?? null}
      blocked={interlock.pendingCandidateDate === null ? undefined : {
        candidateDate: interlock.pendingCandidateDate,
        reviewHref: reviewHref(account.id),
      }}
    />
  );
}
