/**
 * Payout arithmetic. Computes the whole of a payout without committing it, so
 * the receipt modal and fold() apply identical numbers.
 *
 *   fee            = max(0, profit) × manager_split
 *   holder_gets    = (mode = exit) ? value − fee : max(0, profit) − fee
 *   units_redeemed = ((mode = exit) ? value : max(0, profit)) / NAV
 *
 * The performance fee crystallises only on withdrawal, never on a paper gain.
 * Because profit is measured against cost basis, a losing stretch must be
 * recovered before a fee applies again — the high-water mark falls out of the
 * arithmetic rather than being maintained separately.
 */
import { mulDivFloor, type Cents, type Units } from "./money";
import { valueOfUnits, unitsToRedeem, type PoolTotals } from "./nav";

export type PayoutMode = "profit" | "exit";

export interface QuoteInput {
  totals: PoolTotals;
  holderUnits: Units;
  basisCents: Cents;
  /** Manager's share of this holder's profit, in basis points. Ignored for the manager. */
  splitBps: number;
  isManager: boolean;
  mode: PayoutMode;
}

export interface Quote {
  valueCents: Cents;
  /** Signed. Negative means below the high-water mark. */
  profitCents: Cents;
  grossCents: Cents;
  feeCents: Cents;
  toHolderCents: Cents;
  unitsRedeemed: Units;
  belowHighWaterMark: boolean;
  splitBpsApplied: number;
}

export function quote(input: QuoteInput): Quote {
  const { totals, holderUnits, basisCents, isManager, mode } = input;

  if (!Number.isInteger(input.splitBps) || input.splitBps < 0 || input.splitBps > 10_000) {
    throw new RangeError(`splitBps must be an integer 0..10000, got ${input.splitBps}`);
  }
  const splitBpsApplied = isManager ? 0 : input.splitBps;

  const valueCents = valueOfUnits(totals, holderUnits);
  const profitCents = valueCents - basisCents;
  const feeableCents = profitCents > 0n ? profitCents : 0n;

  const feeCents = mulDivFloor(feeableCents, BigInt(splitBpsApplied), 10_000n);
  const grossCents = mode === "exit" ? valueCents : feeableCents;
  const toHolderCents = grossCents - feeCents;
  const unitsRedeemed = unitsToRedeem(totals, grossCents);

  return {
    valueCents,
    profitCents,
    grossCents,
    feeCents,
    toHolderCents,
    unitsRedeemed,
    belowHighWaterMark: profitCents <= 0n,
    splitBpsApplied,
  };
}
