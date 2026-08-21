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
 */
import type { ReactNode } from "react";
import { listManagerAccounts, requireAccount } from "@/lib/compound/load/account";
import { loadInterlock } from "@/lib/compound/load/interlock";
import { InterlockBanner } from "@/lib/compound/ui/banner";
import { Masthead } from "@/lib/compound/ui/masthead";
import { reviewHref } from "@/lib/compound/ui/routes";
import { SubNav } from "./subnav";

export const dynamic = "force-dynamic";

export default async function AccountLayout({
  children, params,
}: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = await requireAccount(id);
  const [accounts, interlock] = await Promise.all([
    listManagerAccounts(),
    loadInterlock(account.id),
  ]);

  return (
    <div className="wrap">
      <Masthead current={account} accounts={accounts} />
      <SubNav accountId={account.id} pendingCount={interlock.pendingCount} />
      {interlock.pendingCandidateDate === null ? null : (
        <InterlockBanner
          frozenAt={interlock.frozenAt}
          candidateDate={interlock.pendingCandidateDate}
          reviewHref={reviewHref(account.id)}
        />
      )}
      {children}
    </div>
  );
}
