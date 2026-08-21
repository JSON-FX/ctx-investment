import { buildTradeHistory } from "./history";
import { FIXTURE_OFFSET_HOURS, RAW_DEALS, fixtureHistory } from "./__fixtures__/deals";

describe("buildTradeHistory", () => {
  // Mutation caught: `return { deals: raw, dropped: [], guard: "applied" }` —
  // the exact shape of the sibling product's defect.
  it("drops the offset-shifted twin and keeps the lower ticket", () => {
    const h = fixtureHistory();
    expect(h.rawCount).toBe(10);
    expect(h.deals).toHaveLength(9);
    expect(h.deals.map((d) => d.ticket)).not.toContain(5092);
    expect(h.deals.map((d) => d.ticket)).toContain(5008);
    expect(h.dropped.map((d) => d.deal.ticket)).toEqual([5092]);
    expect(h.dropped[0]!.duplicateOfTicket).toBe(5008);
    expect(h.guard).toBe("applied");
  });

  // Mutation caught: matching on value fields alone and ignoring the shift.
  // 5007 and 5009 are genuine trades with distinct values; 5001 and 5002 are
  // the same symbol on the same day and must both survive.
  it("keeps every genuine trade, including same-symbol same-day pairs", () => {
    const h = fixtureHistory();
    expect(h.deals.map((d) => d.ticket)).toEqual([
      5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008, 5009,
    ]);
  });

  // Mutation caught: matching a pair at any gap rather than at exactly the
  // offset. These two differ in every timestamp by 5h, not 3h, and are two
  // real trades — dropping one destroys real P/L silently.
  it("does not drop a value-identical pair at the wrong gap", () => {
    const twinAtFiveHours = {
      ...RAW_DEALS[1]!,
      ticket: 5993,
      openTime: "2026-05-08T16:00:00.000Z",
      closeTime: "2026-05-08T19:15:00.000Z",
    };
    const h = buildTradeHistory([...RAW_DEALS, twinAtFiveHours], FIXTURE_OFFSET_HOURS);
    expect(h.deals.map((d) => d.ticket)).toContain(5993);
    expect(h.deals).toHaveLength(10);
  });

  // Mutation caught: passing the signed offset straight to dedupeDeals, which
  // throws a RangeError for anything below 1.
  it("treats a negative broker offset as the same magnitude", () => {
    const plus = buildTradeHistory(RAW_DEALS, 3);
    const minus = buildTradeHistory(RAW_DEALS, -3);
    expect(minus.deals.map((d) => d.ticket)).toEqual(plus.deals.map((d) => d.ticket));
    expect(minus.guard).toBe("applied");
  });

  // Mutation caught: throwing on 0/null, which would 500 the journal page for
  // any account whose offset has not been set.
  it.each([[null], [0]])("reports not-configured for offset %p rather than throwing", (offset) => {
    const h = buildTradeHistory(RAW_DEALS, offset as number | null);
    expect(h.guard).toBe("not-configured");
    expect(h.deals).toHaveLength(10);
    expect(h.dropped).toEqual([]);
  });

  // Mutation caught: returning `raw` unsorted on the not-configured branch, so
  // a caller could tell which branch ran from the ordering alone.
  it("returns ticket order on both branches", () => {
    const unguarded = buildTradeHistory(RAW_DEALS, null);
    expect(unguarded.deals.map((d) => d.ticket)).toEqual([
      5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008, 5009, 5092,
    ]);
  });

  it("does not mutate its input", () => {
    const before = RAW_DEALS.map((d) => d.ticket);
    buildTradeHistory(RAW_DEALS, FIXTURE_OFFSET_HOURS);
    expect(RAW_DEALS.map((d) => d.ticket)).toEqual(before);
  });

  it("handles an empty list", () => {
    const h = buildTradeHistory([], FIXTURE_OFFSET_HOURS);
    expect(h.deals).toHaveLength(0);
    expect(h.guard).toBe("applied");
  });
});
