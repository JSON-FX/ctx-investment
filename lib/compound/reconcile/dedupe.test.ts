import { dedupeDeals } from "./dedupe";
import type { ClosedDeal } from "./types";
import {
  NEAR_OFFSET_BROKER_HOURS,
  NEAR_OFFSET_DUPLICATE_PAIRS,
  NEAR_OFFSET_SHIFT_MS,
} from "./__fixtures__/near-offset-duplicates";

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

/** The same trade, shifted forward by `ms` milliseconds under a later ticket. */
function shiftedByMs(base: ClosedDeal, ms: number, ticket: number): ClosedDeal {
  const move = (iso: string) => new Date(Date.parse(iso) + ms).toISOString();
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
    expect(r.dropped.map((x) => x.deal.ticket).sort((x, y) => x - y)).toEqual([9000, 9001]);
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

  // symbol, side, swap and commission are held constant across every OTHER
  // fixture in this file (deal()'s defaults), so a mutant that dropped any
  // one of them from valueKey would still pass every test above. Each of
  // these four is the one case that varies exactly that field and nothing
  // else, so only it can catch that mutant.
  it("keeps a pair shifted correctly but differing in symbol", () => {
    const a = deal({ ticket: 1000 });
    const b = { ...shifted(a, 3, 9000), symbol: "EURUSD" };
    expect(dedupeDeals([a, b], 3).dropped).toHaveLength(0);
  });

  it("keeps a pair shifted correctly but differing in side", () => {
    const a = deal({ ticket: 1000 }); // side: "sell"
    const b: ClosedDeal = { ...shifted(a, 3, 9000), side: "buy" };
    expect(dedupeDeals([a, b], 3).dropped).toHaveLength(0);
  });

  it("keeps a pair shifted correctly but differing in swap", () => {
    const a = deal({ ticket: 1000 }); // swapCents: -38n
    const b = { ...shifted(a, 3, 9000), swapCents: -39n };
    expect(dedupeDeals([a, b], 3).dropped).toHaveLength(0);
  });

  it("keeps a pair shifted correctly but differing in commission", () => {
    const a = deal({ ticket: 1000 }); // commissionCents: 0n
    const b = { ...shifted(a, 3, 9000), commissionCents: 5n };
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

  it("keeps a pair shifted in opposite directions at each end", () => {
    // +3h at the open, −3h at the close: six hours shorter than its partner.
    // A timezone reinterpretation preserves duration, so this shape cannot be
    // one push read two ways — it is two genuine trades that happen to match
    // on every value field.
    const a = deal({ ticket: 1000 });
    const b: ClosedDeal = {
      ...a,
      ticket: 4000,
      openTime: new Date(Date.parse(a.openTime) + 3 * 3_600_000).toISOString(),
      closeTime: new Date(Date.parse(a.closeTime) - 3 * 3_600_000).toISOString(),
    };
    const r = dedupeDeals([a, b], 3);
    expect(r.kept.map((d) => d.ticket).sort((x, y) => x - y)).toEqual([1000, 4000]);
    expect(r.dropped).toHaveLength(0);
  });
});

describe("dedupeDeals — offset tolerance (near-miss shifts)", () => {
  // Mirrors dedupe.ts's own OFFSET_TOLERANCE_MS. Hardcoded rather than
  // imported, matching this file's existing convention for MIN_OFFSET_HOURS
  // / MAX_OFFSET_HOURS below: the test pins the CONTRACT, so it must not
  // move just because the constant it is checking moves.
  const TOLERANCE_MS = 2_000;
  const OFFSET_3H_MS = 3 * 3_600_000;

  // Mutation caught: reverting to the original `Math.abs(openShift) ===
  // offsetMs` exact-equality predicate (equivalently, OFFSET_TOLERANCE_MS
  // set to 0) keeps this twin instead of dropping it — the exact production
  // defect. See near-offset-duplicates.ts and the report's Probe 2.
  it("drops a twin shifted by the real production offset of 10,799,000ms", () => {
    const genuine = deal({ ticket: 1000 });
    const twin = shiftedByMs(genuine, NEAR_OFFSET_SHIFT_MS, 9000);
    const r = dedupeDeals([genuine, twin], 3);
    expect(r.kept.map((d) => d.ticket)).toEqual([1000]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.deal.ticket).toBe(9000);
    expect(r.dropped[0]!.duplicateOfTicket).toBe(1000);
  });

  // Mutation caught: changing the predicate's `<=` to `<` excludes this
  // boundary and keeps the twin instead of dropping it.
  it("drops a twin shifted exactly at the tolerance bound", () => {
    const genuine = deal({ ticket: 1000 });
    const twin = shiftedByMs(genuine, OFFSET_3H_MS - TOLERANCE_MS, 9000);
    const r = dedupeDeals([genuine, twin], 3);
    expect(r.kept.map((d) => d.ticket)).toEqual([1000]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.duplicateOfTicket).toBe(1000);
  });

  // Mutation caught: widening OFFSET_TOLERANCE_MS from 2,000 to 2,001 drops
  // this twin instead of keeping it — proves the bound is where the
  // predicate says it is, not just "somewhere close."
  it("keeps a twin shifted one millisecond beyond the tolerance bound", () => {
    const genuine = deal({ ticket: 1000 });
    const twin = shiftedByMs(genuine, OFFSET_3H_MS - TOLERANCE_MS - 1, 9000);
    const r = dedupeDeals([genuine, twin], 3);
    expect(r.kept.map((d) => d.ticket).sort((x, y) => x - y)).toEqual([1000, 9000]);
    expect(r.dropped).toHaveLength(0);
  });

  // Mutation caught: dropping the offset-magnitude comparison and keeping
  // only `openShift === closeShift` drops this twin instead of keeping it.
  // Equal-duration alone is not enough to call two rows the same trade
  // pushed twice — the shared gap must also be near a real broker offset.
  it("keeps a pair whose equal shifts sit nowhere near the offset", () => {
    const genuine = deal({ ticket: 1000 });
    const twin = shiftedByMs(genuine, 5 * 60_000, 9000); // 5 minutes, both ends
    const r = dedupeDeals([genuine, twin], 3);
    expect(r.kept.map((d) => d.ticket).sort((x, y) => x - y)).toEqual([1000, 9000]);
    expect(r.dropped).toHaveLength(0);
  });

  // Mutation caught: replacing the openShift===closeShift check with an
  // "each end independently within tolerance of the offset" check drops
  // this twin instead of keeping it. The open end lands exactly on offset;
  // the close end is offset+10ms — individually both are "near enough," but
  // they disagree with EACH OTHER, so duration is not preserved and this is
  // not the duplicate shape.
  it("keeps a pair at the right offset whose open and close shifts differ", () => {
    const genuine = deal({ ticket: 1000 });
    const twin: ClosedDeal = {
      ...genuine,
      ticket: 9000,
      openTime: new Date(Date.parse(genuine.openTime) + OFFSET_3H_MS).toISOString(),
      closeTime: new Date(Date.parse(genuine.closeTime) + OFFSET_3H_MS + 10).toISOString(),
    };
    const r = dedupeDeals([genuine, twin], 3);
    expect(r.kept.map((d) => d.ticket).sort((x, y) => x - y)).toEqual([1000, 9000]);
    expect(r.dropped).toHaveLength(0);
  });

  // Mutation caught: same independent-per-end check as above, from the
  // other direction — this is the historical bug this module's own doc
  // comment names: "an earlier version of this same predicate compared the
  // two gaps independently in absolute terms, which dropped genuine
  // trades." Both ends individually sit within tolerance of the offset in
  // ABSOLUTE terms (+10,799,000 and −10,799,000 both have |shift| close to
  // 10,800,000), but opposite in sign, so this pair's duration is six hours
  // shorter than its partner's — two genuine trades, not a timezone twin.
  it("keeps a pair shifted +offset at the open and −offset at the close, both individually near tolerance", () => {
    const genuine = deal({ ticket: 1000 });
    const twin: ClosedDeal = {
      ...genuine,
      ticket: 9000,
      openTime: new Date(Date.parse(genuine.openTime) + NEAR_OFFSET_SHIFT_MS).toISOString(),
      closeTime: new Date(Date.parse(genuine.closeTime) - NEAR_OFFSET_SHIFT_MS).toISOString(),
    };
    const r = dedupeDeals([genuine, twin], 3);
    expect(r.kept.map((d) => d.ticket).sort((x, y) => x - y)).toEqual([1000, 9000]);
    expect(r.dropped).toHaveLength(0);
  });
});

describe("dedupeDeals — the near-offset production shape (regression)", () => {
  // Confirms the fixture itself carries exactly the measured production
  // shape before trusting any assertion built on top of it: every pair
  // shifted by precisely 10,799,000ms at BOTH ends, not merely "close to"
  // it. If this fails, the fixture drifted, not dedupeDeals.
  it("fixture pairs are shifted by exactly the measured 10,799,000ms at both ends", () => {
    for (const pair of NEAR_OFFSET_DUPLICATE_PAIRS) {
      const openShift = Date.parse(pair.duplicate.openTime) - Date.parse(pair.genuine.openTime);
      const closeShift = Date.parse(pair.duplicate.closeTime) - Date.parse(pair.genuine.closeTime);
      expect(openShift).toBe(NEAR_OFFSET_SHIFT_MS);
      expect(closeShift).toBe(NEAR_OFFSET_SHIFT_MS);
    }
  });

  // Mutation caught: reverting to the original exact-equality predicate
  // (Math.abs(openShift) === offsetMs) keeps all three duplicates instead of
  // dropping them — the real defect that shipped, on data shaped exactly
  // like the restored production account. See the report's Probe 2 for the
  // full before/after run.
  it("drops all three real-shaped duplicate pairs, keeping only the genuine ticket", () => {
    const raw = NEAR_OFFSET_DUPLICATE_PAIRS.flatMap((p) => [p.genuine, p.duplicate]);
    const r = dedupeDeals(raw, NEAR_OFFSET_BROKER_HOURS);

    expect(r.kept.map((d) => d.ticket).sort((x, y) => x - y)).toEqual(
      NEAR_OFFSET_DUPLICATE_PAIRS.map((p) => p.genuine.ticket).sort((x, y) => x - y),
    );
    expect(r.dropped).toHaveLength(NEAR_OFFSET_DUPLICATE_PAIRS.length);
    for (const pair of NEAR_OFFSET_DUPLICATE_PAIRS) {
      const dropped = r.dropped.find((x) => x.deal.ticket === pair.duplicate.ticket);
      expect(dropped).toBeDefined();
      expect(dropped!.duplicateOfTicket).toBe(pair.genuine.ticket);
    }
  });

  it.each(NEAR_OFFSET_DUPLICATE_PAIRS.map((p) => [p.label, p.genuine, p.duplicate] as const))(
    "drops the duplicate in isolation: %s",
    (_label, genuine, duplicate) => {
      const r = dedupeDeals([genuine, duplicate], NEAR_OFFSET_BROKER_HOURS);
      expect(r.kept.map((d) => d.ticket)).toEqual([genuine.ticket]);
      expect(r.dropped).toHaveLength(1);
      expect(r.dropped[0]!.deal.ticket).toBe(duplicate.ticket);
      expect(r.dropped[0]!.duplicateOfTicket).toBe(genuine.ticket);
    },
  );
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
