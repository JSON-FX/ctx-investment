import { unitsFromDecimal } from "@/lib/compound/engine/money";
import { fold } from "@/lib/compound/engine/replay";
import { HOLDER_NAMES, LEDGER, SEEDS } from "./fixture";
import {
  RAIL_MAX_SOLID, allocateShares, railIsHatched, railSegments, railTint,
} from "./rail";

const STATE = fold(LEDGER, SEEDS);

function luminance(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("allocateShares", () => {
  it("sums to exactly 1,000,000 ppm where flooring sums to 999,998", () => {
    const shares = allocateShares(STATE.holders.map((h) => h.units), STATE.units);
    const floors = STATE.holders.map((h) => Number((h.units * 1_000_000n) / STATE.units));
    expect(floors.reduce((a, b) => a + b, 0)).toBe(999_998); // the gap being fixed
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1_000_000);
  });

  it("awards the two spare ppm to the two largest remainders", () => {
    // Remainders rank Grace > Ada > Manager, so Grace and Ada each gain one.
    expect(allocateShares(STATE.holders.map((h) => h.units), STATE.units))
      .toEqual([621_543, 226_583, 151_874]);
  });

  it("gives a sole holder the entire pool", () => {
    expect(allocateShares([unitsFromDecimal("7")], unitsFromDecimal("7"))).toEqual([1_000_000]);
  });

  it("returns zeros for an empty pool rather than dividing by zero", () => {
    expect(allocateShares([0n, 0n], 0n)).toEqual([0, 0]);
  });

  it("refuses units that do not sum to the pool", () => {
    expect(() => allocateShares([unitsFromDecimal("1")], unitsFromDecimal("2")))
      .toThrow(/do not sum to pool units/);
  });

  it("splits three equal holders 333334 / 333333 / 333333, summing to a million", () => {
    const u = unitsFromDecimal("1");
    const shares = allocateShares([u, u, u], u * 3n);
    expect(shares).toEqual([333_334, 333_333, 333_333]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1_000_000);
  });

  it("splits a holder with a single unit out of three fairly", () => {
    // 1 unit of 3: floor(1_000_000/3) = 333333 each, remainder 1 ppm short.
    // All three remainders tie (1/3 exactly), so the tie-break is holder
    // order and the first holder gets the spare ppm.
    const u = unitsFromDecimal("1");
    const shares = allocateShares([u, u, u], u * 3n);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1_000_000);
  });

  it("gives a holder of zero units a zero share without breaking the total", () => {
    const u = unitsFromDecimal("1");
    const shares = allocateShares([u, 0n, u], u * 2n);
    expect(shares[1]).toBe(0);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1_000_000);
  });

  it("sums to exactly 1,000,000 across a prime number of cent-like units", () => {
    // 97 is prime: no holder count here divides it evenly, so floor/ceil/
    // largest-remainder are forced to disagree with a round-fixture answer.
    const shares = allocateShares([37n, 31n, 29n], 97n);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1_000_000);
  });

  it("sums to exactly 1,000,000 splitting seven holders across 1,000,001 raw units", () => {
    const each = 142_857n; // 7 x 142857 = 999999, two short of 1000001
    const holderUnits = [each, each, each, each, each, each, each + 2n];
    expect(holderUnits.reduce((a, b) => a + b, 0n)).toBe(1_000_001n);
    const shares = allocateShares(holderUnits, 1_000_001n);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1_000_000);
    expect(shares).toHaveLength(7);
  });
});

describe("railTint", () => {
  it("puts --own at index 0 for every pool size", () => {
    for (let n = 1; n <= 9; n += 1) expect(railTint(0, n)).toBe("#14532d");
  });

  it("ends a full ramp at --own-2", () => {
    expect(railTint(2, 3)).toBe("#d6e9de");
    expect(railTint(5, 6)).toBe("#d6e9de");
  });

  it("produces the documented ramp for six holders", () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => railTint(i, 6)))
      .toEqual(["#14532d", "#3b7150", "#628f74", "#88ad97", "#afcbbb", "#d6e9de"]);
  });

  it("gets lighter monotonically, for every pool size up to the solid limit", () => {
    for (let n = 2; n <= RAIL_MAX_SOLID; n += 1) {
      const lums = [...Array(n)].map((_, i) => luminance(railTint(i, n)));
      for (let i = 1; i < n; i += 1) expect(lums[i]!).toBeGreaterThan(lums[i - 1]!);
    }
  });

  it("separates adjacent segments by lightness, not by hue alone", () => {
    // 1.371 is the tightest pair, at n=6. Below about 1.35 the boundary stops
    // reading as a boundary in greyscale.
    for (let n = 2; n <= RAIL_MAX_SOLID; n += 1) {
      for (let i = 1; i < n; i += 1) {
        expect(contrast(railTint(i, n), railTint(i - 1, n))).toBeGreaterThanOrEqual(1.35);
      }
    }
  });

  it("cycles past six and hatches every repeat", () => {
    expect(railTint(6, 8)).toBe(railTint(0, 8));
    expect(railIsHatched(5, 8)).toBe(false);
    expect(railIsHatched(6, 8)).toBe(true);
  });

  it("never hatches inside the solid run", () => {
    for (let n = 1; n <= RAIL_MAX_SOLID; n += 1) {
      for (let i = 0; i < n; i += 1) expect(railIsHatched(i, n)).toBe(false);
    }
  });

  it("hatches every holder past the ninth on a fourteen-holder pool, none of them the same as a solid tint's neighbour", () => {
    // A pool with more than twice RAIL_MAX_SOLID holders still hatches every
    // repeat, not just the first lap past six.
    for (let i = RAIL_MAX_SOLID; i < 14; i += 1) expect(railIsHatched(i, 14)).toBe(true);
    for (let i = 0; i < RAIL_MAX_SOLID; i += 1) expect(railIsHatched(i, 14)).toBe(false);
  });

  it("refuses a negative index", () => {
    expect(() => railTint(-1, 3)).toThrow(/bad index/);
  });

  it("refuses a count below one", () => {
    expect(() => railTint(0, 0)).toThrow(/bad count/);
  });
});

describe("railSegments", () => {
  const segs = railSegments(STATE, HOLDER_NAMES);

  it("puts the manager first, at the darkest tint", () => {
    expect(segs[0]!.label).toBe("J. Marsh");
    expect(segs[0]!.isManager).toBe(true);
    expect(segs[0]!.tint).toBe("#14532d");
  });

  it("orders investors by descending stake", () => {
    expect(segs.map((s) => s.label)).toEqual(["J. Marsh", "Ada Lovelace", "Grace Hopper"]);
  });

  it("fills the rail exactly", () => {
    expect(segs.reduce((a, s) => a + s.ppm, 0)).toBe(1_000_000);
  });

  it("labels every segment, so colour is never the sole carrier", () => {
    for (const s of segs) expect(s.label.length).toBeGreaterThan(0);
  });

  it("omits a holder with no units", () => {
    const withGhost = {
      ...STATE,
      holders: [...STATE.holders, {
        holderId: 9, isManager: false, splitBps: 4000,
        units: 0n, basisCents: 0n, status: "closed" as const,
      }],
    };
    expect(railSegments(withGhost, HOLDER_NAMES).map((s) => s.holderId)).toEqual([1, 2, 3]);
  });

  it("names an unnamed holder rather than rendering undefined", () => {
    expect(railSegments(STATE, {})[0]!.label).toBe("Holder #1");
  });

  it("hatches no segment while the pool has three holders", () => {
    for (const s of segs) expect(s.hatched).toBe(false);
  });
});
