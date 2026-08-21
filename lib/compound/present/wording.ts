/**
 * The words on a payout receipt.
 *
 * They live here rather than inside the component because two screens render
 * them: the holder statement's "if you withdrew today" block and the payout
 * sheet itself. A holder who reads "Capital in" on one and "Cost basis" on the
 * other has been given two names for one number, and will reasonably ask which
 * is which at exactly the wrong moment.
 *
 * "Cost basis, their high-water mark" is precise and is jargon. What a
 * non-accountant reads is "what they have put in", with the mechanism stated
 * underneath in a sentence: it rises when they add capital, does not move when
 * they take profit, and resets when they exit. That sentence IS the high-water
 * mark; the term is not needed to explain it, and is kept only as a
 * parenthetical for readers who already know it.
 *
 * BOOTSTRAPPED FOR TASK 13: this file is plan 4's Task 10 deliverable
 * (docs/superpowers/plans/2026-08-21-compound-desk.md, ~line 6015). At the
 * time Task 13 was built, `.worktrees/holder` (feat/desk-holder) had no
 * commits yet, so this is a verbatim transcription of the plan's reference
 * source, not an original design — it exists so Task 13 can compile and be
 * gated on its own. Delete this note (and reconcile with whatever Task 10
 * actually ships) once feat/desk-holder merges.
 */
export const PAYOUT_WORDS = {
  unitsHeld: "Units held",
  unitsHeldHint: "Their share of the pool, in units.",

  valueNow: "Value at today's NAV",
  valueNowHint: "Units held, at the NAV this payout settles against.",

  capitalIn: (name: string) => `What ${name} has put in`,
  capitalInHint: (name: string) =>
    `Profit is measured against this. It rises when ${name} adds capital, does not ` +
    `move when ${name} takes profit, and resets to zero on a full exit — which is ` +
    `what a high-water mark is.`,

  profit: "Profit above that",
  profitHint: "Value today, less what has been put in.",

  holderShare: (name: string, pct: string) => `${name}'s share of the profit (${pct}%)`,
  managerFee: (pct: string) => `Your fee (${pct}%)`,
  managerFeeHint: "Charged only on withdrawal, and only on profit. Never on a paper gain.",

  unitsRedeemed: (name: string) => `Units ${name} gives up`,
  unitsKept: (name: string) => `Units ${name} keeps`,
  unitsKeptHint: "And what they are worth immediately after this payout.",

  receives: (name: string) => `${name} receives`,

  feeSettlement: "How your fee settles",
  feeSettlementUnits: "Keep it in the account, as units",
  feeSettlementUnitsHint:
    "The cash stays in the pool and you are issued units for it. Your capital in rises " +
    "by the fee. NAV does not move.",
  feeSettlementCash: "Take it out, as cash",
  feeSettlementCashHint:
    "Equity falls by the fee and no units are issued. NAV does not move.",

  belowMarkTitle: "Below the high-water mark",
  belowMark: (name: string, put: string, worth: string, recovery: string) =>
    `${name} has put in ${put}. The holding is worth ${worth} today. ` +
    `${recovery} of recovery is needed before any profit can be withdrawn.`,
  atMarkTitle: "Exactly at the high-water mark",
  atMark: (name: string) =>
    `${name}'s holding is worth exactly what they have put in. There is no profit to ` +
    `withdraw yet, and no fee would be charged.`,
  exitStillAvailable: (worth: string) =>
    `A full exit is still available, at today's value of ${worth}, with no fee.`,

  profitOnly: "Profit only",
  profitOnlyHint: (name: string) =>
    `${name} takes their profit and keeps their units. What they have put in is unchanged.`,
  exitInFull: "Exit in full",
  exitInFullHint: (name: string) =>
    `${name} surrenders every unit and leaves the pool. What they have put in resets to zero.`,

  statementVsSettlement: (statement: string, settlement: string) =>
    `This statement values the holding at ${statement}, which is its exact share of ` +
    `account equity. A payout settles at ${settlement}, rounded down to the cent so the ` +
    `pool is never short. The difference is at most one cent and it stays in the pool.`,
} as const;
