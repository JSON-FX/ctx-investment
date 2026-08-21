/**
 * The smallest pieces. Three money components rather than one with a `tone`
 * prop, because spec section 8.2 gives three colours three meanings and a
 * single component with a switch invites a fourth.
 *
 *   Money       plain figure, --ink
 *   DeltaMoney  P/L direction, --gain or --loss, always signed
 *   FeeMoney    the fee, --fee-ink
 *
 * Amber never sets type: --fee is 2.15:1 on white. FeeMoney uses --fee-ink at
 * 5.02:1. The amber itself appears as fills and chips only.
 *
 * Every figure-bearing primitive here renders a plain string built by
 * present/format.ts — never a bigint, never a Number derived from one. That
 * is what keeps a figure on screen unable to disagree with the ledger it
 * came from.
 */
import type { ReactNode } from "react";
import type { Cents, Units } from "@/lib/compound/engine/money";
import {
  formatMoney, formatPpm, formatUnitsDp, signOf,
} from "@/lib/compound/present/format";

let seq = 0;
/** Stable within a render pass; only ever used to tie a label to its value. */
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export function Panel({ children, flush = false }: { children: ReactNode; flush?: boolean }) {
  return <section className={flush ? "panel flush" : "panel"}>{children}</section>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="eyebrow">{children}</span>;
}

export function Money({ cents, currency = "USD" }: { cents: Cents; currency?: string }) {
  return <span className="num">{formatMoney(cents, { currency })}</span>;
}

export function DeltaMoney({ cents, currency = "USD" }: { cents: Cents; currency?: string }) {
  const sign = signOf(cents);
  return (
    <span className={`num ${sign === "neg" ? "neg" : sign === "pos" ? "pos" : ""}`.trim()}>
      {formatMoney(cents, { currency, sign: "always" })}
    </span>
  );
}

export function FeeMoney({
  cents, currency = "USD", zeroAs = "figure",
}: { cents: Cents; currency?: string; zeroAs?: "figure" | "dash" }) {
  if (cents === 0n && zeroAs === "dash") return <span className="num">—</span>;
  return <span className="num fee">{formatMoney(cents, { currency })}</span>;
}

export function UnitCount({ units, dp = 4 }: { units: Units; dp?: number }) {
  return (
    <span className="num">
      {formatUnitsDp(units, dp)}
      <span className="muted"> units</span>
    </span>
  );
}

export function Share({ ppm }: { ppm: number }) {
  return <span className="num">{formatPpm(ppm)}</span>;
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>;
}

export function Chip({ children, tone }: { children: ReactNode; tone?: "live" | "fee" }) {
  return (
    <span className={`chip${tone ? ` is-${tone}` : ""}`}>{children}</span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div style={{ padding: "36px 20px", textAlign: "center" }}>
      <p style={{ margin: "0 0 6px", fontFamily: "var(--serif)", fontSize: 20 }}>{title}</p>
      {children ? <p className="muted" style={{ margin: 0, fontSize: 13 }}>{children}</p> : null}
    </div>
  );
}

/**
 * A label and its figure, tied by aria-labelledby.
 *
 * aria-labelledby NAMES the value element without replacing its contents, so a
 * screen reader announces "Fee if everyone paid out today, $1,409.67" and a
 * test can ask for the figure by the label a reader would use. aria-label
 * would suppress the number, which is the opposite of what is wanted.
 */
export function LabelledFigure({
  label, children, className = "", labelClassName = "k", valueClassName = "v num",
}: {
  label: string;
  children: ReactNode;
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
}) {
  const id = nextId("lf");
  return (
    <div className={className}>
      <span className={labelClassName} id={id}>{label}</span>
      <span className={valueClassName} aria-labelledby={id}>{children}</span>
    </div>
  );
}
