import { dedupeDeals } from "./dedupe";
import type { ClosedDeal } from "./types";

function deal(over: Partial<ClosedDeal> = {}): ClosedDeal {
  return {
    ticket: 1000,
    symbol: "GBPUSD",
    side: "sell",
    volumeMilliLots: 50,
    openTime: "2026-05-04T07:09:00Z",
    closeTime: "2026-05-06T08:31:00Z",
    profitCents: -1_545n,
    swapCents: -38n,
    commissionCents: 0n,
    ...over,
  };
}

/** The same trade, shifted forward by `h` hours under a later ticket. */
function shifted(base: ClosedDeal, h: number, ticket: number): ClosedDeal {
  const move = (iso: string) => new Date(Date.parse(iso) + h * 3_600_000).toISOString();
  return { ...base, ticket, openTime: move(base.openTime), closeTime: move(base.closeTime) };
}

describe("dedupeDeals — the duplicate shape", () => {
  it("drops a twin shifted by exactly the broker offset", () => {
    const genuine = deal({ ticket: 1000 });
    const twin = shifted(genuine, 3, 9000);
    const r = dedupeDeals([genuine, twin], 3);
    expect(r.kept.map((d) => d.ticket)).toEqual([1000]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.deal.ticket).toBe(9000);
    expect(r.dropped[0]!.duplicateOfTicket).toBe(1000);
  });

  it("keeps the lowest ticket regardless of input order", () => {
    const genuine = deal({ ticket: 1000 });
    const twin = shifted(genuine, 3, 9000);
    expect(dedupeDeals([twin, genuine], 3).kept.map((d) => d.ticket)).toEqual([1000]);
  });

  it("drops both twins of a three-way duplicate", () => {
    const genuine = deal({ ticket: 1000 });
    const r = dedupeDeals([genuine, shifted(genuine, 3, 9000), shifted(genuine, -3, 9001)], 3);
    expect(r.kept.map((d) => d.ticket)).toEqual([1000]);
    expect(r.dropped.map((x) => x.deal.ticket).sort()).toEqual([9000, 9001]);
  });
});

describe("dedupeDeals — what it must NOT drop", () => {
  it("keeps a matching pair whose gap is not the broker offset", () => {
    // Identical in every field but shifted 2h, where the offset is 3h. Two
    // genuinely separate trades. Dropping this would destroy real P/L.
    const a = deal({ ticket: 1000 });
    const b = shifted(a, 2, 1001);
    const r = dedupeDeals([a, b], 3);
    expect(r.kept.map((d) => d.ticket).sort()).toEqual([1000, 1001]);
    expect(r.dropped).toHaveLength(0);
  });

  it("keeps a pair shifted correctly but differing in profit", () => {
    const a = deal({ ticket: 1000 });
    const b = { ...shifted(a, 3, 9000), profitCents: -1_546n };
    expect(dedupeDeals([a, b], 3).dropped).toHaveLength(0);
  });

  it("keeps a pair shifted correctly but differing in volume", () => {
    const a = deal({ ticket: 1000 });
    const b = { ...shifted(a, 3, 9000), volumeMilliLots: 60 };
    expect(dedupeDeals([a, b], 3).dropped).toHaveLength(0);
  });

  it("keeps a pair where only close time is shifted, not open time", () => {
    // A real duplicate is shifted on BOTH ends. One end only is a different
    // trade that happened to close 3h later.
    const a = deal({ ticket: 1000 });
    const b = {
      ...a,
      ticket: 9000,
      closeTime: new Date(Date.parse(a.closeTime) + 3 * 3_600_000).toISOString(),
    };
    expect(dedupeDeals([a, b], 3).dropped).toHaveLength(0);
  });

  it("returns a lone deal untouched", () => {
    const r = dedupeDeals([deal()], 3);
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  it("returns empty for no deals", () => {
    expect(dedupeDeals([], 3)).toEqual({ kept: [], dropped: [] });
  });
});

describe("dedupeDeals — validation", () => {
  it("rejects a non-positive offset", () => {
    expect(() => dedupeDeals([], 0)).toThrow(/brokerOffsetHours/);
    expect(() => dedupeDeals([], -3)).toThrow(/brokerOffsetHours/);
  });
  it("rejects an implausible offset", () => {
    expect(() => dedupeDeals([], 15)).toThrow(/brokerOffsetHours/);
  });
  it("accepts the boundaries", () => {
    expect(() => dedupeDeals([], 1)).not.toThrow();
    expect(() => dedupeDeals([], 14)).not.toThrow();
  });
});
