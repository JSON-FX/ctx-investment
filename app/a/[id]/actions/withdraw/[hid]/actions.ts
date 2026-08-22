"use server";

/**
 * The withdraw server action (P6).
 *
 * Co-located rather than appended to the shared actions.ts, for the same
 * reason payout's own action lives in its own module — see
 * app/a/[id]/actions/payout/[hid]/actions.ts's header. This file goes
 * further and does not import from that seam at all either; it duplicates
 * the tiny `staleness()` helper rather than importing payOut's copy of it,
 * so this new route has no dependency on a sibling in-flight task's file.
 *
 * Same re-derivation discipline as every other money-flow action here: this
 * never trusts amountCents or holderValueCents as they come back from the
 * browser without first re-folding the ledger and checking the fingerprint
 * matches. compound_commit_withdrawal's own p_expected_seq check is the same
 * guard enforced again, under the row lock, for the race this application
 * code cannot close on its own.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withAuthenticatedDb } from "@/lib/compound/db/client";
import { commitWithdrawal } from "@/lib/compound/db/write-withdrawal";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { requireAccount } from "@/lib/compound/load/account";
import { loadPoolState } from "@/lib/compound/load/ledger";
import { requireManager } from "@/lib/compound/load/session";
import { fingerprintOf } from "@/lib/compound/present/derive";
import { explainCommitError, isNextControlFlow } from "@/lib/compound/present/errors";
import { fingerprintFromFields, fingerprintMismatch } from "@/lib/compound/present/fingerprint";
import { deskHref, holderHref, withdrawHref } from "@/lib/compound/ui/routes";

async function staleness(accountId: number, formData: FormData): Promise<string | null> {
  const shown = fingerprintFromFields((k) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : null;
  });
  if (shown === null) return "That form was incomplete. Nothing was committed.";
  const current = fingerprintOf(accountId, await loadPoolState(accountId));
  return fingerprintMismatch(shown, current);
}

export async function withdraw(formData: FormData) {
  const account = await requireAccount(String(formData.get("accountId")));
  const user = await requireManager();
  const holderId = Number(formData.get("holderId"));
  const back = withdrawHref(account.id, holderId);

  const stale = await staleness(account.id, formData);
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
      commitWithdrawal(c, {
        accountId: account.id,
        holderId,
        occurredOn: String(formData.get("occurredOn")),
        settlementEquityCents,
        // Both re-read from the SAME hidden fields the receipt rendered —
        // never recomputed here. The fingerprint check above is what makes
        // trusting them safe: if the pool moved, staleness() already refused.
        amountCents: BigInt(String(formData.get("amountCents"))),
        holderValueCents: BigInt(String(formData.get("holderValueCents"))),
        feeSettlement: formData.get("fee") === "cash" ? "cash" : "units",
        splitBpsApplied: Number(formData.get("splitBpsApplied")),
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
