/**
 * The application-level role, read once per request as a cross-check on the
 * JWT claim.
 *
 * Spec section 9's policies read the claim, so the claim is authoritative. This
 * reader exists to catch the one misconfiguration that is otherwise silent: a
 * user whose JWT says admin and whose public.users row does not, or the
 * reverse. Under D1 there is one admin and the two can only disagree by
 * accident — which is exactly when you want to hear about it.
 */
import type { Queryable } from "./types";

export async function getUserRole(c: Queryable, userId: string): Promise<string | null> {
  const { rows } = await c.query<{ role: string }>(
    `select role from public.users where id = $1`,
    [userId],
  );
  return rows[0]?.role ?? null;
}
