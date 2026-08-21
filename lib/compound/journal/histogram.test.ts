import { binNetPnl } from "./histogram";
import { computeTradeEquity } from "./trade-equity";
import { fixtureHistory, fixtureHistoryUnguarded } from "./__fixtures__/deals";

const VALUES = computeTradeEquity(fixtureHistory().deals).curve.map((p) => p.netCents);
// [1195, -426, 2821, -1522, -7, 651, -876, 1353, -26]

describe("binNetPnl", () => {
  const h = binNetPnl(VALUES, 8);

  it("spans the observed range exactly", () => {
    expect(h.minCents).toBe(-1522n);
    expect(h.maxCents).toBe(2821n);
    expect(h.bins).toHaveLength(8);
    expect(h.bins[0]!.startCents).toBe(-1522n);
    expect(h.bins[7]!.endCents).toBe(2821n);
  });

  // step = floor(4343/8) = 542. Mutation caught: a float step, which gives
  // 542.875 and shifts every interior edge.
  it("uses integer edges with the remainder in the top bin", () => {
    expect(h.bins.map((b) => b.startCents)).toEqual([
      -1522n, -980n, -438n, 104n, 646n, 1188n, 1730n, 2272n,
    ]);
    // The top bin is 549 wide; the rest are 542.
    expect(h.bins[7]!.endCents - h.bins[7]!.startCents).toBe(549n);
    expect(h.bins[0]!.endCents - h.bins[0]!.startCents).toBe(542n);
  });

  // Mutation caught: dropping the top-edge clamp, which sends 2821 to index 8
  // and throws or silently loses it; and an off-by-one that shifts every
  // value one bin left. Empty bins at index 3 and 6 are asserted because a
  // "drop empty bins" mutation is otherwise invisible.
  it("counts every value into exactly one bin, including the maximum", () => {
    expect(h.bins.map((b) => b.count)).toEqual([1, 1, 3, 0, 1, 2, 0, 1]);
    expect(h.bins.reduce((a, b) => a + b.count, 0)).toBe(VALUES.length);
    expect(h.total).toBe(9);
  });

  // Mutation caught: signing a bin by its start rather than its midpoint. Bin
  // 2 spans -438..104 and is a loss bin by midpoint; by start it would also be
  // a loss, but bin 3 spans 104..646 and by midpoint is a win — a mutation
  // using endCents alone would call bin 2 a win.
  it("signs each bin by its integer midpoint", () => {
    expect(h.bins.map((b) => b.sign)).toEqual([
      "loss", "loss", "loss", "win", "win", "win", "win", "win",
    ]);
  });

  // THE DEDUPE ASSERTION for this module.
  it("differs from the undeduplicated answer", () => {
    const badValues = computeTradeEquity(fixtureHistoryUnguarded().deals).curve.map(
      (p) => p.netCents,
    );
    const bad = binNetPnl(badValues, 8);
    expect(bad.total).toBe(10);
    expect(bad.bins.map((b) => b.count)).not.toEqual(h.bins.map((b) => b.count));
  });

  it("returns one bin when every value is identical", () => {
    const one = binNetPnl([500n, 500n, 500n], 8);
    expect(one.bins).toHaveLength(1);
    expect(one.bins[0]!.count).toBe(3);
    expect(one.bins[0]!.sign).toBe("win");
  });

  it("signs an all-zero distribution as zero", () => {
    expect(binNetPnl([0n, 0n], 4).bins[0]!.sign).toBe("zero");
  });

  // Mutation caught: `range / BigInt(binCount)` with no narrowing, which is
  // 0n for a range of 3 over 8 bins and then divides by zero.
  it("narrows the histogram rather than dividing by zero on a tiny range", () => {
    const tiny = binNetPnl([1n, 2n, 3n, 4n], 8);
    expect(tiny.bins).toHaveLength(3);
    expect(tiny.bins.map((b) => b.count)).toEqual([1, 1, 2]);
    expect(tiny.bins.reduce((a, b) => a + b.count, 0)).toBe(4);
  });

  it("returns nothing for no values and rejects a bad bin count", () => {
    expect(binNetPnl([], 8)).toEqual({ bins: [], minCents: 0n, maxCents: 0n, total: 0 });
    expect(() => binNetPnl(VALUES, 0)).toThrow(/positive integer/);
    expect(() => binNetPnl(VALUES, 2.5)).toThrow(/positive integer/);
  });
});

describe("binNetPnl — edge ownership at a bin boundary", () => {
  // THE BOUNDARY-OWNERSHIP DECISION, in the smallest fixture that shows it.
  //
  // 3 values, 2 bins, range -100..100, step 100: bin0 is [-100, 0), bin1 is
  // [0, 100]. The value 0 sits exactly on the interior edge shared by both
  // bins. This function puts it in the UPPER bin (bin1, whose startCents is
  // 0) — the value belongs to the bin it starts, not the bin it would end.
  // That also means 0 — the boundary between a loss bin and a win bin — is
  // graded a WIN, not a loss: signOf(0, 100) has a positive midpoint, and the
  // count landing there is what makes that observable.
  //
  // Mutation caught: flipping ownership to the lower bin (e.g. computing the
  // index as ceil((v-min)/step) - 1, or using `<=` where `binNetPnl` uses an
  // implicit `<`) would move the boundary value into bin0, changing the
  // counts below from [1, 2] to [2, 1] and the bin holding it from "win" to
  // "loss". Either rule is defensible; this test is what pins the one chosen.
  it("puts a value exactly on the zero boundary in the upper (win) bin", () => {
    const h = binNetPnl([-100n, 0n, 100n], 2);
    expect(h.bins).toHaveLength(2);
    expect(h.bins[0]).toMatchObject({ startCents: -100n, endCents: 0n });
    expect(h.bins[1]).toMatchObject({ startCents: 0n, endCents: 100n });
    expect(h.bins.map((b) => b.count)).toEqual([1, 2]);
    expect(h.bins.map((b) => b.sign)).toEqual(["loss", "win"]);
  });

  // The same rule, exercised at three interior edges at once, straddling
  // zero on both sides, with exact multiples of the bin width AND values one
  // cent off each side of an edge. binCount=4 over -400..400 gives a clean
  // step of 100 (no remainder, so every edge below is exact): edges at
  // -400, -200, 0, 200, 400.
  //
  // Expected bin membership under "upper bin owns the edge":
  //   bin0 [-400,-200): -400, -201                    -> 2
  //   bin1 [-200,   0): -200, -199, -1                 -> 3
  //   bin2 [   0, 200): 0, 1, 199                       -> 3
  //   bin3 [ 200, 400]: 200, 201, 400 (max, closed top) -> 3
  //
  // Mutation caught: same as above, but now also proves the rule is applied
  // identically on the negative side (-200) and the positive side (200), not
  // just at zero. Under "lower bin owns the edge" the three boundary values
  // -200, 0 and 200 would each shift down one bin, giving [3, 3, 3, 2]
  // instead of [2, 3, 3, 3] — a different, and wrong, distribution.
  it("owns the upper bin at every interior edge, both signs, off-by-one cents included", () => {
    const values = [
      -400n, -201n, -200n, -199n, -1n, 0n, 1n, 199n, 200n, 201n, 400n,
    ];
    const h = binNetPnl(values, 4);
    expect(h.bins.map((b) => [b.startCents, b.endCents])).toEqual([
      [-400n, -200n],
      [-200n, 0n],
      [0n, 200n],
      [200n, 400n],
    ]);
    expect(h.bins.map((b) => b.count)).toEqual([2, 3, 3, 3]);
    expect(h.bins.reduce((a, b) => a + b.count, 0)).toBe(values.length);
    expect(h.bins.map((b) => b.sign)).toEqual(["loss", "loss", "win", "win"]);
  });
});

describe("binNetPnl — floor, not truncate, at the bin midpoint", () => {
  // signOf floors (start+end)/2. Every bin above — the shared VALUES fixture,
  // and both new boundary fixtures — happens to have an EVEN start+end sum,
  // so divFloor and plain truncating bigint division agree on all of them:
  // this is exactly the "round numbers hide the bug" trap the carried-forward
  // note warns about, and it was only found by checking parity by hand, not
  // by running the suite (everything above is green either way).
  //
  // A single bin spanning [-2, 1] (min=-2, max=1, binCount=1 so the whole
  // range is one bin) has start+end = -1, an ODD negative sum, which is
  // exactly where floor and truncate-toward-zero diverge:
  //   divFloor(-1, 2)  = -1  (floor:  -0.5 rounds down)   -> mid < 0 -> "loss"
  //   -1n / 2n         =  0  (bigint truncates toward 0)  -> mid = 0 -> "zero"
  //
  // Mutation caught: replacing `divFloor(startCents + endCents, 2n)` with
  // plain `(startCents + endCents) / 2n` in signOf. Confirmed by hand against
  // int.ts's actual divFloor before writing this, and re-confirmed by running
  // the mutation below (see the report's probe table) — this is the one
  // assertion in this file that would NOT have existed without deliberately
  // hunting for a bin whose sum is odd.
  it("classifies a bin whose exact midpoint is -0.5 as a loss, not zero", () => {
    const h = binNetPnl([-2n, -1n, 0n, 1n], 1);
    expect(h.bins).toHaveLength(1);
    expect(h.bins[0]).toMatchObject({ startCents: -2n, endCents: 1n, count: 4 });
    expect(h.bins[0]!.sign).toBe("loss");
  });
});
