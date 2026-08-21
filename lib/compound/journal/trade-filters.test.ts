import { applyTradeFilters, symbolsOf, TRADE_SPEC } from "./trade-filters";
import { parseTableState, type TableState } from "./table-state";
import { buildTradeHistory, type DedupedDeals } from "./history";
import { FIXTURE_OFFSET_HOURS, RAW_DEALS, fixtureHistory } from "./__fixtures__/deals";

const DEALS = fixtureHistory().deals;
const state = (params: Record<string, string> = {}, extra: Partial<TableState> = {}): TableState => ({
  ...parseTableState(params, TRADE_SPEC),
  ...extra,
});

describe("applyTradeFilters", () => {
  it("defaults to newest first and returns every trade", () => {
    const r = applyTradeFilters(DEALS, state());
    expect(r.rows.map((d) => d.ticket)).toEqual([
      5009, 5008, 5007, 5006, 5005, 5004, 5003, 5002, 5001,
    ]);
    expect(r.total).toBe(9);
  });

  // Mutation caught: computing the summary after pagination, which would make
  // the line above the table describe the visible page rather than the filter.
  it("summarises the whole filtered set, not the visible page", () => {
    const r = applyTradeFilters(DEALS, state({}, { size: 4, page: 2 }));
    expect(r.rows).toHaveLength(4);
    expect(r.summary.count).toBe(9);
    expect(r.summary.netCents).toBe(3163n);
    expect(r.summary.grossCents).toBe(3458n);
  });

  // Mutation caught: filtering on net rather than gross, which reclassifies
  // ticket 5009 (gross +5, net -26).
  it("filters wins on gross profit", () => {
    const r = applyTradeFilters(DEALS, state({ outcome: "wins" }));
    expect(r.rows.map((d) => d.ticket).sort()).toEqual([5001, 5003, 5006, 5008, 5009]);
    expect(r.summary.wins).toBe(5);
    expect(r.summary.losses).toBe(0);
    // Five winners, but the fee on 5009 makes the net less than the gross.
    expect(r.summary.grossCents).toBe(6231n);
    expect(r.summary.netCents).toBe(5994n);
  });

  it("filters the flat trade out of both wins and losses", () => {
    expect(applyTradeFilters(DEALS, state({ outcome: "flat" })).total).toBe(1);
    expect(applyTradeFilters(DEALS, state({ outcome: "losses" })).total).toBe(3);
  });

  it("filters by symbol and by side, and summarises what is left", () => {
    const eur = applyTradeFilters(DEALS, state({ symbol: "EURUSD" }));
    expect(eur.total).toBe(4);
    expect(eur.summary.netCents).toBe(736n);
    expect(eur.summary.grossCents).toBe(833n);
    expect(applyTradeFilters(DEALS, state({ side: "sell" })).total).toBe(5);
  });

  // Mutation caught: a case-sensitive search, which is what a user typing
  // "xau" would hit first.
  it("searches symbol case-insensitively and ticket as a substring", () => {
    expect(applyTradeFilters(DEALS, state({ q: "xau" })).total).toBe(2);
    expect(applyTradeFilters(DEALS, state({ q: "5003" })).total).toBe(1);
    expect(applyTradeFilters(DEALS, state({ q: "500" })).total).toBe(9);
  });

  // Mutation caught: `Number(a.profitCents - b.profitCents)` in the
  // comparator. It happens to work on small fixtures, which is why the second
  // assertion uses values either side of 2^53.
  it("sorts by profit exactly, including beyond the safe integer range", () => {
    const r = applyTradeFilters(DEALS, state({ sort: "profit_desc" }));
    expect(r.rows.map((d) => d.ticket)).toEqual([
      5003, 5008, 5001, 5006, 5009, 5005, 5002, 5007, 5004,
    ]);

    const huge = buildTradeHistory(
      [
        { ...RAW_DEALS[0]!, ticket: 6001, profitCents: 9_007_199_254_740_993n },
        { ...RAW_DEALS[0]!, ticket: 6002, profitCents: 9_007_199_254_740_992n },
      ],
      FIXTURE_OFFSET_HOURS,
    );
    const big = applyTradeFilters(huge.deals, state({ sort: "profit_desc" }));
    expect(big.rows.map((d) => d.ticket)).toEqual([6001, 6002]);
  });

  // Mutation caught: no tie-break, leaving the order dependent on input order.
  it("breaks ties on ticket", () => {
    const r = applyTradeFilters(DEALS, state({ sort: "symbol_asc" }));
    expect(r.rows.map((d) => d.ticket)).toEqual([
      5004, 5001, 5002, 5005, 5009, 5003, 5008, 5006, 5007,
    ]);
  });

  // THE PROBE FOUND A GAP HERE, recorded rather than hidden — the same shape
  // streaks.test.ts already documents for computeStreaks. DEALS comes from
  // buildTradeHistory, which always returns ticket-ascending order (dedupe's
  // final `kept.sort`), and DEALS is already ticket-ascending BEFORE
  // applyTradeFilters ever sorts it. Deleting the explicit
  // `if (cmp === 0) cmp = a.ticket - b.ticket;` line and rerunning against
  // DEALS was tried during this task's mutation probe and left "breaks ties
  // on ticket" above green — Array.sort has been stable since ES2019, so a
  // tie preserves input order, and input order already equals ticket order
  // for this fixture. This test closes the gap: two same-symbol deals built
  // directly and cast to DedupedDeals (bypassing buildTradeHistory's
  // ticket-sort), fed in DESCENDING-ticket input order, so a stable sort
  // with no tie-break would preserve that descending order and only an
  // explicit tie-break produces ascending. Verified against the actual
  // mutation, not predicted: removing the tie-break turns the expected
  // [9101, 9102] into [9102, 9101].
  it("breaks ties on ticket even when the input does not already arrive ticket-sorted", () => {
    const base = RAW_DEALS[2]!;
    const d1 = { ...base, ticket: 9102, symbol: "EURUSD", profitCents: 111n };
    const d2 = { ...base, ticket: 9101, symbol: "EURUSD", profitCents: 222n };
    const deals = [d1, d2] as unknown as DedupedDeals;
    const r = applyTradeFilters(deals, state({ sort: "symbol_asc" }));
    expect(r.rows.map((d) => d.ticket)).toEqual([9101, 9102]);
  });

  // Mutation caught: sorting in place on the caller's array. DedupedDeals is
  // readonly by type, but the runtime array is shared with every other
  // surface on the page.
  it("does not reorder the input", () => {
    const before = DEALS.map((d) => d.ticket);
    applyTradeFilters(DEALS, state({ sort: "profit_asc" }));
    expect(DEALS.map((d) => d.ticket)).toEqual(before);
  });

  it("returns an empty page with a zero summary when nothing matches", () => {
    const r = applyTradeFilters(DEALS, state({ symbol: "NOPE" }));
    expect(r.rows).toEqual([]);
    expect(r.summary).toEqual({ count: 0, netCents: 0n, grossCents: 0n, wins: 0, losses: 0 });
    expect(r.pageCount).toBe(1);
  });

  // Mutation caught: an outcome/side check implemented as a substring or
  // case-insensitive match instead of exact equality against the literal.
  // "wins" the word means nothing here except as the one exact string the
  // branch tests for — anything else, including something that reads as
  // clearly enum-shaped to a person, must fall back to unfiltered rather
  // than matching by accident or throwing.
  it("treats an unrecognised outcome or side as no filter, not an error", () => {
    const badOutcome = applyTradeFilters(DEALS, state({ outcome: "WINS" }));
    expect(badOutcome.total).toBe(9);
    const numericOutcome = applyTradeFilters(DEALS, state({ outcome: "1" }));
    expect(numericOutcome.total).toBe(9);
    const badSide = applyTradeFilters(DEALS, state({ side: "long" }));
    expect(badSide.total).toBe(9);
  });
});

describe("symbolsOf", () => {
  it("lists each symbol once, sorted", () => {
    expect(symbolsOf(DEALS)).toEqual(["BTCUSD", "EURUSD", "GBPUSD", "XAUUSD"]);
  });
});
