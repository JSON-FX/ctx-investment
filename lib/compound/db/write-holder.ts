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
