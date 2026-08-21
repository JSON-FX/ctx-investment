/**
 * The words on a payout receipt.
 *
 * They live here, rather than inside a component, because two screens render
 * them: the holder statement's "if you withdrew today" block (Task 10) and
 * the payout sheet itself (Task 13). A reader who sees "Capital in" on one
 * screen and "Cost basis" on the other has been given two names for one
 * number, and will reasonably ask which is which at exactly the wrong moment
 * — mid-dispute, holding two printouts.
 *
 * "Cost basis, their high-water mark" is precise and it is jargon. What a
 * non-accountant reads is "what they have put in", with the mechanism stated
 * underneath in one sentence: it rises when they add capital, does not move
 * when they take profit, and resets on a full exit. That sentence IS the
 * high-water mark; the term itself is not needed to act on it, so it appears
 * only as a heading for a reader who already knows it (belowMarkTitle), never
 * as something the body text requires understanding first.
 *
 * This single-tenant tool has no investor role (spec §9) — every screen that
 * reads these words is the manager's own, which is why `managerFee` reads
 * "Your fee" rather than naming a role.
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

/**
 * The words on a PARTIAL withdrawal receipt (P6). A different shape from
 * PAYOUT_WORDS, on purpose: "profit" and "exit" ask "how much of what you're
 * ENTITLED TO do you want", but a partial withdrawal asks "how much do you
 * want", and THEN has to say how much of THAT is capital and how much is
 * profit. Reusing PAYOUT_WORDS' "Profit above that" (the whole position's
 * profit, whether or not any of it is being withdrawn right now) for what is
 * actually a per-withdrawal split would be the exact confusion this receipt
 * exists to prevent — see quote.ts's profitCents vs withdrawalProfitCents.
 */
export const WITHDRAW_WORDS = {
  unitsHeld: "Units held",
  unitsHeldHint: "Their share of the pool, in units, before this withdrawal.",

  valueNow: "Value at today's NAV",
  valueNowHint: "Units held, at the NAV this withdrawal settles against. The most they can take out.",

  requested: (name: string) => `What ${name} is asking for`,
  requestedHint: "Capped at the value above — a holder can never take out more than they hold.",

  capitalReturned: (name: string) => `Capital returned`,
  capitalReturnedHint: (name: string) =>
    `The fee-free share of this withdrawal. ${name}'s put-in capital and profit are both ` +
    `spread evenly across every unit they hold, so a partial withdrawal takes the same mix ` +
    `of each as the whole position — this is not the whole of what ${name} has put in, only ` +
    `this withdrawal's share of it.`,

  profitPortion: "Profit in this withdrawal",
  profitPortionHint: "The fee-bearing share of this withdrawal. Zero below the high-water mark.",

  managerFee: (pct: string) => `Your fee (${pct}%)`,
  managerFeeHint: "Charged only on the profit portion above, never on the capital returned.",

  unitsRedeemed: (name: string) => `Units ${name} gives up`,
  unitsKept: (name: string) => `Units ${name} keeps`,
  unitsKeptHint: "And what they are worth immediately after this withdrawal.",

  receives: (name: string) => `${name} receives`,

  newBasis: (name: string) => `${name}'s capital in, after this`,
  newBasisHint:
    "Reduced by the capital returned above, not by the whole withdrawal — this is what " +
    "future profit is measured against, so the high-water mark moves by exactly the " +
    "capital share and no more.",

  feeSettlement: "How your fee settles",
  feeSettlementUnits: "Keep it in the account, as units",
  feeSettlementUnitsHint:
    "The cash stays in the pool and you are issued units for it. NAV does not move.",
  feeSettlementCash: "Take it out, as cash",
  feeSettlementCashHint: "Equity falls by the fee and no units are issued. NAV does not move.",

  atCapTitle: "Withdrawing everything",
  atCap: (name: string) =>
    `This is ${name}'s entire value — every unit is redeemed and their capital in resets ` +
    `to zero, the same as a full exit.`,

  fullValueHint: (worth: string) => `The most that can be requested is ${worth}.`,
} as const;
