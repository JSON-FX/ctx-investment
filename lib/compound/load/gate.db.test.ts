/**
 * Spec section 9's AND gate: signed in, app_metadata.role = 'admin', AND
 * account.managerUserId === user.id. Plan 3's decision P4 runs every pooled
 * connection as service_role, which carries BYPASSRLS, so the 16 RLS policies
 * rls.db.test.ts covers do not run for these pages at all — this gate, in
 * application code, is what actually protects one manager's account from
 * another's eyes. See session.ts's and account.ts's module docs.
 *
 * TWO managers, TWO accounts, throughout. A one-manager fixture passes with
 * either arm of the gate deleted: the only account in the database is yours,
 * so "I can see my account" is true either way. Every case below is built so
 * the OTHER manager's account, or a non-admin identity, is provably
 * unreachable — not merely that the right one is reachable.
 *
 * requireAccount and requireManager both call into a live Supabase session
 * (next/headers cookies, the Auth server) that does not exist in a Jest
 * process. Both halves of the gate are therefore tested through the seams the
 * plan already names for this reason: resolveOwnedAccount(c, userId, idParam)
 * carries the ownership logic, and this file additionally extracts and tests
 * resolveIsAdmin(claimedRole, storedRole) for the role logic, which the
 * plan's own draft of this file did not cover — every case in that draft ran
 * with an implicit admin claim (seedUser's default), so the role arm had no
 * test of its own. That is the exact shape this task flagged as unresolved:
 * "the ownership arm was covered and the role arm was not." Closed below,
 * plus two cases that compose both arms against a single identity that would
 * pass the OTHER arm alone.
 *
 * Seeding and reading run on two different connections, for the same reason
 * holders.db.test.ts does this (see its module doc): seedTwoAccounts/seedUser
 * write auth.users, which only postgres can do — service_role (what
 * resolveOwnedAccount is tested through, via client.ts's real pool, to match
 * what requireAccount actually borrows in production) cannot. Fixture setup
 * runs on the harness's postgres-connected pool; the functions under test run
 * on client.ts's pool. Isolation is resetCompoundTables in beforeEach, not
 * transaction rollback, for the same reason.
 */
import { closePool, withDb } from "@/lib/compound/db/client";
import { getAccountById } from "@/lib/compound/db/compound";
import { getUserRole } from "@/lib/compound/db/users";
import {
  closeTestPool,
  resetCompoundTables,
  seedTwoAccounts,
  seedUser,
  withTestClient,
} from "@/lib/compound/db/testing/harness";
import { LOCAL_SUPABASE_DB_URL } from "@/lib/compound/db/testing/env";
import { resolveOwnedAccount } from "@/lib/compound/load/account";
import { resolveIsAdmin } from "@/lib/compound/load/session";

const ORIGINAL_DATABASE_URL = process.env.COMPOUND_DATABASE_URL;

beforeAll(() => {
  process.env.COMPOUND_DATABASE_URL =
    process.env.COMPOUND_TEST_DATABASE_URL || LOCAL_SUPABASE_DB_URL;
});

beforeEach(async () => {
  await withTestClient((c) => resetCompoundTables(c));
});

afterAll(async () => {
  await closePool();
  await closeTestPool();
  process.env.COMPOUND_DATABASE_URL = ORIGINAL_DATABASE_URL;
});

describe("resolveOwnedAccount — the ownership half", () => {
  it("returns an account its manager owns", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const acct = await withDb((c) =>
      resolveOwnedAccount(c, accountA.managerUserId, String(accountA.accountId)),
    );
    expect(acct?.id).toBe(accountA.accountId);
  });

  it("refuses another manager's account, even though it exists", async () => {
    const { accountA, accountB } = await withTestClient((c) => seedTwoAccounts(c));
    // It really is there — otherwise this test proves nothing.
    expect(await withDb((c) => getAccountById(c, accountB.accountId))).not.toBeNull();
    expect(
      await withDb((c) => resolveOwnedAccount(c, accountA.managerUserId, String(accountB.accountId))),
    ).toBeNull();
  });

  it("refuses an id that is not a plain positive integer", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    for (const bad of [`${accountA.accountId}abc`, "0", "-1", "1.5", " 1", "01", ""]) {
      expect(await withDb((c) => resolveOwnedAccount(c, accountA.managerUserId, bad))).toBeNull();
    }
  });

  it("refuses an account that does not exist", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    expect(
      await withDb((c) => resolveOwnedAccount(c, accountA.managerUserId, "2147483646")),
    ).toBeNull();
  });

  it("carries the broker offset through, null when it is not configured", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    expect(
      (await withDb((c) => resolveOwnedAccount(c, accountA.managerUserId, String(accountA.accountId))))!
        .brokerOffsetHours,
    ).toBeNull();

    await withTestClient((c) =>
      c.query(`update public.compound_account set broker_offset_hours = 3 where id = $1`, [
        accountA.accountId,
      ]),
    );

    expect(
      (await withDb((c) => resolveOwnedAccount(c, accountA.managerUserId, String(accountA.accountId))))!
        .brokerOffsetHours,
    ).toBe(3);
  });

  it("refuses every offset dedupeDeals would throw on", async () => {
    // 1..14 here matches MIN_OFFSET_HOURS..MAX_OFFSET_HOURS in dedupe.ts. If
    // the column let 0 or 15 through, the failure would surface as a crash
    // inside a reconcile run instead of as a refused edit. A CHECK
    // constraint binds regardless of role, so which pool issues this does
    // not matter; kept on the harness pool.
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    for (const bad of [0, 15, -3]) {
      await withTestClient((c) =>
        expect(
          c.query(`update public.compound_account set broker_offset_hours = $2 where id = $1`, [
            accountA.accountId,
            bad,
          ]),
        ).rejects.toThrow(/compound_account_broker_offset_hours_range/),
      );
    }
  });

  it("null is not zero: an unconfigured offset does not read back as 0", async () => {
    // D-G / A5's whole point, made an explicit assertion rather than only
    // implied by the "carries the broker offset through" case above: 0 is a
    // real, legal value dedupeDeals rejects, and null is a different, legal
    // state meaning "not configured". A loader that coalesced null to 0 (a
    // common JS reflex — `value ?? 0`) would make an unconfigured account
    // indistinguishable from one deliberately, and illegally, set to zero.
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const acct = await withDb((c) =>
      resolveOwnedAccount(c, accountA.managerUserId, String(accountA.accountId)),
    );
    expect(acct!.brokerOffsetHours).toBeNull();
    expect(acct!.brokerOffsetHours).not.toBe(0);
  });
});

describe("resolveIsAdmin — the role half", () => {
  // Pure-function cases: no database needed, but run in the same file because
  // the gate is the subject, not the plumbing.
  it("passes on a claimed admin", () => {
    expect(resolveIsAdmin("admin", "admin")).toBe(true);
  });

  it("refuses a claimed non-admin", () => {
    expect(resolveIsAdmin("user", "user")).toBe(false);
  });

  it("falls back to the stored role when the JWT carries no claim", () => {
    expect(resolveIsAdmin(null, "admin")).toBe(true);
    expect(resolveIsAdmin(null, "user")).toBe(false);
  });

  it("falls back to the claim when there is no stored row yet", () => {
    expect(resolveIsAdmin("admin", null)).toBe(true);
    expect(resolveIsAdmin("user", null)).toBe(false);
  });

  it("refuses when neither source says admin", () => {
    expect(resolveIsAdmin(null, null)).toBe(false);
  });

  it("throws rather than silently pick one, when the two sources disagree", () => {
    expect(() => resolveIsAdmin("admin", "user")).toThrow(/Role mismatch/);
    expect(() => resolveIsAdmin("user", "admin")).toThrow(/Role mismatch/);
  });

  // Round-tripped against a real public.users row via client.ts's pool — the
  // same service_role connection requireManager actually reads through (it
  // has an explicit `grant select … on public.users to service_role` from
  // the CopyTraderX fixture migration) — so this is not only a unit test of
  // the predicate but proof getUserRole's real output is what resolveIsAdmin
  // expects to receive.
  //
  // Prefixed dddddddd, not cccccccc: resetCompoundTables truncates the six
  // compound_* tables only, never public.users/auth.users, so a seeded
  // user's row outlives this file and is visible to every other suite in the
  // same `supabase db reset` session. rls.db.test.ts already claims
  // cccccccc-…-0000000000c1 for "Carol" and seeds her as admin (seedUser's
  // default); this file first reused that literal id and asked for role
  // "user" on it, and — caught by an actual run, not by inspection —
  // seedUser's `on conflict (id) do nothing` made the re-seed a silent no-op,
  // so the row kept reading back "admin" and the test failed honestly. A
  // fresh prefix avoids the collision rather than papering over it.
  it("reads a real non-admin row as not admin", async () => {
    const userId = "dddddddd-0000-4000-8000-0000000000d1";
    await withTestClient((c) => seedUser(c, userId, "gate-role-arm@example.test", "user"));
    const stored = await withDb((c) => getUserRole(c, userId));
    expect(stored).toBe("user");
    expect(resolveIsAdmin(null, stored)).toBe(false);
  });

  it("reads a real admin row as admin", async () => {
    const userId = "dddddddd-0000-4000-8000-0000000000d2";
    await withTestClient((c) => seedUser(c, userId, "gate-role-arm-admin@example.test", "admin"));
    const stored = await withDb((c) => getUserRole(c, userId));
    expect(stored).toBe("admin");
    expect(resolveIsAdmin(null, stored)).toBe(true);
  });
});

describe("the AND gate refuses when either arm fails, independently", () => {
  it("ownership alone is not enough: a non-admin who genuinely owns the account is still refused", async () => {
    // The case the plan's draft gate.db.test.ts could not produce: every one
    // of its fixtures ran with seedUser's admin default, so ownership was the
    // only variable anything there could fail on. seedTwoAccounts also seeds
    // both managers as admin by default — flip accountA's manager to a plain
    // user here, after seeding, and prove that the SAME identity
    // resolveOwnedAccount happily returns an account for is still refused
    // once the role arm is asked.
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    await withTestClient((c) =>
      c.query(`update public.users set role = 'user' where id = $1`, [accountA.managerUserId]),
    );
    const stored = await withDb((c) => getUserRole(c, accountA.managerUserId));
    expect(stored).toBe("user");

    // Ownership arm alone: this manager really does own this account.
    const owned = await withDb((c) =>
      resolveOwnedAccount(c, accountA.managerUserId, String(accountA.accountId)),
    );
    expect(owned?.id).toBe(accountA.accountId);

    // Role arm alone, for the same identity: refused.
    expect(resolveIsAdmin(null, stored)).toBe(false);

    // requireAccount runs the role arm first (requireManager, via
    // resolveIsAdmin) and only reaches the ownership arm if that passes — so
    // this identity never gets past step one, and resolveOwnedAccount
    // succeeding here in isolation is exactly the point: ownership was never
    // the thing standing between this user and the account.
  });

  it("role alone is not enough: an admin managing nothing here still cannot reach another manager's account", async () => {
    const { accountB } = await withTestClient((c) => seedTwoAccounts(c));
    const outsider = "dddddddd-0000-4000-8000-0000000000d3";
    await withTestClient((c) => seedUser(c, outsider, "gate-outsider-admin@example.test", "admin"));
    const stored = await withDb((c) => getUserRole(c, outsider));

    // Role arm alone: this identity is a genuine admin.
    expect(resolveIsAdmin(null, stored)).toBe(true);

    // Ownership arm, for the same identity against someone else's account:
    // refused, even though accountB is real and even though this identity
    // cleared the role arm.
    expect(await withDb((c) => getAccountById(c, accountB.accountId))).not.toBeNull();
    expect(await withDb((c) => resolveOwnedAccount(c, outsider, String(accountB.accountId)))).toBeNull();
  });
});
