import { centsFromDecimal, unitsFromDecimal } from "./money";
import type { PoolTotals } from "./nav";
import { quote, type QuoteInput } from "./quote";

// A pool worth $1,000 across 500 units — NAV 2.00.
const POOL: PoolTotals = {
  equityCents: centsFromDecimal("1000"),
  units: unitsFromDecimal("500"),
};

function input(over: Partial<QuoteInput> = {}): QuoteInput {
  return {
    totals: POOL,
    holderUnits: unitsFromDecimal("125"),   // $250 at NAV 2.00
    basisCents: centsFromDecimal("100"),
    splitBps: 4000,
    isManager: false,
    mode: "profit",
    ...over,
  };
}

describe("quote — profit mode above the high-water mark", () => {
  it("values the holding at the prevailing NAV", () => {
    expect(quote(input()).valueCents).toBe(centsFromDecimal("250"));
  });

  it("measures profit against cost basis", () => {
    expect(quote(input()).profitCents).toBe(centsFromDecimal("150"));
  });

  it("splits profit by basis points, flooring the fee", () => {
    const q = quote(input());
    expect(q.feeCents).toBe(centsFromDecimal("60"));       // 150.00 * 40%
    expect(q.toHolderCents).toBe(centsFromDecimal("90"));  // 150.00 - 60.00
  });

  it("floors a fee that does not divide evenly, favouring the holder", () => {
    // profit $218.47 at 40% is $87.388 -> fee $87.38, holder keeps $131.09
    const q = quote(input({
      holderUnits: unitsFromDecimal("264.235"),   // $528.47 at NAV 2.00
      basisCents: centsFromDecimal("310.00"),
    }));
    expect(q.profitCents).toBe(centsFromDecimal("218.47"));
    expect(q.feeCents).toBe(centsFromDecimal("87.38"));
    expect(q.toHolderCents).toBe(centsFromDecimal("131.09"));
    expect(q.feeCents + q.toHolderCents).toBe(q.profitCents);
  });

  it("redeems only the units the profit is worth", () => {
    const q = quote(input());
    expect(q.unitsRedeemed).toBe(unitsFromDecimal("75")); // $150 at NAV 2.00
  });

  it("is not below the high-water mark", () => {
    expect(quote(input()).belowHighWaterMark).toBe(false);
  });
});

describe("quote — below the high-water mark", () => {
  const under = input({ basisCents: centsFromDecimal("400") }); // value $250 < basis $400

  it("reports negative profit", () => {
    expect(quote(under).profitCents).toBe(centsFromDecimal("-150"));
  });

  it("charges no fee", () => {
    expect(quote(under).feeCents).toBe(0n);
  });

  it("pays out nothing in profit mode", () => {
    const q = quote(under);
    expect(q.grossCents).toBe(0n);
    expect(q.toHolderCents).toBe(0n);
    expect(q.unitsRedeemed).toBe(0n);
  });

  it("flags the high-water mark", () => {
    expect(quote(under).belowHighWaterMark).toBe(true);
  });

  it("returns full value with no fee on exit", () => {
    const q = quote({ ...under, mode: "exit" });
    expect(q.feeCents).toBe(0n);
    expect(q.toHolderCents).toBe(centsFromDecimal("250"));
  });
});

describe("quote — exit mode above the mark", () => {
  it("returns value less the fee", () => {
    const q = quote(input({ mode: "exit" }));
    expect(q.grossCents).toBe(centsFromDecimal("250"));
    expect(q.feeCents).toBe(centsFromDecimal("60"));
    expect(q.toHolderCents).toBe(centsFromDecimal("190"));
  });
});

describe("quote — the manager", () => {
  it("never charges themselves a fee", () => {
    const q = quote(input({ isManager: true }));
    expect(q.feeCents).toBe(0n);
    expect(q.splitBpsApplied).toBe(0);
    expect(q.toHolderCents).toBe(centsFromDecimal("150"));
  });

  it("still range-checks the manager's split rather than ignoring it", () => {
    expect(() => quote(input({ isManager: true, splitBps: 10_001 }))).toThrow(RangeError);
    expect(() => quote(input({ isManager: true, splitBps: -1 }))).toThrow(RangeError);
  });

  it("forces the applied split to zero even when a valid one is passed", () => {
    const q = quote(input({ isManager: true, splitBps: 10_000 }));
    expect(q.splitBpsApplied).toBe(0);
    expect(q.feeCents).toBe(0n);
  });
});

describe("quote — validation", () => {
  it("rejects basis points outside 0..10000", () => {
    expect(() => quote(input({ splitBps: -1 }))).toThrow(RangeError);
    expect(() => quote(input({ splitBps: 10_001 }))).toThrow(RangeError);
  });
  it("accepts the boundaries", () => {
    expect(quote(input({ splitBps: 0 })).feeCents).toBe(0n);
    expect(quote(input({ splitBps: 10_000 })).feeCents).toBe(centsFromDecimal("150"));
  });
  it("never produces a negative fee", () => {
    for (const basis of ["0", "100", "250", "400", "10000"]) {
      expect(quote(input({ basisCents: centsFromDecimal(basis) })).feeCents >= 0n).toBe(true);
    }
  });
});

describe("quote — units redeemed on an awkward NAV", () => {
  // NAV here is 700/3 cents per unit, which does not divide UNIT_SCALE
  // evenly. The shared POOL fixture has NAV $2.00 exactly, so its
  // unitsRedeemed figures are identical under floor and ceil and cannot
  // detect a reversed primitive. This fixture can.
  const AWKWARD: PoolTotals = { equityCents: 700n, units: unitsFromDecimal("3") };

  it("ceils the units redeemed when the division leaves a remainder", () => {
    const q = quote({
      totals: AWKWARD,
      holderUnits: unitsFromDecimal("3"),
      basisCents: 600n,
      splitBps: 4000,
      isManager: false,
      mode: "profit",
    });
    expect(q.valueCents).toBe(700n);
    expect(q.profitCents).toBe(100n);
    expect(q.feeCents).toBe(40n);
    expect(q.toHolderCents).toBe(60n);
    // Exact value is 4285714285.714… — floor would give 4285714285n.
    expect(q.unitsRedeemed).toBe(4285714286n);
  });
});
