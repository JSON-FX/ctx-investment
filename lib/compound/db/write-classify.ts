/**
 * Classifying one capital-event candidate. The only way past the interlock.
 *
 * One SQL function call, matching commit-plan.ts's shape: a single round
 * trip is what makes the write atomic by construction rather than by
 * discipline. See the migration (compound_classify_candidate) for what the
 * three outcomes do and why the checks are ordered the way they are.
 *
 * Money crosses the boundary as strings. JSON — well, here just query
 * parameters — cannot carry a bigint, and a JS Number above 2^53 is not the
 * integer that was sent.
 */
import type { Cents } from "@/lib/compound/engine/money";
import type { Queryable } from "./types";
import { toId } from "./sql";

export type ClassifyOutcome = "deposit" | "match" | "ignore";

export interface ClassifyInput {
  accountId: number;
  candidateId: number;
  outcome: ClassifyOutcome;
  /** deposit only. */
  holderId: number | null;
  /** deposit only. */
  amountCents: Cents | null;
  /** match only. */
  matchEntryId: number | null;
  note: string | null;
  expectedSeq: number;
  actorUserId: string;
}

const CALL = `select public.compound_classify_candidate(
    $1, $2, $3, $4, $5::bigint, $6, $7, $8::bigint, $9::uuid) as result`;

interface RawResult {
  ledger_entry_id: string | null;
}

/**
 * Client-side mirrors of the two checks compound_classify_candidate makes
 * before touching a row, so a caller gets a plain RangeError — same as every
 * other validation-shaped refusal in engine/ and reconcile/ — instead of a
 * round trip that was always going to fail. The database re-checks both:
 * this is a fast local refusal, not the authority.
 */
export async function classifyCandidate(
  c: Queryable,
  input: ClassifyInput,
): Promise<{ ledgerEntryId: number | null }> {
  if (input.outcome === "deposit" && (input.amountCents === null || input.amountCents <= 0n)) {
    throw new RangeError(
      `a deposit classification needs a positive amount, got ${input.amountCents}`,
    );
  }
  if (input.outcome === "ignore" && (input.note ?? "").trim() === "") {
    throw new RangeError(
      'classifying a capital event as "not a capital event" requires a note',
    );
  }

  const { rows } = await c.query<{ result: RawResult }>(CALL, [
    input.accountId,
    input.candidateId,
    input.outcome,
    input.holderId,
    input.amountCents === null ? null : input.amountCents.toString(),
    input.matchEntryId,
    input.note ?? "",
    String(input.expectedSeq),
    input.actorUserId,
  ]);

  const raw = rows[0]?.result;
  if (!raw) throw new Error("compound_classify_candidate returned no row");

  return {
    ledgerEntryId: raw.ledger_entry_id === null
      ? null
      : toId(raw.ledger_entry_id, "compound_classify_candidate.ledger_entry_id"),
  };
}
