"use server";

/**
 * The server actions behind Phase B's sheets.
 *
 * Every one of them: resolve the account through the same gate a page uses,
 * re-derive the current state, check the fingerprint the receipt carried, then
 * write. The re-derivation is the point — a commit never trusts a number that
 * came back from the browser, only the inputs the manager typed.
 *
 * `staleness` is exported (not just used locally) so a later sheet does not
 * have to hand-roll the same fingerprint-mismatch check against
 * `fingerprintFromFields`/`fingerprintOf`/`fingerprintMismatch` a second time.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withDbTransaction } from "@/lib/compound/db/client";
import { commitReadingPlan } from "@/lib/compound/db/commit-plan";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { requireAccount } from "@/lib/compound/load/account";
import { loadPoolState } from "@/lib/compound/load/ledger";
import { requireManager } from "@/lib/compound/load/session";
import { encodeDroppedDeals, planFor } from "@/lib/compound/load/reconcile";
import { fingerprintOf } from "@/lib/compound/present/derive";
import { explainCommitError, isNextControlFlow } from "@/lib/compound/present/errors";
import { fingerprintFromFields, fingerprintMismatch } from "@/lib/compound/present/fingerprint";
import { deskHref, readingHref } from "@/lib/compound/ui/routes";

/**
 * Re-derive, compare, and hand back the sentence to show — or null to
 * proceed. Exported so a later sheet (Task 12's addCapital, Task 13's
 * payOut) can reuse the identical check against `fingerprintFromFields` /
 * `fingerprintOf` / `fingerprintMismatch` rather than re-implementing it.
 */
export async function staleness(accountId: number, formData: FormData): Promise<string | null> {
  const shown = fingerprintFromFields((k) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : null;
  });
  if (shown === null) return "That form was incomplete. Nothing was committed.";
  const current = fingerprintOf(accountId, await loadPoolState(accountId));
  return fingerprintMismatch(shown, current);
}

export async function refreshReadings(formData: FormData) {
  const account = await requireAccount(String(formData.get("accountId")));
  const user = await requireManager();
  const back = deskHref(account.id);

  const outcome = await planFor(account);
  if (outcome.kind === "not-configured") {
    redirect(`${back}?error=${encodeURIComponent(
      "The broker UTC offset is not set for this account. Reconciliation stays off " +
      "until it is: without the duplicate-deal guard an inflated explained figure " +
      "can hide a real capital event.",
    )}`);
  }
  if (outcome.kind === "error") {
    redirect(`${back}?error=${encodeURIComponent(outcome.message)}`);
  }

  // Dropped deals are never persisted (see load/reconcile.ts) — this redirect
  // is the only chance to show which tickets this run suppressed. Read them
  // before commitReadingPlan, whose result does not carry the plan back.
  const droppedParam = encodeDroppedDeals(outcome.plan.droppedDeals);

  try {
    const result = await withDbTransaction((c) =>
      commitReadingPlan(c, { accountId: account.id, plan: outcome.plan, actorUserId: user.id }),
    );
    revalidatePath(back, "layout");
    const params = new URLSearchParams({ posted: String(result.readingsInserted) });
    if (result.candidateId !== null) params.set("halted", "1");
    if (droppedParam !== "") params.set("dropped", droppedParam);
    redirect(`${back}?${params.toString()}`);
  } catch (e) {
    if (isNextControlFlow(e)) throw e;
    redirect(`${back}?error=${encodeURIComponent(explainCommitError(e))}`);
  }
}

export async function postReading(formData: FormData) {
  const account = await requireAccount(String(formData.get("accountId")));
  const user = await requireManager();
  const back = readingHref(account.id);

  const stale = await staleness(account.id, formData);
  if (stale !== null) redirect(`${back}?error=${encodeURIComponent(stale)}`);

  // The fence, re-checked here rather than trusted from the page that
  // rendered the form. ReadingSheet keeps the "Post this reading" button off
  // the page unless planFor says the reconciler has nothing left to post —
  // but that is a render-time read. compound_commit_reading_plan's own CX002
  // guard does NOT stand in for this: it only compares against a candidate
  // THIS call passes in p_candidate, and the plan built below is a plain
  // "advance" with none — so a hand-posted reading reaches the writer with
  // no candidate to check, regardless of whether one exists. Without this,
  // a candidate created by a refresh in another tab between this page
  // rendering and this submit would post right through it: the exact loss
  // spec section 5.3 exists to prevent, arriving through the one door the
  // interlock does not watch.
  const fenceOutcome = await planFor(account);
  if (fenceOutcome.kind !== "plan" || fenceOutcome.plan.kind !== "idle") {
    redirect(`${back}?error=${encodeURIComponent(
      "The reconciler has moved since this page was opened — it no longer has nothing " +
      "left to post. Nothing was committed. Reload this page to see the current state.",
    )}`);
  }

  const occurredOn = String(formData.get("occurredOn"));
  const earliestDate = fenceOutcome.lastSnapshotDate ?? account.inceptionDate;
  if (occurredOn <= earliestDate) {
    redirect(`${back}?error=${encodeURIComponent(
      `That date must be after ${earliestDate}, the last day CopyTraderX has. Nothing was committed.`,
    )}`);
  }

  let equityCents: bigint;
  try {
    equityCents = centsFromDecimal(String(formData.get("equity")));
  } catch {
    redirect(`${back}?error=${encodeURIComponent("That is not an amount. Use digits and at most two decimal places.")}`);
  }
  if (equityCents <= 0n) {
    redirect(`${back}?error=${encodeURIComponent("Equity must be positive. An account at zero needs an adjustment entry, not a reading.")}`);
  }

  try {
    await withDbTransaction((c) =>
      commitReadingPlan(c, {
        accountId: account.id,
        plan: {
          kind: "advance",
          readings: [{ occurredOn, equityCents }],
          newCursorDate: occurredOn,
          // A hand-posted reading deduplicated nothing. The field is required
          // on every variant so this has to be said rather than assumed.
          droppedDeals: [],
        },
        actorUserId: user.id,
      }),
    );
    revalidatePath(deskHref(account.id), "layout");
    redirect(deskHref(account.id));
  } catch (e) {
    if (isNextControlFlow(e)) throw e;
    redirect(`${back}?error=${encodeURIComponent(explainCommitError(e))}`);
  }
}
