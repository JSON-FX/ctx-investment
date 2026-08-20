import { UNIT_SCALE, centsFromDecimal, unitsFromDecimal } from "./money";
import {
  isGenesis, unitsForDeposit, valueOfUnits, unitsToRedeem, unitsForFee,
  navTimes1e4, type PoolTotals,
} from "./nav";

const EMPTY: PoolTotals = { equityCents: 0n, units: 0n };

describe("isGenesis", () => {
  it("is true only when no units have been issued", () => {
    expect(isGenesis(EMPTY)).toBe(true);
    expect(isGenesis({ equityCents: 100n, units: UNIT_SCALE })).toBe(false);
  });
});

describe("unitsForDeposit", () => {
  it("issues one unit per dollar at genesis", () => {
    expect(unitsForDeposit(EMPTY, centsFromDecimal("309.41")))
      .toBe(unitsFromDecimal("309.41"));
  });

  it("issues at the prevailing NAV once units exist", () => {
    // equity $1,000, 500 units -> NAV 2.00. A $250 deposit buys 125 units.
    const t: PoolTotals = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("500") };
    expect(unitsForDeposit(t, centsFromDecimal("250"))).toBe(unitsFromDecimal("125"));
  });

  it("floors, so the depositor never receives more units than paid for", () => {
    // equity $1,000, 300 units -> NAV 3.3333...; $100 buys 30 units exactly.
    const t: PoolTotals = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("300") };
    const issued = unitsForDeposit(t, centsFromDecimal("100"));
    expect(issued).toBe(30n * UNIT_SCALE);
    // The exact figure is 30 units; confirm we never exceed the entitlement.
    expect(issued * t.equityCents <= centsFromDecimal("100") * t.units).toBe(true);
  });

  it("rejects a non-positive deposit", () => {
    expect(() => unitsForDeposit(EMPTY, 0n)).toThrow(RangeError);
    expect(() => unitsForDeposit(EMPTY, -1n)).toThrow(RangeError);
  });

  it("rejects equity present with no units — a corrupt state", () => {
    expect(() => unitsForDeposit({ equityCents: 500n, units: 0n }, 100n)).toThrow(RangeError);
  });
});

describe("valueOfUnits", () => {
  it("is units times NAV", () => {
    const t: PoolTotals = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("500") };
    expect(valueOfUnits(t, unitsFromDecimal("125"))).toBe(centsFromDecimal("250"));
  });
  it("is zero for an empty pool", () => {
    expect(valueOfUnits(EMPTY, 0n)).toBe(0n);
  });
  it("floors, never overstating a holder's entitlement", () => {
    const t: PoolTotals = { equityCents: 1000n, units: unitsFromDecimal("3") };
    const v = valueOfUnits(t, unitsFromDecimal("1"));
    expect(v).toBe(333n);
  });
});

describe("unitsToRedeem", () => {
  it("is the inverse of valueOfUnits when exact", () => {
    const t: PoolTotals = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("500") };
    expect(unitsToRedeem(t, centsFromDecimal("250"))).toBe(unitsFromDecimal("125"));
  });
  it("ceils, so a holder never keeps units they were paid for", () => {
    const t: PoolTotals = { equityCents: 1000n, units: unitsFromDecimal("3") };
    // $3.33 of a $10 pool with 3 units -> 0.999 units, must round up.
    const redeemed = unitsToRedeem(t, 333n);
    expect(redeemed * t.equityCents >= 333n * t.units).toBe(true);
  });
  it("redeems nothing for a zero payout", () => {
    const t: PoolTotals = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("500") };
    expect(unitsToRedeem(t, 0n)).toBe(0n);
  });
});

describe("unitsForFee", () => {
  it("floors, so the manager receives no rounding advantage", () => {
    const t: PoolTotals = { equityCents: 1000n, units: unitsFromDecimal("3") };
    const fu = unitsForFee(t, 333n);
    expect(fu * t.equityCents <= 333n * t.units).toBe(true);
  });
});

describe("navTimes1e4", () => {
  it("reports 1.0000 at genesis", () => {
    expect(navTimes1e4(EMPTY)).toBe(10_000n);
  });
  it("reports NAV to four decimal places", () => {
    const t: PoolTotals = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("500") };
    expect(navTimes1e4(t)).toBe(20_000n); // 2.0000
  });
  it("truncates rather than rounding", () => {
    const t: PoolTotals = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("300") };
    expect(navTimes1e4(t)).toBe(33_333n); // 3.3333
  });
});
