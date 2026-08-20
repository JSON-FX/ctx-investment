/**
 * NAV-derived quantities. NAV per unit is equity / units issued, and is never
 * stored — it is a division that rarely terminates. Every function here takes
 * the (equityCents, units) pair and derives what it needs in exact integer
 * arithmetic.
 *
 * Rounding principle: round in the direction that never lets a holder extract
 * more value than they are entitled to. The residual is sub-cent and accrues to
 * the pool, so it is shared pro-rata by everyone.
 */
import { UNIT_SCALE, mulDivFloor, mulDivCeil, type Cents, type Units } from "./money";

export interface PoolTotals {
  equityCents: Cents;
  units: Units;
}

/** Genesis: no units issued yet, so NAV is defined as 1.00. */
export function isGenesis(t: PoolTotals): boolean {
  return t.units === 0n;
}

function assertSolvent(t: PoolTotals): void {
  if (t.equityCents <= 0n) {
    throw new RangeError(`cannot derive NAV against non-positive equity ${t.equityCents}`);
  }
}

/** Units issued for a deposit. FLOOR — never issue more units than were paid for. */
export function unitsForDeposit(t: PoolTotals, amountCents: Cents): Units {
  if (amountCents <= 0n) throw new RangeError(`deposit must be positive, got ${amountCents}`);
  if (isGenesis(t)) {
    if (t.equityCents !== 0n) {
      throw new RangeError(
        `equity ${t.equityCents} with zero units — corrupt state, needs an adjustment entry`,
      );
    }
    return mulDivFloor(amountCents, UNIT_SCALE, 100n); // NAV := 1.00
  }
  assertSolvent(t);
  return mulDivFloor(amountCents, t.units, t.equityCents);
}

/** A holder's value. FLOOR — never overstate an entitlement. */
export function valueOfUnits(t: PoolTotals, holderUnits: Units): Cents {
  if (holderUnits < 0n) throw new RangeError(`negative units ${holderUnits}`);
  if (isGenesis(t)) return 0n;
  assertSolvent(t);
  return mulDivFloor(holderUnits, t.equityCents, t.units);
}

/** Units surrendered for a cash payout. CEIL — never let a holder keep units they were paid for. */
export function unitsToRedeem(t: PoolTotals, grossCents: Cents): Units {
  if (grossCents < 0n) throw new RangeError(`negative gross ${grossCents}`);
  if (isGenesis(t) || grossCents === 0n) return 0n;
  assertSolvent(t);
  return mulDivCeil(grossCents, t.units, t.equityCents);
}

/** Units issued to the manager when a fee is retained. FLOOR — no rounding advantage. */
export function unitsForFee(t: PoolTotals, feeCents: Cents): Units {
  if (feeCents < 0n) throw new RangeError(`negative fee ${feeCents}`);
  if (isGenesis(t) || feeCents === 0n) return 0n;
  assertSolvent(t);
  return mulDivFloor(feeCents, t.units, t.equityCents);
}

/**
 * NAV × 10^4, truncated. Display only — never feed this back into arithmetic.
 * NAV = (equityCents / 100) / (units / UNIT_SCALE).
 */
export function navTimes1e4(t: PoolTotals): bigint {
  if (isGenesis(t)) return 10_000n;
  assertSolvent(t);
  return mulDivFloor(t.equityCents * UNIT_SCALE, 10_000n, t.units * 100n);
}
