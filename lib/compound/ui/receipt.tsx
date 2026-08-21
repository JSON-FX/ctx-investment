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
 *
 * The label and the hint are two different accessible relationships, not one
 * run-on string. `aria-labelledby` computes an element's name from the FULL
 * text content of whatever it points at — so if the hint's `<small>` sat
 * inside the same `<dt>` the label id points to, the value's accessible name
 * would concatenate them with no separator ("What Ada has put inher
 * high-water mark"), which is what an earlier draft of this file did and
 * receipt.test.tsx caught: `getByLabelText("What Ada has put in")` failed to
 * find the line at all, because that string was never the computed name of
 * anything once a hint was present. The label now lives in its own span,
 * referenced by `aria-labelledby`; the hint gets its own id and is wired in
 * with `aria-describedby`, so it stays available to a screen reader as
 * supplementary detail without corrupting the name.
 */
import type { ReactNode } from "react";

export function Receipt({ children, label }: { children: ReactNode; label: string }) {
  return (
    <dl className="receipt" aria-label={label}>
      {children}
    </dl>
  );
}

function slugId(prefix: string, label: string): string {
  return `${prefix}-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
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
  const id = slugId("rl", label);
  const hintId = hint === undefined || hint === null ? undefined : `${id}-hint`;
  return (
    <div className={tone === "fee" ? "receipt-line is-fee" : "receipt-line"}>
      <dt className="l">
        <span id={id}>{label}</span>
        {hintId ? <small id={hintId}>{hint}</small> : null}
      </dt>
      <dd className="r" aria-labelledby={id} aria-describedby={hintId} style={{ margin: 0 }}>
        {children}
      </dd>
    </div>
  );
}

export function ReceiptTotal({
  label, hint, children,
}: { label: string; hint?: ReactNode; children: ReactNode }) {
  const id = slugId("rt", label);
  const hintId = hint === undefined || hint === null ? undefined : `${id}-hint`;
  return (
    <div className="receipt-line receipt-total">
      <dt className="l">
        <span id={id}>{label}</span>
        {hintId ? <small id={hintId}>{hint}</small> : null}
      </dt>
      <dd className="r" aria-labelledby={id} aria-describedby={hintId} style={{ margin: 0 }}>
        {children}
      </dd>
    </div>
  );
}
