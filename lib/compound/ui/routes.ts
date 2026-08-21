/**
 * Every route in the account shell, in one place, so plan 5's three surfaces
 * and this plan's five appear in the same nav without either side hard-coding
 * the other's paths.
 *
 * Order is agreed with plan 5: Desk, then the three trading surfaces, then the
 * two accounting ones. There is no Holders entry — spec section 7 has no
 * holder index route and the desk's holder table is the index.
 */
export const deskHref = (accountId: number) => `/a/${accountId}`;
export const ledgerHref = (accountId: number) => `/a/${accountId}/ledger`;
export const reviewHref = (accountId: number) => `/a/${accountId}/review`;
export const holderHref = (accountId: number, holderId: number) =>
  `/a/${accountId}/holders/${holderId}`;
export const journalHref = (accountId: number) => `/a/${accountId}/journal`;
export const calendarHref = (accountId: number) => `/a/${accountId}/calendar`;
export const performanceHref = (accountId: number) => `/a/${accountId}/performance`;

export const readingHref = (accountId: number) => `/a/${accountId}/actions/reading`;
export const investorHref = (accountId: number) => `/a/${accountId}/actions/investor`;
export const capitalHref = (accountId: number) => `/a/${accountId}/actions/capital`;
export const payoutHref = (accountId: number, holderId: number) =>
  `/a/${accountId}/actions/payout/${holderId}`;
export const withdrawHref = (accountId: number, holderId: number) =>
  `/a/${accountId}/actions/withdraw/${holderId}`;
export const classifyHref = (accountId: number, candidateId: number) =>
  `/a/${accountId}/review/${candidateId}`;

export interface NavEntry {
  key: string;
  label: string;
  href: (accountId: number) => string;
  /** Only Review carries one. */
  badge?: "pending";
}

export const SUBNAV: NavEntry[] = [
  { key: "desk", label: "Desk", href: deskHref },
  { key: "journal", label: "Journal", href: journalHref },
  { key: "calendar", label: "Calendar", href: calendarHref },
  { key: "performance", label: "Performance", href: performanceHref },
  { key: "ledger", label: "Ledger", href: ledgerHref },
  { key: "review", label: "Review", href: reviewHref, badge: "pending" },
];

/**
 * Which nav entry a pathname belongs to.
 *
 * A holder statement and an action sheet both belong to "desk", because that
 * is where the reader came from and where Back should feel like it leads.
 *
 * Compares path SEGMENTS, not a string prefix. The plan's Step 1 draft used
 * `pathname.startsWith(`/a/${accountId}`)` and its own text claims that fails
 * the prefix-collision case — `"/a/71/ledger".startsWith("/a/7")` is `true`,
 * so it says `activeNavKey` returns `"ledger"` for account 7.
 *
 * That claim does not reproduce: probed by reverting to the startsWith
 * version and running routes.test.ts, all cases including the prefix
 * collision still passed. The plan's own reasoning stops at the startsWith
 * check and never traces the rest of the function — after stripping "/a/7",
 * "/a/71/ledger" leaves "1/ledger", and `"1/ledger".split("/")[0]` is "1",
 * not "ledger", which matches no SUBNAV key and correctly falls through to
 * "". Since every account id is all-digits and Next.js's `usePathname()`
 * always puts a literal "/" between the id segment and the next one, the
 * leftover fragment after a false-prefix match can never land mid-word, so
 * the startsWith version turns out to be safe for every reachable pathname,
 * not just the ones this file's tests happen to cover.
 *
 * Kept the segment comparison anyway: it is correct by direct inspection of
 * the id segment rather than by an invariant about the shape of SUBNAV's
 * keys (all-alphabetic, none digit-leading) continuing to hold, which is a
 * steadier property to depend on than a proof that has to be re-derived.
 */
export function activeNavKey(pathname: string, accountId: number): string {
  const parts = pathname.split("/").filter((p) => p !== "");
  if (parts[0] !== "a" || parts[1] !== String(accountId)) return "";
  const first = parts[2] ?? "";
  if (first === "") return "desk";
  if (first === "holders" || first === "actions") return "desk";
  return SUBNAV.some((n) => n.key === first) ? first : "";
}
