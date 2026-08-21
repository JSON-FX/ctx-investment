/**
 * Spec section 7: "account list, or redirect when there is only one".
 *
 * The redirect is unconditional on a single account, including for a manager
 * who has just created it. Under D1 there is one operator with one account,
 * and a list of one is a click they should not have to make.
 */
import { redirect } from "next/navigation";
import { listManagerAccounts } from "@/lib/compound/load/account";
import { AccountList } from "@/lib/compound/ui/account-list";
import { deskHref } from "@/lib/compound/ui/routes";

export const dynamic = "force-dynamic";

export default async function Page() {
  const accounts = await listManagerAccounts();
  if (accounts.length === 1) redirect(deskHref(accounts[0]!.id));

  return (
    <div className="wrap">
      <header className="mast">
        <div>
          <span className="mark">Compound</span>
          <span className="sub">Investor Desk</span>
        </div>
        {accounts.length > 0 ? (
          <a className="btn" href="/accounts/new">Add an account</a>
        ) : null}
      </header>
      <AccountList accounts={accounts} />
    </div>
  );
}
