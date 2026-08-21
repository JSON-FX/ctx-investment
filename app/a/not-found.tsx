/**
 * What requireAccount's notFound() actually renders.
 *
 * Lives here, one segment ABOVE app/a/[id]/, not inside it — verified against
 * a real run, not by inspection. requireAccount is called from
 * app/a/[id]/layout.tsx itself, before that layout ever renders `children`.
 * Next.js's not-found boundary for a segment wraps that segment's `children`
 * slot, not the layout's own execution (see the App Router source:
 * HTTPAccessFallbackErrorBoundary re-throws to the parent when the segment
 * that threw has no matching boundary of its own). A layout that throws
 * notFound() during its own render is therefore caught by the PARENT
 * segment's not-found.tsx, not a sibling one at app/a/[id]/not-found.tsx.
 *
 * Confirmed by probe: with only app/a/[id]/not-found.tsx present, visiting an
 * unowned or nonexistent account id rendered Next's generic built-in 404, not
 * this message. Moving the file here made it render. See
 * app/a/[id]/not-found.tsx's module doc for the other half of this.
 *
 * It says the same thing for an account that does not exist and for one
 * belonging to another manager, deliberately: a distinct message for the
 * second confirms the account exists, which is the thing the gate is
 * refusing to confirm.
 */
export default function AccountNotFound() {
  return (
    <div className="wrap">
      <header className="mast">
        <div>
          <a href="/" style={{ color: "inherit", textDecoration: "none" }}>
            <span className="mark">Compound</span>
          </a>
          <span className="sub">Investor Desk</span>
        </div>
      </header>
      <section className="panel">
        <p style={{ fontFamily: "var(--serif)", fontSize: 20, margin: "0 0 6px" }}>
          No such account
        </p>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          That account does not exist, or it is not one of yours.{" "}
          <a href="/">Back to your accounts</a>.
        </p>
      </section>
    </div>
  );
}
