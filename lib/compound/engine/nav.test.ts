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
    // equity $7.00 across 3 units. $1.00 buys 4.285714285714... units —
    // a genuine remainder, so floor and ceil differ by one and this test
    // fails if the implementation ever switches to ceil.
    const t: PoolTotals = { equityCents: 700n, units: unitsFromDecimal("3") };
    const issued = unitsForDeposit(t, 100n);
    expect(issued).toBe(4285714285n);
    // Never more units than the money paid for.
    expect(issued * t.equityCents <= 100n * t.units).toBe(true);
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
    // Same fixture as the deposit floor test, so the two directions are
    // directly comparable: exact value is 4285714285.714…, floor 4285714285,
    // ceil 4285714286. Redemption must take the larger.
    const t: PoolTotals = { equityCents: 700n, units: unitsFromDecimal("3") };
    const redeemed = unitsToRedeem(t, 100n);
    expect(redeemed).toBe(4285714286n);
    // Never leave a holder holding units the cash already paid for.
    expect(redeemed * t.equityCents >= 100n * t.units).toBe(true);
  });
  it("redeems nothing for a zero payout", () => {
    const t: PoolTotals = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("500") };
    expect(unitsToRedeem(t, 0n)).toBe(0n);
  });
});

describe("unitsForFee", () => {
  it("floors, so the manager receives no rounding advantage", () => {
    // Same fixture again. The manager is a holder like any other, so the
    // fee converts to units at floor, not ceil.
    const t: PoolTotals = { equityCents: 700n, units: unitsFromDecimal("3") };
    const fu = unitsForFee(t, 100n);
    expect(fu).toBe(4285714285n);
    expect(fu * t.equityCents <= 100n * t.units).toBe(true);
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
