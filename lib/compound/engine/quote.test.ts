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
  it("rejects a negative cost basis", () => {
    // fold() cannot produce one, but quote() is a public entry point the
    // receipt calls directly. A negative basis would inflate profit past the
    // holding's value, letting feeCents exceed grossCents on exit and driving
    // toHolderCents negative.
    expect(() => quote(input({ basisCents: -1n }))).toThrow(RangeError);
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

  it("redeems the holder's exact balance on exit, not a value-derived figure", () => {
    // The receipt and fold() must agree. Deriving units from value would
    // under-recover here: valueOfUnits floors 2 units to $4.66, and ceiling
    // that back gives 19_971_428_572 against a balance of 20_000_000_000 —
    // stranding 0.0029 units in a holder who has left.
    const q = quote({
      totals: AWKWARD,
      holderUnits: unitsFromDecimal("2"),
      basisCents: 100n,
      splitBps: 4000,
      isManager: false,
      mode: "exit",
    });
    expect(q.valueCents).toBe(466n);
    expect(q.unitsRedeemed).toBe(unitsFromDecimal("2"));
  });
});

// P6 — partial withdrawal. A holder takes an arbitrary amount, capped at
// their current value. The proportional rule: this withdrawal carries the
// same profit/capital mix as the whole position, because units are fungible.
describe("quote — partial withdrawal, proportional rule", () => {
  it("splits the withdrawal proportionally to the holder's profit/capital mix", () => {
    // Whole position: value $250, basis $100, profit $150 (60% of value).
    // Withdraw exactly half the value ($125): capital and profit both halve.
    const q = quote(input({ mode: "partial", amountCents: centsFromDecimal("125") }));
    expect(q.grossCents).toBe(centsFromDecimal("125"));
    expect(q.capitalPortionCents).toBe(centsFromDecimal("50"));       // 125 * 100/250
    expect(q.withdrawalProfitCents).toBe(centsFromDecimal("75"));     // 125 * 150/250
    expect(q.capitalPortionCents + q.withdrawalProfitCents).toBe(q.grossCents);
    expect(q.feeCents).toBe(centsFromDecimal("30"));                  // 75 * 40%
    expect(q.toHolderCents).toBe(centsFromDecimal("95"));             // 125 - 30
    expect(q.newBasisCents).toBe(centsFromDecimal("50"));             // 100 - 50
  });

  it("floors the profit slice on a division that does not land evenly, favouring the investor", () => {
    // AWKWARD-style pool, so the split itself has a genuine remainder, not
    // just unitsRedeemed. holderUnits 3, basis $6.00, value $7.00 (profit
    // $1.00). Withdraw $3.33.
    //   exact profit slice = 333 * 100/700 = 47.571... -> floor 47
    //   capital slice (complement) = 333 - 47 = 286, NOT floor(333*600/700)=285
    // Flooring the PROFIT side (not the capital side) is the direction that
    // charges no more fee than the exact proportional split would — flooring
    // capital instead would inflate the fee base and charge the holder more
    // than the exact split, which is the wrong direction per the fee-amount
    // rule ("floor — favours the investor").
    const AWKWARD: PoolTotals = { equityCents: 700n, units: unitsFromDecimal("3") };
    const q = quote({
      totals: AWKWARD,
      holderUnits: unitsFromDecimal("3"),
      basisCents: 600n,
      splitBps: 4000,
      isManager: false,
      mode: "partial",
      amountCents: 333n,
    });
    expect(q.withdrawalProfitCents).toBe(47n);
    expect(q.capitalPortionCents).toBe(286n);
    expect(q.capitalPortionCents + q.withdrawalProfitCents).toBe(333n);
    expect(q.feeCents).toBe(18n);          // floor(47 * 40%) = floor(18.8)
    expect(q.toHolderCents).toBe(315n);    // 333 - 18
    expect(q.newBasisCents).toBe(314n);    // 600 - 286
    // Ceils, same direction as every other unitsRedeemed — lands on an
    // awkward, non-terminating fraction of a unit here (not a half-unit;
    // the NAV-2.00 fixture below covers the half-unit case).
    expect(q.unitsRedeemed).toBe(14_271_428_572n);
  });

  it("lands exactly on a half-unit at a flat NAV", () => {
    // NAV $2.00 flat: $125 buys exactly 62.5 units.
    const q = quote(input({ mode: "partial", amountCents: centsFromDecimal("125") }));
    expect(q.unitsRedeemed).toBe(unitsFromDecimal("62.5"));
  });

  it("charges no fee at all below the high-water mark — there is no profit to split", () => {
    const under = input({ basisCents: centsFromDecimal("400") }); // value $250 < basis $400
    const q = quote({ ...under, mode: "partial", amountCents: centsFromDecimal("100") });
    expect(q.withdrawalProfitCents).toBe(0n);
    expect(q.capitalPortionCents).toBe(centsFromDecimal("100"));
    expect(q.feeCents).toBe(0n);
    expect(q.toHolderCents).toBe(centsFromDecimal("100"));
    expect(q.newBasisCents).toBe(centsFromDecimal("300")); // 400 - 100
  });

  it("never charges the manager a fee on their own partial withdrawal", () => {
    const q = quote(input({ mode: "partial", amountCents: centsFromDecimal("125"), isManager: true }));
    expect(q.feeCents).toBe(0n);
    expect(q.splitBpsApplied).toBe(0);
    expect(q.toHolderCents).toBe(centsFromDecimal("125"));
  });

  describe("the cap — a holder may never withdraw more than they hold", () => {
    // Deliberately NOT a round fraction of value (basis $90 of value $250,
    // a 36% ratio) so the boundary isn't hiding behind a fixture where the
    // arithmetic happens to land cleanly regardless of which cent is at play.
    const common = {
      totals: POOL,
      holderUnits: unitsFromDecimal("125"),   // value $250
      basisCents: centsFromDecimal("90"),
      splitBps: 4000,
      isManager: false,
    } as const;
    const cap = centsFromDecimal("250");

    it("succeeds at exactly the cap, and is equivalent to an exit", () => {
      const partial = quote({ ...common, mode: "partial", amountCents: cap });
      const exit = quote({ ...common, mode: "exit" });
      expect(partial.grossCents).toBe(exit.grossCents);
      expect(partial.feeCents).toBe(exit.feeCents);
      expect(partial.toHolderCents).toBe(exit.toHolderCents);
      expect(partial.capitalPortionCents).toBe(exit.capitalPortionCents);
      expect(partial.newBasisCents).toBe(exit.newBasisCents);
      // The whole point: redeems the holder's EXACT unit balance, not a
      // value-derived figure that can strand a fraction of a unit.
      expect(partial.unitsRedeemed).toBe(common.holderUnits);
      expect(partial.unitsRedeemed).toBe(exit.unitsRedeemed);
      expect(partial.newBasisCents).toBe(0n);
    });

    it("succeeds one cent under the cap", () => {
      // Provably exact, not fixture luck: at A = cap-1, floor((cap-1)*P/V)
      // always equals P-1 for integer 0<P<V (since 0 < P/V < 1 puts
      // P - P/V strictly between P-1 and P), so capitalPortion always comes
      // out to exactly (cap-1)-(P-1) = V-P = B, and newBasisCents is exactly
      // zero at this boundary regardless of the fixture's numbers.
      const q = quote({ ...common, mode: "partial", amountCents: cap - 1n });
      expect(q.newBasisCents).toBe(0n);
      expect(() => q).not.toThrow();
    });

    it("refuses one cent over the cap, naming the cap in the message", () => {
      expect(() => quote({ ...common, mode: "partial", amountCents: cap + 1n }))
        .toThrow(/exceeds the holder's value of 25000 cents/);
      expect(() => quote({ ...common, mode: "partial", amountCents: cap + 1n }))
        .toThrow(RangeError);
    });

    it("refuses a non-positive amount", () => {
      expect(() => quote({ ...common, mode: "partial", amountCents: 0n })).toThrow(RangeError);
      expect(() => quote({ ...common, mode: "partial", amountCents: -1n })).toThrow(RangeError);
    });

    it("requires amountCents at all for partial mode", () => {
      expect(() => quote({ ...common, mode: "partial" })).toThrow(RangeError);
    });
  });
});
