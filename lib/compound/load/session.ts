/**
 * Who is asking, and may they use this product at all.
 *
 * Spec section 9: "The admin claim is an AND gate, not an OR bypass." Every
 * compound_* policy requires the admin claim AND a manager_user_id match. This
 * module is the first half — the role. account.ts's resolveOwnedAccount is
 * the second.
 *
 * WHY THIS IS STILL IN APPLICATION CODE, EVEN THOUGH RLS NOW REALLY RUNS.
 * db/client.ts's withAuthenticatedDb (D-F, updated) runs every compound_*
 * query as `authenticated`, with real claims, so the 16 policies
 * compound_rls.sql defines are the actual boundary now, not a decorative one.
 * This function is still the application layer's own copy of the same gate,
 * for two reasons that have nothing to do with distrusting RLS: first, an
 * application still has to know WHO is asking before it can open a
 * connection as them — RLS cannot bootstrap the identity it is then asked to
 * check, this function is what resolves it. Second, defence in depth is the
 * deliberate posture (see the report this change shipped with): a gate that
 * relies on exactly one layer is one migration away from being the only
 * thing standing between two managers' money, the same defect class this
 * project has hit eleven times before.
 *
 * getUserRole reads public.users, one of the CopyTraderX-owned tables — see
 * db/client.ts's withElevatedCopyTraderXRead. That grant is service_role
 * only, regardless of RLS or claims, so this read cannot run on
 * withAuthenticatedDb no matter who is asking or what they claim.
 *
 * getUser, not getSession: getSession decodes the cookie and believes it;
 * getUser validates the token against the Auth server.
 */
import { cache } from "react";
import { redirect } from "next/navigation";
import { withElevatedCopyTraderXRead } from "@/lib/compound/db/client";
import { getUserRole } from "@/lib/compound/db/users";
import { authClient } from "./supabase";

export interface SessionUser {
  id: string;
  email: string | null;
}

/**
 * Where a request with no valid session lands — both the one requireManager
 * issues below and the one the sign-out action (app/a/[id]/layout.tsx)
 * issues after clearing the session. One constant, not two matching
 * strings, so "sign out, then the next request redirects to /sign-in" is
 * true by construction rather than by two literals someone could let drift.
 *
 * requireManager calls into a live Supabase session (next/headers cookies,
 * the Auth server) that does not exist in a Jest process — see this file's
 * own module doc and gate.db.test.ts's — so the redirect itself cannot be
 * exercised end to end here. This constant, and the real, unmocked
 * next/navigation redirect() call session.test.ts makes against it, are the
 * seam that stays testable: change where this points, or break what
 * redirect() does with it, and that test goes red.
 */
export const SIGN_IN_PATH = "/sign-in";

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
  if (error || !data.user) redirect(SIGN_IN_PATH);

  const claim = (data.user.app_metadata as { role?: unknown } | null)?.role;
  const claimed = typeof claim === "string" ? claim : null;
  const stored = await withElevatedCopyTraderXRead((c) => getUserRole(c, data.user!.id));

  if (!resolveIsAdmin(claimed, stored)) redirect(`${SIGN_IN_PATH}?denied=1`);

  return { id: data.user.id, email: data.user.email ?? null };
});
