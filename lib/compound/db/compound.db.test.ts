import { fold } from "@/lib/compound/engine/replay";
import {
  getAccountById,
  getAccountByMt5,
  getHolderSeeds,
  getLedgerEntries,
  getReconcileCursor,
  listAccountsForManager,
  listCandidates,
} from "./compound";
import { closeTestPool, resetCompoundTables, seedUser, withTestClient } from "./testing/harness";

const MANAGER = "aaaaaaaa-0000-4000-8000-0000000007a1";
const OTHER_MANAGER = "bbbbbbbb-0000-4000-8000-0000000007b1";
const MT5 = 9_900_701;
const OTHER_MT5 = 9_900_702;

let accountId = 0;
let otherAccountId = 0;
let managerHolder = 0;
let activeHolder = 0;
let closedHolder = 0;

beforeEach(async () => {
  await withTestClient(async (c) => {
    await resetCompoundTables(c);
    await seedUser(c, MANAGER, "compound-mgr@example.test");
    await seedUser(c, OTHER_MANAGER, "compound-mgr-2@example.test");

    const accounts = await c.query<{ id: string }>(
      `insert into public.compound_account
         (mt5_account, label, broker, currency, default_split_bps,
          inception_date, manager_user_id)
       values ($1, 'Primary', 'Fictional Markets', 'USD', 4000, '2026-05-01', $3),
              ($2, 'Secondary', null, 'USD', 3500, '2026-06-01', $4)
       returning id`,
      [MT5, OTHER_MT5, MANAGER, OTHER_MANAGER],
    );
    accountId = Number(accounts.rows[0]!.id);
    otherAccountId = Number(accounts.rows[1]!.id);

    const holders = await c.query<{ id: string }>(
      `insert into public.compound_holder
         (account_id, name, is_manager, split_bps, joined_at, status)
       values ($1, 'Manager',  true,  4000, '2026-05-01', 'active'),
              ($1, 'Investor', false, 3500, '2026-05-10', 'active'),
              ($1, 'Departed', false, 4000, '2026-05-02', 'closed')
       returning id`,
      [accountId],
    );
    managerHolder = Number(holders.rows[0]!.id);
    activeHolder = Number(holders.rows[1]!.id);
    closedHolder = Number(holders.rows[2]!.id);

    // Inserted so that id order (3,1,2), occurred_on order (2,3,1) and seq
    // order (1,2,3) are three different orderings. `order by id` or
    // `order by occurred_on` both produce a wrong list, so the ordering
    // assertion below can actually fail.
    //
    // seq=1's amount is 0, not an arbitrary opening balance: replay.ts/nav.ts
    // define genesis (zero units issued) as NAV 1.00 and unitsForDeposit()
    // *refuses* a deposit against a genesis pool with nonzero equity — see
    // nav.ts's isGenesis/unitsForDeposit — calling that "corrupt state,
    // needs an adjustment entry". A first reading of 1,000,000 (tried here
    // originally) makes seq=2's deposit hit exactly that refusal, since at
    // that point units are still 0 but equity is not. Opening at 0 is the
    // only value the finished engine accepts before any units exist.
    await c.query(
      `insert into public.compound_ledger_entry
         (account_id, holder_id, seq, occurred_on, type, amount_cents,
          fee_settlement, split_bps_applied)
       values ($1, null, 3, '2026-05-20', 'equity_reading', 1050000, null, null),
              ($1, null, 1, '2026-05-31', 'equity_reading', 0,       null, null),
              ($1, $2,   2, '2026-05-25', 'deposit',         500000, null, null)`,
      [accountId, activeHolder],
    );

    await c.query(
      `insert into public.compound_capital_event_candidate
         (account_id, trade_date, balance_delta_cents, explained_cents,
          unexplained_cents, status)
       values ($1, '2026-06-25', 3100000, 0, 3100000, 'pending'),
              ($1, '2026-06-10',  120000, 120000,  0, 'ignored')`,
      [accountId],
    );
  });
});

afterAll(async () => {
  await withTestClient((c) => resetCompoundTables(c));
  await closeTestPool();
});

describe("account lookups", () => {
  it("reads an account by id, with the date as a key and the split as an int", async () => {
    const account = await withTestClient((c) => getAccountById(c, accountId));
    expect(account).toEqual({
      id: accountId,
      mt5Account: MT5,
      label: "Primary",
      broker: "Fictional Markets",
      currency: "USD",
      defaultSplitBps: 4000,
      inceptionDate: "2026-05-01",
      managerUserId: MANAGER,
    });
  });

  it("reads the same account by MT5 login", async () => {
    const account = await withTestClient((c) => getAccountByMt5(c, MT5));
    expect(account?.id).toBe(accountId);
  });

  it("returns null for an account that does not exist", async () => {
    expect(await withTestClient((c) => getAccountById(c, 999_999))).toBeNull();
    expect(await withTestClient((c) => getAccountByMt5(c, 999_999))).toBeNull();
  });

  it("lists only the accounts a given manager owns", async () => {
    const mine = await withTestClient((c) => listAccountsForManager(c, MANAGER));
    const theirs = await withTestClient((c) => listAccountsForManager(c, OTHER_MANAGER));
    expect(mine.map((a) => a.label)).toEqual(["Primary"]);
    expect(theirs.map((a) => a.label)).toEqual(["Secondary"]);
  });

  it("carries a null broker through as null, not as an empty string", async () => {
    const account = await withTestClient((c) => getAccountById(c, otherAccountId));
    expect(account?.broker).toBeNull();
  });
});

describe("getHolderSeeds", () => {
  it("returns every holder including the closed one", async () => {
    const seeds = await withTestClient((c) => getHolderSeeds(c, accountId));
    expect(seeds.map((s) => s.holderId)).toEqual([managerHolder, activeHolder, closedHolder]);
  });

  it("carries is_manager and the holder's own split", async () => {
    const seeds = await withTestClient((c) => getHolderSeeds(c, accountId));
    expect(seeds).toEqual([
      { holderId: managerHolder, isManager: true, splitBps: 4000 },
      { holderId: activeHolder, isManager: false, splitBps: 3500 },
      { holderId: closedHolder, isManager: false, splitBps: 4000 },
    ]);
  });

  it("returns nothing for an account with no holders", async () => {
    expect(await withTestClient((c) => getHolderSeeds(c, otherAccountId))).toEqual([]);
  });
});

describe("getLedgerEntries", () => {
  it("orders by seq, not by id and not by occurred_on", async () => {
    const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    // The three orderings really are different, so the assertion above is
    // testing something. If these ever coincide, rebuild the fixture.
    expect(entries.map((e) => e.id)).not.toEqual([...entries.map((e) => e.id)].sort((a, b) => a - b));
    expect(entries.map((e) => e.occurredOn)).toEqual([
      "2026-05-31",
      "2026-05-25",
      "2026-05-20",
    ]);
  });

  it("maps every field replay.ts reads", async () => {
    const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
    expect(entries[1]).toEqual({
      id: expect.any(Number),
      seq: 2,
      holderId: activeHolder,
      occurredOn: "2026-05-25",
      type: "deposit",
      amountCents: 500000n,
      feeSettlement: null,
      splitBpsApplied: null,
      reversesId: null,
    });
  });

  it("leaves holderId null on a reading", async () => {
    const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
    expect(entries[0]!.holderId).toBeNull();
    expect(entries[0]!.type).toBe("equity_reading");
  });

  it("returns amounts as bigints", async () => {
    const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
    expect(typeof entries[0]!.amountCents).toBe("bigint");
  });

  it("carries fee_settlement, split_bps_applied and reverses_id when present", async () => {
    const entries = await withTestClient(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `select id from public.compound_ledger_entry where account_id = $1 and seq = 1`,
        [accountId],
      );
      await c.query(
        `insert into public.compound_ledger_entry
           (account_id, holder_id, seq, occurred_on, type, amount_cents,
            fee_settlement, split_bps_applied, reverses_id)
         values ($1, $2, 4, '2026-06-01', 'exit', 250000, 'units', 3500, $3)`,
        [accountId, activeHolder, Number(rows[0]!.id)],
      );
      return getLedgerEntries(c, accountId);
    });
    const exit = entries.find((e) => e.seq === 4)!;
    expect(exit.feeSettlement).toBe("units");
    expect(exit.splitBpsApplied).toBe(3500);
    expect(exit.reversesId).toBeGreaterThan(0);
  });

  it("does not leak another account's entries", async () => {
    await withTestClient((c) =>
      c.query(
        `insert into public.compound_ledger_entry
           (account_id, seq, occurred_on, type, amount_cents)
         values ($1, 1, '2026-06-01', 'equity_reading', 999999)`,
        [otherAccountId],
      ),
    );
    const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
    expect(entries.map((e) => e.amountCents)).not.toContain(999999n);
  });

  it("feeds fold() without any adaptation", async () => {
    const state = await withTestClient(async (c) => {
      const entries = await getLedgerEntries(c, accountId);
      const seeds = await getHolderSeeds(c, accountId);
      return fold(entries, seeds);
    });
    // seq 1 opens the pool at 0 (genesis: no units, no equity yet).
    // seq 2 deposits 500,000c: units issue at NAV 1.00 because the pool is
    // still at genesis (zero units AND zero equity) when the deposit lands.
    // seq 3 sets equity to 1,050,000c — the final reading.
    expect(state.equityCents).toBe(1050000n);
    expect(state.lastReadingOn).toBe("2026-05-20");
    expect(state.seq).toBe(3);
    const investor = state.holders.find((h) => h.holderId === activeHolder)!;
    expect(investor.basisCents).toBe(500000n);
    expect(investor.units).toBeGreaterThan(0n);
  });
});

describe("getReconcileCursor", () => {
  it("reports a null date when no cursor row exists", async () => {
    expect(await withTestClient((c) => getReconcileCursor(c, accountId))).toEqual({
      lastReadingDate: null,
    });
  });

  it("reports the stored date as a key", async () => {
    const cursor = await withTestClient(async (c) => {
      await c.query(
        `insert into public.compound_reconcile_cursor (account_id, last_reading_date, last_run_at)
         values ($1, '2026-08-12', now())`,
        [accountId],
      );
      return getReconcileCursor(c, accountId);
    });
    expect(cursor).toEqual({ lastReadingDate: "2026-08-12" });
  });

  it("reports null when the row exists but the date is null", async () => {
    const cursor = await withTestClient(async (c) => {
      await c.query(
        `insert into public.compound_reconcile_cursor (account_id, last_reading_date, last_run_at)
         values ($1, null, now())`,
        [accountId],
      );
      return getReconcileCursor(c, accountId);
    });
    expect(cursor).toEqual({ lastReadingDate: null });
  });
});

describe("listCandidates", () => {
  it("returns every candidate in trade-date order", async () => {
    const rows = await withTestClient((c) => listCandidates(c, accountId));
    expect(rows.map((r) => r.tradeDate)).toEqual(["2026-06-10", "2026-06-25"]);
  });

  it("filters by status when asked", async () => {
    const rows = await withTestClient((c) => listCandidates(c, accountId, "pending"));
    expect(rows.map((r) => r.tradeDate)).toEqual(["2026-06-25"]);
  });

  it("maps the three cent figures as bigints", async () => {
    const rows = await withTestClient((c) => listCandidates(c, accountId, "pending"));
    expect(rows[0]!.balanceDeltaCents).toBe(3100000n);
    expect(rows[0]!.explainedCents).toBe(0n);
    expect(rows[0]!.unexplainedCents).toBe(3100000n);
  });

  it("renders detected_at as an ISO instant", async () => {
    const rows = await withTestClient((c) => listCandidates(c, accountId, "pending"));
    expect(rows[0]!.detectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("returns nothing for an account with no candidates", async () => {
    expect(await withTestClient((c) => listCandidates(c, otherAccountId))).toEqual([]);
  });
});
