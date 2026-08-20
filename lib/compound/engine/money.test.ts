import {
  UNIT_SCALE, mulDivFloor, mulDivCeil,
  centsFromDecimal, formatCents, unitsFromDecimal, formatUnits,
} from "./money";

describe("mulDivFloor", () => {
  it("computes a*b/d truncating toward zero", () => {
    expect(mulDivFloor(7n, 3n, 2n)).toBe(10n);      // 21/2 = 10.5 -> 10
    expect(mulDivFloor(100n, 1n, 3n)).toBe(33n);
  });
  it("is exact when the division terminates", () => {
    expect(mulDivFloor(100n, 4n, 8n)).toBe(50n);
  });
  it("rejects a zero divisor", () => {
    expect(() => mulDivFloor(1n, 1n, 0n)).toThrow(RangeError);
  });
  it("rejects negative operands", () => {
    expect(() => mulDivFloor(-1n, 1n, 2n)).toThrow(RangeError);
  });
});

describe("mulDivCeil", () => {
  it("rounds up when the division does not terminate", () => {
    expect(mulDivCeil(7n, 3n, 2n)).toBe(11n);       // 21/2 = 10.5 -> 11
    expect(mulDivCeil(100n, 1n, 3n)).toBe(34n);
  });
  it("does not round up when exact", () => {
    expect(mulDivCeil(100n, 4n, 8n)).toBe(50n);
  });
  it("returns zero for a zero numerator", () => {
    expect(mulDivCeil(0n, 5n, 3n)).toBe(0n);
  });
});

describe("centsFromDecimal", () => {
  it("parses whole and fractional amounts", () => {
    expect(centsFromDecimal("309.41")).toBe(30941n);
    expect(centsFromDecimal("1000")).toBe(100000n);
    expect(centsFromDecimal("0.07")).toBe(7n);
    expect(centsFromDecimal("12.5")).toBe(1250n);
  });
  it("parses negatives", () => {
    expect(centsFromDecimal("-43.06")).toBe(-4306n);
  });
  it("rejects more than two decimal places", () => {
    expect(() => centsFromDecimal("1.234")).toThrow(RangeError);
  });
  it("rejects non-numeric input", () => {
    expect(() => centsFromDecimal("abc")).toThrow(RangeError);
  });
});

describe("formatCents", () => {
  it("always renders two decimal places", () => {
    expect(formatCents(30941n)).toBe("309.41");
    expect(formatCents(7n)).toBe("0.07");
    expect(formatCents(100000n)).toBe("1000.00");
  });
  it("renders negatives with a leading sign", () => {
    expect(formatCents(-4306n)).toBe("-43.06");
  });
  it("round-trips with centsFromDecimal", () => {
    for (const s of ["0.00", "0.01", "309.41", "-43.06", "999999.99"]) {
      expect(formatCents(centsFromDecimal(s))).toBe(s);
    }
  });
});

describe("unitsFromDecimal", () => {
  it("scales by UNIT_SCALE", () => {
    expect(unitsFromDecimal("1")).toBe(UNIT_SCALE);
    expect(unitsFromDecimal("309.41")).toBe(3094100000000n);
    expect(unitsFromDecimal("0.0000000001")).toBe(1n);
  });
  it("rejects more than ten decimal places", () => {
    expect(() => unitsFromDecimal("1.00000000001")).toThrow(RangeError);
  });
});

describe("formatUnits", () => {
  it("truncates to the requested precision", () => {
    expect(formatUnits(3094100000000n, 2)).toBe("309.41");
    expect(formatUnits(3094199999999n, 2)).toBe("309.41");
    expect(formatUnits(UNIT_SCALE, 0)).toBe("1");
  });
  it("defaults to two decimal places", () => {
    expect(formatUnits(3094100000000n)).toBe("309.41");
  });
  it("rejects an out-of-range precision", () => {
    expect(() => formatUnits(UNIT_SCALE, 11)).toThrow(RangeError);
  });
});
