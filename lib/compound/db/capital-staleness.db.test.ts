/**
 * Integration. Runs under jest.db.config.mjs against the local stack.
 *
 * `addCapital` (app/a/[id]/actions/investor-actions.ts) refuses to commit a
 * deposit when the pool moved after the receipt was rendered, by calling
 * `staleness()` — exported from Task 11's app/a/[id]/actions/actions.ts
 * specifically so this sheet (and the payout sheet) reuse the identical
 * check rather than each hand-rolling a copy of
 * fingerprintFromFields/fingerprintOf/fingerprintMismatch.
 *
 * `addCapital` itself is a "use server" Next.js Server Action and is not
 * exercised directly here — this project does not unit-test server actions
 * anywhere (Task 11 ships no test for refreshReadings/postReading either;
 * only their constituent pieces are tested). What is tested here is the
 * exact mechanism addCapital's guard depends on, driven the same way a real
 * submission would drive it: build the hidden fingerprint fields a rendered
 * receipt would have carried, then prove `staleness()` returns null while
 * the pool has not moved and a real refusal sentence once it has — using
 * `commitDeposit`, the real writer, to move it, not a hand-edited PoolState.
 *
 * This file necessarily imports app/a/[id]/actions/actions.ts, which is
 * Task 11's file and does not exist in this worktree until that task's
 * branch lands (see this task's report). It is written against the module
 * as read directly from the sibling worktree building it, and verified by
 * temporarily copying that file in for a run — never committed alongside it.
 */
import { closePool, withAuthenticatedDb } from "@/lib/compound/db/client";
import { commitDeposit } from "@/lib/compound/db/write-deposit";
import {
  closeTestPool,
  resetCompoundTables,
  seedTwoAccounts,
  withTestClient,
} from "@/lib/compound/db/testing/harness";
import { LOCAL_SUPABASE_DB_URL } from "@/lib/compound/db/testing/env";
import { fingerprintOf } from "@/lib/compound/present/derive";
import { fingerprintToFields } from "@/lib/compound/present/fingerprint";
import { loadPoolState } from "@/lib/compound/load/ledger";
import { staleness } from "@/app/a/[id]/actions/actions";

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

function formDataOf(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("the staleness guard addCapital calls before every commit", () => {
  it("passes a receipt whose fingerprint still matches the live pool", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const { rows } = await withTestClient((c) =>
      c.query<{ id: string }>(
        `select id from public.compound_holder where account_id = $1 and is_manager`,
        [seed.accountA.accountId],
      ),
    );
    const managerId = Number(rows[0]!.id);

    const state = await loadPoolState(seed.accountA.managerUserId, seed.accountA.accountId);
    const shown = fingerprintOf(seed.accountA.accountId, state);
    const fd = formDataOf(fingerprintToFields(shown));

    expect(await staleness(seed.accountA.managerUserId, seed.accountA.accountId, fd)).toBeNull();

    // managerId retrieved above is what a real capital-page render would
    // also have needed; asserted here only so an unused-variable lint
    // cannot silently drop this test's own realism.
    expect(managerId).toBeGreaterThan(0);
  });

  it("refuses a receipt once another deposit has landed on the same account, and says why", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const { rows } = await withTestClient((c) =>
      c.query<{ id: string }>(
        `select id from public.compound_holder where account_id = $1 and is_manager`,
        [seed.accountA.accountId],
      ),
    );
    const managerId = Number(rows[0]!.id);

    // The receipt a manager would have been looking at: the pool BEFORE the
    // race.
    const before = await loadPoolState(seed.accountA.managerUserId, seed.accountA.accountId);
    const shown = fingerprintOf(seed.accountA.accountId, before);
    const fd = formDataOf(fingerprintToFields(shown));

    // Someone else — another tab, the reconciler — commits a real deposit in
    // between. Not a hand-edited PoolState: the actual writer under test
    // elsewhere in this task, so this probe cannot be satisfied by a fixture
    // that merely LOOKS stale.
    await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
      commitDeposit(c, {
        accountId: seed.accountA.accountId, holderId: managerId,
        occurredOn: "2026-03-02", amountCents: 500_00n, note: null,
        actorUserId: seed.accountA.managerUserId,
      }),
    );

    const message = await staleness(seed.accountA.managerUserId, seed.accountA.accountId, fd);
    expect(message).not.toBeNull();
    expect(message).toContain("account moved while this was open");
    expect(message).toContain("Nothing was committed");
  });

  it("refuses a form with no fingerprint fields at all, rather than defaulting to 'fresh'", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const message = await staleness(seed.accountA.managerUserId, seed.accountA.accountId, new FormData());
    expect(message).toBe("That form was incomplete. Nothing was committed.");
  });
});
