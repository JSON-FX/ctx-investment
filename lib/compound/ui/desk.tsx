/**
 * The desk. Everything on it is derived from one PoolState.
 *
 * Two figures on this page are the same quantity measured two ways and they
 * are meant to stay apart:
 *
 *   Account equity   the COMMITTED figure, from the last posted reading.
 *   Live equity      account_snapshots_current, intraday, not posted.
 *
 * Spec section 5.2 keeps them apart because a payout may never settle against
 * a drifting intraday figure. The headline is always the committed one.
 *
 * The KPI strip carries exactly one amber tile — "Fee if everyone paid out
 * today" — and it is the only amber on the page apart from the manager's row.
 * Spec section 8.2: amber means the fee and nothing else.
 */
import type { ReactNode } from "react";
import type { PoolState } from "@/lib/compound/engine/replay";
import { totalsOf } from "@/lib/compound/engine/replay";
import type { DeskFigures } from "@/lib/compound/present/derive";
import type { RailSegment } from "@/lib/compound/present/rail";
import { HolderTable } from "./holder-table";
import { OwnershipRail } from "./rail";
import { DeltaMoney, EmptyState, FeeMoney, Money, Panel } from "./primitives";
import { KpiStrip, StatementHead, type LiveFigures } from "./statement";

export function Desk({
  accountId, state, figures, segments, currency, entryCount, live, actions,
}: {
  accountId: number;
  state: PoolState;
  figures: DeskFigures;
  segments: RailSegment[];
  currency: string;
  entryCount: number;
  live: LiveFigures | null;
  /** Phase B fills this. Absent in Phase A, and the desk is complete without it. */
  actions?: ReactNode;
}) {
  if (entryCount === 0) {
    return (
      <Panel>
        <EmptyState title="Nothing posted yet">
          This account has no ledger entries. Post an equity reading or add capital
          to start, and every figure on this page will be derived from what you post.
        </EmptyState>
        {actions ? <div className="actions" style={{ justifyContent: "center" }}>{actions}</div> : null}
      </Panel>
    );
  }

  return (
    <>
      <Panel>
        <StatementHead
          totals={totalsOf(state)}
          currency={currency}
          asOf={state.lastReadingOn}
          entryCount={entryCount}
          holderCount={figures.holderCount}
          live={live}
        />
        <OwnershipRail segments={segments} />
        {actions ? <div className="actions">{actions}</div> : null}
      </Panel>

      <KpiStrip
        items={[
          {
            key: "capital",
            label: "Investor capital in",
            value: <Money cents={figures.investorBasisCents} currency={currency} />,
          },
          {
            key: "value",
            label: "Investor value now",
            value: <Money cents={figures.investorValueCents} currency={currency} />,
          },
          {
            key: "pl",
            label: "Investor P/L",
            value: <DeltaMoney cents={figures.investorProfitCents} currency={currency} />,
          },
          {
            key: "yours",
            label: "Your holding",
            value: <Money cents={figures.managerValueCents} currency={currency} />,
          },
          {
            key: "fee",
            label: "Fee if everyone paid out today",
            tone: "fee",
            value: <FeeMoney cents={figures.feeIfAllExitCents} currency={currency} />,
          },
        ]}
      />

      <Panel flush>
        <HolderTable
          accountId={accountId}
          figures={figures}
          currency={currency}
          showActions={actions !== undefined}
        />
      </Panel>

      <p className="foot">
        Every figure on this page is derived by replaying {entryCount} ledger{" "}
        {entryCount === 1 ? "entry" : "entries"}. Nothing is stored. Money is integer
        cents, units are integers scaled 1e-10, and no floating point is used anywhere
        in the accounting.
      </p>
    </>
  );
}
