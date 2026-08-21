/**
 * Integration. Runs under jest.db.config.mjs against the local stack.
 *
 * Mirrors write-payout.db.test.ts's structure and its funded() fixture
 * pattern closely — same two-account seed, same beforeEach/afterAll shape —
 * but with its own settlement figures, chosen so the capital/profit split
 * and the cap boundaries are easy to verify by hand: manager deposits
 * $25,000, Ada deposits $10,000 (35,000 units at NAV 1.00, genesis), then
 * the withdrawal's own settlement reading of $70,000 doubles NAV to 2.00,
 * putting Ada's value at exactly $20,000 (the cap for these tests) against
 * her $10,000 basis.
 */
import { withDb, withDbTransaction } from "@/lib/compound/db/client";
import { getHolderSeeds, getLedgerEntries } from "@/lib/compound/db/compound";
import { listHolders } from "@/lib/compound/db/holders";
import { commitDeposit } from "@/lib/compound/db/write-deposit";
import { addHolder } from "@/lib/compound/db/write-holder";
import { commitWithdrawal } from "@/lib/compound/db/write-withdrawal";
import {
  closeTestPool, resetCompoundTables, seedTwoAccounts, withTestClient,
} from "@/lib/compound/db/testing/harness";
import { assertInvariants, checkInvariants } from "@/lib/compound/engine/invariants";
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
    foreignHolderId = accountA.holderIds[0]!;
    managerHolderId = accountB.holderIds[0]!;
  });
});

afterAll(async () => {
  await withTestClient((c) => resetCompoundTables(c));
  await closeTestPool();
});

/** Funds the seeded account: manager in for 25,000, Ada in for 10,000. */
async function funded(): Promise<number> {
  await withDb((c) => commitDeposit(c, {
    accountId, holderId: managerHolderId, occurredOn: "2026-03-02",
    amountCents: 2_500_000n, note: null, actorUserId: managerUserId,
  }));
  const adaId = await withDb((c) => addHolder(c, {
    accountId, name: "Ada Lovelace", email: null, splitBps: 4000,
    joinedAt: "2026-05-04", actorUserId: managerUserId,
  }));
  await withDb((c) => commitDeposit(c, {
    accountId, holderId: adaId, occurredOn: "2026-05-04",
    amountCents: 1_000_000n, note: null, actorUserId: managerUserId,
  }));
  return adaId;
}

async function maxSeq(): Promise<number> {
  return Math.max(...(await withDb((c) => getLedgerEntries(c, accountId))).map((e) => e.seq));
}

// Settlement equity $70,000 -> NAV 2.00. Ada's 10,000 units are worth
// $20,000 against her $10,000 basis — the cap for every boundary test below.
const SETTLEMENT_EQUITY = 7_000_000n;
const ADA_CAP = 2_000_000n; // $20,000

describe("commitWithdrawal", () => {
  it("writes the settlement reading and the withdrawal, in that order, adjacent", async () => {
    const adaId = await funded();
    const seq = await maxSeq();

    const r = await withDb((c) => commitWithdrawal(c, {
      accountId, holderId: adaId, occurredOn: "2026-08-18",
      settlementEquityCents: SETTLEMENT_EQUITY, amountCents: 800_000n,
      holderValueCents: ADA_CAP, feeSettlement: "units",
      splitBpsApplied: 4000, expectedSeq: seq, note: null, actorUserId: managerUserId,
    }));

    const after = await withDb((c) => getLedgerEntries(c, accountId));
    const reading = after.find((e) => e.id === r.readingEntryId)!;
    const withdrawal = after.find((e) => e.id === r.withdrawalEntryId)!;
    expect(reading.type).toBe("equity_reading");
    expect(reading.seq).toBe(seq + 1);
    expect(reading.amountCents).toBe(SETTLEMENT_EQUITY);
    expect(withdrawal.type).toBe("withdrawal");
    expect(withdrawal.seq).toBe(seq + 2);
    expect(withdrawal.amountCents).toBe(800_000n); // the requested A, not toHolderCents
    expect(withdrawal.splitBpsApplied).toBe(4000);
    expect(withdrawal.feeSettlement).toBe("units");
  });

  it("folds to a state that satisfies every invariant, and matches quote()'s split by hand", async () => {
    const adaId = await funded();
    const seq = await maxSeq();
    await withDb((c) => commitWithdrawal(c, {
      accountId, holderId: adaId, occurredOn: "2026-08-18",
      settlementEquityCents: SETTLEMENT_EQUITY, amountCents: 800_000n,
      holderValueCents: ADA_CAP, feeSettlement: "units",
      splitBpsApplied: 4000, expectedSeq: seq, note: null, actorUserId: managerUserId,
    }));
    const state = fold(
      await withDb((c) => getLedgerEntries(c, accountId)),
      await withDb((c) => getHolderSeeds(c, accountId)),
    );
    expect(() => assertInvariants(state)).not.toThrow();

    const ada = state.holders.find((h) => h.holderId === adaId)!;
    // By hand: value $20,000, basis $10,000, profit $10,000. Withdraw
    // $8,000: capital slice 8000*10000/20000=4000, profit slice 4000,
    // fee 4000*40%=1600. New basis 10000-4000=6000.
    expect(ada.basisCents).toBe(6_000_00n);
    // Units redeemed = 8000/NAV(2.00) = 4000 units; Ada started with 10,000.
    expect(ada.units).toBe(6_000n * 10_000_000_000n); // 6,000 units remaining
  });

  it("refuses when the account has moved since the receipt, with CX204", async () => {
    const adaId = await funded();
    const seq = await maxSeq();
    await expect(withDb((c) => commitWithdrawal(c, {
      accountId, holderId: adaId, occurredOn: "2026-08-18",
      settlementEquityCents: SETTLEMENT_EQUITY, amountCents: 800_000n,
      holderValueCents: ADA_CAP, feeSettlement: "units",
      splitBpsApplied: 4000, expectedSeq: seq - 1, note: null, actorUserId: managerUserId,
    }))).rejects.toThrow(/the receipt was worked out at entry/);

    await expect(withDb((c) => commitWithdrawal(c, {
      accountId, holderId: adaId, occurredOn: "2026-08-18",
      settlementEquityCents: SETTLEMENT_EQUITY, amountCents: 800_000n,
      holderValueCents: ADA_CAP, feeSettlement: "units",
      splitBpsApplied: 4000, expectedSeq: seq, note: null, actorUserId: managerUserId,
    }))).resolves.toBeDefined();
  });

  it("writes nothing at all when the seq check fails", async () => {
    const adaId = await funded();
    const before = (await withDb((c) => getLedgerEntries(c, accountId))).length;
    await expect(withDb((c) => commitWithdrawal(c, {
      accountId, holderId: adaId, occurredOn: "2026-08-18",
      settlementEquityCents: SETTLEMENT_EQUITY, amountCents: 800_000n,
      holderValueCents: ADA_CAP, feeSettlement: "units",
      splitBpsApplied: 4000, expectedSeq: 0, note: null, actorUserId: managerUserId,
    }))).rejects.toThrow();
    expect((await withDb((c) => getLedgerEntries(c, accountId))).length).toBe(before);
  });

  it("leaves no orphan reading when the withdrawal insert fails", async () => {
    const adaId = await funded();
    const before = (await withDb((c) => getLedgerEntries(c, accountId))).length;
    const seq = await maxSeq();

    // split_bps_applied out of range (compound_ledger_entry's own CHECK)
    // fails on the SECOND insert, after the reading has already been written
    // inside this same function call — proves the two inserts are one
    // transaction, exactly like write-payout.db.test.ts's equivalent test.
    // Calling the raw SQL function directly, bypassing commitWithdrawal's
    // own client-side range check, which would otherwise refuse this before
    // it ever reached the database.
    await expect(withDb((c) => c.query(
      `select public.compound_commit_withdrawal($1,$2,'2026-08-18'::date,$3::bigint,
         $4::bigint,$5::bigint,'units',$6,$7::bigint,'',$8::uuid)`,
      [accountId, adaId, SETTLEMENT_EQUITY.toString(), "800000",
        ADA_CAP.toString(), 99_999, String(seq), managerUserId],
    ))).rejects.toThrow();
    expect((await withDb((c) => getLedgerEntries(c, accountId))).length).toBe(before);
  });

  it("does not move the reconcile cursor", async () => {
    const adaId = await funded();
    await withDb((c) => c.query(
      `insert into public.compound_reconcile_cursor (account_id, last_reading_date)
       values ($1, '2026-08-14')
       on conflict (account_id) do update set last_reading_date = excluded.last_reading_date`,
      [accountId],
    ));
    const seq = await maxSeq();
    await withDb((c) => commitWithdrawal(c, {
      accountId, holderId: adaId, occurredOn: "2026-08-18",
      settlementEquityCents: SETTLEMENT_EQUITY, amountCents: 800_000n,
      holderValueCents: ADA_CAP, feeSettlement: "units",
      splitBpsApplied: 4000, expectedSeq: seq, note: null, actorUserId: managerUserId,
    }));
    const { rows } = await withDb((c) => c.query<{ last_reading_date: string }>(
      `select last_reading_date::text from public.compound_reconcile_cursor where account_id = $1`,
      [accountId],
    ));
    expect(rows[0]!.last_reading_date).toBe("2026-08-14");
  });

  it("refuses a withdrawal dated on or after an unclassified capital event", async () => {
    const adaId = await funded();
    await withDb((c) => c.query(
      `insert into public.compound_capital_event_candidate
         (account_id, trade_date, balance_delta_cents, explained_cents, unexplained_cents)
       values ($1, '2026-08-12', 500000, 0, 500000)`, [accountId],
    ));
    const seq = await maxSeq();
    await expect(withDb((c) => commitWithdrawal(c, {
      accountId, holderId: adaId, occurredOn: "2026-08-18",
      settlementEquityCents: SETTLEMENT_EQUITY, amountCents: 800_000n,
      holderValueCents: ADA_CAP, feeSettlement: "units",
      splitBpsApplied: 4000, expectedSeq: seq, note: null, actorUserId: managerUserId,
    }))).rejects.toThrow(/on or after the unclassified capital event/);
  });

  it("refuses a holder that is not on this account, with CX205", async () => {
    await funded();
    const seq = await maxSeq();
    await expect(withDb((c) => commitWithdrawal(c, {
      accountId, holderId: foreignHolderId, occurredOn: "2026-08-18",
      settlementEquityCents: SETTLEMENT_EQUITY, amountCents: 800_000n,
      holderValueCents: ADA_CAP, feeSettlement: "units",
      splitBpsApplied: 4000, expectedSeq: seq, note: null, actorUserId: managerUserId,
    }))).rejects.toThrow(/is not on account/);
  });

  it("refuses non-positive settlement equity, with CX207", async () => {
    const adaId = await funded();
    const seq = await maxSeq();
    await expect(withDb((c) => commitWithdrawal(c, {
      accountId, holderId: adaId, occurredOn: "2026-08-18",
      settlementEquityCents: 0n, amountCents: 800_000n,
      holderValueCents: ADA_CAP, feeSettlement: "units",
      splitBpsApplied: 4000, expectedSeq: seq, note: null, actorUserId: managerUserId,
    }))).rejects.toThrow(/settlement equity must be positive/);
  });

  it("refuses an unrecognised fee settlement, with CX208", async () => {
    const adaId = await funded();
    const seq = await maxSeq();
    await expect(withDb((c) => c.query(
      `select public.compound_commit_withdrawal($1,$2,'2026-08-18'::date,$3::bigint,
         $4::bigint,$5::bigint,'crypto',$6,$7::bigint,'',$8::uuid)`,
      [accountId, adaId, SETTLEMENT_EQUITY.toString(), "800000",
        ADA_CAP.toString(), 4000, String(seq), managerUserId],
    ))).rejects.toThrow(/fee settlement must be units or cash/);
  });

  describe("the cap — a holder may never withdraw more than they hold", () => {
    it("refuses a non-positive amount, with CX212", async () => {
      const adaId = await funded();
      const seq = await maxSeq();
      await expect(withDb((c) => commitWithdrawal(c, {
        accountId, holderId: adaId, occurredOn: "2026-08-18",
        settlementEquityCents: SETTLEMENT_EQUITY, amountCents: 0n,
        holderValueCents: ADA_CAP, feeSettlement: "units",
        splitBpsApplied: 4000, expectedSeq: seq, note: null, actorUserId: managerUserId,
      }))).rejects.toThrow(/withdrawal amount must be positive/);

      // The client-side check is a fast local refusal, not the authority —
      // prove the database refuses it too, bypassing the TS-level guard.
      await expect(withDb((c) => c.query(
        `select public.compound_commit_withdrawal($1,$2,'2026-08-18'::date,$3::bigint,
           $4::bigint,$5::bigint,'units',$6,$7::bigint,'',$8::uuid)`,
        [accountId, adaId, SETTLEMENT_EQUITY.toString(), "-100",
          ADA_CAP.toString(), 4000, String(seq), managerUserId],
      ))).rejects.toMatchObject({ code: "CX212" });
    });

    it("refuses one cent over the cap, with CX213, naming the cap", async () => {
      const adaId = await funded();
      const seq = await maxSeq();
      const over = ADA_CAP + 1n;
      await expect(withDb((c) => commitWithdrawal(c, {
        accountId, holderId: adaId, occurredOn: "2026-08-18",
        settlementEquityCents: SETTLEMENT_EQUITY, amountCents: over,
        holderValueCents: ADA_CAP, feeSettlement: "units",
        splitBpsApplied: 4000, expectedSeq: seq, note: null, actorUserId: managerUserId,
      }))).rejects.toThrow(/exceeds the holder's value of 2000000 cents/);

      // Bypass the client-side guard too, proving the database is the
      // authority and not merely a mirror of the TypeScript check.
      await expect(withDb((c) => c.query(
        `select public.compound_commit_withdrawal($1,$2,'2026-08-18'::date,$3::bigint,
           $4::bigint,$5::bigint,'units',$6,$7::bigint,'',$8::uuid)`,
        [accountId, adaId, SETTLEMENT_EQUITY.toString(), over.toString(),
          ADA_CAP.toString(), 4000, String(seq), managerUserId],
      ))).rejects.toMatchObject({ code: "CX213" });
    });

    it("succeeds one cent under the cap, and does not close the holder", async () => {
      const adaId = await funded();
      const seq = await maxSeq();
      await withDb((c) => commitWithdrawal(c, {
        accountId, holderId: adaId, occurredOn: "2026-08-18",
        settlementEquityCents: SETTLEMENT_EQUITY, amountCents: ADA_CAP - 1n,
        holderValueCents: ADA_CAP, feeSettlement: "units",
        splitBpsApplied: 4000, expectedSeq: seq, note: null, actorUserId: managerUserId,
      }));
      const stored = (await withDb((c) => listHolders(c, accountId))).find((h) => h.id === adaId)!;
      const derived = fold(
        await withDb((c) => getLedgerEntries(c, accountId)),
        await withDb((c) => getHolderSeeds(c, accountId)),
      ).holders.find((h) => h.holderId === adaId)!;
      expect(stored.status).toBe("active");
      expect(derived.status).toBe("active");
      expect(derived.units > 0n).toBe(true);
    });

    it("succeeds at exactly the cap, redeems every unit, and closes the holder like an exit", async () => {
      const adaId = await funded();
      const seq = await maxSeq();
      await withDb((c) => commitWithdrawal(c, {
        accountId, holderId: adaId, occurredOn: "2026-08-18",
        settlementEquityCents: SETTLEMENT_EQUITY, amountCents: ADA_CAP,
        holderValueCents: ADA_CAP, feeSettlement: "units",
        splitBpsApplied: 4000, expectedSeq: seq, note: null, actorUserId: managerUserId,
      }));
      const stored = (await withDb((c) => listHolders(c, accountId))).find((h) => h.id === adaId)!;
      const state = fold(
        await withDb((c) => getLedgerEntries(c, accountId)),
        await withDb((c) => getHolderSeeds(c, accountId)),
      );
      const derived = state.holders.find((h) => h.holderId === adaId)!;
      expect(stored.status).toBe("closed");
      expect(derived.status).toBe("closed");
      expect(derived.units).toBe(0n);
      expect(derived.basisCents).toBe(0n);
      expect(checkInvariants(state)).toEqual([]);
    });
  });
});
