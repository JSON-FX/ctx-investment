import { checkInvariants } from "./invariants";
import { centsFromDecimal, unitsFromDecimal } from "./money";
import { navTimes1e4 } from "./nav";
import {
  fold, totalsOf,
  type HolderSeed, type LedgerEntry, type LedgerEntryType,
} from "./replay";

const MANAGER: HolderSeed = { holderId: 1, isManager: true, splitBps: 0 };
const INVESTOR: HolderSeed = { holderId: 2, isManager: false, splitBps: 4000 };

let nextSeq = 0;
beforeEach(() => { nextSeq = 0; });

function entry(
  type: LedgerEntryType,
  amount: string,
  over: Partial<LedgerEntry> = {},
): LedgerEntry {
  nextSeq += 1;
  return {
    id: nextSeq,
    seq: nextSeq,
    holderId: null,
    occurredOn: "2026-01-01",
    type,
    amountCents: centsFromDecimal(amount),
    feeSettlement: null,
    splitBpsApplied: null,
    reversesId: null,
    ...over,
  };
}

describe("fold — empty ledger", () => {
  it("returns a zeroed pool with the seeded holders", () => {
    const s = fold([], [MANAGER, INVESTOR]);
    expect(s.equityCents).toBe(0n);
    expect(s.units).toBe(0n);
    expect(s.lastReadingOn).toBeNull();
    expect(s.holders).toHaveLength(2);
    expect(s.holders.every((h) => h.units === 0n && h.basisCents === 0n)).toBe(true);
  });
});

describe("fold — deposits", () => {
  it("issues one unit per dollar for the founding deposit", () => {
    const s = fold([entry("deposit", "300", { holderId: 1 })], [MANAGER]);
    expect(s.units).toBe(unitsFromDecimal("300"));
    expect(s.equityCents).toBe(centsFromDecimal("300"));
    expect(s.holders[0]!.units).toBe(unitsFromDecimal("300"));
    expect(s.holders[0]!.basisCents).toBe(centsFromDecimal("300"));
  });

  it("leaves NAV unchanged when a second holder deposits", () => {
    const ledger = [
      entry("deposit", "300", { holderId: 1 }),
      entry("equity_reading", "600"),          // NAV doubles to 2.0000
      entry("deposit", "300", { holderId: 2 }),
    ];
    const before = fold(ledger.slice(0, 2), [MANAGER, INVESTOR]);
    const after = fold(ledger, [MANAGER, INVESTOR]);
    expect(navTimes1e4(totalsOf(before))).toBe(20_000n);
    expect(navTimes1e4(totalsOf(after))).toBe(20_000n);
  });

  it("issues the later depositor units at the prevailing NAV", () => {
    const s = fold([
      entry("deposit", "300", { holderId: 1 }),
      entry("equity_reading", "600"),
      entry("deposit", "300", { holderId: 2 }),
    ], [MANAGER, INVESTOR]);
    // $300 at NAV 2.00 buys 150 units.
    expect(s.holders.find((h) => h.holderId === 2)!.units).toBe(unitsFromDecimal("150"));
    expect(s.units).toBe(unitsFromDecimal("450"));
    expect(s.equityCents).toBe(centsFromDecimal("900"));
  });

  it("accumulates cost basis across repeat deposits", () => {
    const s = fold([
      entry("deposit", "300", { holderId: 1 }),
      entry("deposit", "200", { holderId: 1 }),
    ], [MANAGER]);
    expect(s.holders[0]!.basisCents).toBe(centsFromDecimal("500"));
  });
});

describe("fold — equity readings", () => {
  it("replaces equity and records the reading date", () => {
    const s = fold([
      entry("deposit", "300", { holderId: 1 }),
      entry("equity_reading", "412.55", { occurredOn: "2026-03-04" }),
    ], [MANAGER]);
    expect(s.equityCents).toBe(centsFromDecimal("412.55"));
    expect(s.lastReadingOn).toBe("2026-03-04");
  });

  it("does not change units", () => {
    const s = fold([
      entry("deposit", "300", { holderId: 1 }),
      entry("equity_reading", "900"),
    ], [MANAGER]);
    expect(s.units).toBe(unitsFromDecimal("300"));
  });
});

describe("fold — adjustments", () => {
  it("moves equity without issuing units", () => {
    const s = fold([
      entry("deposit", "300", { holderId: 1 }),
      entry("adjustment", "-12.50"),
    ], [MANAGER]);
    expect(s.equityCents).toBe(centsFromDecimal("287.50"));
    expect(s.units).toBe(unitsFromDecimal("300"));
  });
});

describe("fold — ordering and reversals", () => {
  it("applies entries in seq order regardless of array order", () => {
    const a = entry("deposit", "300", { holderId: 1 });
    const b = entry("equity_reading", "600");
    const forward = fold([a, b], [MANAGER]);
    const shuffled = fold([b, a], [MANAGER]);
    expect(shuffled).toEqual(forward);
  });

  it("orders same-date entries by seq, so deposit-then-reading is deterministic", () => {
    const s = fold([
      entry("deposit", "300", { holderId: 1, occurredOn: "2026-05-02" }),
      entry("equity_reading", "600", { occurredOn: "2026-05-02" }),
    ], [MANAGER]);
    expect(s.equityCents).toBe(centsFromDecimal("600"));
    expect(s.units).toBe(unitsFromDecimal("300"));
  });

  it("skips both a reversed entry and its reversing entry", () => {
    const dep = entry("deposit", "300", { holderId: 1 });
    const bad = entry("deposit", "999", { holderId: 2 });
    const rev = entry("deposit", "-999", { holderId: 2, reversesId: bad.id });
    const s = fold([dep, bad, rev], [MANAGER, INVESTOR]);
    expect(s.equityCents).toBe(centsFromDecimal("300"));
    expect(s.units).toBe(unitsFromDecimal("300"));
    expect(s.holders.find((h) => h.holderId === 2)!.units).toBe(0n);
  });
});

describe("fold — validation", () => {
  it("rejects an entry naming an unknown holder", () => {
    expect(() => fold([entry("deposit", "100", { holderId: 99 })], [MANAGER]))
      .toThrow(/unknown holderId 99/);
  });
  it("rejects a deposit with no holder", () => {
    expect(() => fold([entry("deposit", "100")], [MANAGER]))
      .toThrow(/requires a holderId/);
  });
});

describe("fold — profit payout, fee retained as units", () => {
  // Manager founds with $300. Equity doubles to $600 -> NAV 2.0000.
  // Investor deposits $300 -> 150 units. Equity $900, 450 units, NAV 2.0000.
  // Equity read at $1,800 -> NAV 4.0000.
  // Investor value 150 * 4 = $600, basis $300, profit $300.
  // Fee 40% = $120. Investor receives $180. Units redeemed 300/4 = 75.
  // Fee units 120/4 = 30 to the manager.
  function ledger() {
    return [
      entry("deposit", "300", { holderId: 1 }),
      entry("equity_reading", "600"),
      entry("deposit", "300", { holderId: 2 }),
      entry("equity_reading", "1800"),
      entry("payout", "0", { holderId: 2, feeSettlement: "units", splitBpsApplied: 4000 }),
    ];
  }

  it("pays the holder their share of profit", () => {
    const before = fold(ledger().slice(0, 4), [MANAGER, INVESTOR]);
    const after = fold(ledger(), [MANAGER, INVESTOR]);
    expect(before.equityCents - after.equityCents).toBe(centsFromDecimal("180"));
  });

  it("redeems only the units the profit was worth", () => {
    const s = fold(ledger(), [MANAGER, INVESTOR]);
    expect(s.holders.find((h) => h.holderId === 2)!.units).toBe(unitsFromDecimal("75"));
  });

  it("issues the fee to the manager as units at the pre-payout NAV", () => {
    const s = fold(ledger(), [MANAGER, INVESTOR]);
    const mgr = s.holders.find((h) => h.holderId === 1)!;
    expect(mgr.units).toBe(unitsFromDecimal("330"));               // 300 + 30
    expect(mgr.basisCents).toBe(centsFromDecimal("420"));          // 300 + 120
  });

  it("leaves NAV unchanged", () => {
    const before = fold(ledger().slice(0, 4), [MANAGER, INVESTOR]);
    const after = fold(ledger(), [MANAGER, INVESTOR]);
    expect(navTimes1e4(totalsOf(after))).toBe(navTimes1e4(totalsOf(before)));
    expect(navTimes1e4(totalsOf(after))).toBe(40_000n);
  });

  it("leaves the holder's cost basis untouched", () => {
    const s = fold(ledger(), [MANAGER, INVESTOR]);
    expect(s.holders.find((h) => h.holderId === 2)!.basisCents).toBe(centsFromDecimal("300"));
  });
});

describe("fold — profit payout, fee taken as cash", () => {
  function ledger() {
    return [
      entry("deposit", "300", { holderId: 1 }),
      entry("equity_reading", "600"),
      entry("deposit", "300", { holderId: 2 }),
      entry("equity_reading", "1800"),
      entry("payout", "0", { holderId: 2, feeSettlement: "cash", splitBpsApplied: 4000 }),
    ];
  }

  it("removes the fee from equity and issues no units", () => {
    const s = fold(ledger(), [MANAGER, INVESTOR]);
    expect(s.equityCents).toBe(centsFromDecimal("1500")); // 1800 - 180 - 120
    expect(s.holders.find((h) => h.holderId === 1)!.units).toBe(unitsFromDecimal("300"));
  });

  it("leaves NAV unchanged", () => {
    const s = fold(ledger(), [MANAGER, INVESTOR]);
    expect(navTimes1e4(totalsOf(s))).toBe(40_000n);
  });
});

describe("fold — exit", () => {
  function ledger(settlement: "units" | "cash") {
    return [
      entry("deposit", "300", { holderId: 1 }),
      entry("equity_reading", "600"),
      entry("deposit", "300", { holderId: 2 }),
      entry("equity_reading", "1800"),
      entry("exit", "0", { holderId: 2, feeSettlement: settlement, splitBpsApplied: 4000 }),
    ];
  }

  it("redeems every unit the holder owns", () => {
    const s = fold(ledger("cash"), [MANAGER, INVESTOR]);
    expect(s.holders.find((h) => h.holderId === 2)!.units).toBe(0n);
  });

  it("closes the holder and clears their basis", () => {
    const h = fold(ledger("cash"), [MANAGER, INVESTOR]).holders.find((x) => x.holderId === 2)!;
    expect(h.status).toBe("closed");
    expect(h.basisCents).toBe(0n);
  });

  it("returns value less fee", () => {
    // value $600, profit $300, fee $120, holder receives $480
    const before = fold(ledger("cash").slice(0, 4), [MANAGER, INVESTOR]);
    const after = fold(ledger("cash"), [MANAGER, INVESTOR]);
    expect(before.equityCents - after.equityCents).toBe(centsFromDecimal("600"));
  });

  it("leaves NAV unchanged", () => {
    expect(navTimes1e4(totalsOf(fold(ledger("units"), [MANAGER, INVESTOR])))).toBe(40_000n);
    expect(navTimes1e4(totalsOf(fold(ledger("cash"), [MANAGER, INVESTOR])))).toBe(40_000n);
  });
});

describe("fold — payout below the high-water mark", () => {
  function ledger() {
    return [
      entry("deposit", "300", { holderId: 1 }),
      entry("deposit", "300", { holderId: 2 }),
      entry("equity_reading", "300"),   // halved; investor value $150 < basis $300
      entry("payout", "0", { holderId: 2, feeSettlement: "units", splitBpsApplied: 4000 }),
    ];
  }

  it("is a no-op in profit mode", () => {
    const before = fold(ledger().slice(0, 3), [MANAGER, INVESTOR]);
    const after = fold(ledger(), [MANAGER, INVESTOR]);
    expect(after.equityCents).toBe(before.equityCents);
    expect(after.units).toBe(before.units);
  });

  it("charges no fee on exit and returns current value", () => {
    const l = ledger();
    l[3] = entry("exit", "0", { holderId: 2, feeSettlement: "cash", splitBpsApplied: 4000 });
    const before = fold(l.slice(0, 3), [MANAGER, INVESTOR]);
    const after = fold(l, [MANAGER, INVESTOR]);
    expect(before.equityCents - after.equityCents).toBe(centsFromDecimal("150"));
    expect(after.holders.find((h) => h.holderId === 1)!.basisCents).toBe(centsFromDecimal("300"));
  });
});

describe("fold — re-entry after an exit", () => {
  // Only an exit produces a closed holder, so this is the only test that can
  // pin the closed -> active transition and the fresh cost basis a
  // re-entering holder gets. An earlier version of this file asserted the
  // same thing against a holder that was never closed, and could not fail.
  it("reactivates a holder who previously exited, with a fresh basis", () => {
    const s = fold([
      entry("deposit", "300", { holderId: 1 }),
      entry("deposit", "300", { holderId: 2 }),
      entry("exit", "0", { holderId: 2, feeSettlement: "cash", splitBpsApplied: 4000 }),
      entry("deposit", "150", { holderId: 2 }),
    ], [MANAGER, INVESTOR]);

    const h = s.holders.find((x) => x.holderId === 2)!;
    expect(h.status).toBe("active");
    expect(h.basisCents).toBe(centsFromDecimal("150"));
    expect(h.units).toBe(unitsFromDecimal("150"));
  });
});

describe("fold — a retained fee credited to a manager who has exited", () => {
  // The manager can leave and still be owed a fee on an investor's later
  // payout. Crediting units to a holder marked "closed" would break the
  // engine's own rule that an exited holder holds nothing, so taking the fee
  // reopens the position.
  function ledger() {
    return [
      entry("deposit", "300", { holderId: 1 }),
      entry("deposit", "300", { holderId: 2 }),
      entry("equity_reading", "1200"),   // NAV 2.0000
      entry("exit", "0", { holderId: 1, feeSettlement: "cash", splitBpsApplied: 0 }),
      entry("payout", "0", { holderId: 2, feeSettlement: "units", splitBpsApplied: 4000 }),
    ];
  }

  it("reopens the manager rather than leaving them closed holding units", () => {
    const mgr = fold(ledger(), [MANAGER, INVESTOR]).holders.find((h) => h.holderId === 1)!;
    expect(mgr.status).toBe("active");
    expect(mgr.units).toBe(unitsFromDecimal("60"));      // $120 fee at NAV 2.00
    expect(mgr.basisCents).toBe(centsFromDecimal("120"));
  });

  it("leaves no invariant violated", () => {
    expect(checkInvariants(fold(ledger(), [MANAGER, INVESTOR]))).toEqual([]);
  });
});

describe("fold — a wiped-out account", () => {
  // Equity goes to zero with units still outstanding: a margin call.
  // checkInvariants calls this legitimate, so the engine must be able to
  // value it and let a holder exit at $0.00 rather than trapping them behind
  // a thrown error.
  it("lets a holder exit a zero-equity pool without throwing", () => {
    const s = fold([
      entry("deposit", "300", { holderId: 1 }),
      entry("deposit", "300", { holderId: 2 }),
      entry("equity_reading", "0"),
      entry("exit", "0", { holderId: 2, feeSettlement: "cash", splitBpsApplied: 4000 }),
    ], [MANAGER, INVESTOR]);

    const h = s.holders.find((x) => x.holderId === 2)!;
    expect(h.units).toBe(0n);
    expect(h.basisCents).toBe(0n);
    expect(h.status).toBe("closed");
    expect(s.equityCents).toBe(0n);
    expect(s.units).toBe(unitsFromDecimal("300")); // the manager's units remain
    expect(checkInvariants(s)).toEqual([]);
  });
});

describe("fold — a payout carries the terms it was made under", () => {
  // splitBpsApplied is an input, not a lookup. Falling back to the holder's
  // current split would let a later change to their terms silently rewrite
  // what an already-settled payout was worth.
  it("rejects a payout with no splitBpsApplied", () => {
    expect(() => fold([
      entry("deposit", "300", { holderId: 1 }),
      entry("deposit", "300", { holderId: 2 }),
      entry("equity_reading", "1200"),
      entry("payout", "0", { holderId: 2, feeSettlement: "units" }),
    ], [MANAGER, INVESTOR])).toThrow(/no splitBpsApplied/);
  });

  it("rejects an exit with no splitBpsApplied", () => {
    expect(() => fold([
      entry("deposit", "300", { holderId: 1 }),
      entry("deposit", "300", { holderId: 2 }),
      entry("equity_reading", "1200"),
      entry("exit", "0", { holderId: 2, feeSettlement: "cash" }),
    ], [MANAGER, INVESTOR])).toThrow(/no splitBpsApplied/);
  });
});

describe("fold — partial withdrawal (P6)", () => {
  // Manager founds with $300. Investor deposits $300. Equity read at $1,800
  // -> NAV 4.0000. Investor value 150*4=$600, basis $300, profit $300.
  // Withdraw $150 (a quarter of value): capital and profit both quarter.
  //   capital slice = 150 * 300/600 = 75, profit slice = 150 * 300/600 = 75
  //   fee = 75 * 40% = 30, holder receives 150-30=120
  //   units redeemed = 150/4 = 37.5
  function ledger(amount: string) {
    return [
      entry("deposit", "300", { holderId: 1 }),
      entry("equity_reading", "600"),
      entry("deposit", "300", { holderId: 2 }),
      entry("equity_reading", "1800"),
      entry("withdrawal", amount, { holderId: 2, feeSettlement: "units", splitBpsApplied: 4000 }),
    ];
  }

  it("pays the holder the requested amount less the fee on its profit slice", () => {
    const before = fold(ledger("150").slice(0, 4), [MANAGER, INVESTOR]);
    const after = fold(ledger("150"), [MANAGER, INVESTOR]);
    expect(before.equityCents - after.equityCents).toBe(centsFromDecimal("120"));
  });

  it("redeems only the units the requested amount is worth", () => {
    // Investor holds 150 units (deposited $300 at NAV 2.00). $150 at NAV
    // 4.00 is 37.5 units redeemed, leaving 112.5 — checked as a delta, not
    // the remaining balance, so a fixture where the two numbers happen to
    // coincide can't hide a wrong redemption figure.
    const before = fold(ledger("150").slice(0, 4), [MANAGER, INVESTOR]);
    const after = fold(ledger("150"), [MANAGER, INVESTOR]);
    const beforeUnits = before.holders.find((h) => h.holderId === 2)!.units;
    const afterUnits = after.holders.find((h) => h.holderId === 2)!.units;
    expect(beforeUnits - afterUnits).toBe(unitsFromDecimal("37.5"));
    expect(afterUnits).toBe(unitsFromDecimal("112.5"));
  });

  it("reduces cost basis by the capital slice, not the whole withdrawal", () => {
    const s = fold(ledger("150"), [MANAGER, INVESTOR]);
    // basis $300 - capital slice $75 = $225. NOT $300-$150=$150 (that would
    // be "capital first"), and NOT left at $300 (that would be "profit
    // first" for this particular ratio, coincidentally, but see the quote.ts
    // module doc for why that alternative is wrong in general).
    expect(s.holders.find((h) => h.holderId === 2)!.basisCents).toBe(centsFromDecimal("225"));
  });

  it("issues the fee to the manager as units at the pre-withdrawal NAV", () => {
    const s = fold(ledger("150"), [MANAGER, INVESTOR]);
    const mgr = s.holders.find((h) => h.holderId === 1)!;
    expect(mgr.units).toBe(unitsFromDecimal("307.5"));   // 300 + 30/4
    expect(mgr.basisCents).toBe(centsFromDecimal("330")); // 300 + 30
  });

  it("leaves NAV unchanged", () => {
    expect(navTimes1e4(totalsOf(fold(ledger("150"), [MANAGER, INVESTOR])))).toBe(40_000n);
  });

  it("leaves the holder active, still holding units", () => {
    const h = fold(ledger("150"), [MANAGER, INVESTOR]).holders.find((x) => x.holderId === 2)!;
    expect(h.status).toBe("active");
    expect(h.units > 0n).toBe(true);
  });

  it("satisfies every invariant", () => {
    expect(checkInvariants(fold(ledger("150"), [MANAGER, INVESTOR]))).toEqual([]);
  });

  it("charges no fee below the high-water mark", () => {
    const l = [
      entry("deposit", "300", { holderId: 1 }),
      entry("deposit", "300", { holderId: 2 }),
      entry("equity_reading", "300"),   // halved; investor value $150 < basis $300
      entry("withdrawal", "100", { holderId: 2, feeSettlement: "units", splitBpsApplied: 4000 }),
    ];
    const s = fold(l, [MANAGER, INVESTOR]);
    const h = s.holders.find((x) => x.holderId === 2)!;
    // Received the full $100 requested, none of it fee.
    expect(fold(l.slice(0, 3), [MANAGER, INVESTOR]).equityCents - s.equityCents)
      .toBe(centsFromDecimal("100"));
    expect(h.basisCents).toBe(centsFromDecimal("200")); // 300 - 100, all capital
    expect(checkInvariants(s)).toEqual([]);
  });

  it("rejects a withdrawal with no splitBpsApplied", () => {
    expect(() => fold([
      entry("deposit", "300", { holderId: 1 }),
      entry("deposit", "300", { holderId: 2 }),
      entry("equity_reading", "1200"),
      entry("withdrawal", "100", { holderId: 2, feeSettlement: "units" }),
    ], [MANAGER, INVESTOR])).toThrow(/no splitBpsApplied/);
  });

  describe("withdrawing the full cap in one go", () => {
    // Same ledger, but the investor withdraws their ENTIRE $600 rather than
    // a slice of it — must behave exactly like an exit.
    function fullLedger(settlement: "units" | "cash") {
      return [
        entry("deposit", "300", { holderId: 1 }),
        entry("equity_reading", "600"),
        entry("deposit", "300", { holderId: 2 }),
        entry("equity_reading", "1800"),
        entry("withdrawal", "600", { holderId: 2, feeSettlement: settlement, splitBpsApplied: 4000 }),
      ];
    }

    it("redeems every unit the holder owns, and closes them like an exit", () => {
      const s = fold(fullLedger("cash"), [MANAGER, INVESTOR]);
      const h = s.holders.find((x) => x.holderId === 2)!;
      expect(h.units).toBe(0n);
      expect(h.basisCents).toBe(0n);
      expect(h.status).toBe("closed");
    });

    it("pays exactly what an equivalent exit would pay", () => {
      const viaWithdrawal = fold(fullLedger("cash"), [MANAGER, INVESTOR]);
      const viaExit = fold([
        entry("deposit", "300", { holderId: 1 }),
        entry("equity_reading", "600"),
        entry("deposit", "300", { holderId: 2 }),
        entry("equity_reading", "1800"),
        entry("exit", "0", { holderId: 2, feeSettlement: "cash", splitBpsApplied: 4000 }),
      ], [MANAGER, INVESTOR]);
      expect(viaWithdrawal.equityCents).toBe(viaExit.equityCents);
      expect(viaWithdrawal.units).toBe(viaExit.units);
    });

    it("satisfies every invariant", () => {
      expect(checkInvariants(fold(fullLedger("units"), [MANAGER, INVESTOR]))).toEqual([]);
    });

    it("does not leave a phantom basis behind when the holder is underwater", () => {
      // Investor deposits $300, account halves to $150 for them, they cash
      // out everything they have left ($150, their whole value — a loss).
      // Basis must go to zero like any other exit, not to $300-$150=$150,
      // which would overstate a later re-deposit's starting basis.
      const s = fold([
        entry("deposit", "300", { holderId: 1 }),
        entry("deposit", "300", { holderId: 2 }),
        entry("equity_reading", "300"),   // halved
        entry("withdrawal", "150", { holderId: 2, feeSettlement: "cash", splitBpsApplied: 4000 }),
      ], [MANAGER, INVESTOR]);
      const h = s.holders.find((x) => x.holderId === 2)!;
      expect(h.units).toBe(0n);
      expect(h.basisCents).toBe(0n);
      expect(h.status).toBe("closed");
      expect(checkInvariants(s)).toEqual([]);
    });
  });
});

describe("fold — exit redeems the exact unit balance", () => {
  // valueOfUnits floors to whole cents and unitsToRedeem ceils back to units,
  // so the round trip can under-recover. Here quote() would redeem
  // 19_980_000_000 units against a balance of 20_000_000_000, stranding
  // 0.002 units in a holder who has supposedly left. Exit therefore redeems
  // h.units directly. Every other exit fixture in this file uses round
  // numbers where the two agree, so this is the only test that pins it.
  it("leaves an exiting holder with exactly zero units when the round trip under-recovers", () => {
    const s = fold([
      entry("deposit", "1", { holderId: 1 }),
      entry("deposit", "2", { holderId: 2 }),
      entry("equity_reading", "10"),
      entry("exit", "0", { holderId: 2, feeSettlement: "cash", splitBpsApplied: 4000 }),
    ], [MANAGER, INVESTOR]);

    const h = s.holders.find((x) => x.holderId === 2)!;
    expect(h.units).toBe(0n);
    expect(h.status).toBe("closed");
    expect(h.basisCents).toBe(0n);
    // The manager keeps their single unit; the pool retains the residual.
    expect(s.units).toBe(unitsFromDecimal("1"));
  });
});
