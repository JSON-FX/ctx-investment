"use server";

/**
 * The server actions behind Task 12's two sheets.
 *
 * Kept in a file of its own rather than appended to
 * `app/a/[id]/actions/actions.ts` (Task 11's file, which holds
 * `refreshReadings`/`postReading`): three Phase B tasks (this one, the
 * payout receipt, the review queue) all need to add server actions on this
 * same seam, all in parallel worktrees. Three branches editing the tail of
 * one file is a guaranteed merge collision for no benefit — every action
 * here is reachable from its own route regardless of which file defines it.
 * `staleness` is imported, not re-implemented: Task 11 exports it from
 * `./actions` for exactly this reuse (its own doc comment names Task 12's
 * addCapital directly).
 *
 * Every action here: resolve the account through the same gate a page uses,
 * re-derive the current state where money moves, check the fingerprint the
 * receipt carried, then write. The re-derivation is the point — a commit
 * never trusts a number that came back from the browser, only the inputs
 * the manager typed.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withAuthenticatedDb } from "@/lib/compound/db/client";
import { addHolder } from "@/lib/compound/db/write-holder";
import { commitDeposit } from "@/lib/compound/db/write-deposit";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { requireAccount } from "@/lib/compound/load/account";
import { requireManager } from "@/lib/compound/load/session";
import { explainCommitError, isNextControlFlow } from "@/lib/compound/present/errors";
import { capitalHref, deskHref, investorHref } from "@/lib/compound/ui/routes";
import { staleness } from "./actions";

export async function addInvestor(formData: FormData) {
  const account = await requireAccount(String(formData.get("accountId")));
  const user = await requireManager();
  const back = investorHref(account.id);
  try {
    const holderId = await withAuthenticatedDb(user.id, (c) =>
      addHolder(c, {
        accountId: account.id,
        name: String(formData.get("name") ?? ""),
        email: String(formData.get("email") ?? "") || null,
        splitBps: Math.round(Number(formData.get("split")) * 100),
        joinedAt: String(formData.get("joinedAt")),
        actorUserId: user.id,
      }),
    );
    revalidatePath(deskHref(account.id), "layout");
    redirect(`${capitalHref(account.id)}?holderId=${holderId}`);
  } catch (e) {
    if (isNextControlFlow(e)) throw e;
    redirect(`${back}?step=confirm&error=${encodeURIComponent(explainCommitError(e))}`);
  }
}

export async function addCapital(formData: FormData) {
  const account = await requireAccount(String(formData.get("accountId")));
  const user = await requireManager();
  const back = capitalHref(account.id);

  const stale = await staleness(account.id, formData);
  if (stale !== null) redirect(`${back}?error=${encodeURIComponent(stale)}`);

  let amountCents: bigint;
  try {
    amountCents = centsFromDecimal(String(formData.get("amount")));
  } catch {
    redirect(`${back}?error=${encodeURIComponent("That is not an amount. Use digits and at most two decimal places.")}`);
    return;
  }

  try {
    await withAuthenticatedDb(user.id, (c) =>
      commitDeposit(c, {
        accountId: account.id,
        holderId: Number(formData.get("holderId")),
        occurredOn: String(formData.get("occurredOn")),
        amountCents,
        note: String(formData.get("note") ?? "") || null,
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
