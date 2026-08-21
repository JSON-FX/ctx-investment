import {
  applyOrderFilters,
  applyPositionSort,
  classifyOrderState,
  ORDER_SPEC,
  POSITION_SPEC,
} from "./order-filters";
import { parseTableState } from "./table-state";
import type { OpenPosition, OrderRow } from "./rows";

const O = (ticket: number, symbol: string, type: string, stateRaw: string, setup: string): OrderRow => ({
  ticket,
  symbol,
  type,
  state: stateRaw,
  volumeInitialMilliLots: 50,
  volumeCurrentMilliLots: 0,
  priceOpen: "1.09341",
  priceCurrent: null,
  slPrice: null,
  tpPrice: null,
  timeSetup: setup,
  timeDone: null,
  comment: null,
});

const ORDERS: OrderRow[] = [
  O(7702, "XAUUSD", "order_type_sell_limit", "order_state_placed", "2026-05-09T08:00:00.000Z"),
  O(7701, "EURUSD", "order_type_buy", "order_state_filled", "2026-05-08T06:59:00.000Z"),
  O(7704, "EURUSD", "order_type_buy", "order_state_rejected", "2026-05-08T06:59:00.000Z"),
  O(7703, "BTCUSD", "order_type_buy_stop", "order_state_expired", "2026-05-10T23:45:00.000Z"),
];

const P = (ticket: number, symbol: string, side: "buy" | "sell", profit: bigint, opened: string): OpenPosition => ({
  ticket,
  symbol,
  side,
  volumeMilliLots: 50,
  openPrice: "1.09341",
  currentPrice: "1.09507",
  slPrice: null,
  tpPrice: null,
  profitCents: profit,
  swapCents: -205n,
  commissionCents: -29n,
  openTime: opened,
  comment: null,
});

const POSITIONS: OpenPosition[] = [
  P(8802, "XAUUSD", "sell", -2940n, "2026-05-08T09:15:00.000Z"),
  P(8801, "EURUSD", "buy", 8300n, "2026-05-08T07:00:00.000Z"),
];

describe("classifyOrderState", () => {
  // Mutation caught: bucketing rejected or expired as "other", which drops
  // them out of the Canceled filter and makes the summary understate.
  it.each([
    ["order_state_filled", "filled"],
    ["order_state_canceled", "canceled"],
    ["order_state_expired", "canceled"],
    ["order_state_rejected", "canceled"],
    ["order_state_partial", "partial"],
    ["order_state_placed", "open"],
    ["order_state_something_new", "other"],
  ])("buckets %s as %s", (raw, bucket) => {
    expect(classifyOrderState(raw)).toBe(bucket);
  });
});

describe("applyOrderFilters", () => {
  const st = (p: Record<string, string> = {}) => parseTableState(p, ORDER_SPEC);

  it("defaults to newest setup first, ties broken on ticket", () => {
    const r = applyOrderFilters(ORDERS, st());
    expect(r.rows.map((o) => o.ticket)).toEqual([7703, 7702, 7704, 7701]);
  });

  it("filters by bucket and counts three groups", () => {
    const r = applyOrderFilters(ORDERS, st({ state: "canceled" }));
    expect(r.rows.map((o) => o.ticket).sort()).toEqual([7703, 7704]);
    const all = applyOrderFilters(ORDERS, st());
    expect(all.summary).toEqual({ count: 4, filled: 1, canceled: 2, open: 1 });
  });

  it("filters by exact type and by symbol", () => {
    expect(applyOrderFilters(ORDERS, st({ type: "order_type_buy" })).total).toBe(2);
    expect(applyOrderFilters(ORDERS, st({ symbol: "EURUSD" })).total).toBe(2);
  });

  it("does not reorder the input", () => {
    const before = ORDERS.map((o) => o.ticket);
    applyOrderFilters(ORDERS, st({ sort: "symbol_asc" }));
    expect(ORDERS.map((o) => o.ticket)).toEqual(before);
  });

  // Mutation caught: `if (bucket) rows = rows.filter(... === bucket)` — a
  // bare truthy check instead of enumerating the four real buckets. "other"
  // is a legitimate classifyOrderState() return value (see the table above),
  // but it is not one of the four filter chips this table exposes; a raw MT5
  // constant and a wrong-case bucket name are not bucket names at all. Under
  // the truthy-check version each of these is still "applied" as a filter,
  // and because nothing's classification ever equals the raw string, the
  // table silently empties instead of falling back to unfiltered — the same
  // failure mode `outcome`/`side` in trade-filters.ts avoid by enumerating.
  it("treats a bucket name outside the filter UI's set as no filter", () => {
    expect(applyOrderFilters(ORDERS, st({ state: "other" })).total).toBe(4);
    expect(applyOrderFilters(ORDERS, st({ state: "order_state_filled" })).total).toBe(4);
    expect(applyOrderFilters(ORDERS, st({ state: "FILLED" })).total).toBe(4);
  });
});

describe("applyPositionSort", () => {
  const st = (p: Record<string, string> = {}) => parseTableState(p, POSITION_SPEC);

  // Mutation caught: summing profitCents alone. Two positions carrying -205
  // swap and -29 commission each make the difference 468 cents.
  it("sums floating P/L including swap and commission", () => {
    const r = applyPositionSort(POSITIONS, st());
    expect(r.summary.floatingCents).toBe(4892n);
    expect(r.summary.longs).toBe(1);
    expect(r.summary.shorts).toBe(1);
  });

  it("sorts by profit exactly", () => {
    const r = applyPositionSort(POSITIONS, st({ sort: "profit_asc" }));
    expect(r.rows.map((p) => p.ticket)).toEqual([8802, 8801]);
  });

  it("defaults to newest open first", () => {
    expect(applyPositionSort(POSITIONS, st()).rows.map((p) => p.ticket)).toEqual([8802, 8801]);
  });
});
