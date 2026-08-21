/**
 * Recording a deposit.
 *
 * The amount crosses the boundary as a DECIMAL STRING. JSON.stringify throws on
 * a bigint, and a JSON number above 2^53 is not the number you sent. pg's
 * parameter binding takes the string and Postgres casts it to bigint exactly.
 *
 * BOOTSTRAPPED FOR TASK 13: this file and its migration are plan 4's Task 12
 * deliverable (docs/superpowers/plans/2026-08-21-compound-desk.md, ~line
 * 8001). At the time Task 13 was built, `.worktrees/invest` (feat/desk-invest)
 * had no commits yet. Task 13's own db-test fixtures (write-payout.db.test.ts)
 * need a funded account, so this is a verbatim transcription of the plan's
 * reference source used ONLY to unblock that fixture — Task 13 does not
 * otherwise touch deposits. Reconcile with whatever Task 12 actually ships
 * once feat/desk-invest merges.
 */
import type { Cents } from "@/lib/compound/engine/money";
import type { Queryable } from "./types";
import { toId } from "./sql";

export interface CommitDepositInput {
  accountId: number;
  holderId: number;
  /** YYYY-MM-DD, broker-server date. */
  occurredOn: string;
  amountCents: Cents;
  note: string | null;
  actorUserId: string;
}

export async function commitDeposit(
  c: Queryable,
  input: CommitDepositInput,
): Promise<{ ledgerEntryId: number; seq: number }> {
  if (input.amountCents <= 0n) {
    throw new RangeError(`a deposit must be positive, got ${input.amountCents}`);
  }
  const { rows } = await c.query<{ result: { ledger_entry_id: string; seq: string } }>(
    `select public.compound_commit_deposit($1,$2,$3::date,$4::bigint,$5,$6::uuid) as result`,
    [input.accountId, input.holderId, input.occurredOn,
     input.amountCents.toString(), input.note ?? "", input.actorUserId],
  );
  return {
    ledgerEntryId: toId(rows[0]!.result.ledger_entry_id, "compound_commit_deposit.ledger_entry_id"),
    seq: toId(rows[0]!.result.seq, "compound_commit_deposit.seq"),
  };
}
