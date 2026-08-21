import { fold } from "@/lib/compound/engine/replay";
import { LEDGER, SEEDS } from "./fixture";
import { fingerprintOf } from "./derive";
import { fingerprintFromFields, fingerprintMismatch, fingerprintToFields } from "./fingerprint";

const F = fingerprintOf(7, fold(LEDGER, SEEDS));

describe("round trip", () => {
  it("survives the form, exactly, past Number.MAX_SAFE_INTEGER", () => {
    const big = { accountId: 7, seq: 6, equityCents: "9007199254740993", units: "402224547963043" };
    const fields = fingerprintToFields(big);
    const back = fingerprintFromFields((k) => fields[k] ?? null);
    expect(back).toEqual(big);
    // The value a Number round trip would have produced, for contrast.
    expect(Number(big.equityCents)).toBe(9_007_199_254_740_992);
  });

  it("carries every field as a string", () => {
    const fields = fingerprintToFields(F);
    expect(Object.values(fields).every((v) => typeof v === "string")).toBe(true);
  });

  it("refuses a missing field rather than defaulting it", () => {
    expect(fingerprintFromFields(() => null)).toBeNull();
    const fields = fingerprintToFields(F);
    expect(fingerprintFromFields((k) => (k === "fpUnits" ? null : fields[k] ?? null))).toBeNull();
  });

  it("refuses a field that is not a decimal integer", () => {
    const fields: Record<string, string> = { ...fingerprintToFields(F), fpEquityCents: "5574391.00" };
    expect(fingerprintFromFields((k) => fields[k] ?? null)).toBeNull();
  });
});

describe("fingerprintMismatch", () => {
  it("passes an unchanged pool", () => {
    expect(fingerprintMismatch(F, { ...F })).toBeNull();
  });

  it("refuses a different account outright", () => {
    expect(fingerprintMismatch(F, { ...F, accountId: 8 }))
      .toBe("That receipt belongs to a different account.");
  });

  it("refuses a moved seq, naming both positions", () => {
    const msg = fingerprintMismatch(F, { ...F, seq: 7 });
    expect(msg).toContain("was at entry 6");
    expect(msg).toContain("is at entry 7 now");
    expect(msg).toContain("Nothing was committed");
  });

  it("refuses equity that moved while seq did not", () => {
    // The case seq alone misses: a reversal of an old entry leaves the pool
    // different at a seq the reader might still recognise.
    expect(fingerprintMismatch(F, { ...F, equityCents: "5574390" })).not.toBeNull();
  });

  it("refuses units that moved while seq and equity did not", () => {
    expect(fingerprintMismatch(F, { ...F, units: "402224547963044" })).not.toBeNull();
  });
});
