import { UNIT_SCALE, centsFromDecimal } from "@/lib/compound/engine/money";
import { fold, type PoolState } from "@/lib/compound/engine/replay";
import { ADA_ID, GRACE_ID, LEDGER, LEDGER_UNDERWATER, MANAGER_ID, SEEDS }
  from "./fixture";
import { ledgerSteps } from "./derive";
import { holderPosition, holderStatement } from "./holder";

const c = centsFromDecimal;
const STATE = fold(LEDGER, SEEDS);
const UNDER = fold(LEDGER_UNDERWATER, SEEDS);

describe("holderPosition — above the mark", () => {
  const p = holderPosition(STATE, ADA_ID);

  it("gives the statement value and the settlement value separately, a cent apart", () => {
    expect(p.statementValueCents).toBe(c("12630.61"));   // allocated
    expect(p.settlementValueCents).toBe(c("12630.60"));  // floored
    expect(p.statementValueCents).not.toBe(p.settlementValueCents);
  });

  it("measures profit against the settlement value, because that is what a fee is charged on", () => {
    expect(p.profitCents).toBe(c("2630.60"));
    expect(p.profitCents).not.toBe(c("2630.61"));
  });

  it("reports the mark state as above, and needs no recovery", () => {
    expect(p.markState).toBe("above");
    expect(p.recoveryCents).toBe(0n);
  });

  it("quotes both modes against the same NAV", () => {
    expect(p.profitQuote.feeCents).toBe(c("1052.24"));
    expect(p.profitQuote.toHolderCents).toBe(c("1578.36"));
    expect(p.exitQuote.feeCents).toBe(c("1052.24"));
    expect(p.exitQuote.toHolderCents).toBe(c("11578.36"));
  });

  it("carries the holder's largest-remainder share", () => {
    expect(p.ppm).toBe(226_583);
  });
});

describe("holderPosition — below the mark", () => {
  it("states the recovery for each holder", () => {
    expect(holderPosition(UNDER, MANAGER_ID).recoveryCents).toBe(c("1312.71"));
    expect(holderPosition(UNDER, ADA_ID).recoveryCents).toBe(c("1364.84"));
    expect(holderPosition(UNDER, GRACE_ID).recoveryCents).toBe(c("1712.02"));
  });

  it("charges no fee in either mode", () => {
    const p = holderPosition(UNDER, ADA_ID);
    expect(p.profitQuote.feeCents).toBe(0n);
    expect(p.exitQuote.feeCents).toBe(0n);
  });

  it("still lets a full exit take the whole value", () => {
    expect(holderPosition(UNDER, ADA_ID).exitQuote.toHolderCents).toBe(c("8635.16"));
  });

  it("pays nothing in profit mode", () => {
    expect(holderPosition(UNDER, ADA_ID).profitQuote.toHolderCents).toBe(0n);
  });

  it("reports the mark state as below", () => {
    expect(holderPosition(UNDER, ADA_ID).markState).toBe("below");
  });
});

describe("holderPosition — exactly at the mark", () => {
  // Deliberately tiny and deliberately awkward: 700 cents across 3 units.
  const atMark: PoolState = {
    equityCents: 700n,
    units: 3n * UNIT_SCALE,
    holders: [{
      holderId: 1, isManager: false, splitBps: 4000,
      units: 3n * UNIT_SCALE, basisCents: 700n, status: "active",
    }],
    lastReadingOn: "2026-08-14",
    seq: 1,
  };

  it("says AT the mark, not below it", () => {
    // quote().belowHighWaterMark is `profitCents <= 0n` and reports true here.
    // A screen that rendered that would say "below the high-water mark, $0.00
    // of recovery needed", which reads as a bug to the person it is shown to.
    const p = holderPosition(atMark, 1);
    expect(p.profitCents).toBe(0n);
    expect(p.markState).toBe("at");
    expect(p.recoveryCents).toBe(0n);
    expect(p.profitQuote.belowHighWaterMark).toBe(true);   // the engine's own view
  });
});

describe("holderPosition — a one-cent statement/settlement gap on a minimal fixture", () => {
  // Two holders, 700 cents, 3 units. Floors are 233 and 466, one cent short of
  // 700; largest remainder awards the cent to the second holder (remainder 2 > 1).
  const split: PoolState = {
    equityCents: 700n,
    units: 3n * UNIT_SCALE,
    holders: [
      { holderId: 1, isManager: true, splitBps: 0, units: 1n * UNIT_SCALE, basisCents: 200n, status: "active" },
      { holderId: 2, isManager: false, splitBps: 4000, units: 2n * UNIT_SCALE, basisCents: 400n, status: "active" },
    ],
    lastReadingOn: "2026-08-14",
    seq: 1,
  };

  it("gives holder 2 a statement value one cent above their settlement value", () => {
    const p = holderPosition(split, 2);
    expect(p.statementValueCents).toBe(467n);
    expect(p.settlementValueCents).toBe(466n);
  });

  it("leaves holder 1's two figures equal", () => {
    const p = holderPosition(split, 1);
    expect(p.statementValueCents).toBe(233n);
    expect(p.settlementValueCents).toBe(233n);
  });
});

describe("holderPosition — refusals", () => {
  it("refuses a holder who is not on this account", () => {
    expect(() => holderPosition(STATE, 99)).toThrow(/no holder 99 on this account/);
  });
});

describe("holderStatement", () => {
  const rows = holderStatement(ledgerSteps(LEDGER, SEEDS), ADA_ID);

  it("includes every entry from her deposit on, not only her own", () => {
    // Four steps, not six: the two before her deposit are not her history.
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.own).map((r) => r.seq)).toEqual([3]);
  });

  it("starts at her deposit rather than a run of zeroes", () => {
    // The fixture has account activity at seq 1 and 2, before Ada existed as a
    // holder. Rendering those gives her rows of zero units, zero basis and zero
    // value — noise on a document handed to an investor, and misleading: it
    // implies she was present for a period she had no stake in.
    expect(rows[0]!.seq).toBe(3);
    expect(rows[0]!.own).toBe(true);
    expect(rows[0]!.type).toBe("deposit");
    // Nowhere in her statement does she hold nothing.
    expect(rows.every((r) => r.unitsAfter > 0n)).toBe(true);
  });

  it("issues her units on her deposit and sets her capital in", () => {
    expect(rows[0]!.unitsDelta).toBeGreaterThan(0n);
    expect(rows[0]!.basisAfter).toBe(c("10000.00"));
    expect(rows[0]!.valueAfter).toBe(c("10000.00"));
  });

  it("moves her value on a reading she had no part in", () => {
    // This is why readings are on a holder's statement at all: without seq 4
    // her value jumps between her own entries with nothing to explain it.
    expect(rows[1]!.own).toBe(false);
    expect(rows[1]!.unitsDelta).toBe(0n);
    expect(rows[1]!.valueDelta).toBeGreaterThan(0n);
  });

  it("ends on the figure her statement head shows", () => {
    expect(rows[3]!.valueAfter).toBe(c("12630.61"));
    expect(rows[3]!.unitsAfter).toBe(holderPosition(STATE, ADA_ID).holder.units);
  });

  it("leaves her value unmoved by another holder's deposit", () => {
    // Grace joins at seq 5. Ada's units do not change and neither does her
    // value: a deposit issues units at the prevailing NAV, which is what makes
    // staggered entry safe.
    expect(rows[2]!.unitsDelta).toBe(0n);
    expect(rows[2]!.valueDelta).toBe(0n);
  });
});
