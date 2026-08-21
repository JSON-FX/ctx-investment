/**
 * The frame every money flow renders in. A route, not an overlay (decision
 * D-B): no parallel routes, no interception, no client state. A half-finished
 * flow is a URL that can be reopened, and the back button does what it looks
 * like it does.
 */
import type { ReactNode } from "react";

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

export function Field({
  name, label, hint, children,
}: { name: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field" htmlFor={name}>
      <span>{label}</span>
      {children}
      {hint ? <small className="muted" style={{ display: "block", marginTop: 4 }}>{hint}</small> : null}
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
