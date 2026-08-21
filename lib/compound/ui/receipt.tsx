/**
 * A receipt: label on the left, figure on the right, one line per fact, and a
 * total that is visually distinct from every line above it.
 *
 * Every line carries a sub-label slot. The payout receipt uses it to say what
 * an accounting term means in plain words — "What Ada has put in" with "her
 * high-water mark: profit is measured against this" underneath — because the
 * person who reads this back in a dispute is not an accountant.
 *
 * Every figure a receipt renders is passed in as already-formatted content
 * (a Money/DeltaMoney/FeeMoney primitive, or a plain string) — this module
 * only wires a label to its value with aria-labelledby. It does not format or
 * compute anything itself.
 */
import type { ReactNode } from "react";

export function Receipt({ children, label }: { children: ReactNode; label: string }) {
  return (
    <dl className="receipt" aria-label={label}>
      {children}
    </dl>
  );
}

export function ReceiptLine({
  label, hint, children, tone,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  /** `fee` paints the line amber. Reserved for the fee. */
  tone?: "fee";
}) {
  const id = `rl-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  return (
    <div className={tone === "fee" ? "receipt-line is-fee" : "receipt-line"}>
      <dt className="l" id={id}>
        {label}
        {hint ? <small>{hint}</small> : null}
      </dt>
      <dd className="r" aria-labelledby={id} style={{ margin: 0 }}>{children}</dd>
    </div>
  );
}

export function ReceiptTotal({
  label, hint, children,
}: { label: string; hint?: ReactNode; children: ReactNode }) {
  const id = `rt-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  return (
    <div className="receipt-line receipt-total">
      <dt className="l" id={id}>
        {label}
        {hint ? <small>{hint}</small> : null}
      </dt>
      <dd className="r" aria-labelledby={id} style={{ margin: 0 }}>{children}</dd>
    </div>
  );
}
