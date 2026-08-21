/**
 * Turning a refusal into a sentence a manager can act on.
 *
 * Every writer in this product raises a custom SQLSTATE rather than letting a
 * constraint name reach a screen. A refusal that says "23514" tells the reader
 * nothing; a refusal that says which rule fired and what to do about it is the
 * difference between a safety mechanism and an obstacle.
 *
 * Codes are allocated in blocks so a stray one is obviously unhandled. This
 * file is the single MESSAGES table for the whole product — Tasks 12-14 do
 * not edit it (they write SQL that raises these codes; this file is the only
 * place the sentence lives). Reserved blocks, confirmed against the plan and
 * the actual migrations/SQL text as written on 2026-08-21:
 *
 *   CX0xx  the reading writer and the ledger's structural guards (plan 3)
 *          CX001-005 commit_reading_plan; CX010 append-only trigger.
 *   CX1xx  accounts and holders (Task 6, merged; Task 12)
 *          CX101 compound_create_account (already live); CX102 documented
 *          for compound_add_holder but not raised by the version of that
 *          function this plan read — is_manager is hard-coded false there,
 *          so the second-manager path it would guard has no way in. Left in
 *          this table because a reserved code costs nothing and the function
 *          may yet grow the check its own doc comment promises.
 *   CX2xx  capital events: deposits, payouts and classification
 *          (Tasks 12-14). CX201/CX202 are carried over from this task's own
 *          draft (no units to pay out; below high-water mark) but neither
 *          appears in compound_commit_payout's actual SQLSTATE list as
 *          written — that suggests they are meant to be checked in
 *          application code before a payout sheet ever submits, not raised
 *          by the writer. Kept here, inert, in case Task 13 ships them as
 *          SQLSTATEs after all. CX206-CX211 are transcribed from the
 *          deposit, payout and classify writers as those tasks' own plan
 *          sections specify them; CX203/CX204/CX205/CX208 are deliberately
 *          reused across Tasks 12-14 for the same underlying refusal
 *          (not-pending / stale seq / no such holder / bad enum value)
 *          rather than re-allocated per task.
 */
const MESSAGES: Record<string, string> = {
  // CX0xx — the reading writer (compound_commit_reading_plan) and the
  // ledger's own append-only guard.
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
  CX010:
    "Ledger entries can't be edited or deleted once posted. To correct a mistake, " +
    "record a reversing entry instead of changing history.",

  // CX1xx — accounts and holders.
  CX101: "That MT5 account already has a Compound account.",
  CX102: "That account already has a manager. There can only be one.",

  // CX2xx — capital events: deposits (Task 12), payouts (Task 13),
  // classification (Task 14).
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
  CX205: "That holder is not on this account.",
  CX206: "A deposit must be a positive amount.",
  CX207: "Settlement equity must be a positive amount.",
  CX208: "That is not a valid choice for this form. Nothing was committed.",
  CX209:
    "Marking this \"not a capital event\" needs a note — it's the only record of " +
    "why the balance moved and nobody is going to remember by the time it matters.",
  CX210: "That entry does not belong to this account.",
  CX211: "A deposit needs a positive amount.",
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
