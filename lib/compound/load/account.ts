/**
 * Resolving a route parameter to an account the signed-in manager owns.
 *
 * notFound() rather than a 403 for an account someone does not own: a 403
 * confirms the account exists, and under D5 there will be more than one
 * manager's account in this database eventually.
 *
 * Wrapped in cache() so the layout and the page inside it resolve the same
 * account with one query. Plan 5's three surfaces call this too.
 */
import { cache } from "react";
import { notFound } from "next/navigation";
import type { Queryable } from "@/lib/compound/db/types";
import { withDb } from "@/lib/compound/db/client";
import { getAccountById, listAccountsForManager } from "@/lib/compound/db/compound";
import { requireManager } from "./session";

export interface ResolvedAccount {
  id: number;
  mt5Account: number;
  label: string;
  broker: string | null;
  currency: string;
  defaultSplitBps: number;
  inceptionDate: string;
  managerUserId: string;
  /** Null means not configured. Reconciliation refuses while it is null. */
  brokerOffsetHours: number | null;
}

export const listManagerAccounts = cache(async (): Promise<ResolvedAccount[]> => {
  const user = await requireManager();
  return withDb((c) => listAccountsForManager(c, user.id));
});

/**
 * The ownership half of spec section 9's AND gate, as a pure-ish function of
 * (connection, user, parameter) so it can be tested with two managers.
 *
 * requireAccount below calls requireManager first, so by the time this runs
 * the caller has already cleared the role half (session.ts's resolveIsAdmin).
 * This function only ever sees the ownership question — does THIS admin own
 * THIS account — which is the question a one-account fixture cannot put to
 * the test (see gate.db.test.ts).
 */
export async function resolveOwnedAccount(
  c: Queryable,
  managerUserId: string,
  idParam: string,
): Promise<ResolvedAccount | null> {
  // Reject anything that is not a plain positive integer before it reaches
  // SQL. "7abc" parses to 7 under parseInt and would resolve someone's account.
  if (!/^[1-9][0-9]{0,17}$/.test(idParam)) return null;
  const account = await getAccountById(c, Number(idParam));
  if (account === null) return null;
  if (account.managerUserId !== managerUserId) return null;
  return account;
}

export const requireAccount = cache(async (idParam: string): Promise<ResolvedAccount> => {
  const user = await requireManager();
  const account = await withDb((c) => resolveOwnedAccount(c, user.id, idParam));
  if (account === null) notFound();
  return account;
});
