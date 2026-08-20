import { centsFromDecimal, unitsFromDecimal } from "./money";
import { checkInvariants, assertInvariants } from "./invariants";
import type { PoolState, HolderState } from "./replay";

function holder(over: Partial<HolderState> = {}): HolderState {
  return {
    holderId: 1, isManager: false, splitBps: 4000,
    units: unitsFromDecimal("100"), basisCents: centsFromDecimal("100"),
    status: "active", ...over,
  };
}

function state(over: Partial<PoolState> = {}): PoolState {
  return {
    equityCents: centsFromDecimal("200"),
    units: unitsFromDecimal("200"),
    holders: [holder({ holderId: 1 }), holder({ holderId: 2 })],
    lastReadingOn: "2026-01-01",
    seq: 3,
    ...over,
  };
}

describe("checkInvariants — a healthy pool", () => {
  it("reports no violations", () => {
    expect(checkInvariants(state())).toEqual([]);
  });
  it("reports no violations for an empty pool", () => {
    expect(checkInvariants(state({ equityCents: 0n, units: 0n, holders: [] }))).toEqual([]);
  });
});

describe("I1 — holder units sum to units issued", () => {
  it("catches a shortfall", () => {
    const v = checkInvariants(state({ units: unitsFromDecimal("300") }));
    expect(v.map((x) => x.code)).toContain("I1_UNITS_SUM");
  });
  it("names both figures in the detail", () => {
    const v = checkInvariants(state({ units: unitsFromDecimal("300") }));
    expect(v.find((x) => x.code === "I1_UNITS_SUM")!.detail).toMatch(/\d+/);
  });
});

describe("I2 — holder values sum to equity", () => {
  it("holds exactly when equity does not divide evenly", () => {
    // $10.00 across three equal holders — largest-remainder must close the gap.
    const s = state({
      equityCents: 1000n,
      units: unitsFromDecimal("3"),
      holders: [
        holder({ holderId: 1, units: unitsFromDecimal("1") }),
        holder({ holderId: 2, units: unitsFromDecimal("1") }),
        holder({ holderId: 3, units: unitsFromDecimal("1") }),
      ],
    });
    expect(checkInvariants(s).filter((v) => v.code === "I2_VALUE_SUM")).toEqual([]);
  });

  it("catches equity present with no units", () => {
    const v = checkInvariants(state({ equityCents: 500n, units: 0n, holders: [] }));
    expect(v.map((x) => x.code)).toContain("I2_ORPHAN_EQUITY");
  });

  it("does not run the value check when I1 already failed", () => {
    const v = checkInvariants(state({ units: unitsFromDecimal("300") }));
    expect(v.map((x) => x.code)).not.toContain("I2_VALUE_SUM");
  });
});

describe("I4 — no negative quantities", () => {
  it("catches negative units", () => {
    const s = state({
      units: unitsFromDecimal("0"),
      holders: [holder({ holderId: 1, units: -1n }), holder({ holderId: 2, units: 1n })],
    });
    expect(checkInvariants(s).map((x) => x.code)).toContain("I4_NEGATIVE_UNITS");
  });
  it("catches a negative cost basis", () => {
    const s = state({ holders: [
      holder({ holderId: 1, basisCents: -1n }),
      holder({ holderId: 2 }),
    ] });
    expect(checkInvariants(s).map((x) => x.code)).toContain("I4_NEGATIVE_BASIS");
  });
});

describe("assertInvariants", () => {
  it("is silent on a healthy pool", () => {
    expect(() => assertInvariants(state())).not.toThrow();
  });
  it("throws listing every violation", () => {
    expect(() => assertInvariants(state({ units: unitsFromDecimal("300") })))
      .toThrow(/I1_UNITS_SUM/);
  });
});
