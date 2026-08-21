/**
 * The statement head and the KPI strip.
 *
 * The head shows the COMMITTED equity — the figure from the last posted
 * reading — as the large number, and the live figure beside it under a label
 * that says it is not posted. Spec section 5.2 keeps the two apart because a
 * payout may never settle against a drifting intraday figure, and a screen
 * that shows only one of them cannot make that distinction visible.
 */
import type { ReactNode } from "react";
import type { Cents } from "@/lib/compound/engine/money";
import type { PoolTotals } from "@/lib/compound/engine/nav";
import {
  formatDate, formatNav, formatSinceInception, formatUnitsDp, splitMoney,
} from "@/lib/compound/present/format";
import { LiveChip } from "./banner";
import { DeltaMoney, Eyebrow, LabelledFigure } from "./primitives";

export interface LiveFigures {
  equityCents: Cents;
  floatingPnlCents: Cents;
  pushedAt: string;
}

export function StatementHead({
  totals, currency, asOf, entryCount, holderCount, live,
}: {
  totals: PoolTotals;
  currency: string;
  asOf: string | null;
  entryCount: number;
  holderCount: number;
  live: LiveFigures | null;
}) {
  const { whole, cents } = splitMoney(totals.equityCents, currency);
  const navUp = totals.units === 0n || formatSinceInception(totals).startsWith("+");
  return (
    <>
      <Eyebrow>
        Account equity · derived from {entryCount} ledger{" "}
        {entryCount === 1 ? "entry" : "entries"} ·{" "}
        {asOf === null ? "no reading posted yet" : `as of ${formatDate(asOf)}`}
      </Eyebrow>
      <div className="erow">
        <p className="equity num" aria-label="Account equity" style={{ margin: "8px 0 0" }}>
          {whole}
          <span className="cents">.{cents}</span>
        </p>
        <div className="navbox" style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <LabelledFigure label="NAV / unit">{formatNav(totals)}</LabelledFigure>
          <LabelledFigure label="Since inception">
            <span className={navUp ? "pos" : "neg"}>{formatSinceInception(totals)}</span>
          </LabelledFigure>
          <LabelledFigure label="Units issued">{formatUnitsDp(totals.units)}</LabelledFigure>
          <LabelledFigure label="Holders">{holderCount}</LabelledFigure>
        </div>
      </div>
      {live === null ? null : (
        // A div, not a p: LabelledFigure's root is a div, and a div is not
        // valid inside a p. React only warns about this in the browser (see
        // "In HTML, <div> cannot be a descendant of <p>" in react-dom's dev
        // console) rather than failing a test, so nothing here would have
        // caught it without reading the console output from a real render —
        // exactly the kind of defect `pnpm test` can pass around.
        <div style={{ margin: "14px 0 0", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <LiveChip pushedAt={live.pushedAt} />
          <LabelledFigure
            label="Live equity"
            className=""
            labelClassName="eyebrow"
            valueClassName="num"
          >
            {splitMoney(live.equityCents, currency).whole}.
            {splitMoney(live.equityCents, currency).cents}
          </LabelledFigure>
          <LabelledFigure
            label="Floating P/L"
            className=""
            labelClassName="eyebrow"
            valueClassName="num"
          >
            <DeltaMoney cents={live.floatingPnlCents} currency={currency} />
          </LabelledFigure>
        </div>
      )}
    </>
  );
}

export interface KpiItem {
  key: string;
  label: string;
  value: ReactNode;
  /** `fee` paints the tile amber. Reserved for the fee, per spec section 8.2. */
  tone?: "fee";
}

export function KpiStrip({ items }: { items: KpiItem[] }) {
  return (
    <div className="kpi">
      {items.map((i) => (
        <LabelledFigure
          key={i.key}
          label={i.label}
          className={i.tone === "fee" ? "kpi-item is-fee" : "kpi-item"}
        >
          {i.value}
        </LabelledFigure>
      ))}
    </div>
  );
}
