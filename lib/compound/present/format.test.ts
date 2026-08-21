import { centsFromDecimal, unitsFromDecimal } from "@/lib/compound/engine/money";
import { allocateValues, valueOfUnits } from "@/lib/compound/engine/nav";
import { fold, totalsOf } from "@/lib/compound/engine/replay";
import { ADA_ID, LEDGER, SEEDS } from "./fixture";
import {
  formatDate, formatMoney, formatNav, formatPpm, formatSinceInception,
  formatSplit, formatSplitWords, formatUnitsDp, formatUtcStamp, signOf, splitMoney,
} from "./format";

const STATE = fold(LEDGER, SEEDS);
const TOTALS = totalsOf(STATE);

describe("formatMoney", () => {
  it("groups thousands and keeps both cents", () => {
    expect(formatMoney(centsFromDecimal("55743.91"))).toBe("$55,743.91");
  });

  it("groups millions", () => {
    expect(formatMoney(centsFromDecimal("1234567.08"))).toBe("$1,234,567.08");
  });

  it("keeps a trailing zero in the cents", () => {
    // "1000.50" -> 100050 cents. A Number round trip renders "1000.5".
    expect(formatMoney(centsFromDecimal("1000.50"))).toBe("$1,000.50");
  });

  it("puts the minus outside the symbol", () => {
    expect(formatMoney(centsFromDecimal("-1364.84"))).toBe("-$1,364.84");
  });

  it("signs a positive figure only when asked", () => {
    expect(formatMoney(centsFromDecimal("2630.61"))).toBe("$2,630.61");
    expect(formatMoney(centsFromDecimal("2630.61"), { sign: "always" })).toBe("+$2,630.61");
  });

  it("signs zero as positive under sign:always, because zero P/L is not a loss", () => {
    expect(formatMoney(0n, { sign: "always" })).toBe("+$0.00");
  });

  it("renders a sub-dollar figure without losing the leading zero", () => {
    expect(formatMoney(centsFromDecimal("0.07"))).toBe("$0.07");
  });

  it("uses the account currency symbol", () => {
    expect(formatMoney(centsFromDecimal("12.34"), { currency: "EUR" })).toBe("€12.34");
  });

  it("falls back to the code for a currency it has no symbol for", () => {
    expect(formatMoney(centsFromDecimal("12.34"), { currency: "PHP" })).toBe("PHP 12.34");
  });

  it("survives a figure past Number.MAX_SAFE_INTEGER", () => {
    // 9007199254740993 cents. As a double this is 9007199254740992 — the two
    // integers on either side of MAX_SAFE_INTEGER are not distinguishable
    // once a Number conversion has happened, so this only passes if no money
    // value is ever converted to Number on its way through.
    expect(formatMoney(9_007_199_254_740_993n)).toBe("$90,071,992,547,409.93");
  });
});

describe("splitMoney", () => {
  it("separates the major and minor parts", () => {
    expect(splitMoney(centsFromDecimal("55743.91"))).toEqual({ whole: "$55,743", cents: "91" });
  });

  it("keeps the sign with the major part", () => {
    expect(splitMoney(centsFromDecimal("-8.05"))).toEqual({ whole: "-$8", cents: "05" });
  });
});

describe("formatUnitsDp", () => {
  it("truncates rather than rounds, at 4dp (decision D-K)", () => {
    // Ada's raw units are 9113.7132585206... — the fifth decimal digit is 5
    // and the sixth is 8, so a round-half-up implementation would print
    // 9,113.7133. Truncation prints 9,113.7132. Verified against a real
    // fold(), not picked to look right.
    const ada = STATE.holders.find((h) => h.holderId === ADA_ID)!;
    expect(formatUnitsDp(ada.units)).toBe("9,113.7132");
  });

  it("groups thousands", () => {
    expect(formatUnitsDp(unitsFromDecimal("40222.4547963043"))).toBe("40,222.4547");
  });

  it("keeps ten places when asked", () => {
    expect(formatUnitsDp(unitsFromDecimal("40222.4547963043"), 10)).toBe("40,222.4547963043");
  });

  it("renders zero units without a stray separator", () => {
    expect(formatUnitsDp(0n)).toBe("0.0000");
  });

  it("puts the minus outside the grouped digits", () => {
    // Units are never negative in a valid PoolState, but LedgerStep deltas
    // (Task 3) can be — a payout step's holderUnitsDelta is a redemption.
    // formatUnitsDp must not silently drop the sign on that path.
    expect(formatUnitsDp(unitsFromDecimal("-1234.5"))).toBe("-1,234.5000");
  });

  it("survives a raw unit value past Number.MAX_SAFE_INTEGER", () => {
    // UNIT_SCALE is 1e10, so any pool north of ~900,000 whole units has a raw
    // value past 2^53. 1,000,000.0000000001 units -> 10000000000000001n raw.
    expect(formatUnitsDp(unitsFromDecimal("1000000.0000000001"), 10)).toBe(
      "1,000,000.0000000001",
    );
  });
});

describe("formatNav", () => {
  it("is 1.3858 on the fixture, truncated at 4dp", () => {
    // The true value is 1.38589... (verified to 5dp against the engine
    // separately). Truncating prints 1.3858; rounding would print 1.3859.
    // This one assertion is enough to catch either floor->round or
    // floor->ceil in navTimes1e4, without this test needing to know that.
    expect(formatNav(TOTALS)).toBe("1.3858");
  });

  it("is 1.0000 at genesis", () => {
    expect(formatNav({ equityCents: 0n, units: 0n })).toBe("1.0000");
  });

  it("pads a NAV whose fraction has leading zeros", () => {
    // equity 1000.50 across 1000 units is NAV 1.0005. Without padStart the
    // fraction renders as "5" and the figure reads 1.5.
    expect(formatNav({
      equityCents: centsFromDecimal("1000.50"),
      units: unitsFromDecimal("1000"),
    })).toBe("1.0005");
  });
});

describe("formatSinceInception", () => {
  it("is +38.58% on the fixture", () => {
    expect(formatSinceInception(TOTALS)).toBe("+38.58%");
  });

  it("is +0.00% at genesis, not an empty string", () => {
    expect(formatSinceInception({ equityCents: 0n, units: 0n })).toBe("+0.00%");
  });

  it("signs a loss", () => {
    // 0.9474 NAV -> -5.26%
    expect(formatSinceInception({
      equityCents: centsFromDecimal("38110.44"),
      units: unitsFromDecimal("40222.4547963043"),
    })).toBe("-5.26%");
  });
});

describe("formatPpm", () => {
  it("renders a share at 2dp", () => {
    expect(formatPpm(621_543)).toBe("62.15%");
  });

  it("renders a whole hundred percent", () => {
    expect(formatPpm(1_000_000)).toBe("100.00%");
  });

  it("pads a small share", () => {
    expect(formatPpm(407)).toBe("0.04%");
  });

  it("rounds an exact half up, distinguishing round from floor", () => {
    // 650 ppm / 100 = 6.50 hundredths exactly (an exact IEEE-754 half, not an
    // artefact of the division) — round-half-up gives 7 -> "0.07%"; floor
    // gives 6 -> "0.06%". Floor is the rounding bias used everywhere in
    // engine/, so "harmonise formatPpm with the engine's floor bias" is a
    // plausible, wrong edit this test is here to catch.
    expect(formatPpm(650)).toBe("0.07%");
  });

  it("refuses a share outside 0..1000000", () => {
    expect(() => formatPpm(1_000_001)).toThrow(/ppm must be an integer/);
  });
});

describe("formatSplit", () => {
  it("renders the default as 60 / 40", () => {
    expect(formatSplit(4000)).toBe("60 / 40");
  });

  it("renders Grace's 3700 as 63 / 37, not 60 / 40", () => {
    expect(formatSplit(3700)).toBe("63 / 37");
  });

  it("keeps two decimals for a split that is not a whole percent", () => {
    expect(formatSplit(3750)).toBe("62.50 / 37.50");
  });

  it("refuses a split outside 0..10000", () => {
    expect(() => formatSplit(10_001)).toThrow(/splitBps must be an integer/);
  });
});

describe("formatSplitWords", () => {
  it("names the holder, both percentages, and when the fee applies", () => {
    const words = formatSplitWords(3700, "Grace Hopper");
    expect(words).toContain("Grace Hopper keeps 63% of profit and you keep 37%");
    expect(words).toContain("only when Grace Hopper withdraws");
    expect(words).toContain("only on profit above what Grace Hopper has put in");
  });
});

describe("formatDate", () => {
  it("renders a broker-server date without constructing a Date", () => {
    expect(formatDate("2026-08-14")).toBe("14 Aug 2026");
  });

  it("does not shift the day west of UTC", () => {
    // A Date built from "2026-01-01" is midnight UTC, which is 31 Dec locally
    // anywhere west of Greenwich. This function never builds one.
    expect(formatDate("2026-01-01")).toBe("1 Jan 2026");
  });

  it("refuses a timestamp", () => {
    expect(() => formatDate("2026-08-14T00:00:00Z")).toThrow(/not a YYYY-MM-DD date/);
  });

  it("refuses a month the regex shape allows but no calendar has", () => {
    // "13" matches \d{2}; MONTHS[12] is undefined. Under noUncheckedIndexedAccess
    // that must fail loudly, not print the literal string "undefined".
    expect(() => formatDate("2026-13-01")).toThrow(/month out of range/);
  });
});

describe("formatUtcStamp", () => {
  it("renders the UTC wall clock, whatever zone the reader is in", () => {
    expect(formatUtcStamp("2026-08-18T09:14:22.000Z")).toBe("18 Aug 2026, 09:14 UTC");
  });

  it("does not shift a stamp near midnight", () => {
    // new Date("2026-01-01T00:30:00Z") is 31 Dec locally west of Greenwich.
    expect(formatUtcStamp("2026-01-01T00:30:00.000Z")).toBe("1 Jan 2026, 00:30 UTC");
  });

  it("refuses a bare date", () => {
    expect(() => formatUtcStamp("2026-08-18")).toThrow(/not an ISO 8601 timestamp/);
  });
});

describe("signOf", () => {
  it("distinguishes zero from positive", () => {
    expect(signOf(0n)).toBe("zero");
    expect(signOf(1n)).toBe("pos");
    expect(signOf(-1n)).toBe("neg");
  });
});

describe("decision D-A: allocated and floored value are both formatted, and stay distinct", () => {
  // The desk shows allocateValues (sums to equity exactly); a payout receipt
  // shows quote()'s valueCents, i.e. valueOfUnits (floored, so nobody redeems
  // more than the pool holds). format.ts does not choose between them — it
  // formats whichever Cents it is handed. This test proves the boundary
  // preserves the one-cent gap rather than quietly collapsing it, which is
  // the failure mode D-A exists to name: a formatter that rounds allocated
  // and floored to the same string would make this file's Cents value look
  // like a rendering choice instead of two different questions.
  const ada = STATE.holders.find((h) => h.holderId === ADA_ID)!;
  const holderUnitsInOrder = STATE.holders.map((h) => h.units);
  const allocated = allocateValues(TOTALS, holderUnitsInOrder);
  const adaIndex = STATE.holders.indexOf(ada);

  it("allocated value formats to $12,630.61", () => {
    expect(formatMoney(allocated[adaIndex]!)).toBe("$12,630.61");
  });

  it("floored value formats to $12,630.60 — one cent less, not an error", () => {
    expect(formatMoney(valueOfUnits(TOTALS, ada.units))).toBe("$12,630.60");
  });

  it("the two figures are not equal", () => {
    expect(formatMoney(allocated[adaIndex]!)).not.toBe(formatMoney(valueOfUnits(TOTALS, ada.units)));
  });
});
