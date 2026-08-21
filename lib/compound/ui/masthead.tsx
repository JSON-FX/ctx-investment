/**
 * The masthead and the account switcher.
 *
 * The switcher is a <details> element. No client component, no state, no
 * hydration — it opens and closes because that is what <details> does, and it
 * is keyboard-operable and screen-reader-announced without any work.
 *
 * The MT5 number is masked here for the same reason it is masked in the account
 * list: this is the strip that appears in every screenshot of the product.
 *
 * MastheadAccount mirrors load/account.ts's ResolvedAccount structurally
 * rather than importing it — the same reason account-list.tsx's
 * AccountListItem does (see that file's module doc): `import type` is erased
 * at runtime, but ui/purity.test.ts's scan is a plain regex over source text,
 * blind to the `type` keyword, so `import type { ResolvedAccount } from
 * "@/lib/compound/load/account"` here would still read as ui/ reaching into
 * load/. The plan's own draft of this file imported it directly; run against
 * purity.test.ts it fails the same way account-list.tsx's earlier draft did.
 * Only the fields this file actually renders.
 */
import { maskMt5 } from "./account-list";

export interface MastheadAccount {
  id: number;
  mt5Account: number;
  label: string;
  currency: string;
}

export function AccountSwitcher({
  current, accounts,
}: { current: MastheadAccount; accounts: MastheadAccount[] }) {
  const others = accounts.filter((a) => a.id !== current.id);
  const summary = (
    <>
      <span className="dot" aria-hidden="true" />
      {current.label}
      <span className="muted"> · {maskMt5(current.mt5Account)}</span>
      {current.currency === "USD" ? null : <span className="muted"> · {current.currency}</span>}
    </>
  );

  if (others.length === 0 && accounts.length <= 1) {
    return <p className="switcher" style={{ margin: 0 }}><span>{summary}</span></p>;
  }

  return (
    <details className="switcher">
      <summary aria-label={`Account: ${current.label}. Switch account.`}>
        {summary}
        <span aria-hidden="true">▾</span>
      </summary>
      <div>
        {accounts.map((a) => (
          <a key={a.id} href={`/a/${a.id}`} aria-current={a.id === current.id ? "true" : undefined}>
            {a.label}
            <span className="muted"> · {maskMt5(a.mt5Account)}</span>
          </a>
        ))}
        <a href="/accounts/new">+ Add an account</a>
      </div>
    </details>
  );
}

export function Masthead({
  current, accounts, signOutAction,
}: {
  current: MastheadAccount;
  accounts: MastheadAccount[];
  /** A Server Action: clears the session, then redirects to /sign-in. */
  signOutAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <header className="mast">
      <div>
        <a href="/" style={{ color: "inherit", textDecoration: "none" }}>
          <span className="mark">Compound</span>
        </a>
        <span className="sub">Investor Desk</span>
      </div>
      <AccountSwitcher current={current} accounts={accounts} />
      <form action={signOutAction}>
        <button className="btn" type="submit">Sign out</button>
      </form>
    </header>
  );
}
