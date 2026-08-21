/**
 * Turning a refusal into a sentence a manager can act on.
 *
 * Every writer in this product raises a custom SQLSTATE rather than letting a
 * constraint name reach a screen. A refusal that says "23514" tells the reader
 * nothing; a refusal that says which rule fired and what to do about it is the
 * difference between a safety mechanism and an obstacle.
 *
 * Codes are allocated in blocks so a stray one is obviously unhandled:
 *   CX0xx  the reading writer        (plan 3)
 *   CX1xx  accounts and holders      (this plan)
 *   CX2xx  capital and payouts       (this plan)
 *
 * BOOTSTRAPPED FOR TASK 13: this file is plan 4's Task 11 deliverable
 * (docs/superpowers/plans/2026-08-21-compound-desk.md, ~line 6914). At the
 * time Task 13 was built, `.worktrees/seam` (feat/desk-seam) had no commits
 * yet, so CX001-CX204 below are a verbatim transcription of the plan's
 * reference source. CX205-CX208 were ADDED here by Task 13 — they are new
 * SQLSTATEs raised by Task 13's own `compound_commit_payout` (CX205, CX207,
 * CX208) and by Task 12's `compound_commit_deposit`, which Task 13 also had
 * to bootstrap for its db-test fixtures (CX206, "a deposit must be
 * positive"). Task 13 messaged the Task 11 owner (agent a8cc92d71a7c0c6c6)
 * asking it to reserve these codes in its real errors.ts; this file is a
 * stand-in until that reply lands and feat/desk-seam actually merges.
 */
const MESSAGES: Record<string, string> = {
  CX001: "That account no longer exists.",
  CX002:
    "There is an unclassified capital event on or before that date. Classify it in " +
    "Review first — NAV must not cross a capital event nobody has explained.",
  CX003:
    "A reading has already been posted for that date or later. Readings only move " +
    "forward, and a correction is a reversing entry rather than an overwrite.",
  CX004:
    "The reading dates and the new cursor position disagree. Nothing was written. " +
    "Reload and try again.",
  CX005: "Those readings are not in ascending date order.",
  CX101: "That MT5 account already has a Compound account.",
  CX102: "That account already has a manager. There can only be one.",
  CX201:
    "That holder has no units to pay out. Add capital first, or check you picked " +
    "the right holder.",
  CX202:
    "That payout is below the holder's high-water mark, so there is no profit to " +
    "withdraw. A full exit is still available.",
  CX203: "That capital event has already been classified.",
  CX204:
    "The account moved while this was open, so the figures you read are no longer " +
    "the figures that would be written. Nothing was committed. Close this and reopen it.",
  // --- Added by Task 13 (payout) — see the bootstrap note above. ---
  CX205: "That holder is not on this account. Check you picked the right holder.",
  CX206: "A deposit must be a positive amount.",
  CX207:
    "Settlement equity must be a positive amount. Check the figure you entered — " +
    "an account cannot pay out against zero or negative equity.",
  CX208:
    "That withdrawal type or fee-settlement choice was not recognised. Nothing was " +
    "committed. Reload and try again.",
};

export function explainCommitError(e: unknown): string {
  const code = typeof e === "object" && e !== null && "code" in e
    ? String((e as { code: unknown }).code)
    : null;
  if (code !== null && code in MESSAGES) return MESSAGES[code]!;
  if (e instanceof RangeError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong and nothing was committed.";
}

/** True for Next's redirect/notFound control-flow throws, which must be re-thrown. */
export function isNextControlFlow(e: unknown): boolean {
  return typeof e === "object" && e !== null && "digest" in e &&
    typeof (e as { digest: unknown }).digest === "string" &&
    /^(NEXT_REDIRECT|NEXT_NOT_FOUND)/.test((e as { digest: string }).digest);
}
