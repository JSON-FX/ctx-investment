import {
  getAccountOwnerUserId,
  getClosedDeals,
  getDailySnapshots,
  getLiveSnapshot,
} from "./copytraderx";
import { closeTestPool, seedUser, withTestClient } from "./testing/harness";

/** Fictional. Isolated from the shipped seed's 90000001. */
const MT5 = 9_900_601;
const OTHER_MT5 = 9_900_602;
const OWNER = "aaaaaaaa-0000-4000-8000-0000000006a1";

beforeAll(async () => {
  await withTestClient(async (c) => {
    await c.query("delete from public.deals where mt5_account = any($1::bigint[])", [
      [MT5, OTHER_MT5],
    ]);
    await c.query(
      "delete from public.account_snapshots_daily where mt5_account = any($1::bigint[])",
      [[MT5, OTHER_MT5]],
    );
    await c.query(
      "delete from public.account_snapshots_current where mt5_account = any($1::bigint[])",
      [[MT5, OTHER_MT5]],
    );
    await c.query("delete from public.licenses where mt5_account = any($1::bigint[])", [
      [MT5, OTHER_MT5],
    ]);
    await seedUser(c, OWNER, "ctx-owner@example.test");

    // Every money value below is picked because a float path gets it wrong.
    //   10000.05 * 100 is 1000004.9999999998836 in IEEE 754 → trunc gives 1000004
    //   10000.29 * 100 → trunc gives 1000028
    //        0.29 * 100 is 28.999999999999996  → trunc gives 28
    //       -2.05 * 100 is -204.99999999999997 → trunc gives -204
    // 1234.56 is included as a control: it converts correctly either way, and
    // is here so the suite does not look like it only ever uses odd numbers.
    await c.query(
      `insert into public.account_snapshots_daily
         (mt5_account, trade_date, balance_close, equity_close, daily_pnl)
       values ($1, '2026-08-03', 10000.05, 10000.29, 0.00),
              ($1, '2026-08-04', 10123.45, 10123.45, 123.40),
              ($1, '2026-08-05', 10250.13, 10199.87, 126.68),
              ($2, '2026-08-04', 55555.55, 55555.55, 0.00)`,
      [MT5, OTHER_MT5],
    );

    await c.query(
      `insert into public.deals
         (mt5_account, ticket, ea_source, symbol, side, volume,
          open_price, close_price, open_time, close_time,
          profit, swap, commission)
       values
         ($1, 9901001, 'impulse', 'EURUSD', 'buy',  0.05, 1.0, 1.0,
          '2026-08-04T07:00:00+00', '2026-08-04T08:00:00+00', 1234.56, -2.05, -0.29),
         ($1, 9901002, 'impulse', 'BTCUSD', 'sell', 0.03, 1.0, 1.0,
          '2026-08-05T07:00:00+00', '2026-08-05T09:30:00+00', -50.26, 0.00, -0.29),
         ($2, 9901099, 'impulse', 'GBPUSD', 'buy',  1.00, 1.0, 1.0,
          '2026-08-04T07:00:00+00', '2026-08-04T08:00:00+00', 10.00, 0.00, 0.00)`,
      [MT5, OTHER_MT5],
    );

    await c.query(
      `insert into public.account_snapshots_current
         (mt5_account, balance, equity, margin, free_margin, margin_level,
          floating_pnl, drawdown_pct, leverage, currency, server, pushed_at)
       values ($1, 10250.13, 10199.87, 100.00, 10099.87, 1000.0,
               -50.26, 0.5, 500, 'USD', 'Fictional-Demo', '2026-08-05T21:00:00+00')`,
      [MT5],
    );

    await c.query(
      `insert into public.licenses (mt5_account, product, status, user_id)
       values ($1, 'impulse', 'active', $2)`,
      [MT5, OWNER],
    );
  });
});

afterAll(async () => {
  await withTestClient(async (c) => {
    await c.query("delete from public.deals where mt5_account = any($1::bigint[])", [
      [MT5, OTHER_MT5],
    ]);
    await c.query(
      "delete from public.account_snapshots_daily where mt5_account = any($1::bigint[])",
      [[MT5, OTHER_MT5]],
    );
    await c.query(
      "delete from public.account_snapshots_current where mt5_account = any($1::bigint[])",
      [[MT5, OTHER_MT5]],
    );
    await c.query("delete from public.licenses where mt5_account = any($1::bigint[])", [
      [MT5, OTHER_MT5],
    ]);
  });
  await closeTestPool();
});

describe("getDailySnapshots", () => {
  it("returns every day for the account, in date order", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, MT5));
    expect(rows.map((r) => r.tradeDate)).toEqual(["2026-08-03", "2026-08-04", "2026-08-05"]);
  });

  it("converts dollars to cents without a float in sight", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, MT5));
    // 1000005, not 1000004. This is the assertion the whole SQL-side
    // conversion exists for.
    expect(rows[0]!.balanceCloseCents).toBe(1000005n);
    expect(rows[0]!.equityCloseCents).toBe(1000029n);
    expect(rows[1]!.balanceCloseCents).toBe(1012345n);
    expect(rows[2]!.balanceCloseCents).toBe(1025013n);
  });

  it("keeps balance and equity distinct — they are different facts", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, MT5));
    expect(rows[2]!.balanceCloseCents).toBe(1025013n);
    expect(rows[2]!.equityCloseCents).toBe(1019987n);
    expect(rows[2]!.balanceCloseCents).not.toBe(rows[2]!.equityCloseCents);
  });

  it("returns bigints, not numbers", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, MT5));
    expect(typeof rows[0]!.balanceCloseCents).toBe("bigint");
  });

  it("does not leak another account's rows", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, MT5));
    expect(rows.map((r) => r.balanceCloseCents)).not.toContain(5555555n);
  });

  it("honours an inclusive from bound", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, MT5, { from: "2026-08-04" }));
    expect(rows.map((r) => r.tradeDate)).toEqual(["2026-08-04", "2026-08-05"]);
  });

  it("honours an inclusive to bound", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, MT5, { to: "2026-08-04" }));
    expect(rows.map((r) => r.tradeDate)).toEqual(["2026-08-03", "2026-08-04"]);
  });

  it("returns nothing for an account with no snapshots", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, 9_909_999));
    expect(rows).toEqual([]);
  });
});

describe("getClosedDeals", () => {
  it("returns the account's deals in ticket order", async () => {
    const deals = await withTestClient((c) => getClosedDeals(c, MT5));
    expect(deals.map((d) => d.ticket)).toEqual([9901001, 9901002]);
  });

  it("converts profit, swap and commission to exact cents including negatives", async () => {
    const deals = await withTestClient((c) => getClosedDeals(c, MT5));
    expect(deals[0]!.profitCents).toBe(123456n);
    // -205, not -204.
    expect(deals[0]!.swapCents).toBe(-205n);
    // -29, not -28.
    expect(deals[0]!.commissionCents).toBe(-29n);
    expect(deals[1]!.profitCents).toBe(-5026n);
  });

  it("converts lots to milli-lots as an integer", async () => {
    const deals = await withTestClient((c) => getClosedDeals(c, MT5));
    expect(deals[0]!.volumeMilliLots).toBe(50);
    expect(deals[1]!.volumeMilliLots).toBe(30);
    expect(Number.isInteger(deals[0]!.volumeMilliLots)).toBe(true);
  });

  it("renders both timestamps as ISO instants in UTC", async () => {
    const deals = await withTestClient((c) => getClosedDeals(c, MT5));
    expect(deals[0]!.openTime).toBe("2026-08-04T07:00:00.000Z");
    expect(deals[0]!.closeTime).toBe("2026-08-04T08:00:00.000Z");
    expect(deals[1]!.closeTime).toBe("2026-08-05T09:30:00.000Z");
  });

  it("produces timestamps reconcile/date-key.ts can parse", async () => {
    const { utcDateKey } = await import("@/lib/compound/reconcile/date-key");
    const deals = await withTestClient((c) => getClosedDeals(c, MT5));
    expect(utcDateKey(deals[0]!.closeTime)).toBe("2026-08-04");
    expect(utcDateKey(deals[1]!.closeTime)).toBe("2026-08-05");
  });

  it("feeds dealNetCents correctly", async () => {
    const { dealNetCents } = await import("@/lib/compound/reconcile/types");
    const deals = await withTestClient((c) => getClosedDeals(c, MT5));
    // 123456 + (-205) + (-29)
    expect(dealNetCents(deals[0]!)).toBe(123222n);
  });

  it("filters on the UTC calendar day of close_time", async () => {
    const deals = await withTestClient((c) => getClosedDeals(c, MT5, { from: "2026-08-05" }));
    expect(deals.map((d) => d.ticket)).toEqual([9901002]);
  });

  it("does not leak another account's deals", async () => {
    const deals = await withTestClient((c) => getClosedDeals(c, MT5));
    expect(deals.map((d) => d.ticket)).not.toContain(9901099);
  });

  it("refuses a side value it does not recognise rather than casting it", async () => {
    await withTestClient(async (c) => {
      await c.query(
        `insert into public.deals
           (mt5_account, ticket, ea_source, symbol, side, volume,
            open_price, close_price, open_time, close_time, profit, swap, commission)
         values ($1, 9901003, 'impulse', 'EURUSD', 'BUY', 0.01, 1.0, 1.0,
                 '2026-08-06T07:00:00+00', '2026-08-06T08:00:00+00', 1.00, 0.00, 0.00)`,
        [MT5],
      );
    });
    try {
      await expect(withTestClient((c) => getClosedDeals(c, MT5))).rejects.toThrow(
        /deals\.side: expected "buy" or "sell", got "BUY"/,
      );
    } finally {
      await withTestClient((c) =>
        c.query("delete from public.deals where ticket = 9901003 and mt5_account = $1", [MT5]),
      );
    }
  });
});

describe("getLiveSnapshot", () => {
  it("returns the live figures with equity and balance apart", async () => {
    const snap = await withTestClient((c) => getLiveSnapshot(c, MT5));
    expect(snap).toEqual({
      mt5Account: MT5,
      balanceCents: 1025013n,
      equityCents: 1019987n,
      floatingPnlCents: -5026n,
      currency: "USD",
      server: "Fictional-Demo",
      pushedAt: "2026-08-05T21:00:00.000Z",
    });
  });

  it("returns null when the account has never pushed", async () => {
    const snap = await withTestClient((c) => getLiveSnapshot(c, 9_909_999));
    expect(snap).toBeNull();
  });
});

describe("getAccountOwnerUserId", () => {
  it("resolves an MT5 account to its public.users owner", async () => {
    const owner = await withTestClient((c) => getAccountOwnerUserId(c, MT5));
    expect(owner).toBe(OWNER);
  });

  it("returns null for an unlicensed account rather than throwing", async () => {
    const owner = await withTestClient((c) => getAccountOwnerUserId(c, 9_909_999));
    expect(owner).toBeNull();
  });

  it("ignores a revoked licence", async () => {
    await withTestClient((c) =>
      c.query(
        `insert into public.licenses (mt5_account, product, status, user_id)
         values ($1, 'impulse', 'revoked', $2)`,
        [OTHER_MT5, OWNER],
      ),
    );
    try {
      const owner = await withTestClient((c) => getAccountOwnerUserId(c, OTHER_MT5));
      expect(owner).toBeNull();
    } finally {
      await withTestClient((c) =>
        c.query("delete from public.licenses where mt5_account = $1", [OTHER_MT5]),
      );
    }
  });
});

describe("the 2^53 boundary", () => {
  /**
   * A balance of $90,071,992,547,409.93 is deliberately absurd. It is here
   * because 90071992547409.93 * 100 is exactly 2^53 + 1 — the first integer a
   * JavaScript number cannot represent — so any path that touches a float
   * returns 9007199254740992 and this test says so.
   */
  const BIG_MT5 = 9_900_699;

  beforeAll(async () => {
    await withTestClient((c) =>
      c.query(
        `insert into public.account_snapshots_daily
           (mt5_account, trade_date, balance_close, equity_close, daily_pnl)
         values ($1, '2026-08-03', 90071992547409.93, 90071992547409.93, 0.00)`,
        [BIG_MT5],
      ),
    );
  });

  afterAll(async () => {
    await withTestClient((c) =>
      c.query("delete from public.account_snapshots_daily where mt5_account = $1", [BIG_MT5]),
    );
  });

  it("survives the round trip exactly", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, BIG_MT5));
    expect(rows[0]!.balanceCloseCents).toBe(9007199254740993n);
    expect(Number(rows[0]!.balanceCloseCents)).toBe(9007199254740992); // for contrast
  });
});
