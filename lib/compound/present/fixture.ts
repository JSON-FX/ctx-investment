/**
 * The fixture every test in plan 4 renders against. Fictional names,
 * fictional amounts, deliberately awkward denominators.
 *
 * Every number below was produced by running the merged engine (`fold`,
 * `quote`, `allocateValues`, `navTimes1e4`) over this ledger, not calculated
 * by hand or adjusted for legibility afterwards.
 *
 * Final state, from fold():
 *   equity  55743.91      units 40222.4547963043      NAV 1.3858... (1.38589 to 5dp)
 *   Manager  25000.0000000000u  basis 25000.00  alloc 34647.26  floor 34647.25
 *   Ada       9113.7132585206u  basis 10000.00  alloc 12630.61  floor 12630.60
 *   Grace     6108.7415377837u  basis  7500.00  alloc  8466.04  floor  8466.04
 *
 * Properties a round fixture does not have, that this plan tests directly:
 *   - allocated and floored value differ by a cent for Ada and Manager, and
 *     the floored column is two cents short of equity (55743.89 vs 55743.91)
 *     — decision D-A: both are correct, for different questions.
 *   - naively-floored ppm shares sum to 999998, not 1000000 (621543 + 226582
 *     + 151873) — the gap `allocateShares` (Task 3) exists to close.
 *   - NAV does not terminate. Its 5th decimal digit is 9 (1.38589...), so
 *     truncating at 4dp (1.3858) and rounding at 4dp (1.3859) visibly
 *     disagree — the fixture itself proves formatNav truncates rather than
 *     rounds, with no mutation required.
 *
 * Grace's split is 3700, not the 4000 default, so a component that
 * hard-codes 40 percent fails against her row.
 */
import { centsFromDecimal } from "@/lib/compound/engine/money";
import type { HolderSeed, LedgerEntry } from "@/lib/compound/engine/replay";

export const MANAGER_ID = 1;
export const ADA_ID = 2;
export const GRACE_ID = 3;

export const HOLDER_NAMES: Record<number, string> = {
  [MANAGER_ID]: "J. Marsh",
  [ADA_ID]: "Ada Lovelace",
  [GRACE_ID]: "Grace Hopper",
};

export const SEEDS: HolderSeed[] = [
  { holderId: MANAGER_ID, isManager: true, splitBps: 0 },
  { holderId: ADA_ID, isManager: false, splitBps: 4000 },
  { holderId: GRACE_ID, isManager: false, splitBps: 3700 },
];

function entry(
  id: number,
  seq: number,
  holderId: number | null,
  occurredOn: string,
  type: LedgerEntry["type"],
  amount: string,
  feeSettlement: LedgerEntry["feeSettlement"] = null,
  splitBpsApplied: number | null = null,
): LedgerEntry {
  return {
    id, seq, holderId, occurredOn, type,
    amountCents: centsFromDecimal(amount),
    feeSettlement, splitBpsApplied, reversesId: null,
  };
}

export const LEDGER: LedgerEntry[] = [
  entry(1, 1, MANAGER_ID, "2026-03-02", "deposit", "25000.00"),
  entry(2, 2, null, "2026-04-30", "equity_reading", "27431.19"),
  entry(3, 3, ADA_ID, "2026-05-04", "deposit", "10000.00"),
  entry(4, 4, null, "2026-06-30", "equity_reading", "41883.07"),
  entry(5, 5, GRACE_ID, "2026-07-06", "deposit", "7500.00"),
  entry(6, 6, null, "2026-08-14", "equity_reading", "55743.91"),
];

/**
 * The same account after a reading that puts everyone under water (NAV
 * 0.9474). Recovery figures — the deficit each holder's value must close
 * before a fee can crystallise again — are Manager $1,312.71, Ada $1,364.84,
 * Grace $1,712.02, read from `quote(...).profitCents` at this state.
 */
export const LEDGER_UNDERWATER: LedgerEntry[] = [
  ...LEDGER,
  entry(7, 7, null, "2026-08-18", "equity_reading", "38110.44"),
];

/** Live figures from account_snapshots_current, ahead of the last reading. */
export const LIVE = {
  balanceCents: centsFromDecimal("55805.00"),
  equityCents: centsFromDecimal("55930.00"),
  floatingPnlCents: centsFromDecimal("125.00"),
  pushedAt: "2026-08-18T09:14:22.000Z",
};
