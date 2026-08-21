/**
 * Adding a holder. Terms only — no ledger entry, because joining and funding
 * are separate events and only the second one moves money.
 *
 * compound_holder stores no balance columns by design (section 6.1): units
 * and cost basis are derived by folding the ledger, never stored here. A
 * holder this function creates starts with no units and no value until a
 * deposit is recorded for them — that absence is not a special "zero" case,
 * it is what every holder looks like before their first deposit.
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

/**
 * Editing a holder's identity and terms: name, email, split_bps. No ledger
 * entry, same reason as addHolder — nothing here has an accounting
 * consequence of its own.
 *
 * status is deliberately absent: it is set only by compound_commit_payout on
 * a full exit (decision D-M), never by a direct edit. units and cost_basis
 * are not columns at all (section 6.1) — there is nothing here to touch.
 *
 * A change to splitBps affects only what a FUTURE quote() sees. Every
 * already-posted payout or exit carries its own splitBpsApplied, frozen at
 * the seq it was written, and compound_ledger_entry is INSERT/SELECT only —
 * this function has no way to reach backwards even if it wanted to.
 */
export interface UpdateHolderInput {
  accountId: number;
  holderId: number;
  name: string;
  email: string | null;
  splitBps: number;
  actorUserId: string;
}

export async function updateHolder(c: Queryable, input: UpdateHolderInput): Promise<void> {
  if (!Number.isInteger(input.splitBps) || input.splitBps < 0 || input.splitBps > 10_000) {
    throw new RangeError(`splitBps must be an integer 0..10000, got ${input.splitBps}`);
  }
  if (input.name.trim() === "") throw new RangeError("a holder needs a name");
  await c.query(
    `select public.compound_update_holder($1,$2,$3,$4,$5,$6::uuid)`,
    [input.accountId, input.holderId, input.name.trim(), input.email ?? "", input.splitBps,
     input.actorUserId],
  );
}
