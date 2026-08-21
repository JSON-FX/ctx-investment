/**
 * The account list. Deliberately thin: it lists accounts, it does not value
 * them. Valuing every account on this page means replaying every ledger in the
 * database to render a screen the manager passes through in half a second.
 *
 * The MT5 account number is MASKED to its last four digits. The repository is
 * public and screenshots of this page will end up in issues; the full number is
 * on the desk, one click away, where the context is already private.
 *
 * Ownership scoping — showing a manager only their own accounts — happens one
 * layer down, in lib/compound/load/account.ts's listManagerAccounts and
 * lib/compound/db/compound.ts's listAccountsForManager. This component only
 * ever renders the array it is handed; see write-account.db.test.ts for the
 * test that a manager cannot see another manager's row.
 *
 * AccountListItem mirrors load/account.ts's ResolvedAccount structurally
 * rather than importing it. The plan's own draft of this file imported
 * ResolvedAccount directly, and ui/purity.test.ts caught it: `import type`
 * is erased at runtime, but that test's scan is a plain regex over source
 * text, blind to the `type` keyword, so the import still reads as ui/
 * reaching into load/. Every other component in this kit (HolderTable's
 * DeskFigures, StatementHead's own local LiveFigures) already avoids this by
 * depending only on present/, engine/ or a locally-declared shape — this
 * follows the same rule. TypeScript's structural typing means the real
 * ResolvedAccount[] listManagerAccounts() returns still satisfies this type
 * at every call site with no cast; drops only managerUserId, which nothing
 * below renders.
 */
import { formatDate, formatSplit } from "@/lib/compound/present/format";
import { Chip, EmptyState, Panel } from "./primitives";
import { deskHref } from "./routes";

export interface AccountListItem {
  id: number;
  mt5Account: number;
  label: string;
  broker: string | null;
  currency: string;
  defaultSplitBps: number;
  /** YYYY-MM-DD. */
  inceptionDate: string;
  /** Null means not configured. */
  brokerOffsetHours: number | null;
}

export function maskMt5(account: number): string {
  const s = String(account);
  return s.length <= 4 ? s : `••••${s.slice(-4)}`;
}

export function AccountList({ accounts }: { accounts: AccountListItem[] }) {
  if (accounts.length === 0) {
    return (
      <Panel>
        <EmptyState title="No accounts yet">
          Compound reads an MT5 account that CopyTraderX is already pushing.
          Add one to start.
        </EmptyState>
        <p style={{ textAlign: "center", margin: 0 }}>
          <a className="btn btn-primary" href="/accounts/new">Add an account</a>
        </p>
      </Panel>
    );
  }

  return (
    <Panel flush>
      <div className="scroller">
        <table>
          <caption className="eyebrow">Accounts</caption>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">MT5</th>
              <th scope="col">Broker</th>
              <th scope="col">Currency</th>
              <th scope="col">Default split</th>
              <th scope="col">Inception</th>
              <th scope="col">Reconciliation</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  <a href={deskHref(a.id)}>{a.label}</a>
                </th>
                <td className="num">{maskMt5(a.mt5Account)}</td>
                <td>{a.broker ?? "—"}</td>
                <td className="num">{a.currency}</td>
                <td className="num">{formatSplit(a.defaultSplitBps)}</td>
                <td className="num">{formatDate(a.inceptionDate)}</td>
                <td>
                  {a.brokerOffsetHours === null
                    ? <Chip tone="fee">Broker offset not set</Chip>
                    : <span className="num">±{a.brokerOffsetHours}h</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
