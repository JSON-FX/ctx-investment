/**
 * resolveIsAdmin and SIGN_IN_PATH are the two testable seams of this module.
 * requireManager itself calls into a live Supabase session (next/headers
 * cookies, the Auth server) that does not exist in a Jest process — this
 * file's own module doc says so, and gate.db.test.ts's says the same about
 * requireAccount. Neither can be run end to end here without either a real
 * Next.js request (this repo deliberately has no next/jest — see Task 1 of
 * the desk plan) or mocking the data layer (this codebase's own convention
 * has none — no test anywhere in lib/compound mocks a module). Both extract
 * and test the part that IS pure instead of leaving the whole function
 * unverified.
 *
 * The redirect() call below is real, not mocked: next/navigation's redirect
 * throws a plain Error carrying a NEXT_REDIRECT digest, and building that
 * error does not require an active Next.js request (confirmed by reading
 * node_modules/next/dist/client/components/redirect.js — it optionally
 * chains off actionAsyncStorage and falls back cleanly when that store is
 * absent, which it always is here). Only next/headers's cookies() needs a
 * request scope and throws outside one; redirect() does not.
 */
import { redirect } from "next/navigation";
import { SIGN_IN_PATH, resolveIsAdmin } from "./session";

describe("resolveIsAdmin", () => {
  it("is true when the claimed role is admin and nothing is stored to disagree", () => {
    expect(resolveIsAdmin("admin", null)).toBe(true);
  });

  it("is true when only the stored role says admin", () => {
    expect(resolveIsAdmin(null, "admin")).toBe(true);
  });

  it("is false for a plain user, from either source", () => {
    expect(resolveIsAdmin("user", null)).toBe(false);
    expect(resolveIsAdmin(null, "user")).toBe(false);
  });

  it("is false when neither source says anything", () => {
    expect(resolveIsAdmin(null, null)).toBe(false);
  });

  it("agrees silently when both sources say the same thing", () => {
    expect(resolveIsAdmin("admin", "admin")).toBe(true);
    expect(resolveIsAdmin("user", "user")).toBe(false);
  });

  it("throws, rather than picking one, when the two sources disagree", () => {
    expect(() => resolveIsAdmin("admin", "user")).toThrow(/Role mismatch/);
    expect(() => resolveIsAdmin("user", "admin")).toThrow(/Role mismatch/);
  });
});

describe("SIGN_IN_PATH", () => {
  it("is /sign-in", () => {
    expect(SIGN_IN_PATH).toBe("/sign-in");
  });

  it("is what a real, unmocked next/navigation redirect() sends a signed-out request to", () => {
    // This exercises Next's actual redirect mechanism against the exact
    // value requireManager and the sign-out action both call redirect()
    // with. It cannot run the Supabase-dependent functions themselves (see
    // this file's module doc) — but if SIGN_IN_PATH ever pointed anywhere
    // else, this goes red, and so does every real redirect that uses it.
    let digest = "";
    try {
      redirect(SIGN_IN_PATH);
    } catch (e) {
      digest = (e as { digest?: string }).digest ?? "";
    }
    expect(digest).toMatch(/^NEXT_REDIRECT;replace;\/sign-in;/);
  });
});
