import { horizontalScale, polylinePoints, verticalScale } from "./scale";

describe("verticalScale", () => {
  const s = verticalScale([0n, 50n, 100n], 200, 10);

  it("puts the maximum at the top pad and the minimum at the bottom", () => {
    expect(s.y(100n)).toBe(10);
    expect(s.y(0n)).toBe(190);
    expect(s.y(50n)).toBe(100);
  });

  // Mutation caught: `Number(v) / Number(span)`. Both of these values are past
  // 2^53, so a float path collapses them to the same coordinate and the two
  // points plot on top of each other.
  it("plots values past the safe integer range distinctly", () => {
    const big = verticalScale(
      [9_007_199_254_740_992n, 9_007_199_254_740_993n],
      200,
      10,
    );
    expect(big.flat).toBe(false);
    expect(big.y(9_007_199_254_740_993n)).toBe(10);
    expect(big.y(9_007_199_254_740_992n)).toBe(190);
    expect(big.y(9_007_199_254_740_993n)).not.toBe(big.y(9_007_199_254_740_992n));
  });

  // Mutation caught: dividing by a zero span, which produces NaN and a path
  // attribute of "M10,NaN" that renders as nothing at all.
  it("centres a flat series instead of dividing by zero", () => {
    const flat = verticalScale([500n, 500n, 500n], 200, 10);
    expect(flat.flat).toBe(true);
    expect(flat.y(500n)).toBe(100);
    expect(Number.isNaN(flat.y(500n))).toBe(false);
  });

  it("handles an empty series", () => {
    const none = verticalScale([], 200, 10);
    expect(none.y(0n)).toBe(100);
    expect(none.flat).toBe(true);
  });

  // Mutation caught: reporting a zero line for a domain that does not contain
  // zero, which draws a baseline in the wrong place on an all-positive curve.
  it("reports a zero line only when zero is inside the domain", () => {
    expect(verticalScale([-100n, 100n], 200, 10).zeroY).toBe(100);
    expect(verticalScale([100n, 300n], 200, 10).zeroY).toBeNull();
    expect(verticalScale([-300n, -100n], 200, 10).zeroY).toBeNull();
  });

  // Mutation caught: no clamp, so a value outside the domain plots off-canvas
  // and silently stretches the viewBox.
  it("clamps a value outside the domain to the edge", () => {
    expect(s.y(500n)).toBe(10);
    expect(s.y(-500n)).toBe(190);
  });
});

describe("horizontalScale", () => {
  it("spreads points across the usable width", () => {
    const x = horizontalScale(5, 210, 5);
    expect(x(0)).toBe(5);
    expect(x(4)).toBe(205);
    expect(x(2)).toBe(105);
  });

  // Mutation caught: dividing by (count - 1) with count 1, which is NaN.
  it("puts a single point at the left pad", () => {
    expect(horizontalScale(1, 210, 5)(0)).toBe(5);
  });
});

describe("polylinePoints", () => {
  it("emits one vertex per value and never a NaN", () => {
    const values = [0n, 50n, 100n];
    const out = polylinePoints(values, verticalScale(values, 200, 10), horizontalScale(3, 210, 5));
    expect(out.split(" ")).toHaveLength(3);
    expect(out).not.toContain("NaN");
    expect(out).toBe("5,190 105,100 205,10");
  });
});
