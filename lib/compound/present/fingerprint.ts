/**
 * The freshness contract.
 *
 * A receipt is arithmetic against a pool at a known seq. Between rendering it
 * and confirming it, the reconciler may have posted readings, or a second tab
 * may have committed a deposit. Confirming then would write arithmetic the
 * manager never read — the figures would be right for a pool that no longer
 * exists.
 *
 * The fingerprint travels through hidden form fields as DECIMAL STRINGS. A
 * bigint does not survive JSON and a form field is text either way; parsing it
 * back with BigInt() is exact where Number() is not.
 *
 * BOOTSTRAPPED FOR TASK 13: this file is plan 4's Task 11 deliverable
 * (docs/superpowers/plans/2026-08-21-compound-desk.md, ~line 6974). At the
 * time Task 13 was built, `.worktrees/seam` (feat/desk-seam) had no commits
 * yet, so this is a verbatim transcription of the plan's reference source,
 * not an original design. Task 13's payout-sheet and payout action both
 * depend on this exact contract (see the CX204 test in
 * write-payout.db.test.ts). Reconcile with whatever Task 11 actually ships
 * once feat/desk-seam merges.
 */
import type { Fingerprint } from "./derive";

export function fingerprintToFields(f: Fingerprint): Record<string, string> {
  return {
    fpAccountId: String(f.accountId),
    fpSeq: String(f.seq),
    fpEquityCents: f.equityCents,
    fpUnits: f.units,
  };
}

const DECIMAL = /^-?[0-9]+$/;

export function fingerprintFromFields(
  get: (key: string) => string | null,
): Fingerprint | null {
  const accountId = get("fpAccountId");
  const seq = get("fpSeq");
  const equityCents = get("fpEquityCents");
  const units = get("fpUnits");
  if (accountId === null || seq === null || equityCents === null || units === null) return null;
  if (![accountId, seq, equityCents, units].every((v) => DECIMAL.test(v))) return null;
  return {
    accountId: Number(accountId),
    seq: Number(seq),
    equityCents,
    units,
  };
}

/**
 * Null when the receipt is still good; otherwise the sentence to show.
 *
 * All four fields are compared, not just seq. seq alone would miss the case
 * that matters most on a busy account: an entry written and then reversed
 * leaves seq higher and the pool identical, while a reversal of an OLD entry
 * leaves the pool different at a seq the reader might still recognise.
 */
export function fingerprintMismatch(
  shown: Fingerprint,
  current: Fingerprint,
): string | null {
  if (shown.accountId !== current.accountId) {
    return "That receipt belongs to a different account.";
  }
  if (
    shown.seq === current.seq &&
    shown.equityCents === current.equityCents &&
    shown.units === current.units
  ) {
    return null;
  }
  return (
    `The account moved while this was open — it was at entry ${shown.seq} when these ` +
    `figures were worked out and it is at entry ${current.seq} now. Nothing was ` +
    `committed. Close this and reopen it to see the current figures.`
  );
}
