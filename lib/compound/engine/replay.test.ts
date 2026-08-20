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
