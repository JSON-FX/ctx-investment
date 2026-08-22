/**
 * The account shell's landmark structure: the <main> every route's content
 * renders into, and the skip link that reaches it without tabbing through
 * the masthead first.
 *
 * A Server Component, like everything else in this file's family — no state,
 * nothing route-dependent. It lives under lib/compound/ui rather than in
 * app/a/[id]/layout.tsx itself so the "ui" Jest project can render it:
 * jest.config.mjs's roots are lib/ and lib/compound/ui/ only, and app/ is
 * outside both, unreachable by `pnpm test` no matter what the file contains.
 * layout.tsx (app/) composes this component; this component is where the
 * actual markup — and its test coverage — lives.
 *
 * ACCOUNT_MAIN_ID is exported rather than the two components each hard-coding
 * "account-main" separately, so SkipToContent's href and AccountMain's id
 * cannot drift apart from each other one string literal at a time.
 */
import type { ReactNode } from "react";

export const ACCOUNT_MAIN_ID = "account-main";

/**
 * The masthead and the six-link sub-nav repeat, identically, above every
 * route's content — a keyboard user re-tabs through both, every navigation,
 * on every one of these routes, before reaching anything that changed. This
 * is the standard bypass-blocks pattern: an off-screen link that is the
 * first focusable element on the page and becomes visible the moment it has
 * focus, so a sighted keyboard user can see where Enter is about to send
 * them.
 *
 * tabIndex={-1} on AccountMain's <main> (not on this link) is what makes the
 * jump land: without it, activating an in-page #hash link scrolls the
 * viewport but leaves focus behind on the link itself, so a screen reader
 * keeps announcing the masthead as "next" instead of the content that just
 * scrolled into view.
 */
export function SkipToContent() {
  return (
    <a className="skip-link" href={`#${ACCOUNT_MAIN_ID}`}>
      Skip to content
    </a>
  );
}

export function AccountMain({ children }: { children: ReactNode }) {
  return (
    <main id={ACCOUNT_MAIN_ID} tabIndex={-1}>
      {children}
    </main>
  );
}
