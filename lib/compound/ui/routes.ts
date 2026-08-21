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
 * Compares path SEGMENTS, not a string prefix. The plan's first draft used
 * `pathname.startsWith(`/a/${accountId}`)`, which is true for
 * `"/a/71/ledger".startsWith("/a/7")` — account 71's ledger page would have
 * highlighted account 7's tab. Splitting into segments and comparing the
 * account-id segment exactly is what keeps /a/71 and /a/7 apart.
 */
export function activeNavKey(pathname: string, accountId: number): string {
  const parts = pathname.split("/").filter((p) => p !== "");
  if (parts[0] !== "a" || parts[1] !== String(accountId)) return "";
  const first = parts[2] ?? "";
  if (first === "") return "desk";
  if (first === "holders" || first === "actions") return "desk";
  return SUBNAV.some((n) => n.key === first) ? first : "";
}
