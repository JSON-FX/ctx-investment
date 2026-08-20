/**
 * The invariants from the design spec, §3.5. These must hold after every
 * operation. The property suite asserts them across randomised sequences, and a
 * nightly job asserts them against live state.
 *
 * Invariants 1 and 2 hold EXACTLY, not within a tolerance — a direct
 * consequence of deriving balances instead of materialising them. Units are
 * integers that sum exactly, and value is a pure function of units.
 *
 * Invariant 3 is a property of transitions rather than of a single state, so
 * it is asserted in the property suite rather than here. Note its corrected
 * form: a deposit, payout, exit or fee settlement never DECREASES NAV, but may
 * raise it very slightly. Flooring a value leaves a sub-cent residual in the
 * pool, so exact equality holds only where the divisions terminate. What must
 * never happen is NAV moving down on anything but an equity reading — that
 * would mean a holder extracted more than they were owed.
 *
 * Invariant 5 (append-only) is enforced in the database by withholding UPDATE
 * and DELETE grants, not in application code.
 */
import { allocateValues } from "./nav";
import type { PoolState } from "./replay";

export interface InvariantViolation {
  code: string;
  detail: string;
}

export function checkInvariants(state: PoolState): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  // I4 first — negative quantities would make the sums below meaningless.
  for (const h of state.holders) {
    if (h.units < 0n) {
      violations.push({
        code: "I4_NEGATIVE_UNITS",
        detail: `holder ${h.holderId} holds ${h.units} units`,
      });
    }
    if (h.basisCents < 0n) {
      violations.push({
        code: "I4_NEGATIVE_BASIS",
        detail: `holder ${h.holderId} has cost basis ${h.basisCents}`,
      });
    }
  }

  // Pool-level I4: negative equity is corrupt state, not merely unbalanced.
  // This must be recorded before the I2 branch below, because allocateValues
  // rejects non-positive equity and would throw instead of reporting.
  if (state.equityCents < 0n) {
    violations.push({
      code: "I4_NEGATIVE_EQUITY",
      detail: `account equity ${state.equityCents} is negative`,
    });
  }

  // I1 — Σ holder units = units issued.
  const sumUnits = state.holders.reduce((s, h) => s + h.units, 0n);
  const unitsBalance = sumUnits === state.units;
  if (!unitsBalance) {
    violations.push({
      code: "I1_UNITS_SUM",
      detail: `Σ holder units ${sumUnits} ≠ units issued ${state.units}`,
    });
  }

  // I2 — Σ holder value = equity. Only meaningful once I1 holds.
  if (state.units === 0n) {
    if (state.equityCents !== 0n) {
      violations.push({
        code: "I2_ORPHAN_EQUITY",
        detail: `equity ${state.equityCents} with zero units issued`,
      });
    }
  } else if (state.equityCents === 0n) {
    // A wiped-out pool: every holder's value is zero, which sums to zero
    // equity, so the invariant holds trivially. allocateValues would agree —
    // it returns all zeros here — but there is nothing to learn from asking.
  } else if (unitsBalance && violations.length === 0) {
    const values = allocateValues(
      { equityCents: state.equityCents, units: state.units },
      state.holders.map((h) => h.units),
    );
    const sumValue = values.reduce((s, c) => s + c, 0n);
    if (sumValue !== state.equityCents) {
      violations.push({
        code: "I2_VALUE_SUM",
        detail: `Σ holder value ${sumValue} ≠ equity ${state.equityCents}`,
      });
    }
  }

  return violations;
}

export function assertInvariants(state: PoolState): void {
  const violations = checkInvariants(state);
  if (violations.length > 0) {
    const lines = violations.map((v) => `  ${v.code}: ${v.detail}`).join("\n");
    throw new Error(`accounting invariants violated:\n${lines}`);
  }
}
