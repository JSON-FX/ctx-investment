/**
 * Recording a deposit.
 *
 * The amount crosses the boundary as a DECIMAL STRING. JSON.stringify throws on
 * a bigint, and a JSON number above 2^53 is not the number you sent. pg's
 * parameter binding takes the string and Postgres casts it to bigint exactly.
 *
 * This writer stores the amount that was deposited — an INPUT. It does not
 * compute or store how many units that bought: engine/replay.ts's fold()
 * derives that by replaying, at whatever NAV is prevailing when the entry is
 * folded, which is what keeps a deposit from being able to disagree with the
 * engine after any change to it (section 6.1).
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

export interface CommitDepositResult {
  ledgerEntryId: number;
  seq: number;
}

export async function commitDeposit(
  c: Queryable,
  input: CommitDepositInput,
): Promise<CommitDepositResult> {
  if (input.amountCents <= 0n) {
    throw new RangeError(`a deposit must be positive, got ${input.amountCents}`);
  }
  const { rows } = await c.query<{ result: { ledger_entry_id: string; seq: string } }>(
    `select public.compound_commit_deposit($1,$2,$3::date,$4::bigint,$5,$6::uuid) as result`,
    [input.accountId, input.holderId, input.occurredOn,
     input.amountCents.toString(), input.note ?? "", input.actorUserId],
  );
  const raw = rows[0]?.result;
  if (!raw) throw new Error("compound_commit_deposit returned no row");
  return {
    ledgerEntryId: toId(raw.ledger_entry_id, "compound_commit_deposit.ledger_entry_id"),
    seq: toId(raw.seq, "compound_commit_deposit.seq"),
  };
}
