/**
 * Committing a partial withdrawal (P6). Money crosses as decimal strings; see
 * write-deposit.ts.
 *
 * Client-side mirrors of the two checks compound_commit_withdrawal makes
 * before touching a row, so a caller gets a plain RangeError — same as every
 * other validation-shaped refusal in engine/ and db/ (write-classify.ts's
 * classifyCandidate is the closest precedent) — instead of a round trip that
 * was always going to fail. The database re-checks both, with its own CX
 * code: this is a fast local refusal, not the authority.
 */
import type { Cents } from "@/lib/compound/engine/money";
import type { Queryable } from "./types";
import { toId } from "./sql";

export interface CommitWithdrawalInput {
  accountId: number;
  holderId: number;
  /** YYYY-MM-DD, broker-server date. */
  occurredOn: string;
  /** The exact equity this withdrawal settles against. Written as a reading. */
  settlementEquityCents: Cents;
  /** The amount requested, A. What quote() computed toHolderCents etc. from. */
  amountCents: Cents;
  /**
   * The cap — valueOfUnits(totals, holderUnits), floored, from the SAME
   * fold() that produced expectedSeq. Not re-derived here or in the
   * database; see the migration's header for why that is deliberate.
   */
  holderValueCents: Cents;
  feeSettlement: "units" | "cash";
  splitBpsApplied: number;
  /** max(seq) at the moment the receipt was rendered. */
  expectedSeq: number;
  note: string | null;
  actorUserId: string;
}

export async function commitWithdrawal(
  c: Queryable,
  input: CommitWithdrawalInput,
): Promise<{ readingEntryId: number; withdrawalEntryId: number; seq: number }> {
  if (input.amountCents <= 0n) {
    throw new RangeError(`withdrawal amount must be positive, got ${input.amountCents}`);
  }
  if (input.amountCents > input.holderValueCents) {
    throw new RangeError(
      `withdrawal amount ${input.amountCents} exceeds the holder's value of ` +
        `${input.holderValueCents} cents`,
    );
  }
  if (!Number.isInteger(input.splitBpsApplied) ||
      input.splitBpsApplied < 0 || input.splitBpsApplied > 10_000) {
    throw new RangeError(`splitBpsApplied must be an integer 0..10000, got ${input.splitBpsApplied}`);
  }
  if (input.settlementEquityCents <= 0n) {
    throw new RangeError(`settlement equity must be positive, got ${input.settlementEquityCents}`);
  }
  const { rows } = await c.query<{
    result: { reading_entry_id: string; withdrawal_entry_id: string; seq: string };
  }>(
    `select public.compound_commit_withdrawal(
       $1,$2,$3::date,$4::bigint,$5::bigint,$6::bigint,$7,$8,$9::bigint,$10,$11::uuid) as result`,
    [
      input.accountId, input.holderId, input.occurredOn,
      input.settlementEquityCents.toString(), input.amountCents.toString(),
      input.holderValueCents.toString(), input.feeSettlement,
      input.splitBpsApplied, String(input.expectedSeq),
      input.note ?? "", input.actorUserId,
    ],
  );
  const r = rows[0]!.result;
  return {
    readingEntryId: toId(r.reading_entry_id, "compound_commit_withdrawal.reading_entry_id"),
    withdrawalEntryId: toId(r.withdrawal_entry_id, "compound_commit_withdrawal.withdrawal_entry_id"),
    seq: toId(r.seq, "compound_commit_withdrawal.seq"),
  };
}
