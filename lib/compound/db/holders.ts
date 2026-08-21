/**
 * Holder identity and terms.
 *
 * getHolderSeeds (plan 3) returns what fold needs and nothing else, on purpose:
 * it must not be able to disagree with the engine. This reader returns what a
 * SCREEN needs — names, contact, joined date, the stored status.
 *
 * The stored status is returned and never used to decide anything. fold derives
 * a holder's status from the ledger, and a stored column that can drift from a
 * derived one is exactly the second truth D7 exists to avoid. See decision D-M.
 */
import type { Queryable } from "./types";
import { dateKeyExpr, toId } from "./sql";

export interface HolderRow {
  id: number;
  accountId: number;
  name: string;
  email: string | null;
  /** public.users id, set when portal access lands in v2. */
  userId: string | null;
  isManager: boolean;
  splitBps: number;
  /** YYYY-MM-DD, or null. */
  joinedAt: string | null;
  /** STORED. Never read to decide anything — fold decides. See decision D-M. */
  status: "active" | "closed";
}

interface Row {
  id: string;
  account_id: string;
  name: string;
  email: string | null;
  user_id: string | null;
  is_manager: boolean;
  split_bps: number;
  joined_at: string | null;
  status: string;
}

export async function listHolders(c: Queryable, accountId: number): Promise<HolderRow[]> {
  const { rows } = await c.query<Row>(
    `select id, account_id, name, email, user_id, is_manager, split_bps,
            ${dateKeyExpr("joined_at")} as joined_at, status
       from public.compound_holder
      where account_id = $1
      order by is_manager desc, id asc`,
    [accountId],
  );
  return rows.map((r) => {
    if (r.status !== "active" && r.status !== "closed") {
      throw new Error(`compound_holder.status is ${JSON.stringify(r.status)} for holder ${r.id}`);
    }
    return {
      id: toId(r.id, "compound_holder.id"),
      accountId: toId(r.account_id, "compound_holder.account_id"),
      name: r.name,
      email: r.email,
      userId: r.user_id,
      isManager: r.is_manager,
      splitBps: r.split_bps,
      joinedAt: r.joined_at,
      status: r.status,
    };
  });
}
