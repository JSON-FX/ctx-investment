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
import { withAuthenticatedDb } from "@/lib/compound/db/client";
import { commitReadingPlan } from "@/lib/compound/db/commit-plan";
import { classifyCandidate } from "@/lib/compound/db/write-classify";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { requireAccount } from "@/lib/compound/load/account";
import { loadPoolState } from "@/lib/compound/load/ledger";
import { requireManager } from "@/lib/compound/load/session";
import { encodeDroppedDeals, planFor } from "@/lib/compound/load/reconcile";
import { fingerprintOf } from "@/lib/compound/present/derive";
import { explainCommitError, isNextControlFlow } from "@/lib/compound/present/errors";
import { fingerprintFromFields, fingerprintMismatch } from "@/lib/compound/present/fingerprint";
import { classifyHref, deskHref, readingHref, reviewHref } from "@/lib/compound/ui/routes";

/**
 * Re-derive, compare, and hand back the sentence to show — or null to
 * proceed. Exported so a later sheet (Task 12's addCapital, Task 13's
 * payOut) can reuse the identical check against `fingerprintFromFields` /
 * `fingerprintOf` / `fingerprintMismatch` rather than re-implementing it.
 *
 * managerUserId is an explicit parameter, not resolved internally — see
 * load/ledger.ts's module doc: loadPoolState needs a caller identity to open
 * its own compound_* connection as, and resolving one via requireManager()
 * inside this function would make it uncallable from anywhere without a live
 * Next.js request, capital-staleness.db.test.ts included, which calls this
 * function directly against a real writer with no request in sight.
 */
export async function staleness(
  managerUserId: string,
  accountId: number,
  formData: FormData,
): Promise<string | null> {
  const shown = fingerprintFromFields((k) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : null;
  });
  if (shown === null) return "That form was incomplete. Nothing was committed.";
  const current = fingerprintOf(accountId, await loadPoolState(managerUserId, accountId));
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
    const result = await withAuthenticatedDb(user.id, (c) =>
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

  const stale = await staleness(user.id, account.id, formData);
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
    await withAuthenticatedDb(user.id, (c) =>
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

/**
 * Classifying one capital-event candidate. Decision D-J: deposit, match an
 * existing entry, or not-a-capital-event with a required note — and no
 * fourth option, because a negative unexplained move that is not an
 * already-recorded payout is a partial withdrawal (spec §12, P6) and this
 * action has no way to record one correctly.
 *
 * classifyCandidate re-checks everything this action checks (outcome shape,
 * positive amount, note-on-ignore) inside its own transaction — the checks
 * here are a fast local refusal with a form-shaped error message, not the
 * authority. What classifyCandidate additionally guarantees, and this
 * action does not need to: the candidate is still 'pending' (CX203) and the
 * account has not moved since the receipt (CX204), both re-verified under
 * the row lock, atomically with the write.
 */
export async function classify(formData: FormData) {
  const account = await requireAccount(String(formData.get("accountId")));
  const user = await requireManager();
  const candidateId = Number(formData.get("candidateId"));
  const back = classifyHref(account.id, candidateId);

  const stale = await staleness(user.id, account.id, formData);
  if (stale !== null) redirect(`${back}?error=${encodeURIComponent(stale)}`);
  const shown = fingerprintFromFields((k) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : null;
  })!;

  const outcome = String(formData.get("outcome"));
  if (outcome !== "deposit" && outcome !== "match" && outcome !== "ignore") {
    redirect(`${back}?error=${encodeURIComponent("Choose what this was before classifying it.")}`);
  }

  let amountCents: bigint | null = null;
  if (outcome === "deposit") {
    try {
      amountCents = centsFromDecimal(String(formData.get("amount")));
    } catch {
      redirect(`${back}?error=${encodeURIComponent("That is not an amount. Use digits and at most two decimal places.")}`);
    }
  }

  try {
    await withAuthenticatedDb(user.id, (c) =>
      classifyCandidate(c, {
        accountId: account.id,
        candidateId,
        outcome: outcome as "deposit" | "match" | "ignore",
        holderId: outcome === "deposit" ? Number(formData.get("holderId")) : null,
        amountCents,
        matchEntryId: outcome === "match" ? Number(formData.get("matchEntryId")) : null,
        note: String(formData.get("note") ?? "") || null,
        expectedSeq: shown.seq,
        actorUserId: user.id,
      }),
    );
    revalidatePath(deskHref(account.id), "layout");
    redirect(reviewHref(account.id));
  } catch (e) {
    if (isNextControlFlow(e)) throw e;
    redirect(`${back}?error=${encodeURIComponent(explainCommitError(e))}`);
  }
}
