import { centsFromDecimal, unitsFromDecimal } from "./money";
import { navTimes1e4 } from "./nav";
import {
  fold, totalsOf, checkNavUnchanged,
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

  it("reactivates a closed holder", () => {
    const s = fold([
      entry("deposit", "300", { holderId: 1 }),
      entry("deposit", "100", { holderId: 2 }),
    ], [MANAGER, { ...INVESTOR }]);
    expect(s.holders.find((h) => h.holderId === 2)!.status).toBe("active");
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

describe("checkNavUnchanged", () => {
  it("passes when NAV is preserved", () => {
    const t = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("500") };
    expect(checkNavUnchanged(t, t)).toBe(true);
  });
  it("fails when NAV moves", () => {
    const a = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("500") };
    const b = { equityCents: centsFromDecimal("2000"), units: unitsFromDecimal("500") };
    expect(checkNavUnchanged(a, b)).toBe(false);
  });
});

describe("fold — re-entry after an exit", () => {
  // Task 6's "reactivates a closed holder" test could not fail, because
  // nothing in that task's scope produces a closed holder. Exit does, so
  // this is the first test that genuinely pins the closed -> active
  // transition and the fresh cost basis a re-entering holder gets.
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
