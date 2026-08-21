import { PAYOUT_WORDS } from "./wording";

describe("PAYOUT_WORDS", () => {
  it("names the holder in every sentence that is about them", () => {
    expect(PAYOUT_WORDS.capitalIn("Ada")).toBe("What Ada has put in");
    expect(PAYOUT_WORDS.receives("Ada")).toBe("Ada receives");
    expect(PAYOUT_WORDS.unitsRedeemed("Ada")).toBe("Units Ada gives up");
  });

  it("explains the high-water mark without requiring the term", () => {
    const hint = PAYOUT_WORDS.capitalInHint("Ada");
    expect(hint).toContain("rises when Ada adds capital");
    expect(hint).toContain("does not move when Ada takes profit");
    expect(hint).toContain("resets to zero on a full exit");
  });

  it("says when a fee is charged, in the fee's own hint", () => {
    expect(PAYOUT_WORDS.managerFeeHint).toContain("only on withdrawal");
    expect(PAYOUT_WORDS.managerFeeHint).toContain("only on profit");
    expect(PAYOUT_WORDS.managerFeeHint).toContain("Never on a paper gain");
  });

  it("states the recovery figure in the below-the-mark sentence", () => {
    expect(PAYOUT_WORDS.belowMark("Ada", "$10,000.00", "$8,635.16", "$1,364.84"))
      .toBe(
        "Ada has put in $10,000.00. The holding is worth $8,635.16 today. " +
        "$1,364.84 of recovery is needed before any profit can be withdrawn.",
      );
  });

  it("keeps exit available in the same breath as refusing profit", () => {
    expect(PAYOUT_WORDS.exitStillAvailable("$8,635.16"))
      .toContain("still available, at today's value of $8,635.16, with no fee");
  });

  it("does not say 'below the mark' when the holder is exactly on it", () => {
    expect(PAYOUT_WORDS.atMark("Ada")).not.toMatch(/below/i);
    expect(PAYOUT_WORDS.atMark("Ada")).toContain("no profit to withdraw yet");
  });

  it("explains both fee settlements as NAV-neutral", () => {
    expect(PAYOUT_WORDS.feeSettlementUnitsHint).toContain("NAV does not move");
    expect(PAYOUT_WORDS.feeSettlementCashHint).toContain("NAV does not move");
    expect(PAYOUT_WORDS.feeSettlementUnitsHint).toContain("capital in rises by the fee");
  });

  it("explains the statement/settlement gap and where the cent goes", () => {
    const s = PAYOUT_WORDS.statementVsSettlement("$12,630.61", "$12,630.60");
    expect(s).toContain("exact share of account equity");
    expect(s).toContain("rounded down to the cent so the pool is never short");
    expect(s).toContain("at most one cent and it stays in the pool");
  });
});
