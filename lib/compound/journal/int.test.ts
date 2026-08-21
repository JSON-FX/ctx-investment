import { absBig, divFloor, maxBig, minBig, toIndex } from "./int";

describe("divFloor", () => {
  // Mutation caught: `return n / d`. BigInt division truncates toward zero,
  // so every one of these negative cases comes back one too high.
  it("floors a negative quotient away from zero", () => {
    expect(divFloor(-7n, 2n)).toBe(-4n); // truncation gives -3n
    expect(divFloor(-2773n, 3n)).toBe(-925n); // truncation gives -924n
    expect(divFloor(-1n, 3n)).toBe(-1n); // truncation gives 0n
  });

  it("floors a positive quotient toward zero, which is the same thing", () => {
    expect(divFloor(7n, 2n)).toBe(3n);
    expect(divFloor(6231n, 5n)).toBe(1246n); // 1246.2
  });

  // Mutation caught: an unconditional `q - 1n`, which would make every exact
  // division one too low.
  it("does not adjust an exact division, in either sign", () => {
    expect(divFloor(-8n, 2n)).toBe(-4n);
    expect(divFloor(8n, 2n)).toBe(4n);
    expect(divFloor(0n, 5n)).toBe(0n);
  });

  // Mutation caught: comparing signs with `n < 0n && d < 0n` instead of `!==`.
  it("floors correctly when the divisor is negative", () => {
    expect(divFloor(7n, -2n)).toBe(-4n);
    expect(divFloor(-7n, -2n)).toBe(3n);
  });

  it("rejects a zero divisor rather than returning a poisoned value", () => {
    expect(() => divFloor(1n, 0n)).toThrow(/division by zero/);
  });
});

describe("absBig / maxBig / minBig", () => {
  it("handles the sign boundary", () => {
    expect(absBig(-1n)).toBe(1n);
    expect(absBig(0n)).toBe(0n);
    expect(maxBig(-5n, -9n)).toBe(-5n);
    expect(minBig(-5n, -9n)).toBe(-9n);
  });
});

describe("toIndex", () => {
  it("converts a small non-negative bigint", () => {
    expect(toIndex(0n)).toBe(0);
    expect(toIndex(7n)).toBe(7);
  });

  // Mutation caught: `Number(n)` with no guard. 9007199254740993n silently
  // becomes 9007199254740992 — the exact failure spec section 4 exists to
  // prevent, arriving through an index instead of through a balance.
  it("refuses a value that could only have come from a money figure", () => {
    expect(() => toIndex(9_007_199_254_740_993n)).toThrow(/out of range/);
    expect(() => toIndex(-1n)).toThrow(/out of range/);
  });
});
