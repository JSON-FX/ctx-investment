/**
 * Committing a payout. Money crosses as decimal strings; see write-deposit.ts.
 */
import type { Cents } from "@/lib/compound/engine/money";
import type { Queryable } from "./types";
import { toId } from "./sql";

export interface CommitPayoutInput {
  accountId: number;
  holderId: number;
  /** YYYY-MM-DD, broker-server date. */
  occurredOn: string;
  /** The exact equity this payout settles against. Written as a reading. */
  settlementEquityCents: Cents;
  mode: "payout" | "exit";
  feeSettlement: "units" | "cash";
  splitBpsApplied: number;
  /** What quote() computed. Recorded, never re-read by fold. */
  grossCents: Cents;
  /** max(seq) at the moment the receipt was rendered. */
  expectedSeq: number;
  note: string | null;
  actorUserId: string;
}

export async function commitPayout(
  c: Queryable,
  input: CommitPayoutInput,
): Promise<{ readingEntryId: number; payoutEntryId: number; seq: number }> {
  if (!Number.isInteger(input.splitBpsApplied) ||
      input.splitBpsApplied < 0 || input.splitBpsApplied > 10_000) {
    throw new RangeError(`splitBpsApplied must be an integer 0..10000, got ${input.splitBpsApplied}`);
  }
  if (input.settlementEquityCents <= 0n) {
    throw new RangeError(`settlement equity must be positive, got ${input.settlementEquityCents}`);
  }
  const { rows } = await c.query<{
    result: { reading_entry_id: string; payout_entry_id: string; seq: string };
  }>(
    `select public.compound_commit_payout(
       $1,$2,$3::date,$4::bigint,$5,$6,$7,$8::bigint,$9::bigint,$10,$11::uuid) as result`,
    [
      input.accountId, input.holderId, input.occurredOn,
      input.settlementEquityCents.toString(), input.mode, input.feeSettlement,
      input.splitBpsApplied, input.grossCents.toString(), String(input.expectedSeq),
      input.note ?? "", input.actorUserId,
    ],
  );
  const r = rows[0]!.result;
  return {
    readingEntryId: toId(r.reading_entry_id, "compound_commit_payout.reading_entry_id"),
    payoutEntryId: toId(r.payout_entry_id, "compound_commit_payout.payout_entry_id"),
    seq: toId(r.seq, "compound_commit_payout.seq"),
  };
}
