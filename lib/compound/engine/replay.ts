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
import { unitsForDeposit, unitsForFee, navTimes1e4, type PoolTotals } from "./nav";
import { quote } from "./quote";

export type LedgerEntryType =
  | "deposit"
  | "payout"
  | "exit"
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
  /** Signed for adjustment; positive otherwise. */
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
      case "exit": {
        const h = holderOf(e.holderId);
        // Every figure is taken against the PRE-payout totals. That is what
        // keeps NAV constant across the operation.
        const totals: PoolTotals = { equityCents, units };
        const q = quote({
          totals,
          holderUnits: h.units,
          basisCents: h.basisCents,
          splitBps: e.splitBpsApplied ?? h.splitBps,
          isManager: h.isManager,
          mode: e.type === "exit" ? "exit" : "profit",
        });

        // On exit the holder surrenders everything, so redeem their exact
        // balance rather than a ceil()-derived figure that could leave dust.
        const redeemed = e.type === "exit" ? h.units : q.unitsRedeemed;

        h.units -= redeemed;
        units -= redeemed;
        equityCents -= q.toHolderCents;

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
          }
        }

        if (e.type === "exit") {
          h.basisCents = 0n;
          h.status = "closed";
        }
        break;
      }
    }
  }

  return { equityCents, units, holders: [...holders.values()], lastReadingOn, seq };
}

/**
 * True when two sets of totals report the same NAV to four decimal places.
 * Deposits, payouts and fee settlements must all satisfy this; only an equity
 * reading may move NAV.
 */
export function checkNavUnchanged(before: PoolTotals, after: PoolTotals): boolean {
  return navTimes1e4(before) === navTimes1e4(after);
}
