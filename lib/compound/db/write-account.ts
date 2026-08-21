/**
 * The account writer. One call, one transaction, two rows.
 *
 * compound_create_account is a single plpgsql function body — one client
 * round trip is one Postgres statement, which is atomic by construction even
 * without an explicit BEGIN/COMMIT here. If the manager-holder insert fails,
 * Postgres unwinds the account insert that preceded it in the same function
 * invocation. See write-account.db.test.ts's "leaves no orphan account
 * behind" case for the proof.
 */
import type { Queryable } from "./types";
import { toId } from "./sql";

export interface CreateAccountInput {
  mt5Account: number;
  label: string;
  broker: string | null;
  currency: string;
  defaultSplitBps: number;
  /** YYYY-MM-DD. */
  inceptionDate: string;
  managerUserId: string;
  managerName: string;
  /** Null means not configured; reconciliation refuses while it is. */
  brokerOffsetHours: number | null;
}

export interface CreateAccountResult {
  accountId: number;
  managerHolderId: number;
}

interface RawResult {
  account_id: string;
  manager_holder_id: string;
}

export async function createAccount(
  c: Queryable,
  input: CreateAccountInput,
): Promise<CreateAccountResult> {
  if (!Number.isInteger(input.defaultSplitBps) ||
      input.defaultSplitBps < 0 || input.defaultSplitBps > 10_000) {
    throw new RangeError(`defaultSplitBps must be an integer 0..10000, got ${input.defaultSplitBps}`);
  }
  const { rows } = await c.query<{ result: RawResult }>(
    `select public.compound_create_account($1,$2,$3,$4,$5,$6::date,$7::uuid,$8,$9) as result`,
    [
      input.mt5Account, input.label, input.broker ?? "", input.currency,
      input.defaultSplitBps, input.inceptionDate, input.managerUserId,
      input.managerName, input.brokerOffsetHours,
    ],
  );
  // rows[0] is checked at runtime rather than asserted with `!`: a function
  // call that returns no row is a real, if unlikely, failure mode and
  // commit-plan.ts's own writer treats it the same way rather than trusting
  // the type checker over what the driver actually handed back.
  const raw = rows[0]?.result;
  if (!raw) throw new Error("compound_create_account returned no row");

  return {
    accountId: toId(raw.account_id, "compound_create_account.account_id"),
    managerHolderId: toId(raw.manager_holder_id, "compound_create_account.manager_holder_id"),
  };
}
