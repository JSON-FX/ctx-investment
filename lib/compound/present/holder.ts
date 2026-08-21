/**
 * One holder's position and history.
 *
 * markState exists because quote()'s belowHighWaterMark is `profitCents <=
 * 0n`, which reports a holder sitting EXACTLY on their mark as below it.
 * That is defensible inside the engine — zero profit and negative profit
 * both mean no fee — and it is wrong on a screen, where "below the
 * high-water mark, $0.00 of recovery needed" reads as a glitch. Branching on
 * the sign of profitCents here fixes the presentation without touching an
 * engine 125 tests already agree with.
 *
 * profitCents here is measured against settlementValueCents (FLOORED), not
 * statementValueCents (ALLOCATED) — deliberately: quote()'s own profitCents
 * is what a fee is charged on, and quote() values a holding by flooring
 * (engine/nav.ts's valueOfUnits). Measuring profit against the allocated
 * figure instead would let this presenter disagree with the fee the engine
 * itself would charge on the same holder, on the same screen.
 */
import type { Cents, Units } from "@/lib/compound/engine/money";
import { allocateValues, valueOfUnits } from "@/lib/compound/engine/nav";
import { quote, type Quote } from "@/lib/compound/engine/quote";
import {
  totalsOf, type HolderState, type LedgerEntryType, type PoolState,
} from "@/lib/compound/engine/replay";
import type { LedgerStep } from "./derive";
import { allocateShares } from "./rail";

export interface HolderPosition {
  holder: HolderState;
  /** Parts per million, largest-remainder allocated — sums to 1,000,000 across holders. */
  ppm: number;
  /** ALLOCATED (decision D-A). Sums with the other holders to equity exactly. */
  statementValueCents: Cents;
  /** FLOORED (decision D-A). What a payout actually settles at. Can be one cent lower. */
  settlementValueCents: Cents;
  /** Against the SETTLEMENT value, because that is what a fee is charged on. */
  profitCents: Cents;
  /** Positive only when below the mark. Zero at or above it. */
  recoveryCents: Cents;
  markState: "above" | "at" | "below";
  profitQuote: Quote;
  exitQuote: Quote;
}

export function holderPosition(state: PoolState, holderId: number): HolderPosition {
  const index = state.holders.findIndex((h) => h.holderId === holderId);
  if (index === -1) throw new RangeError(`no holder ${holderId} on this account`);
  const holder = state.holders[index]!;
  const totals = totalsOf(state);

  const common = {
    totals,
    holderUnits: holder.units,
    basisCents: holder.basisCents,
    splitBps: holder.splitBps,
    isManager: holder.isManager,
  };
  const profitQuote = quote({ ...common, mode: "profit" });
  const exitQuote = quote({ ...common, mode: "exit" });

  const settlementValueCents = valueOfUnits(totals, holder.units);
  const profitCents = settlementValueCents - holder.basisCents;

  return {
    holder,
    ppm: allocateShares(state.holders.map((h) => h.units), state.units)[index]!,
    statementValueCents: allocateValues(totals, state.holders.map((h) => h.units))[index]!,
    settlementValueCents,
    profitCents,
    recoveryCents: profitCents < 0n ? -profitCents : 0n,
    markState: profitCents > 0n ? "above" : profitCents === 0n ? "at" : "below",
    profitQuote,
    exitQuote,
  };
}

export interface HolderStatementRow {
  seq: number;
  occurredOn: string;
  type: LedgerEntryType;
  voided: boolean;
  /** True when the entry is this holder's own. A reading or another holder's entry is not. */
  own: boolean;
  /** Signed. Zero for an entry that does not move this holder's units. */
  unitsDelta: Units;
  unitsAfter: Units;
  basisAfter: Cents;
  /** ALLOCATED, so a row here agrees with the desk and the statement head on the same date. */
  valueAfter: Cents;
  /** Signed. What this entry did to this holder's value. */
  valueDelta: Cents;
}

/**
 * Every entry on the account, from this holder's point of view.
 *
 * Readings are included even though they are nobody's entry, because a
 * statement that showed only a holder's own deposits could not explain why
 * their value changed between them — which is the single most likely
 * question a statement has to answer. Filtering to `entry.holderId ===
 * holderId` is the obvious optimisation and it is exactly the one that would
 * make a statement unable to explain itself.
 */
export function holderStatement(
  steps: readonly LedgerStep[],
  holderId: number,
): HolderStatementRow[] {
  const valueIn = (state: PoolState): Cents => {
    const i = state.holders.findIndex((h) => h.holderId === holderId);
    if (i === -1) return 0n;
    return allocateValues(totalsOf(state), state.holders.map((h) => h.units))[i]!;
  };
  const holderIn = (state: PoolState): HolderState | undefined =>
    state.holders.find((h) => h.holderId === holderId);

  return steps.map((s) => {
    const before = holderIn(s.before);
    const after = holderIn(s.after);
    return {
      seq: s.entry.seq,
      occurredOn: s.entry.occurredOn,
      type: s.entry.type,
      voided: s.voided,
      own: s.entry.holderId === holderId,
      unitsDelta: (after?.units ?? 0n) - (before?.units ?? 0n),
      unitsAfter: after?.units ?? 0n,
      basisAfter: after?.basisCents ?? 0n,
      valueAfter: valueIn(s.after),
      valueDelta: valueIn(s.after) - valueIn(s.before),
    };
  });
}
