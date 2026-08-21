/**
 * The ledger reducer. compound_ledger_entry is the only truth; units, cost
 * basis, NAV and every holder figure are derived by replaying it.
 *
 * The ledger stores INPUTS, not outputs. There is no units_delta and no
 * nav_at_entry, because storing a derived value creates a second truth that can
 * disagree with this function. splitBpsApplied is the exception: the terms in
 * force at the moment of a payout are an input, since a holder's split may
 * change afterwards.
 *
 * seq, not occurredOn, defines replay order. Two events on the same date still
 * have a definite order, which is what makes same-day deposit-then-reading
 * deterministic.
 */
import type { Cents, Units } from "./money";
import { unitsForDeposit, unitsForFee, type PoolTotals } from "./nav";
import { quote, type PayoutMode } from "./quote";

export type LedgerEntryType =
  | "deposit"
  | "payout"
  | "exit"
  | "withdrawal"
  | "equity_reading"
  | "adjustment";

export interface LedgerEntry {
  id: number;
  /** Monotonic per account. Defines replay order. */
  seq: number;
  /** Null only for equity_reading and adjustment. */
  holderId: number | null;
  /** Broker-server date, YYYY-MM-DD. */
  occurredOn: string;
  type: LedgerEntryType;
  /**
   * Signed for adjustment; positive otherwise.
   *
   * For "withdrawal" this is a genuine INPUT that fold() reads, exactly like
   * a deposit's amount — the arbitrary requested figure cannot be derived
   * from anything else. That is unlike "payout" and "exit", whose
   * amountCents is a redundant record of what quote() already computed from
   * holder state alone; fold() never reads it back for those two.
   */
  amountCents: Cents;
  feeSettlement: "units" | "cash" | null;
  splitBpsApplied: number | null;
  reversesId: number | null;
}

export interface HolderSeed {
  holderId: number;
  isManager: boolean;
  splitBps: number;
}

export interface HolderState {
  holderId: number;
  isManager: boolean;
  splitBps: number;
  units: Units;
  basisCents: Cents;
  status: "active" | "closed";
}

export interface PoolState {
  equityCents: Cents;
  units: Units;
  holders: HolderState[];
  lastReadingOn: string | null;
  /** seq of the last entry considered. */
  seq: number;
}

export function totalsOf(state: PoolState): PoolTotals {
  return { equityCents: state.equityCents, units: state.units };
}

export function fold(
  entries: readonly LedgerEntry[],
  seeds: readonly HolderSeed[],
): PoolState {
  const holders = new Map<number, HolderState>(
    seeds.map((s) => [
      s.holderId,
      {
        holderId: s.holderId,
        isManager: s.isManager,
        splitBps: s.splitBps,
        units: 0n,
        basisCents: 0n,
        status: "active" as const,
      },
    ]),
  );

  // A reversal voids both the original entry and the reversing entry.
  const voided = new Set<number>();
  for (const e of entries) {
    if (e.reversesId !== null) {
      voided.add(e.reversesId);
      voided.add(e.id);
    }
  }

  const ordered = [...entries].sort((a, b) => a.seq - b.seq);

  let equityCents: Cents = 0n;
  let units: Units = 0n;
  let lastReadingOn: string | null = null;
  let seq = 0;

  const holderOf = (id: number | null): HolderState => {
    if (id === null) throw new Error("entry requires a holderId");
    const h = holders.get(id);
    if (!h) throw new Error(`unknown holderId ${id}`);
    return h;
  };

  for (const e of ordered) {
    seq = e.seq;
    if (voided.has(e.id)) continue;

    switch (e.type) {
      case "equity_reading": {
        equityCents = e.amountCents;
        lastReadingOn = e.occurredOn;
        break;
      }
      case "adjustment": {
        equityCents += e.amountCents;
        break;
      }
      case "deposit": {
        const h = holderOf(e.holderId);
        const issued = unitsForDeposit({ equityCents, units }, e.amountCents);
        h.units += issued;
        h.basisCents += e.amountCents;
        h.status = "active";
        units += issued;
        equityCents += e.amountCents;
        break;
      }
      case "payout":
      case "exit":
      case "withdrawal": {
        const h = holderOf(e.holderId);
        if (e.splitBpsApplied === null) {
          throw new Error(
            `${e.type} entry ${e.id} has no splitBpsApplied — the terms in force ` +
              `at the time of a payout are an input, not a lookup. Replaying against ` +
              `the holder's current split would make history depend on mutable state.`,
          );
        }
        // Every figure is taken against the PRE-payout totals. That is what
        // keeps NAV from decreasing across the operation.
        const totals: PoolTotals = { equityCents, units };
        const mode: PayoutMode =
          e.type === "exit" ? "exit" : e.type === "withdrawal" ? "partial" : "profit";
        const q = quote({
          totals,
          holderUnits: h.units,
          basisCents: h.basisCents,
          splitBps: e.splitBpsApplied,
          isManager: h.isManager,
          mode,
          // amountCents is the requested figure ONLY for "withdrawal" — see
          // the field doc on LedgerEntry.amountCents. quote() ignores this
          // input for every other mode.
          amountCents: e.type === "withdrawal" ? e.amountCents : undefined,
        });

        h.units -= q.unitsRedeemed;
        units -= q.unitsRedeemed;
        equityCents -= q.toHolderCents;
        // Uniform across all three types: 0 net change for "payout" (its
        // capitalPortionCents is always 0), a full reset to 0 for "exit"
        // (capitalPortionCents === basisCents always), and the proportional
        // reduction for "withdrawal". One assignment replaces what used to
        // be an exit-only special case, because quote() now derives the
        // right answer for every mode rather than fold() hard-coding one.
        h.basisCents = q.newBasisCents;

        if (q.feeCents > 0n) {
          const manager = [...holders.values()].find((x) => x.isManager);
          if (!manager) throw new Error("a fee crystallised but no manager holder was seeded");
          if (e.feeSettlement === "cash") {
            equityCents -= q.feeCents;
          } else {
            const feeUnits = unitsForFee(totals, q.feeCents);
            manager.units += feeUnits;
            units += feeUnits;
            manager.basisCents += q.feeCents;
            // A manager who had exited is back in the pool. Leaving them
            // "closed" while holding units would contradict the rule that an
            // exited holder holds nothing.
            manager.status = "active";
          }
        }

        // A withdrawal that drains a holder to zero units closes them for
        // the same reason exit always does: a holder with nothing left
        // cannot be "active" in any sense the desk shows, and a later
        // re-deposit reactivating them (case "deposit", below) already
        // starts their basis fresh either way.
        if (e.type === "exit" || (e.type === "withdrawal" && h.units === 0n)) {
          h.status = "closed";
        }
        break;
      }
    }
  }

  return { equityCents, units, holders: [...holders.values()], lastReadingOn, seq };
}
