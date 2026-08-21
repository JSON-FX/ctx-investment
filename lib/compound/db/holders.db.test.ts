/**
 * Integration. Runs under jest.db.config.mjs against the local stack.
 *
 * Seeding and reading deliberately run on two different connections.
 * seedTwoAccounts calls seedUser, which inserts into auth.users — a write
 * only postgres (or supabase_auth_admin) can make. service_role cannot:
 * confirmed by first writing this file entirely against client.ts's pool and
 * watching every test fail with "permission denied for table users". Since
 * that permission gap is specific to auth.users and not to anything Compound
 * reads at runtime (service_role holds an explicit `grant select … on
 * public.users` from the CopyTraderX fixture migration, so getUserRole is
 * unaffected), the fix moves ONLY the fixture setup onto the harness's
 * postgres-connected pool. listHolders itself still runs through client.ts's
 * withDb — the same pool requireAccount and every other loader actually
 * borrow in production — so what is under test still runs as service_role,
 * matching a real request. Isolation between tests is resetCompoundTables in
 * beforeEach, matching rls.db.test.ts and commit-plan.db.test.ts, rather than
 * transaction rollback: the plan's draft used a single rolled-back
 * withDbTransaction spanning both seeding and reading, which cannot work once
 * seeding needs a different role than the read.
 *
 * Two further disagreements between the plan's draft and the real harness,
 * both checked against a real run rather than assumed:
 *
 *   1. The plan's snippet imported seedTwoAccounts from
 *      "@/lib/compound/db/test-harness" and destructured { mine, theirs }.
 *      The real helper (plan 3's Task 1) lives at
 *      lib/compound/db/testing/harness.ts and returns { accountA, accountB } —
 *      see TwoAccountSeed there.
 *
 *   2. The plan's "puts the manager first" test asserted the manager holder's
 *      splitBps is 0, and its "carries the holder's own split" test asserted
 *      the investor's splitBps is 3700, distinct from the account's
 *      default_split_bps. Neither holds: seedTwoAccounts seeds Account A with
 *      default_split_bps 4000 and gives BOTH "Seed Manager A" and "Seed
 *      Investor A1" split_bps 4000 too — manager, investor and account
 *      default all read 4000. Adjusted to assert what the harness actually
 *      seeds, and added a case that inserts a second holder at a genuinely
 *      distinct split, since nothing in the base fixture can otherwise tell
 *      "the holder's own column" apart from a neighbour's value or the
 *      account default.
 */
import { closePool, withDb } from "@/lib/compound/db/client";
import { listHolders } from "@/lib/compound/db/holders";
import {
  closeTestPool,
  resetCompoundTables,
  seedTwoAccounts,
  withTestClient,
} from "@/lib/compound/db/testing/harness";
import { LOCAL_SUPABASE_DB_URL } from "@/lib/compound/db/testing/env";

// withDb (client.ts) reads COMPOUND_DATABASE_URL, not COMPOUND_TEST_DATABASE_URL,
// and throws if it is unset. Nothing sets it globally; client.db.test.ts is the
// precedent for doing this locally so this file does not depend on run order.
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

describe("listHolders", () => {
  it("returns only the requested account's holders", async () => {
    const { accountA, accountB } = await withTestClient((c) => seedTwoAccounts(c));
    const rows = await withDb((c) => listHolders(c, accountA.accountId));
    expect(rows.map((r) => r.accountId)).toEqual([accountA.accountId, accountA.accountId]);
    expect(rows.some((r) => r.accountId === accountB.accountId)).toBe(false);
  });

  it("puts the manager first", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const rows = await withDb((c) => listHolders(c, accountA.accountId));
    expect(rows[0]!.isManager).toBe(true);
    expect(rows[0]!.name).toBe("Seed Manager A");
    // The harness's own fixture (see the module doc above): this account's
    // manager, its one investor and the account's own default all happen to
    // share 4000. Recorded as fact, not as proof the column is read
    // correctly — the next test supplies a value nothing else in the
    // fixture shares.
    expect(rows[0]!.splitBps).toBe(4000);
  });

  it("carries each holder's own split_bps column, not a neighbour's or the account default", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    // 3700 matches nothing else touching this account: not default_split_bps
    // (4000), not the manager's or the seeded investor's split (also 4000).
    // A reader that returned the wrong column, or the account default, would
    // print 4000 here instead.
    const newId = await withTestClient(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into public.compound_holder
           (account_id, name, is_manager, split_bps, joined_at, status)
         values ($1, 'Seed Investor A2', false, 3700, '2026-05-03', 'active')
         returning id`,
        [accountA.accountId],
      );
      return Number(rows[0]!.id);
    });

    const rows = await withDb((c) => listHolders(c, accountA.accountId));
    expect(rows.find((r) => r.id === newId)?.splitBps).toBe(3700);
    expect(rows.find((r) => r.name === "Seed Investor A1")?.splitBps).toBe(4000);
  });

  it("refuses a status the type does not allow, rather than casting it", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    // The CHECK constraint stops this at the database, which is the point:
    // the reader's throw is a second line of defence, not the first. CHECK
    // constraints bind regardless of role, so which pool runs this does not
    // matter — kept on the harness pool since no service_role grant is
    // otherwise needed here.
    await withTestClient((c) =>
      expect(
        c.query(`update public.compound_holder set status = 'paused' where account_id = $1`, [
          accountA.accountId,
        ]),
      ).rejects.toThrow(/compound_holder_status_check|violates check constraint/),
    );
  });

  it("returns an empty array for an account with no holders, not null", async () => {
    expect(await withDb((c) => listHolders(c, 2_147_483_646))).toEqual([]);
  });
});
