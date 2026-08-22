"use server";

/**
 * The saveHolder server action behind the edit-holder sheet.
 *
 * Co-located with its page rather than appended to the shared
 * app/a/[id]/actions/actions.ts, matching the payout route's own precedent
 * (see app/a/[id]/actions/payout/[hid]/actions.ts's header) — one route, one
 * action file, nothing to collide with.
 *
 * D-F (updated): compound_holder's RLS policies now run for real — this
 * connects as `authenticated` with the signed-in manager's own claims
 * (withAuthenticatedDb), so the database itself refuses a holder row outside
 * account.managerUserId's own accounts before requireAccount's application
 * check ever runs. requireAccount remains the defence-in-depth layer, and it
 * is still what stops a HOLDER id from crossing accounts WITHIN one
 * manager's own rows: listHolders(c, account.id) is already scoped to the
 * resolved account, so a holder id belonging to a different account simply
 * is not in that list — checked here before anything is written, the same
 * guard the statement and edit pages both already apply before they render.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withAuthenticatedDb } from "@/lib/compound/db/client";
import { listHolders } from "@/lib/compound/db/holders";
import { updateHolder } from "@/lib/compound/db/write-holder";
import { requireAccount } from "@/lib/compound/load/account";
import { requireManager } from "@/lib/compound/load/session";
import { explainCommitError, isNextControlFlow } from "@/lib/compound/present/errors";
import { deskHref, editHolderHref, holderHref } from "@/lib/compound/ui/routes";

export async function saveHolder(formData: FormData) {
  const account = await requireAccount(String(formData.get("accountId")));
  const user = await requireManager();
  const holderId = Number(formData.get("holderId"));
  const back = editHolderHref(account.id, holderId);

  const holders = await withAuthenticatedDb(user.id, (c) => listHolders(c, account.id));
  const holder = holders.find((h) => h.id === holderId);
  if (holder === undefined) {
    redirect(`${back}?error=${encodeURIComponent(
      "That holder is not on this account. Check you picked the right holder.",
    )}`);
  }

  const name = String(formData.get("name") ?? "");
  const email = String(formData.get("email") ?? "") || null;
  // Forced to 0 for the manager regardless of what the submitted form
  // carries — EditHolderSheet never renders a split field for them, and
  // this is the application-side half of the same refusal
  // compound_update_holder's CX304 makes the database's. Never trust a
  // number that came back from the browser for a row it should never apply
  // to, even one this route's own sheet would not have sent.
  const splitBps = holder.isManager ? 0 : Math.round(Number(formData.get("split")) * 100);

  try {
    await withAuthenticatedDb(user.id, (c) =>
      updateHolder(c, {
        accountId: account.id,
        holderId: holder.id,
        name,
        email,
        splitBps,
        actorUserId: user.id,
      }),
    );
    revalidatePath(deskHref(account.id), "layout");
    redirect(holderHref(account.id, holder.id));
  } catch (e) {
    if (isNextControlFlow(e)) throw e;
    redirect(`${back}?error=${encodeURIComponent(explainCommitError(e))}`);
  }
}
