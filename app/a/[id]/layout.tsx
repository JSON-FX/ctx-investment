/**
 * The account shell. Agreement A1 with plan 5: this layout owns the masthead,
 * the switcher, the sub-nav and the frozen-figures banner; plan 5's /journal,
 * /calendar and /performance render inside it as page content only.
 *
 * It loads three things and no more: the account, the manager's other accounts
 * for the switcher, and the interlock state for the badge and the banner. It
 * does NOT load or fold the ledger. Two of plan 5's surfaces need no ledger,
 * and a layout that replays one taxes every navigation for a figure most
 * pages will not render.
 *
 * The banner is here rather than on each page for a reason worth stating: when
 * the reconciler has stopped, EVERY figure on the account is as of the frozen
 * date. A banner that appeared on the desk and not on /performance would be
 * telling the truth in one place and implying its opposite in another.
 *
 * `<main>` also lives here, for the same reason: every route under this
 * layout shares one masthead and one six-link sub-nav, so the single
 * landmark that skips both belongs where they do, wrapping `{children}`
 * once, not repeated on each page. SkipToContent and AccountMain are
 * lib/compound/ui/shell.tsx, not inline here, so the "ui" Jest project can
 * actually render and test them — this file itself sits outside every Jest
 * project's roots.
 */
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { listManagerAccounts, requireAccount } from "@/lib/compound/load/account";
import { loadInterlock } from "@/lib/compound/load/interlock";
import { SIGN_IN_PATH } from "@/lib/compound/load/session";
import { authClient } from "@/lib/compound/load/supabase";
import { InterlockBanner } from "@/lib/compound/ui/banner";
import { Masthead } from "@/lib/compound/ui/masthead";
import { reviewHref } from "@/lib/compound/ui/routes";
import { AccountMain, SkipToContent } from "@/lib/compound/ui/shell";
import { SubNav } from "./subnav";

export const dynamic = "force-dynamic";

/**
 * Clears the session, then lands on sign-in. Matches sign-in/page.tsx's own
 * signIn action: an inline "use server" function on the page/layout that
 * needs it, rather than a shared action file — this is the only place in
 * the product that signs anyone out.
 *
 * SIGN_IN_PATH (session.ts), not a literal "/sign-in" here: the same
 * constant requireManager redirects an unauthenticated request to, so this
 * action and the gate the next request hits are provably pointed at the
 * same place rather than two strings that happen to agree today.
 */
async function signOut() {
  "use server";
  const supabase = await authClient();
  await supabase.auth.signOut();
  redirect(SIGN_IN_PATH);
}

export default async function AccountLayout({
  children, params,
}: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = await requireAccount(id);
  const [accounts, interlock] = await Promise.all([
    listManagerAccounts(),
    loadInterlock(account.managerUserId, account.id),
  ]);

  return (
    <div className="wrap">
      <SkipToContent />
      <Masthead current={account} accounts={accounts} signOutAction={signOut} />
      <SubNav accountId={account.id} pendingCount={interlock.pendingCount} />
      {interlock.pendingCandidateDate === null ? null : (
        <InterlockBanner
          frozenAt={interlock.frozenAt}
          candidateDate={interlock.pendingCandidateDate}
          reviewHref={reviewHref(account.id)}
        />
      )}
      <AccountMain>{children}</AccountMain>
    </div>
  );
}
