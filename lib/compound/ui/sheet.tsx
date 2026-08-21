/**
 * The frame every money flow renders in. A route, not an overlay (decision
 * D-B): no parallel routes, no interception, no client state. A half-finished
 * flow is a URL that can be reopened, and the back button does what it looks
 * like it does.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

export function Sheet({
  title, lede, children, backHref, backLabel = "Cancel",
}: {
  title: string;
  lede?: ReactNode;
  children: ReactNode;
  backHref: string;
  backLabel?: string;
}) {
  return (
    <div className="sheet-scrim">
      <div className="sheet">
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
        {children}
        <p style={{ marginTop: 22, marginBottom: 0 }}>
          <a href={backHref}>{backLabel}</a>
        </p>
      </div>
    </div>
  );
}

export function SheetActions({ children }: { children: ReactNode }) {
  return <div className="actions">{children}</div>;
}

/**
 * The control's accessible name is pinned with an explicit `aria-label`,
 * rather than left to the implicit "name from the wrapping <label>'s text
 * content" computation. That computation walks every text node inside the
 * <label> — including the hint's <small> — so a Field with a hint would
 * otherwise expose a control whose accessible name is the label and the hint
 * run together with no separator, and `getByLabelText("Date")` (the label
 * alone) would not find it. This is the same failure mode receipt.tsx's own
 * doc comment describes for `aria-labelledby` on a `<dt>` that also holds a
 * hint; the fix here is the input-side equivalent — `aria-label` takes
 * priority over "name from content" in the accessible-name algorithm, so it
 * wins regardless of what text the wrapping <label> contains.
 *
 * `aria-describedby` is wired the same way so the hint is still available to
 * assistive tech as a description, not lost by moving it out of the name.
 */
export function Field({
  name, label, hint, children,
}: { name: string; label: string; hint?: ReactNode; children: ReactNode }) {
  const hintId = hint === undefined || hint === null ? undefined : `${name}-hint`;
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<{ "aria-label"?: string; "aria-describedby"?: string }>, {
        "aria-label": label,
        "aria-describedby": hintId,
      })
    : children;
  return (
    <label className="field" htmlFor={name}>
      <span>{label}</span>
      {control}
      {hint ? <small id={hintId} className="muted" style={{ display: "block", marginTop: 4 }}>{hint}</small> : null}
    </label>
  );
}

export function FieldError({ children }: { children: ReactNode }) {
  return (
    <div className="field-error" role="alert">
      <strong>Nothing was committed.</strong> {children}
    </div>
  );
}
