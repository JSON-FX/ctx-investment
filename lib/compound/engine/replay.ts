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
import { unitsForDeposit, type PoolTotals } from "./nav";

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
        throw new Error(`${e.type} entries are not applied yet — see Task 7`);
      }
    }
  }

  return { equityCents, units, holders: [...holders.values()], lastReadingOn, seq };
}
