/**
 * Adding a holder. Terms only — no ledger entry, because joining and funding
 * are separate events and only the second one moves money.
 *
 * BOOTSTRAPPED FOR TASK 13: this file and its migration are plan 4's Task 12
 * deliverable (docs/superpowers/plans/2026-08-21-compound-desk.md, ~line
 * 7813). At the time Task 13 was built, `.worktrees/invest` (feat/desk-invest)
 * had no commits yet. Task 13's own db-test fixtures (write-payout.db.test.ts)
 * need a funded account, which needs a holder, so this is a verbatim
 * transcription of the plan's reference source used ONLY to unblock that
 * fixture — Task 13 does not otherwise touch holder creation. Reconcile with
 * whatever Task 12 actually ships once feat/desk-invest merges.
 */
import type { Queryable } from "./types";
import { toId } from "./sql";

export interface AddHolderInput {
  accountId: number;
  name: string;
  email: string | null;
  splitBps: number;
  /** YYYY-MM-DD. */
  joinedAt: string;
  actorUserId: string;
}

export async function addHolder(c: Queryable, input: AddHolderInput): Promise<number> {
  if (!Number.isInteger(input.splitBps) || input.splitBps < 0 || input.splitBps > 10_000) {
    throw new RangeError(`splitBps must be an integer 0..10000, got ${input.splitBps}`);
  }
  if (input.name.trim() === "") throw new RangeError("a holder needs a name");
  const { rows } = await c.query<{ id: string }>(
    `select public.compound_add_holder($1,$2,$3,$4,$5::date,$6::uuid) as id`,
    [input.accountId, input.name.trim(), input.email ?? "", input.splitBps,
     input.joinedAt, input.actorUserId],
  );
  return toId(rows[0]!.id, "compound_add_holder.id");
}
