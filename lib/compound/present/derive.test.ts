import { centsFromDecimal, unitsFromDecimal, type Cents, type Units } from "@/lib/compound/engine/money";
import { fold, type HolderState, type LedgerEntry, type PoolState } from "@/lib/compound/engine/replay";
import { ADA_ID, GRACE_ID, HOLDER_NAMES, LEDGER, MANAGER_ID, SEEDS } from "./fixture";
import {
  assertNavDidNotFall, capitalMarks, deskFigures, fingerprintOf, ledgerSteps, previewEntry,
} from "./derive";

const c = centsFromDecimal;
const u = unitsFromDecimal;

describe("ledgerSteps", () => {
  const steps = ledgerSteps(LEDGER, SEEDS);

  it("produces one step per entry", () => {
    expect(steps).toHaveLength(6);
  });

  it("carries the running equity, units and NAV of every prefix", () => {
    expect(steps.map((s) => s.after.equityCents.toString())).toEqual([
      "2500000", "2743119", "3743119", "4188307", "4938307", "5574391",
    ]);
    expect(steps.map((s) => s.after.units)).toEqual([
      u("25000"), u("25000"), u("34113.7132585206"), u("34113.7132585206"),
      u("40222.4547963043"), u("40222.4547963043"),
    ]);
  });

  it("ends where fold(all) ends — the ledger page cannot drift from the desk", () => {
    expect(steps[steps.length - 1]!.after).toEqual(fold(LEDGER, SEEDS));
  });

  it("chains: each step's before is the previous step's after", () => {
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]!.before).toEqual(steps[i - 1]!.after);
    }
  });

  it("reports units issued only on the entries that issue them", () => {
    expect(steps.map((s) => s.unitsDelta > 0n)).toEqual([true, false, true, false, true, false]);
  });

  it("reports the holder's own unit change, and null for a reading", () => {
    expect(steps[0]!.holderUnitsDelta).toBe(u("25000"));
    expect(steps[1]!.holderUnitsDelta).toBeNull();
  });

  it("orders by seq, not by array position", () => {
    const shuffled = [LEDGER[3]!, LEDGER[0]!, LEDGER[5]!, LEDGER[2]!, LEDGER[4]!, LEDGER[1]!];
    expect(ledgerSteps(shuffled, SEEDS).map((s) => s.entry.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("marks both sides of a reversal as voided", () => {
    const reversal: LedgerEntry = {
      id: 7, seq: 7, holderId: GRACE_ID, occurredOn: "2026-08-20",
      type: "deposit", amountCents: c("-7500.00"), feeSettlement: null,
      splitBpsApplied: null, reversesId: 5,
    };
    const withReversal = ledgerSteps([...LEDGER, reversal], SEEDS);
    expect(withReversal.filter((s) => s.voided).map((s) => s.entry.id)).toEqual([5, 7]);
  });
});

describe("capitalMarks", () => {
  it("marks each deposit once, in date order, as money in", () => {
    expect(capitalMarks(LEDGER, SEEDS)).toEqual([
      { occurredOn: "2026-03-02", type: "deposit", amountCents: c("25000.00"), direction: "in" },
      { occurredOn: "2026-05-04", type: "deposit", amountCents: c("10000.00"), direction: "in" },
      { occurredOn: "2026-07-06", type: "deposit", amountCents: c("7500.00"), direction: "in" },
    ]);
  });

  it("marks a readings-only ledger with nothing", () => {
    expect(capitalMarks(LEDGER.filter((e) => e.type === "equity_reading"), SEEDS)).toEqual([]);
  });

  it("marks a payout with the cash that LEFT, not the amount that was requested", () => {
    // Ada's profit payout: amountCents on the entry is the requested 2630.60.
    // The cash that left is toHolderCents, 1578.36 — the fee stayed in the
    // pool as units. Reading amountCents would put a mark of the wrong height
    // on the equity curve.
    const payout: LedgerEntry = {
      id: 7, seq: 7, holderId: ADA_ID, occurredOn: "2026-08-18", type: "payout",
      amountCents: c("2630.60"), feeSettlement: "units", splitBpsApplied: 4000,
      reversesId: null,
    };
    expect(capitalMarks([...LEDGER, payout], SEEDS).at(-1)).toEqual({
      occurredOn: "2026-08-18", type: "payout",
      amountCents: c("1578.36"), direction: "out",
    });
  });

  it("leaves no phantom step where a deposit was reversed", () => {
    const reversal: LedgerEntry = {
      id: 7, seq: 7, holderId: GRACE_ID, occurredOn: "2026-08-20",
      type: "deposit", amountCents: c("-7500.00"), feeSettlement: null,
      splitBpsApplied: null, reversesId: 5,
    };
    const marks = capitalMarks([...LEDGER, reversal], SEEDS);
    expect(marks.map((m) => m.occurredOn)).toEqual(["2026-03-02", "2026-05-04"]);
  });
});

describe("assertNavDidNotFall", () => {
  it("permits a reading to lower NAV", () => {
    expect(() => assertNavDidNotFall("equity_reading", 13_858n, 9_474n)).not.toThrow();
  });

  it("permits an adjustment to lower NAV", () => {
    expect(() => assertNavDidNotFall("adjustment", 13_858n, 13_857n)).not.toThrow();
  });

  it("refuses a deposit that lowers NAV, naming both figures", () => {
    expect(() => assertNavDidNotFall("deposit", 13_858n, 13_857n))
      .toThrow(/deposit would move NAV down from 13858 to 13857/);
  });

  it("refuses a payout that lowers NAV", () => {
    expect(() => assertNavDidNotFall("payout", 13_858n, 13_857n)).toThrow(/NAV down/);
  });

  it("permits NAV rising by a rounding residual", () => {
    expect(() => assertNavDidNotFall("deposit", 13_858n, 13_859n)).not.toThrow();
  });

  it("permits NAV unchanged", () => {
    expect(() => assertNavDidNotFall("exit", 13_858n, 13_858n)).not.toThrow();
  });
});

describe("previewEntry — a deposit", () => {
  const p = previewEntry({
    accountId: 7,
    entries: LEDGER,
    seeds: SEEDS,
    proposed: {
      holderId: ADA_ID, occurredOn: "2026-08-18", type: "deposit",
      amountCents: c("4250.00"), feeSettlement: null, splitBpsApplied: null,
    },
  });

  it("is exactly fold(existing ++ proposed)", () => {
    expect(p.after).toEqual(fold([...LEDGER, {
      id: 7, seq: 7, holderId: ADA_ID, occurredOn: "2026-08-18", type: "deposit",
      amountCents: c("4250.00"), feeSettlement: null, splitBpsApplied: null, reversesId: null,
    }], SEEDS));
  });

  it("issues the floor of the units the deposit buys", () => {
    // 4250.00 at NAV 1.3858... is 3066.6207821498... units. Ceil would be
    // 3066.6207821499 and would lower NAV, which assertNavDidNotFall forbids.
    expect(p.unitsDelta).toBe(u("3066.6207821498"));
  });

  it("adds exactly the deposit to equity", () => {
    expect(p.equityDelta).toBe(c("4250.00"));
  });

  it("leaves NAV where it was", () => {
    expect(p.navBeforeX1e4).toBe(13_858n);
    expect(p.navAfterX1e4).toBe(13_858n);
    expect(p.navResidualX1e4).toBe(0n);
  });

  it("dilutes shares and leaves the other holders' values alone", () => {
    expect(p.sharesBefore).toEqual([621_543, 226_583, 151_874]);
    expect(p.sharesAfter).toEqual([577_513, 281_372, 141_115]);
    expect(p.valuesBefore).toEqual([c("34647.26"), c("12630.61"), c("8466.04")]);
    expect(p.valuesAfter).toEqual([c("34647.26"), c("16880.61"), c("8466.04")]);
  });

  it("keeps both share rows summing to a full pool", () => {
    expect(p.sharesBefore.reduce((a, b) => a + b, 0)).toBe(1_000_000);
    expect(p.sharesAfter.reduce((a, b) => a + b, 0)).toBe(1_000_000);
  });

  it("keeps both value rows summing to their equity exactly", () => {
    expect(p.valuesBefore.reduce((a, b) => a + b, 0n)).toBe(c("55743.91"));
    expect(p.valuesAfter.reduce((a, b) => a + b, 0n)).toBe(c("55743.91") + c("4250.00"));
  });

  it("fingerprints the state the preview was computed against", () => {
    expect(p.fingerprint).toEqual({
      accountId: 7, seq: 6, equityCents: "5574391", units: "402224547963043",
    });
  });
});

describe("previewEntry — a profit payout with the fee retained as units", () => {
  const p = previewEntry({
    accountId: 7,
    entries: LEDGER,
    seeds: SEEDS,
    proposed: {
      holderId: ADA_ID, occurredOn: "2026-08-18", type: "payout",
      amountCents: c("2630.60"), feeSettlement: "units", splitBpsApplied: 4000,
    },
  });

  it("takes only the cash the holder receives out of the account", () => {
    expect(p.equityDelta).toBe(c("-1578.36"));
  });

  it("nets units: Ada surrenders 1898.13, the manager is issued 759.2520121904", () => {
    expect(p.unitsDelta).toBe(u("759.2520121904") - u("1898.1300304762"));
  });

  it("leaves NAV where it was — the settlement is NAV-neutral", () => {
    expect(p.navAfterX1e4).toBe(p.navBeforeX1e4);
  });

  it("returns Ada to her cost basis, which is what a high-water mark means", () => {
    const ada = p.after.holders.findIndex((h) => h.holderId === ADA_ID);
    expect(p.after.holders[ada]!.basisCents).toBe(c("10000.00"));
    expect(p.valuesAfter[ada]).toBe(c("10000.01")); // allocated; floored is 10000.00
  });

  it("raises the manager's cost basis by the fee they took as units", () => {
    const mgr = p.after.holders.find((h) => h.holderId === MANAGER_ID)!;
    expect(mgr.basisCents).toBe(c("26052.24")); // 25000.00 + 1052.24
  });
});

describe("previewEntry — the same payout settled in cash", () => {
  const p = previewEntry({
    accountId: 7,
    entries: LEDGER,
    seeds: SEEDS,
    proposed: {
      holderId: ADA_ID, occurredOn: "2026-08-18", type: "payout",
      amountCents: c("2630.60"), feeSettlement: "cash", splitBpsApplied: 4000,
    },
  });

  it("takes the holder's cash AND the fee out of the account", () => {
    expect(p.equityDelta).toBe(c("-2630.60"));
  });

  it("issues the manager no units", () => {
    expect(p.after.holders.find((h) => h.holderId === MANAGER_ID)!.units).toBe(u("25000"));
  });

  it("still leaves NAV where it was", () => {
    expect(p.navAfterX1e4).toBe(p.navBeforeX1e4);
  });
});

describe("deskFigures", () => {
  const d = deskFigures(fold(LEDGER, SEEDS), HOLDER_NAMES);

  it("values holders by allocation, so the column sums to equity exactly", () => {
    expect(d.rows.map((r) => r.valueCents))
      .toEqual([c("34647.26"), c("12630.61"), c("8466.04")]);
    expect(d.rows.reduce((s, r) => s + r.valueCents, 0n)).toBe(c("55743.91"));
  });

  it("does not reconcile the allocated value with the floored one", () => {
    // Ada reads 12630.61 here and 12630.60 on her payout receipt. Decision
    // D-A. If this ever becomes equal, one of the two is now wrong.
    const ada = d.rows.find((r) => r.holderId === ADA_ID)!;
    expect(ada.valueCents).toBe(c("12630.61"));
  });

  it("measures profit against cost basis", () => {
    expect(d.rows.map((r) => r.profitCents))
      .toEqual([c("9647.26"), c("2630.61"), c("966.04")]);
  });

  it("charges the manager no fee on their own holding", () => {
    expect(d.rows.find((r) => r.isManager)!.feeIfExitCents).toBe(0n);
  });

  it("applies each holder's own split, not the default", () => {
    // Grace is 3700, not 4000. 966.04 x 37% floors to 357.43; at 40% it would
    // be 386.41, so a hard-coded default fails here and only here.
    expect(d.rows.find((r) => r.holderId === GRACE_ID)!.feeIfExitCents).toBe(c("357.43"));
    expect(d.rows.find((r) => r.holderId === ADA_ID)!.feeIfExitCents).toBe(c("1052.24"));
  });

  it("totals the accrued fee across every holder", () => {
    expect(d.feeIfAllExitCents).toBe(c("1409.67")); // 1052.24 + 357.43
  });

  it("totals investor capital, value and profit, excluding the manager", () => {
    expect(d.investorBasisCents).toBe(c("17500.00"));
    expect(d.investorValueCents).toBe(c("21096.65"));
    expect(d.investorProfitCents).toBe(c("3596.65"));
  });

  it("reports the manager's own value separately", () => {
    expect(d.managerValueCents).toBe(c("34647.26"));
  });

  it("counts only holders who hold something", () => {
    expect(d.holderCount).toBe(3);
  });

  it("carries NAV as an integer, for the presentation layer to format", () => {
    expect(d.navX1e4).toBe(13_858n);
  });
});

describe("deskFigures — everyone under water", () => {
  const d = deskFigures(
    fold([...LEDGER, {
      id: 7, seq: 7, holderId: null, occurredOn: "2026-08-18",
      type: "equity_reading", amountCents: c("38110.44"),
      feeSettlement: null, splitBpsApplied: null, reversesId: null,
    }], SEEDS),
    HOLDER_NAMES,
  );

  it("charges no fee at all", () => {
    expect(d.feeIfAllExitCents).toBe(0n);
    expect(d.rows.every((r) => r.feeIfExitCents === 0n)).toBe(true);
  });

  it("reports negative profit for every holder", () => {
    // fixture.ts's own doc comment cites "Ada $1,364.84" as the recovery
    // figure, but that number is read from quote(...).profitCents — the
    // FLOORED valuation. deskFigures.profitCents is basisCents subtracted
    // from the ALLOCATED (largest-remainder) value instead (decision D-A),
    // and the two differ by a cent for Ada here exactly as they do in the
    // solvent fixture: allocated is one cent more favourable to Ada, so her
    // deficit is one cent smaller. Manager and Grace are unaffected — this
    // fixture's remainder happens to fall on Ada alone at this equity figure.
    expect(d.rows.map((r) => r.profitCents))
      .toEqual([c("-1312.71"), c("-1364.83"), c("-1712.02")]);
  });

  it("still sums holder value to equity exactly", () => {
    expect(d.rows.reduce((s, r) => s + r.valueCents, 0n)).toBe(c("38110.44"));
  });
});

/**
 * Allocation must sum to equity exactly (invariant 2), on denominators a
 * round fixture cannot expose. `deskFigures` never floors a value column
 * independently — it goes through `allocateValues`, engine/nav.ts's own
 * largest-remainder allocator — and these are the present/ layer's own proof
 * of that, minimal and independent of the canonical fixture, so the property
 * is pinned at the call site this task actually adds rather than only at
 * engine/nav.test.ts (which this plan does not touch).
 */
describe("deskFigures — value column sums to equity exactly, on awkward denominators", () => {
  function poolState(equityCents: Cents, holderUnits: readonly Units[]): PoolState {
    const total = holderUnits.reduce((s, x) => s + x, 0n);
    const holders: HolderState[] = holderUnits.map((units, i) => ({
      holderId: i + 1,
      isManager: i === 0,
      splitBps: i === 0 ? 0 : 4000,
      units,
      basisCents: 0n,
      status: "active",
    }));
    return { equityCents, units: total, holders, lastReadingOn: null, seq: 1 };
  }

  it("100 cents across three holders — 100 is not a multiple of 3", () => {
    const d = deskFigures(poolState(100n, [u("1"), u("1"), u("1")]), {});
    expect(d.rows.reduce((s, r) => s + r.valueCents, 0n)).toBe(100n);
  });

  it("three holders splitting a prime number of cents (97)", () => {
    const d = deskFigures(poolState(97n, [u("1"), u("1"), u("1")]), {});
    expect(d.rows.reduce((s, r) => s + r.valueCents, 0n)).toBe(97n);
    // A prime total shares no factor with any holder count > 1, so every
    // holder's exact entitlement is non-terminating — floor, ceil and
    // largest-remainder are forced to disagree here.
    expect(new Set(d.rows.map((r) => r.valueCents.toString())).size).toBeGreaterThan(1);
  });

  it("1,000,001 cents split seven ways", () => {
    const each = u("1");
    const d = deskFigures(
      poolState(c("10000.01"), [each, each, each, each, each, each, each]),
      {},
    );
    expect(d.rows).toHaveLength(7);
    expect(d.rows.reduce((s, r) => s + r.valueCents, 0n)).toBe(c("10000.01"));
  });

  it("a holder holding the smallest possible non-zero balance — a single raw unit out of three", () => {
    // 1n is one ten-billionth of a whole unit (UNIT_SCALE), the smallest
    // representable non-zero holding. All three holders are equally small
    // here, which is the point: even at the bottom of the scale the three
    // values still land on exactly the pool's equity, not one raw unit short.
    const d = deskFigures(poolState(c("10000.01"), [1n, 1n, 1n]), {});
    expect(d.rows.reduce((s, r) => s + r.valueCents, 0n)).toBe(c("10000.01"));
  });

  it("a holder with zero units gets zero value and does not steal from the total", () => {
    const d = deskFigures(poolState(c("100.03"), [u("2"), 0n, u("1")]), {});
    expect(d.rows.find((r) => r.units === 0n)!.valueCents).toBe(0n);
    expect(d.rows.reduce((s, r) => s + r.valueCents, 0n)).toBe(c("100.03"));
  });
});

describe("fingerprintOf", () => {
  it("carries bigints as decimal strings, because a form field is text", () => {
    const f = fingerprintOf(3, fold(LEDGER, SEEDS));
    expect(f).toEqual({ accountId: 3, seq: 6, equityCents: "5574391", units: "402224547963043" });
    expect(typeof f.units).toBe("string");
  });
});
