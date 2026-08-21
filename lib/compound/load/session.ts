/**
 * Who is asking, and may they use this product at all.
 *
 * Spec section 9: "The admin claim is an AND gate, not an OR bypass." Every
 * compound_* policy requires the admin claim AND a manager_user_id match. This
 * module is the first half — the role. account.ts's resolveOwnedAccount is
 * the second.
 *
 * WHY THIS IS IN APPLICATION CODE. Plan 3's decision P4 runs every pooled
 * connection as service_role, which has BYPASSRLS. The policies plan 3 wrote
 * are real and protect any other client of the database, and they do NOT run
 * for these pages. A gate that relies on them would pass every test whether it
 * was right or not, which is the defect class this project has now hit eleven
 * times.
 *
 * getUser, not getSession: getSession decodes the cookie and believes it;
 * getUser validates the token against the Auth server.
 */
import { cache } from "react";
import { redirect } from "next/navigation";
import { withDb } from "@/lib/compound/db/client";
import { getUserRole } from "@/lib/compound/db/users";
import { authClient } from "./supabase";

export interface SessionUser {
  id: string;
  email: string | null;
}

/**
 * The role half of spec section 9's AND gate: does this identity carry the
 * admin claim?
 *
 * Extracted as a pure function of the two role sources — the JWT
 * app_metadata claim the RLS policies actually read, and the public.users row
 * kept as a cross-check — so it is testable without a live Supabase session.
 * requireManager below is the thin wrapper that supplies both from a real
 * request; resolveOwnedAccount in account.ts is the ownership half, extracted
 * the same way and for the same reason.
 *
 * The claim is authoritative because the policies read it, even though those
 * policies do not run for these pages (see the module doc above). The stored
 * role is consulted only to catch the one misconfiguration that is otherwise
 * silent: under D1 there is one admin, so the two sources can only disagree by
 * accident, which is exactly when this should throw instead of silently
 * picking one of them.
 */
export function resolveIsAdmin(claimedRole: string | null, storedRole: string | null): boolean {
  if (claimedRole !== null && storedRole !== null && claimedRole !== storedRole) {
    throw new Error(
      `Role mismatch: JWT app_metadata.role is ${claimedRole}, public.users.role is ` +
        `${storedRole}. Compound will not run against a directory whose two role ` +
        `sources disagree.`,
    );
  }
  return (claimedRole ?? storedRole) === "admin";
}

export const requireManager = cache(async (): Promise<SessionUser> => {
  const supabase = await authClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) redirect("/sign-in");

  const claim = (data.user.app_metadata as { role?: unknown } | null)?.role;
  const claimed = typeof claim === "string" ? claim : null;
  const stored = await withDb((c) => getUserRole(c, data.user!.id));

  if (!resolveIsAdmin(claimed, stored)) redirect("/sign-in?denied=1");

  return { id: data.user.id, email: data.user.email ?? null };
});
