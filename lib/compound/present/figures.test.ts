import { formatDate } from "./format";
import {
  MINUS,
  lots,
  money,
  pctFromBps,
  ratioFromMilli,
  signedMoney,
  toneOf,
  utcDate,
  utcStamp,
} from "./figures";

describe("money", () => {
  // Mutation caught: dividing by 100 into a float. 9007199254740993n cannot
  // survive that trip, and the assertion names the exact string it must give.
  it("groups thousands and never loses a cent", () => {
    expect(money(1_263_061n)).toBe("12,630.61");
    expect(money(7n)).toBe("0.07");
    expect(money(100_000n)).toBe("1,000.00");
    expect(money(-409n)).toBe("4.09");
    expect(money(9_007_199_254_740_993n)).toBe("90,071,992,547,409.93");
  });

  // Mutation caught: `\B(?=(\d{3})+)` without the negative lookahead, which
  // inserts a comma inside the decimal part.
  it("does not group the decimal part", () => {
    expect(money(123_456_789n)).toBe("1,234,567.89");
  });

  it("carries no currency symbol, unlike format.ts's formatMoney", () => {
    expect(money(100n)).not.toContain("$");
  });
});

describe("signedMoney", () => {
  // Mutation caught: using a hyphen. Spec section 8.3 needs a glyph that is
  // digit-width in the mono face.
  it("uses a real minus sign and no sign at zero", () => {
    expect(signedMoney(1237n)).toBe("+12.37");
    expect(signedMoney(-409n)).toBe(`${MINUS}4.09`);
    expect(signedMoney(0n)).toBe("0.00");
    expect(MINUS).toBe("−");
    expect(signedMoney(-409n)).not.toContain("-");
  });
});

describe("pctFromBps", () => {
  // Mutation caught: `(bps / 100).toFixed(2)`, which is a float path and
  // renders 5555 as "55.55" by luck and 1 as "0.01" by luck, but is banned.
  it("renders basis points with two decimals", () => {
    expect(pctFromBps(5555)).toBe("55.55%");
    expect(pctFromBps(10_000)).toBe("100.00%");
    expect(pctFromBps(1)).toBe("0.01%");
    expect(pctFromBps(0)).toBe("0.00%");
    expect(pctFromBps(-250)).toBe(`${MINUS}2.50%`);
  });

  // Mutation caught: no zero-pad, which renders 5505 as "55.5%".
  it("zero-pads a single-digit remainder", () => {
    expect(pctFromBps(5505)).toBe("55.05%");
  });

  it("rejects a fractional value rather than rounding it silently", () => {
    expect(() => pctFromBps(55.5)).toThrow(/integer/);
  });

  // format.ts's formatPpm throws on a negative ppm; pctFromBps must not
  // inherit that, since a losing period's percentage is routinely negative.
  it("accepts a negative value that formatPpm would reject", () => {
    expect(() => pctFromBps(-1)).not.toThrow();
  });
});

describe("ratioFromMilli", () => {
  it("renders thousandths and an em dash for null", () => {
    expect(ratioFromMilli(2247n)).toBe("2.247");
    expect(ratioFromMilli(20n)).toBe("0.020");
    expect(ratioFromMilli(1_000_000n)).toBe("1,000.000");
    expect(ratioFromMilli(null)).toBe("—");
  });

  it("signs a negative ratio with the same glyph as money", () => {
    expect(ratioFromMilli(-2247n)).toBe(`${MINUS}2.247`);
  });
});

describe("lots", () => {
  it("renders milli-lots as two decimals", () => {
    expect(lots(50)).toBe("0.05");
    expect(lots(1200)).toBe("1.20");
    expect(lots(0)).toBe("0.00");
    expect(lots(120)).toBe("0.12");
  });

  it("rejects a fractional milli-lot", () => {
    expect(() => lots(50.5)).toThrow(/integer/);
  });

  it("rejects a negative milli-lot", () => {
    expect(() => lots(-10)).toThrow(/integer/);
  });
});

describe("utcStamp", () => {
  it("slices a UTC instant to date and minute", () => {
    expect(utcStamp("2026-05-08T14:15:00.000Z")).toBe("2026-05-08 14:15");
  });

  // Mutation caught: dropping the Z guard, which would print "2026-05-08
  // 23:30" for a +03:00 timestamp whose UTC time is 20:30 — a wall clock in
  // the wrong zone with nothing on screen to say so. format.ts's own
  // formatUtcStamp has no such guard; this is the exact gap composing from
  // it would have inherited.
  it("refuses a timestamp that is not UTC", () => {
    expect(() => utcStamp("2026-05-08T23:30:00+03:00")).toThrow(/ending in Z/);
    expect(() => utcStamp("2026-05-08 14:15:00")).toThrow(/ending in Z/);
  });
});

describe("utcDate", () => {
  // utcDate is format.ts's formatDate re-exported under the name this
  // module's interface promises, not a second implementation. Proven by
  // reference equality, not merely by matching output — a passing behavioural
  // test alone would not catch a future edit that reintroduces a parallel
  // implementation with (for now) identical output.
  it("is exactly format.ts's formatDate", () => {
    expect(utcDate).toBe(formatDate);
  });

  it("renders a date key without a leading zero on the day", () => {
    expect(utcDate("2026-05-08")).toBe("8 May 2026");
    expect(utcDate("2026-12-25")).toBe("25 Dec 2026");
  });
});

describe("toneOf", () => {
  it("returns the existing utility classes, and nothing at zero", () => {
    expect(toneOf(1n)).toBe("pos");
    expect(toneOf(-1n)).toBe("neg");
    expect(toneOf(0n)).toBe("");
  });
});
