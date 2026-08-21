/**
 * One holder's statement.
 *
 * The withdraw block is a preview of the payout receipt and imports the same
 * words from PAYOUT_WORDS. In Phase A it has no button; Task 13 adds the link
 * through `withdrawAction`.
 *
 * The `holder` prop is typed structurally here rather than imported from
 * lib/compound/db/holders. ui/purity.test.ts forbids ui/ sources from
 * importing anything under "@/lib/compound/db", including a type-only import
 * — the regex matches the module specifier regardless of the `type` keyword,
 * and the point of that rule is that this file renders what it is handed and
 * never gains a reason to reach for the data layer, not even for a shape. A
 * real HolderRow from db/holders.ts satisfies HolderIdentity structurally, so
 * the page can pass one straight through with no cast.
 *
 * `derivedStatus` reads `position.holder.status` — the engine's own
 * HolderState, produced by folding the ledger — not `holder.status`, the
 * value carried on the HolderIdentity prop. Decision D-M: the database
 * column is stored for a direct reader's benefit only and no screen may use
 * it to decide anything, because fold() is the one place a holder's status is
 * decided. A holder who exited is "closed" with zero units; a holder who has
 * not deposited yet is "active" with zero units. Reading the wrong status
 * source would be unable to tell those apart.
 */
import type { ReactNode } from "react";
import type { PoolTotals } from "@/lib/compound/engine/nav";
import type { HolderPosition, HolderStatementRow } from "@/lib/compound/present/holder";
import {
  formatDate, formatMoney, formatNav, formatSplit, formatSplitWords, formatUnitsDp,
} from "@/lib/compound/present/format";
import { PAYOUT_WORDS } from "@/lib/compound/present/wording";
import {
  DeltaMoney, Eyebrow, FeeMoney, Money, Panel, Share, Tag,
} from "./primitives";
import { Receipt, ReceiptLine } from "./receipt";
import { KpiStrip } from "./statement";

/** Mirrors db/holders.ts's HolderRow shape — see the module doc for why this is not imported. */
export interface HolderIdentity {
  id: number;
  accountId: number;
  name: string;
  email: string | null;
  userId: string | null;
  isManager: boolean;
  splitBps: number;
  joinedAt: string | null;
  status: "active" | "closed";
}

const TYPE_LABELS: Record<string, string> = {
  deposit: "Deposit", payout: "Payout", exit: "Exit",
  equity_reading: "Account revalued", adjustment: "Adjustment",
};

export function HolderStatement({
  holder, position, rows, totals, currency, withdrawAction,
}: {
  holder: HolderIdentity;
  position: HolderPosition;
  rows: HolderStatementRow[];
  totals: PoolTotals;
  currency: string;
  /** Phase B fills this. */
  withdrawAction?: ReactNode;
}) {
  const name = holder.name;
  const money = (c: bigint) => formatMoney(c, { currency });
  const [holderPct = "0", managerPct = "0"] = formatSplit(holder.splitBps).split(" / ");
  const derivedStatus = position.holder.status;

  return (
    <>
      <Panel>
        <Eyebrow>
          Holder statement · joined{" "}
          {holder.joinedAt === null ? "—" : formatDate(holder.joinedAt)}
        </Eyebrow>
        <h1 style={{ fontFamily: "var(--serif)", fontWeight: 400, fontSize: 30, margin: "6px 0 2px" }}>
          {name}
          {holder.isManager ? <Tag>Manager</Tag> : null}
          {derivedStatus === "closed" ? <Tag>Closed</Tag> : null}
        </h1>
        <p className="muted" style={{ margin: "0 0 16px", fontSize: 13 }}>
          {holder.isManager
            ? "You manage this account. No fee is charged on your own holding."
            : formatSplitWords(holder.splitBps, name)}
        </p>

        <KpiStrip
          items={[
            { key: "units", label: "Units held", value: formatUnitsDp(position.holder.units) },
            { key: "share", label: "Share of the pool", value: <Share ppm={position.ppm} /> },
            {
              key: "capital",
              label: PAYOUT_WORDS.capitalIn(name),
              value: <Money cents={position.holder.basisCents} currency={currency} />,
            },
            {
              key: "value",
              label: "Value on this statement",
              value: <Money cents={position.statementValueCents} currency={currency} />,
            },
            {
              // Not PAYOUT_WORDS.profit ("Profit above that"): that phrase is
              // also the receipt line's label below, on the same rendered
              // page. Two elements sharing one accessible name is not just
              // untestable by label (this plan's own rule 2) — it is the
              // same ambiguity for a screen reader, which is what the label
              // exists for. Same figure, two structurally different homes,
              // two names.
              key: "profit",
              label: "Profit",
              value: <DeltaMoney cents={position.profitCents} currency={currency} />,
            },
          ]}
        />

        <p className="split-note">
          {PAYOUT_WORDS.statementVsSettlement(
            money(position.statementValueCents),
            money(position.settlementValueCents),
          )}
        </p>
      </Panel>

      <Panel>
        <Eyebrow>If {name} withdrew today · NAV {formatNav(totals)}</Eyebrow>

        {position.markState === "above" ? (
          <Receipt label={`Withdrawal preview for ${name}`}>
            <ReceiptLine label={PAYOUT_WORDS.valueNow} hint={PAYOUT_WORDS.valueNowHint}>
              <span className="num">{money(position.settlementValueCents)}</span>
            </ReceiptLine>
            <ReceiptLine label={PAYOUT_WORDS.profit} hint={PAYOUT_WORDS.profitHint}>
              <DeltaMoney cents={position.profitCents} currency={currency} />
            </ReceiptLine>
            <ReceiptLine label={PAYOUT_WORDS.holderShare(name, holderPct)}>
              <span className="num">{money(position.profitQuote.toHolderCents)}</span>
            </ReceiptLine>
            <ReceiptLine
              label={PAYOUT_WORDS.managerFee(managerPct)}
              hint={PAYOUT_WORDS.managerFeeHint}
              tone="fee"
            >
              <FeeMoney cents={position.profitQuote.feeCents} currency={currency} />
            </ReceiptLine>
            <ReceiptLine label={`${PAYOUT_WORDS.exitInFull} — ${name} receives`}>
              <span className="num">{money(position.exitQuote.toHolderCents)}</span>
            </ReceiptLine>
          </Receipt>
        ) : (
          <div className="banner-halt" role="status">
            <strong>
              {position.markState === "below"
                ? PAYOUT_WORDS.belowMarkTitle
                : PAYOUT_WORDS.atMarkTitle}
            </strong>
            <p style={{ margin: "6px 0 0" }}>
              {position.markState === "below"
                ? PAYOUT_WORDS.belowMark(
                    name,
                    money(position.holder.basisCents),
                    money(position.settlementValueCents),
                    money(position.recoveryCents),
                  )
                : PAYOUT_WORDS.atMark(name)}
            </p>
            <p style={{ margin: "6px 0 0" }}>
              {PAYOUT_WORDS.exitStillAvailable(money(position.exitQuote.toHolderCents))}
            </p>
          </div>
        )}

        {withdrawAction ? <div className="actions">{withdrawAction}</div> : null}
      </Panel>

      <Panel flush>
        <div className="scroller">
          <table>
            <caption className="eyebrow">{name}&apos;s history</caption>
            <thead>
              <tr>
                <th scope="col">Occurred</th>
                <th scope="col">What happened</th>
                <th scope="col">Units in/out</th>
                <th scope="col">Units after</th>
                <th scope="col">Capital in</th>
                <th scope="col">Value after</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.seq} className={r.voided ? "voided" : ""}>
                  <th scope="row" className="num" style={{ fontWeight: 400 }}>
                    {formatDate(r.occurredOn)}
                  </th>
                  <td>
                    {TYPE_LABELS[r.type] ?? r.type}
                    {r.own ? null : <span className="muted"> · account-wide</span>}
                    {r.voided ? <span className="muted"> · voided</span> : null}
                  </td>
                  <td className="num">
                    {r.unitsDelta === 0n
                      ? "—"
                      : `${r.unitsDelta > 0n ? "+" : "-"}${formatUnitsDp(
                          r.unitsDelta < 0n ? -r.unitsDelta : r.unitsDelta,
                        )}`}
                  </td>
                  <td className="num">{formatUnitsDp(r.unitsAfter)}</td>
                  <td><Money cents={r.basisAfter} currency={currency} /></td>
                  <td><Money cents={r.valueAfter} currency={currency} /></td>
                  <td>
                    {r.valueDelta === 0n
                      ? <span className="num">—</span>
                      : <DeltaMoney cents={r.valueDelta} currency={currency} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
