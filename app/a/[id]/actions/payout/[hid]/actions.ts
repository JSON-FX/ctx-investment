"use server";

/**
 * The payOut server action.
 *
 * PARALLEL-WORKTREE NOTE: plan 4's Task 13 (docs/superpowers/plans/
 * 2026-08-21-compound-desk.md, ~line 9628) writes this by appending to
 * `app/a/[id]/actions/actions.ts` — the shared file Task 11 (the action seam,
 * `.worktrees/seam`, branch feat/desk-seam) owns and was actively building
 * this file in. Task 13's brief is explicit: do not edit the seam owner's
 * files; ask instead. So `payOut` lives in its own module here rather than
 * appended to actions.ts, importing the seam's exported pure helpers
 * (`fingerprintFromFields`, `fingerprintMismatch`, `explainCommitError`,
 * `isNextControlFlow`) instead of touching that file. This was flagged to the
 * seam owner (agent a8cc92d71a7c0c6c6) via SendMessage before this was
 * written. If Task 11 would rather own this function directly, it is a
 * ten-line move once feat/desk-seam merges: cut this function into
 * actions.ts, delete this file, and change the page's import.
 *
 * The re-derivation is the point, same as every other money-flow action in
 * this plan: a commit never trusts a number that came back from the browser,
 * only the inputs the manager typed. The fingerprint check re-folds the
 * ledger and refuses when the pool has moved since the receipt was rendered;
 * compound_commit_payout's p_expected_seq check is the same guard enforced
 * again, under the row lock, for the race this application code cannot close.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withAuthenticatedDb } from "@/lib/compound/db/client";
import { commitPayout } from "@/lib/compound/db/write-payout";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { requireAccount } from "@/lib/compound/load/account";
import { loadPoolState } from "@/lib/compound/load/ledger";
import { requireManager } from "@/lib/compound/load/session";
import { fingerprintOf } from "@/lib/compound/present/derive";
import { explainCommitError, isNextControlFlow } from "@/lib/compound/present/errors";
import { fingerprintFromFields, fingerprintMismatch } from "@/lib/compound/present/fingerprint";
import { deskHref, holderHref, payoutHref } from "@/lib/compound/ui/routes";

/**
 * Re-derive, compare, and hand back the sentence to show — or null to
 * proceed. Mirrors the private `staleness()` helper the plan's Task 11
 * defines in actions.ts (~line 7151); duplicated here rather than imported
 * because that helper is not exported and this module deliberately does not
 * import from actions.ts. Keep this in step with that helper's behaviour if
 * either changes.
 */
async function staleness(
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

export async function payOut(formData: FormData) {
  const account = await requireAccount(String(formData.get("accountId")));
  const user = await requireManager();
  const holderId = Number(formData.get("holderId"));
  const back = payoutHref(account.id, holderId);

  const stale = await staleness(user.id, account.id, formData);
  if (stale !== null) redirect(`${back}?error=${encodeURIComponent(stale)}`);

  const shown = fingerprintFromFields((k) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : null;
  })!;

  let settlementEquityCents: bigint;
  try {
    settlementEquityCents = centsFromDecimal(String(formData.get("equity")));
  } catch {
    redirect(`${back}?error=${encodeURIComponent("That is not an amount. Use digits and at most two decimal places.")}`);
    return;
  }

  try {
    await withAuthenticatedDb(user.id, (c) =>
      commitPayout(c, {
        accountId: account.id,
        holderId,
        occurredOn: String(formData.get("occurredOn")),
        settlementEquityCents,
        mode: formData.get("mode") === "exit" ? "exit" : "payout",
        feeSettlement: formData.get("fee") === "cash" ? "cash" : "units",
        splitBpsApplied: Number(formData.get("splitBpsApplied")),
        grossCents: BigInt(String(formData.get("grossCents"))),
        expectedSeq: shown.seq,
        note: String(formData.get("note") ?? "") || null,
        actorUserId: user.id,
      }),
    );
    revalidatePath(deskHref(account.id), "layout");
    redirect(holderHref(account.id, holderId));
  } catch (e) {
    if (isNextControlFlow(e)) throw e;
    redirect(`${back}?error=${encodeURIComponent(explainCommitError(e))}`);
  }
}
