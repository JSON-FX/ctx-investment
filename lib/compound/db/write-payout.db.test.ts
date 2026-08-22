/**
 * Integration. Runs under jest.db.config.mjs against the local stack.
 *
 * Two disagreements between the plan's Task 13 Step 5 draft and the real
 * harness, both checked against a real run rather than assumed — the same
 * class of defect write-account.db.test.ts and holders.db.test.ts already
 * document independently for other tasks in this plan:
 *
 *   1. The plan's snippet imported `{ MANAGER_USER_ID, seedTwoAccounts }`
 *      from "@/lib/compound/db/test-harness" and destructured `{ mine }`
 *      from seedTwoAccounts's result. Neither the path, the constant, nor
 *      the `mine`/`theirs` shape exist. The real helper (plan 3's Task 1)
 *      lives at lib/compound/db/testing/harness.ts and returns
 *      `{ accountA, accountB }` — see TwoAccountSeed there. Account B seeds
 *      "the manager alone" (one holder), which is exactly the starting shape
 *      this file's `funded()` needs, so it is used as the account under
 *      test and its `managerUserId`/`holderIds[0]` stand in for the plan's
 *      invented constants.
 *
 *   2. seedTwoAccounts calls seedUser, which inserts into auth.users — a
 *      write only postgres (or supabase_auth_admin) can make; no role
 *      client.ts ever switches to can (confirmed exactly as
 *      holders.db.test.ts's header describes, independently, for this file).
 *      So seeding runs on the harness's postgres-connected pool
 *      (withTestClient) and every writer under test — commitDeposit,
 *      addHolder, commitPayout — runs through client.ts's withAuthenticatedDb,
 *      connected as the account's own manager, the same helper and identity
 *      payOut's action actually borrows in production. Two roles on two
 *      connections cannot share one rolled-back transaction, so isolation
 *      here is resetCompoundTables in beforeEach (matching
 *      holders.db.test.ts and commit-plan.db.test.ts) rather than the plan
 *      draft's single transaction-per-test with a "rollback" throw at the
 *      end.
 *
 * addHolder and commitDeposit are themselves bootstrapped for this task —
 * see their own file headers and .superpowers/desk-task-13-report.md.
 */
import { withAuthenticatedDb } from "@/lib/compound/db/client";
import { getHolderSeeds, getLedgerEntries } from "@/lib/compound/db/compound";
import { listHolders } from "@/lib/compound/db/holders";
import { commitDeposit } from "@/lib/compound/db/write-deposit";
import { addHolder } from "@/lib/compound/db/write-holder";
import { commitPayout } from "@/lib/compound/db/write-payout";
import {
  closeTestPool, resetCompoundTables, seedTwoAccounts, withTestClient,
} from "@/lib/compound/db/testing/harness";
import { assertInvariants } from "@/lib/compound/engine/invariants";
import { fold } from "@/lib/compound/engine/replay";

let accountId = 0;
let managerHolderId = 0;
let managerUserId = "";
/** A holder on the OTHER account seedTwoAccounts creates in the same call — for the CX205 test. */
let foreignHolderId = 0;

beforeEach(async () => {
  await withTestClient(async (c) => {
    await resetCompoundTables(c);
    const { accountA, accountB } = await seedTwoAccounts(c);
    accountId = accountB.accountId;
    managerUserId = accountB.managerUserId;
    // accountA is a different account from the SAME seedTwoAccounts call —
    // calling seedTwoAccounts a second time inside a test would collide on
    // its hardcoded mt5_account numbers (confirmed: duplicate key on
    // compound_account_mt5_account_key), so account A's own holder stands in
    // as "a holder not on this account" instead.
    foreignHolderId = accountA.holderIds[0]!;
    managerHolderId = accountB.holderIds[0]!;
  });
});

afterAll(async () => {
  await withTestClient((c) => resetCompoundTables(c));
  await closeTestPool();
});

/** Funds the seeded account: manager in for 25,000, Ada in for 10,000, equity 55,743.91. */
async function funded(): Promise<number> {
  await withAuthenticatedDb(managerUserId, (c) => commitDeposit(c, {
    accountId, holderId: managerHolderId, occurredOn: "2026-03-02",
    amountCents: 2_500_000n, note: null, actorUserId: managerUserId,
  }));
  const adaId = await withAuthenticatedDb(managerUserId, (c) => addHolder(c, {
    accountId, name: "Ada Lovelace", email: null, splitBps: 4000,
    joinedAt: "2026-05-04", actorUserId: managerUserId,
  }));
  await withAuthenticatedDb(managerUserId, (c) => commitDeposit(c, {
    accountId, holderId: adaId, occurredOn: "2026-05-04",
    amountCents: 1_000_000n, note: null, actorUserId: managerUserId,
  }));
  return adaId;
}

describe("commitPayout", () => {
  it("writes the settlement reading and the payout, in that order, adjacent", async () => {
    const adaId = await funded();
    const before = await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId));
    const maxSeq = Math.max(...before.map((e) => e.seq));

    const r = await withAuthenticatedDb(managerUserId, (c) => commitPayout(c, {
      accountId, holderId: adaId, occurredOn: "2026-08-18",
      settlementEquityCents: 5_574_391n, mode: "payout", feeSettlement: "units",
      splitBpsApplied: 4000, grossCents: 263_060n, expectedSeq: maxSeq,
      note: null, actorUserId: managerUserId,
    }));

    const after = await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId));
    const reading = after.find((e) => e.id === r.readingEntryId)!;
    const payout = after.find((e) => e.id === r.payoutEntryId)!;
    expect(reading.type).toBe("equity_reading");
    expect(reading.seq).toBe(maxSeq + 1);
    expect(reading.amountCents).toBe(5_574_391n);
    expect(payout.type).toBe("payout");
    expect(payout.seq).toBe(maxSeq + 2);
    expect(payout.splitBpsApplied).toBe(4000);
    expect(payout.feeSettlement).toBe("units");
  });

  it("folds to a state that satisfies every invariant", async () => {
    const adaId = await funded();
    const maxSeq = Math.max(...(await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId))).map((e) => e.seq));
    await withAuthenticatedDb(managerUserId, (c) => commitPayout(c, {
      accountId, holderId: adaId, occurredOn: "2026-08-18",
      settlementEquityCents: 5_574_391n, mode: "payout", feeSettlement: "units",
      splitBpsApplied: 4000, grossCents: 263_060n, expectedSeq: maxSeq,
      note: null, actorUserId: managerUserId,
    }));
    const state = fold(
      await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId)),
      await withAuthenticatedDb(managerUserId, (c) => getHolderSeeds(c, accountId)),
    );
    expect(() => assertInvariants(state)).not.toThrow();
  });

  it("refuses when the account has moved since the receipt, with CX204", async () => {
    const adaId = await funded();
    const maxSeq = Math.max(...(await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId))).map((e) => e.seq));

    await expect(withAuthenticatedDb(managerUserId, (c) => commitPayout(c, {
      accountId, holderId: adaId, occurredOn: "2026-08-18",
      settlementEquityCents: 5_574_391n, mode: "payout", feeSettlement: "units",
      splitBpsApplied: 4000, grossCents: 263_060n,
      expectedSeq: maxSeq - 1,   // a receipt worked out one entry ago
      note: null, actorUserId: managerUserId,
    }))).rejects.toThrow(/the receipt was worked out at entry/);

    // And the correct seq still works, so the guard is not "refuse everything".
    await expect(withAuthenticatedDb(managerUserId, (c) => commitPayout(c, {
      accountId, holderId: adaId, occurredOn: "2026-08-18",
      settlementEquityCents: 5_574_391n, mode: "payout", feeSettlement: "units",
      splitBpsApplied: 4000, grossCents: 263_060n, expectedSeq: maxSeq,
      note: null, actorUserId: managerUserId,
    }))).resolves.toBeDefined();
  });

  it("writes nothing at all when the seq check fails", async () => {
    const adaId = await funded();
    const before = (await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId))).length;
    await expect(withAuthenticatedDb(managerUserId, (c) => commitPayout(c, {
      accountId, holderId: adaId, occurredOn: "2026-08-18",
      settlementEquityCents: 5_574_391n, mode: "payout", feeSettlement: "units",
      splitBpsApplied: 4000, grossCents: 263_060n, expectedSeq: 0,
      note: null, actorUserId: managerUserId,
    }))).rejects.toThrow();
    // The reading must not survive without its payout. The seq guard fires
    // before either insert, so this is a weak assertion on its own — the
    // atomicity that matters is proved next, where the SECOND insert fails
    // after the FIRST has already run inside the same function call.
    expect((await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId))).length).toBe(before);
  });

  it("leaves no orphan reading when the payout insert fails", async () => {
    const adaId = await funded();
    const before = (await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId))).length;
    const maxSeq = Math.max(...(await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId))).map((e) => e.seq));

    // split_bps_applied out of range (compound_ledger_entry's own CHECK,
    // 0..10000 — confirmed against the real migration, not assumed) fails on
    // the SECOND insert, after the reading has already been written inside
    // this same function call. Proves the two inserts are one transaction:
    // if they were separate statements from the client, the reading would
    // survive on its own.
    await expect(withAuthenticatedDb(managerUserId, (c) => c.query(
      `select public.compound_commit_payout($1,$2,'2026-08-18'::date,$3::bigint,
         'payout','units',$4,$5::bigint,$6::bigint,'',$7::uuid)`,
      [accountId, adaId, "5574391", 99_999, "263060", String(maxSeq), managerUserId],
    ))).rejects.toThrow();
    expect((await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId))).length).toBe(before);
  });

  it("closes the holder's stored status on exit, in step with what fold derives", async () => {
    // Decision D-M, and the test plan 3 could not write because none of its
    // fixtures had a payout in them.
    const adaId = await funded();
    const maxSeq = Math.max(...(await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId))).map((e) => e.seq));
    await withAuthenticatedDb(managerUserId, (c) => commitPayout(c, {
      accountId, holderId: adaId, occurredOn: "2026-08-18",
      settlementEquityCents: 5_574_391n, mode: "exit", feeSettlement: "units",
      splitBpsApplied: 4000, grossCents: 1_263_060n, expectedSeq: maxSeq,
      note: null, actorUserId: managerUserId,
    }));
    const stored = (await withAuthenticatedDb(managerUserId, (c) => listHolders(c, accountId))).find((h) => h.id === adaId)!;
    const derived = fold(
      await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId)),
      await withAuthenticatedDb(managerUserId, (c) => getHolderSeeds(c, accountId)),
    ).holders.find((h) => h.holderId === adaId)!;
    expect(stored.status).toBe("closed");
    expect(derived.status).toBe("closed");
    expect(stored.status).toBe(derived.status);
  });

  it("does not move the reconcile cursor", async () => {
    const adaId = await funded();
    await withAuthenticatedDb(managerUserId, (c) => c.query(
      `insert into public.compound_reconcile_cursor (account_id, last_reading_date)
       values ($1, '2026-08-14')
       on conflict (account_id) do update set last_reading_date = excluded.last_reading_date`,
      [accountId],
    ));
    const maxSeq = Math.max(...(await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId))).map((e) => e.seq));
    await withAuthenticatedDb(managerUserId, (c) => commitPayout(c, {
      accountId, holderId: adaId, occurredOn: "2026-08-18",
      settlementEquityCents: 5_574_391n, mode: "payout", feeSettlement: "units",
      splitBpsApplied: 4000, grossCents: 263_060n, expectedSeq: maxSeq,
      note: null, actorUserId: managerUserId,
    }));
    const { rows } = await withAuthenticatedDb(managerUserId, (c) => c.query<{ last_reading_date: string }>(
      `select last_reading_date::text from public.compound_reconcile_cursor where account_id = $1`,
      [accountId],
    ));
    expect(rows[0]!.last_reading_date).toBe("2026-08-14");
  });

  it("refuses a payout dated on or after an unclassified capital event", async () => {
    const adaId = await funded();
    await withAuthenticatedDb(managerUserId, (c) => c.query(
      `insert into public.compound_capital_event_candidate
         (account_id, trade_date, balance_delta_cents, explained_cents, unexplained_cents)
       values ($1, '2026-08-12', 500000, 0, 500000)`, [accountId],
    ));
    const maxSeq = Math.max(...(await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId))).map((e) => e.seq));
    await expect(withAuthenticatedDb(managerUserId, (c) => commitPayout(c, {
      accountId, holderId: adaId, occurredOn: "2026-08-18",
      settlementEquityCents: 5_574_391n, mode: "payout", feeSettlement: "units",
      splitBpsApplied: 4000, grossCents: 263_060n, expectedSeq: maxSeq,
      note: null, actorUserId: managerUserId,
    }))).rejects.toThrow(/on or after the unclassified capital event/);
  });

  it("refuses a holder that is not on this account, with CX205", async () => {
    await funded();
    // foreignHolderId (set in beforeEach) is account A's manager holder —
    // a different account from the SAME seedTwoAccounts call that created
    // the account this test runs against.
    const maxSeq = Math.max(...(await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId))).map((e) => e.seq));
    await expect(withAuthenticatedDb(managerUserId, (c) => commitPayout(c, {
      accountId, holderId: foreignHolderId, occurredOn: "2026-08-18",
      settlementEquityCents: 5_574_391n, mode: "payout", feeSettlement: "units",
      splitBpsApplied: 4000, grossCents: 263_060n, expectedSeq: maxSeq,
      note: null, actorUserId: managerUserId,
    }))).rejects.toThrow(/is not on account/);
  });

  it("refuses non-positive settlement equity, with CX207", async () => {
    const adaId = await funded();
    const maxSeq = Math.max(...(await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId))).map((e) => e.seq));
    await expect(withAuthenticatedDb(managerUserId, (c) => commitPayout(c, {
      accountId, holderId: adaId, occurredOn: "2026-08-18",
      settlementEquityCents: 0n, mode: "payout", feeSettlement: "units",
      splitBpsApplied: 4000, grossCents: 263_060n, expectedSeq: maxSeq,
      note: null, actorUserId: managerUserId,
    }))).rejects.toThrow(/settlement equity must be positive/);
  });

  it("refuses an unrecognised mode or fee settlement, with CX208", async () => {
    const adaId = await funded();
    const maxSeq = Math.max(...(await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId))).map((e) => e.seq));
    await expect(withAuthenticatedDb(managerUserId, (c) => c.query(
      `select public.compound_commit_payout($1,$2,'2026-08-18'::date,$3::bigint,
         'withdrawal','units',$4,$5::bigint,$6::bigint,'',$7::uuid)`,
      [accountId, adaId, "5574391", 4000, "263060", String(maxSeq), managerUserId],
    ))).rejects.toThrow(/mode must be payout or exit/);

    await expect(withAuthenticatedDb(managerUserId, (c) => c.query(
      `select public.compound_commit_payout($1,$2,'2026-08-18'::date,$3::bigint,
         'payout','crypto',$4,$5::bigint,$6::bigint,'',$7::uuid)`,
      [accountId, adaId, "5574391", 4000, "263060", String(maxSeq), managerUserId],
    ))).rejects.toThrow(/fee settlement must be units or cash/);
  });
});
