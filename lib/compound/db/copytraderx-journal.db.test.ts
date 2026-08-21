import { getOpenPositions, getOrders } from "./copytraderx";
import { closeTestPool, withTestClient } from "./testing/harness";

/** Fictional. Isolated from the shipped seed and from plan 3's fixtures. */
const MT5 = 9_900_701;
const OTHER_MT5 = 9_900_702;

beforeAll(async () => {
  await withTestClient(async (c) => {
    await c.query("delete from public.positions where mt5_account = any($1::bigint[])", [
      [MT5, OTHER_MT5],
    ]);
    await c.query("delete from public.orders where mt5_account = any($1::bigint[])", [
      [MT5, OTHER_MT5],
    ]);

    // -2.05 * 100 is -204.99999999999997 in IEEE 754, so a float path gives
    // -204. 0.29 * 100 is 28.999999999999996, so a float path gives 28.
    await c.query(
      `insert into public.positions
         (mt5_account, ticket, ea_source, symbol, side, volume,
          open_price, current_price, sl, tp, profit, swap, commission,
          open_time, comment)
       values
         ($1, 8801, 'impulse', 'EURUSD', 'buy',  0.05, 1.09341, 1.09507,
          1.09000, null, 83.00, -2.05, -0.29, '2026-05-08T07:00:00+00', 'grid-1'),
         ($1, 8802, 'impulse', 'XAUUSD', 'sell', 0.12, 2411.55000, 2409.10000,
          null, 2400.00000, -29.40, 0.00, -0.72, '2026-05-08T09:15:00+00', null),
         ($2, 8899, 'impulse', 'GBPUSD', 'buy',  1.00, 1.26000, 1.26100,
          null, null, 100.00, 0.00, 0.00, '2026-05-08T10:00:00+00', null)`,
      [MT5, OTHER_MT5],
    );

    await c.query(
      `insert into public.orders
         (mt5_account, ticket, ea_source, symbol, type, state,
          volume_initial, volume_current, price_open, price_current,
          sl, tp, time_setup, time_done, comment)
       values
         ($1, 7701, 'impulse', 'EURUSD', 'order_type_buy',        'order_state_filled',
          0.05, 0.00, 1.09341, null, null, null,
          '2026-05-08T06:59:00+00', '2026-05-08T07:00:00+00', null),
         ($1, 7702, 'impulse', 'XAUUSD', 'order_type_sell_limit', 'order_state_placed',
          0.12, 0.12, 2415.00000, 2409.10000, null, null,
          '2026-05-09T08:00:00+00', null, 'pending'),
         ($1, 7703, 'impulse', 'BTCUSD', 'order_type_buy_stop',   'order_state_canceled',
          0.01, 0.01, 61000.00000, null, null, null,
          '2026-05-10T23:45:00+00', '2026-05-11T00:05:00+00', null),
         ($2, 7799, 'impulse', 'GBPUSD', 'order_type_buy',        'order_state_filled',
          1.00, 0.00, 1.26000, null, null, null,
          '2026-05-08T10:00:00+00', '2026-05-08T10:00:01+00', null)`,
      [MT5, OTHER_MT5],
    );
  });
});

afterAll(async () => {
  await withTestClient(async (c) => {
    await c.query("delete from public.positions where mt5_account = any($1::bigint[])", [
      [MT5, OTHER_MT5],
    ]);
    await c.query("delete from public.orders where mt5_account = any($1::bigint[])", [
      [MT5, OTHER_MT5],
    ]);
  });
  await closeTestPool();
});

describe("getOpenPositions", () => {
  it("returns the account's positions in open-time order", async () => {
    const rows = await withTestClient((c) => getOpenPositions(c, MT5));
    expect(rows.map((r) => r.ticket)).toEqual([8801, 8802]);
  });

  // Mutation caught: converting cents in JavaScript. -205, not -204; -29, not -28.
  it("converts money to exact cents including negatives", async () => {
    const rows = await withTestClient((c) => getOpenPositions(c, MT5));
    expect(rows[0]!.profitCents).toBe(8300n);
    expect(rows[0]!.swapCents).toBe(-205n);
    expect(rows[0]!.commissionCents).toBe(-29n);
    expect(rows[1]!.profitCents).toBe(-2940n);
    expect(typeof rows[0]!.profitCents).toBe("bigint");
  });

  // Mutation caught: parsing a price with Number(), which drops trailing
  // precision and turns 2411.55000 into 2411.55 — a different string on screen
  // from what the terminal shows.
  it("returns prices verbatim as strings", async () => {
    const rows = await withTestClient((c) => getOpenPositions(c, MT5));
    expect(rows[0]!.openPrice).toBe("1.09341");
    expect(rows[1]!.openPrice).toBe("2411.55000");
    expect(typeof rows[0]!.openPrice).toBe("string");
  });

  // Mutation caught: coalescing a null stop to 0, which renders as a stop at
  // zero — a materially wrong statement about the position.
  it("keeps an absent stop or target null", async () => {
    const rows = await withTestClient((c) => getOpenPositions(c, MT5));
    expect(rows[0]!.slPrice).toBe("1.09000");
    expect(rows[0]!.tpPrice).toBeNull();
    expect(rows[1]!.slPrice).toBeNull();
  });

  it("converts lots to integer milli-lots", async () => {
    const rows = await withTestClient((c) => getOpenPositions(c, MT5));
    expect(rows[0]!.volumeMilliLots).toBe(50);
    expect(rows[1]!.volumeMilliLots).toBe(120);
  });

  it("does not leak another account's positions", async () => {
    const rows = await withTestClient((c) => getOpenPositions(c, MT5));
    expect(rows.map((r) => r.ticket)).not.toContain(8899);
  });

  it("returns nothing for an account with no open positions", async () => {
    expect(await withTestClient((c) => getOpenPositions(c, 9_909_999))).toEqual([]);
  });
});

describe("getOrders", () => {
  it("returns the account's orders newest first", async () => {
    const rows = await withTestClient((c) => getOrders(c, MT5));
    expect(rows.map((r) => r.ticket)).toEqual([7703, 7702, 7701]);
  });

  // Mutation caught: rendering a null timestamp as the string "null".
  it("keeps an unfinished order's time_done null", async () => {
    const rows = await withTestClient((c) => getOrders(c, MT5));
    const pending = rows.find((r) => r.ticket === 7702)!;
    expect(pending.timeDone).toBeNull();
    expect(pending.priceCurrent).toBe("2409.10000");
    const filled = rows.find((r) => r.ticket === 7701)!;
    expect(filled.timeDone).toBe("2026-05-08T07:00:00.000Z");
    expect(filled.priceCurrent).toBeNull();
  });

  // Mutation caught: mapping the raw constants to labels in SQL. The UI layer
  // humanises them; the reader must not, or an unrecognised constant is lost
  // before anyone can see it.
  it("returns raw MT5 type and state constants", async () => {
    const rows = await withTestClient((c) => getOrders(c, MT5));
    expect(rows.map((r) => r.type).sort()).toEqual([
      "order_type_buy",
      "order_type_buy_stop",
      "order_type_sell_limit",
    ]);
    expect(rows.find((r) => r.ticket === 7703)!.state).toBe("order_state_canceled");
  });

  it("keeps initial and current volume apart", async () => {
    const rows = await withTestClient((c) => getOrders(c, MT5));
    const filled = rows.find((r) => r.ticket === 7701)!;
    expect(filled.volumeInitialMilliLots).toBe(50);
    expect(filled.volumeCurrentMilliLots).toBe(0);
  });

  // Mutation caught: comparing time_setup against a bare date, which resolves
  // in the session timezone. Ticket 7703 is set up at 23:45 UTC on 05-10.
  it("filters on the UTC calendar day of time_setup", async () => {
    const rows = await withTestClient((c) => getOrders(c, MT5, { from: "2026-05-10" }));
    expect(rows.map((r) => r.ticket)).toEqual([7703]);
    const to = await withTestClient((c) => getOrders(c, MT5, { to: "2026-05-08" }));
    expect(to.map((r) => r.ticket)).toEqual([7701]);
  });

  it("does not leak another account's orders", async () => {
    const rows = await withTestClient((c) => getOrders(c, MT5));
    expect(rows.map((r) => r.ticket)).not.toContain(7799);
  });
});
