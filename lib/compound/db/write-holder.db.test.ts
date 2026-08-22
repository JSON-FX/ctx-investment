/**
 * Integration. Runs under jest.db.config.mjs against the local stack.
 *
 * Isolation is resetCompoundTables in beforeEach, matching every other
 * writer test in this directory (holders.db.test.ts, write-account.db.test.ts,
 * write-classify.db.test.ts) — not transaction rollback, for the same reason
 * those files give: seedTwoAccounts writes auth.users, which only
 * postgres/supabase_auth_admin can do, so fixture seeding (withTestClient,
 * the harness's postgres-connected pool) and the writer under test
 * (withAuthenticatedDb, client.ts's authenticated helper — connected as the
 * account's own manager, the same helper and identity requireAccount
 * actually borrows in production) are two different connections, not one
 * rolled-back transaction spanning both.
 *
 * The centrepiece of this file is "changing a split does not rewrite
 * history" — the property the task exists to prove. compound_ledger_entry
 * stores splitBpsApplied on every payout/exit at the seq it was written
 * (replay.ts refuses to fold one with none), and compound_update_holder only
 * ever touches compound_holder.split_bps. Proving the two cannot drift into
 * each other needs a ledger entry already on the books before the holder is
 * edited — seedLedger supplies that.
 */
import { closePool, withAuthenticatedDb } from "@/lib/compound/db/client";
import { getLedgerEntries } from "@/lib/compound/db/compound";
import { listHolders } from "@/lib/compound/db/holders";
import { updateHolder, type UpdateHolderInput } from "@/lib/compound/db/write-holder";
import {
  closeTestPool,
  expectPgError,
  resetCompoundTables,
  seedLedger,
  seedTwoAccounts,
  sequenceConsumed,
  withTestClient,
  type TwoAccountSeed,
} from "@/lib/compound/db/testing/harness";
import { LOCAL_SUPABASE_DB_URL } from "@/lib/compound/db/testing/env";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { fold } from "@/lib/compound/engine/replay";

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

/** The seeded manager's own holder id — looked up, never assumed to be a fixed index. */
async function managerHolderId(seed: TwoAccountSeed["accountA"]): Promise<number> {
  const { rows } = await withTestClient((c) =>
    c.query<{ id: string }>(
      `select id from public.compound_holder where account_id = $1 and is_manager`,
      [seed.accountId],
    ),
  );
  return Number(rows[0]!.id);
}

function input(
  seed: TwoAccountSeed["accountA"],
  holderId: number,
  overrides: Partial<UpdateHolderInput> = {},
): UpdateHolderInput {
  return {
    accountId: seed.accountId,
    holderId,
    name: "Ada Lovelace",
    email: "ada@example.test",
    splitBps: 4000,
    actorUserId: seed.managerUserId,
    ...overrides,
  };
}

describe("updateHolder", () => {
  it("changes name, email and split, all three at once", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const investorId = accountA.holderIds[1]!; // "Seed Investor A1"

    await withAuthenticatedDb(accountA.managerUserId, (c) =>
      updateHolder(c, input(accountA, investorId, {
        name: "Renamed Investor", email: "renamed@example.test", splitBps: 2500,
      })),
    );

    const rows = await withAuthenticatedDb(accountA.managerUserId, (c) => listHolders(c, accountA.accountId));
    const holder = rows.find((r) => r.id === investorId);
    expect(holder).toMatchObject({
      name: "Renamed Investor", email: "renamed@example.test", splitBps: 2500,
    });
  });

  it("the sequence: rename, then reload — the new name is shown and the old one is gone", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const investorId = accountA.holderIds[1]!;

    // Before: a plain, independent read — not a variable carried over from
    // setup — sees the seeded name.
    const before = await withAuthenticatedDb(accountA.managerUserId, (c) => listHolders(c, accountA.accountId));
    expect(before.find((r) => r.id === investorId)?.name).toBe("Seed Investor A1");

    await withAuthenticatedDb(accountA.managerUserId, (c) =>
      updateHolder(c, input(accountA, investorId, { name: "Grace Hopper", splitBps: 3700 })),
    );

    // "Reload" is a SECOND, independent read call — the same shape a fresh
    // page load issues — not a re-use of any state the write touched.
    const after = await withAuthenticatedDb(accountA.managerUserId, (c) => listHolders(c, accountA.accountId));
    const names = after.map((r) => r.name);
    expect(names).toContain("Grace Hopper");
    expect(names).not.toContain("Seed Investor A1");
  });

  it("clears email back to null when given an empty string, matching addHolder's own nullif", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const investorId = accountA.holderIds[1]!;
    await withAuthenticatedDb(accountA.managerUserId, (c) => updateHolder(c, input(accountA, investorId, { email: "" })));
    const rows = await withAuthenticatedDb(accountA.managerUserId, (c) => listHolders(c, accountA.accountId));
    expect(rows.find((r) => r.id === investorId)?.email).toBeNull();
  });

  it("does not touch any holder on the other manager's account", async () => {
    const { accountA, accountB } = await withTestClient((c) => seedTwoAccounts(c));
    const otherManagerHolderId = accountB.holderIds[0]!;

    // accountA is the account named, but the holder id belongs to accountB.
    await expectPgError(
      withAuthenticatedDb(accountA.managerUserId, (c) => updateHolder(c, input(accountA, otherManagerHolderId))),
      "CX301",
      /holder .* is not on account/,
    );

    // Read as Bob himself — the point is that HIS OWN row is untouched, and
    // an outsider's inability to see it at all would make this assertion
    // vacuous rather than a genuine check.
    const rowsB = await withAuthenticatedDb(accountB.managerUserId, (c) =>
      listHolders(c, accountB.accountId),
    );
    expect(rowsB.find((r) => r.id === otherManagerHolderId)?.name).toBe("Seed Manager B");
  });

  it("refuses a holder id that does not exist at all", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    await expectPgError(
      withAuthenticatedDb(accountA.managerUserId, (c) => updateHolder(c, input(accountA, 999_999_999))),
      "CX301",
      /holder .* is not on account/,
    );
  });

  it("refuses when the account does not exist", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const investorId = accountA.holderIds[1]!;
    await expectPgError(
      withAuthenticatedDb(accountA.managerUserId, (c) => updateHolder(c, { ...input(accountA, investorId), accountId: 2_147_483_646 })),
      "CX001",
      /no account/,
    );
  });

  it("refuses a blank name before it reaches SQL", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const investorId = accountA.holderIds[1]!;
    await expect(
      withAuthenticatedDb(accountA.managerUserId, (c) => updateHolder(c, input(accountA, investorId, { name: "   " }))),
    ).rejects.toThrow(/a holder needs a name/);
  });

  it("refuses a split outside 0..10000 before it reaches SQL", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const investorId = accountA.holderIds[1]!;
    await expect(
      withAuthenticatedDb(accountA.managerUserId, (c) => updateHolder(c, input(accountA, investorId, { splitBps: 10_001 }))),
    ).rejects.toThrow(/splitBps must be an integer/);
  });

  it("refuses setting the manager's split to anything but zero", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const managerId = await managerHolderId(accountA);
    // seedTwoAccounts seeds the manager's split_bps at 4000, the same as the
    // account default (see holders.db.test.ts's own module doc) — a raw
    // fixture insert, not a run through compound_create_account, which is
    // the only place that actually enforces "the manager's split is 0" in
    // production. That makes this the sharper case: the guard has to refuse
    // a NON-zero-to-non-zero change too, not only catch an obviously wrong
    // 0-to-nonzero one.
    await expectPgError(
      withAuthenticatedDb(accountA.managerUserId, (c) => updateHolder(c, input(accountA, managerId, { splitBps: 100 }))),
      "CX304",
      /manager's split is fixed at 0/,
    );
    // Refused, not partially applied: the manager's row is untouched from
    // whatever it read before this call.
    const rows = await withAuthenticatedDb(accountA.managerUserId, (c) => listHolders(c, accountA.accountId));
    expect(rows.find((r) => r.id === managerId)?.splitBps).toBe(4000);
  });

  it("allows correcting the manager's split down to zero — the guard checks the TARGET value, not whether it changed", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const managerId = await managerHolderId(accountA);
    // Seeded at 4000 (see the test above). This is a genuine change, and
    // it's allowed because 0 is the one value CX304 never refuses.
    await withAuthenticatedDb(accountA.managerUserId, (c) =>
      updateHolder(c, input(accountA, managerId, { name: "J. Marsh", splitBps: 0 })),
    );
    const rows = await withAuthenticatedDb(accountA.managerUserId, (c) => listHolders(c, accountA.accountId));
    expect(rows.find((r) => r.id === managerId)).toMatchObject({ name: "J. Marsh", splitBps: 0 });
  });

  it("writes an audit row naming the actor, and prior_state carries what the row said before", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const investorId = accountA.holderIds[1]!;

    await withAuthenticatedDb(accountA.managerUserId, (c) =>
      updateHolder(c, input(accountA, investorId, {
        name: "Renamed Investor", email: "renamed@example.test", splitBps: 2500,
      })),
    );

    const { rows } = await withAuthenticatedDb(accountA.managerUserId, (c) =>
      c.query<{ actor: string; action: string; entity: string; entity_id: string;
                prior_state: { name: string; email: string | null; split_bps: number } }>(
        `select actor, action, entity, entity_id, prior_state from public.compound_audit
          where entity = 'compound_holder' and entity_id = $1`,
        [investorId],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe(accountA.managerUserId);
    expect(rows[0]!.action).toBe("update_holder");
    // The name that changed is traceable: what it said BEFORE this write,
    // not the new value — a prior_state that echoed the new row would prove
    // nothing about what changed.
    expect(rows[0]!.prior_state).toEqual({
      name: "Seed Investor A1", email: null, split_bps: 4000,
    });
  });

  it("a forced failure on the audit insert rolls back the holder row too, having actually reached the update first", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const investorId = accountA.holderIds[1]!;
    const AUDIT = "public.compound_audit";

    // Revoked from `authenticated`, not `service_role` — see
    // write-classify.db.test.ts's identical fix for the reasoning.
    await withTestClient((c) => c.query(`revoke insert on ${AUDIT} from authenticated`));
    const before = await withTestClient((c) => sequenceConsumed(c, AUDIT, "id"));

    try {
      await expect(
        withAuthenticatedDb(accountA.managerUserId, (c) => updateHolder(c, input(accountA, investorId, { name: "Should Not Land" }))),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await withTestClient((c) => c.query(`grant insert on ${AUDIT} to authenticated`));
    }

    // The audit insert is the LAST statement in the function body — this is
    // the proof the UPDATE really ran first, not that the guard fired before
    // any write. Without forcing a failure this late, "the holder row is
    // unchanged" could mean either "correctly rolled back" or "never tried".
    const after = await withTestClient((c) => sequenceConsumed(c, AUDIT, "id"));
    expect(after - before).toBe(0); // the audit sequence itself never advanced (insert never ran)

    const rows = await withAuthenticatedDb(accountA.managerUserId, (c) => listHolders(c, accountA.accountId));
    expect(rows.find((r) => r.id === investorId)?.name).toBe("Seed Investor A1");
  });
});

describe("updateHolder — a changed split does not rewrite an already-posted payout", () => {
  it("splitBpsApplied on a posted payout survives a later change to the holder's current split_bps", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const investorId = accountA.holderIds[1]!;

    // A deposit, an equity_reading that puts the account into profit, and a
    // payout for the investor at the split THEN in force (4000 — matching
    // the harness's own seed). All three seeded directly, so this test
    // depends on nothing but compound_ledger_entry's own columns.
    const ids = await withTestClient((c) => seedLedger(c, accountA.accountId, [
      { seq: 1, occurredOn: "2026-05-02", type: "deposit", amountCents: centsFromDecimal("10000.00"), holderId: investorId },
      { seq: 2, occurredOn: "2026-06-01", type: "equity_reading", amountCents: centsFromDecimal("12000.00") },
      {
        seq: 3, occurredOn: "2026-06-02", type: "payout", amountCents: centsFromDecimal("500.00"),
        holderId: investorId, feeSettlement: "cash", splitBpsApplied: 4000,
      },
    ]));
    const payoutEntryId = ids[2]!;

    const beforeEntries = await withAuthenticatedDb(accountA.managerUserId, (c) => getLedgerEntries(c, accountA.accountId));
    const beforeSeeds = (await withAuthenticatedDb(accountA.managerUserId, (c) => listHolders(c, accountA.accountId))).map((h) => ({
      holderId: h.id, isManager: h.isManager, splitBps: h.splitBps,
    }));
    const beforeState = fold(beforeEntries, beforeSeeds);
    const beforeHolder = beforeState.holders.find((h) => h.holderId === investorId)!;

    // Change the holder's CURRENT split — a decision made today, long after
    // that payout posted.
    await withAuthenticatedDb(accountA.managerUserId, (c) =>
      updateHolder(c, {
        accountId: accountA.accountId, holderId: investorId,
        name: "Seed Investor A1", email: null, splitBps: 1500,
        actorUserId: accountA.managerUserId,
      }),
    );

    // The raw ledger row is untouched: split_bps_applied still reads what it
    // was written with. compound_ledger_entry is INSERT/SELECT only, so this
    // is also mechanically guaranteed — asserted anyway, because the
    // guarantee is only worth something if something checks it.
    const afterEntries = await withAuthenticatedDb(accountA.managerUserId, (c) => getLedgerEntries(c, accountA.accountId));
    const payoutEntry = afterEntries.find((e) => e.id === payoutEntryId)!;
    expect(payoutEntry.splitBpsApplied).toBe(4000);

    // Re-fold with the NEW seeds (what a fresh page load would fetch). The
    // seed's current splitBps has moved to 1500 — that governs any FUTURE
    // quote — but replaying the ALREADY-POSTED payout must land on exactly
    // the same units/equity effect as before, because fold() reads
    // e.splitBpsApplied for that entry, never the seed's live value.
    const afterSeeds = (await withAuthenticatedDb(accountA.managerUserId, (c) => listHolders(c, accountA.accountId))).map((h) => ({
      holderId: h.id, isManager: h.isManager, splitBps: h.splitBps,
    }));
    expect(afterSeeds.find((s) => s.holderId === investorId)?.splitBps).toBe(1500);

    const afterState = fold(afterEntries, afterSeeds);
    const afterHolder = afterState.holders.find((h) => h.holderId === investorId)!;

    // The historical entry's economic effect is bit-for-bit identical: same
    // units held and same basis after replay, before and after the holder's
    // current split changed.
    expect(afterHolder.units).toBe(beforeHolder.units);
    expect(afterHolder.basisCents).toBe(beforeHolder.basisCents);
    expect(afterState.equityCents).toBe(beforeState.equityCents);

    // And the seed's OWN splitBps on the returned state reflects the new
    // value — proving the two are genuinely independent, not that the test
    // failed to observe the change at all.
    expect(afterHolder.splitBps).toBe(1500);
    expect(beforeHolder.splitBps).toBe(4000);
  });
});
