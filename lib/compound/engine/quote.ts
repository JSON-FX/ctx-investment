/**
 * Payout arithmetic. Computes the whole of a payout without committing it, so
 * the receipt modal and fold() apply identical numbers.
 *
 *   fee            = max(0, profit) × manager_split
 *   holder_gets    = (mode = exit) ? value − fee : max(0, profit) − fee
 *   units_redeemed = (mode = exit) ? holder_units : max(0, profit) / NAV
 *
 * The performance fee crystallises only on withdrawal, never on a paper gain.
 * Because profit is measured against cost basis, a losing stretch must be
 * recovered before a fee applies again — the high-water mark falls out of the
 * arithmetic rather than being maintained separately.
 *
 * PARTIAL WITHDRAWAL (mode "partial", P6 — spec §12/§13 open question 3,
 * resolved in favour of pro-rata basis reduction). A holder may withdraw an
 * arbitrary amount `amountCents`, capped at `0 < amountCents <= valueCents`
 * (the same floored figure a payout receipt already shows — decision D-A).
 *
 * The PROPORTIONAL RULE governs the split: this withdrawal carries the same
 * profit/capital mix as the holder's whole position, because a redeemed unit
 * is fungible and carries its pro-rata share of both basis and profit.
 *
 *   withdrawalProfitCents = floor(amountCents × max(0, profitCents) / valueCents)
 *   capitalPortionCents   = amountCents − withdrawalProfitCents
 *   fee                   = floor(withdrawalProfitCents × manager_split)
 *   newBasisCents         = basisCents − capitalPortionCents
 *
 * Two simpler alternatives were rejected. "Profit first" (draw down profit
 * until exhausted, then capital) drives basis to a floor quickly, so every
 * later gain is fully fee-bearing — it front-loads the manager's fee onto
 * the investor's future gains. "Capital first" is the mirror image: no fee
 * until capital is gone, front-loading the investor's advantage and leaving
 * the manager to carry the position. Proportional is the standard fund
 * treatment, needs no lot tracking, and is the only one of the three under
 * which a holder who withdraws twice in a row (for the same total amount, in
 * two pieces instead of one) is charged the same fee either way — the other
 * two are path-dependent, so a holder or manager could game the fee by
 * choosing withdrawal order.
 *
 * withdrawalProfitCents is FLOORED — the same direction as the fee-amount
 * rule below (favours the investor): a division that does not land evenly
 * calls slightly LESS of the withdrawal profit-bearing, never more. The fee
 * base can only shrink relative to the exact split, never grow; the
 * complementary cent lands in capitalPortionCents instead, which is
 * fee-free. capitalPortionCents is therefore never worse for the holder than
 * the exact proportional split, by at most one cent per withdrawal.
 *
 * At amountCents === valueCents (the cap, in full) this is treated
 * identically to exit in every field — not as a limiting case of the
 * proportional formula, which would leave a phantom basis remainder behind
 * for a holder who exits while underwater (profitCents < 0): the formula
 * alone gives capitalPortionCents = valueCents there, not basisCents, and a
 * later re-deposit would then compound onto a stale basis instead of
 * starting fresh. See unitsRedeemed below for the other reason full and
 * partial-at-the-cap must agree exactly.
 */
import { mulDivFloor, type Cents, type Units } from "./money";
import { valueOfUnits, unitsToRedeem, type PoolTotals } from "./nav";

export type PayoutMode = "profit" | "exit" | "partial";

export interface QuoteInput {
  totals: PoolTotals;
  holderUnits: Units;
  basisCents: Cents;
  /**
   * Manager's share of this holder's profit, in basis points.
   *
   * Always range-checked, including for the manager: a split outside 0..10000
   * means corrupt holder terms, and failing loudly beats silently ignoring it.
   * Forced to 0 when isManager, because the manager never charges themselves —
   * see splitBpsApplied for what was actually used.
   */
  splitBps: number;
  isManager: boolean;
  mode: PayoutMode;
  /**
   * The amount requested. Required, and used, only when mode is "partial" —
   * "profit" and "exit" derive their own gross and ignore this field. Refused
   * outside 0 < amountCents <= valueOfUnits(totals, holderUnits) — the cap.
   */
  amountCents?: Cents;
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
  /**
   * The fee-free slice of grossCents. Zero for "profit" (the whole gross IS
   * profit, by construction of the mode); basisCents for "exit" (the whole
   * position closes, so the whole basis returns, whatever the sign of
   * profitCents); the proportional, floor-rounded split for "partial".
   */
  capitalPortionCents: Cents;
  /**
   * grossCents − capitalPortionCents: the fee-bearing slice of THIS
   * withdrawal. Not the same number as profitCents, which is the whole
   * position's profit whether or not any of it is being taken out right now
   * — can be negative for "exit" below the high-water mark, matching
   * profitCents there; never negative for "profit" or "partial".
   */
  withdrawalProfitCents: Cents;
  /** basisCents after this operation: basisCents − capitalPortionCents. */
  newBasisCents: Cents;
}

export function quote(input: QuoteInput): Quote {
  const { totals, holderUnits, basisCents, isManager, mode } = input;

  if (basisCents < 0n) {
    throw new RangeError(`basisCents must be non-negative, got ${basisCents}`);
  }
  if (!Number.isInteger(input.splitBps) || input.splitBps < 0 || input.splitBps > 10_000) {
    throw new RangeError(`splitBps must be an integer 0..10000, got ${input.splitBps}`);
  }
  const splitBpsApplied = isManager ? 0 : input.splitBps;

  const valueCents = valueOfUnits(totals, holderUnits);
  const profitCents = valueCents - basisCents;
  const feeableCents = profitCents > 0n ? profitCents : 0n;

  let amountCents: Cents | undefined;
  if (mode === "partial") {
    amountCents = input.amountCents;
    if (amountCents === undefined) {
      throw new RangeError('mode "partial" requires amountCents');
    }
    if (amountCents <= 0n) {
      throw new RangeError(`withdrawal amount must be positive, got ${amountCents}`);
    }
    if (amountCents > valueCents) {
      throw new RangeError(
        `withdrawal amount ${amountCents} exceeds the holder's value of ${valueCents} cents`,
      );
    }
  }

  // A partial withdrawal of the full cap IS an exit, in every field — see
  // the module doc for why the basis side of this matters, and the
  // unitsRedeemed comment below for why the units side does too.
  const isFullWithdrawal = mode === "exit" || (mode === "partial" && amountCents === valueCents);
  // True only for a genuine, sub-cap partial withdrawal — the one case where
  // the proportional formula, rather than exit's direct arithmetic, applies.
  const isProportional = mode === "partial" && !isFullWithdrawal;

  let grossCents: Cents;
  let capitalPortionCents: Cents;
  if (isFullWithdrawal) {
    grossCents = valueCents;
    capitalPortionCents = basisCents;
  } else if (isProportional) {
    grossCents = amountCents!;
    capitalPortionCents = grossCents - mulDivFloor(grossCents, feeableCents, valueCents);
  } else {
    grossCents = feeableCents;
    capitalPortionCents = 0n;
  }
  const withdrawalProfitCents = grossCents - capitalPortionCents;

  // The fee is always on the POSITION's profit (feeableCents, already
  // clamped to >= 0), never on the signed withdrawalProfitCents above — a
  // full withdrawal (exit, or partial at the cap) can recover less than
  // basis, and the fee must stay zero then, not go negative.
  const feeBaseCents = isProportional ? withdrawalProfitCents : feeableCents;
  const feeCents = mulDivFloor(feeBaseCents, BigInt(splitBpsApplied), 10_000n);
  const toHolderCents = grossCents - feeCents;

  // On exit — or a partial withdrawal of the full cap — the holder
  // surrenders their exact balance rather than a figure derived from value.
  // Over the rationals the two agree; in integers they do not: valueOfUnits
  // floors to whole cents and unitsToRedeem ceils back — the round trip can
  // under-recover, stranding a fraction of a unit in a holder who has left.
  const unitsRedeemed = isFullWithdrawal ? holderUnits : unitsToRedeem(totals, grossCents);

  return {
    valueCents,
    profitCents,
    grossCents,
    feeCents,
    toHolderCents,
    unitsRedeemed,
    belowHighWaterMark: profitCents <= 0n,
    splitBpsApplied,
    capitalPortionCents,
    withdrawalProfitCents,
    newBasisCents: basisCents - capitalPortionCents,
  };
}
