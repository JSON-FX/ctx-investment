/**
 * Everything a screen needs that is derived from a ledger rather than
 * formatted from a single figure.
 *
 * The rule this module exists to enforce (decision D-D): A PREVIEW IS A FOLD.
 * `previewEntry` appends the proposed entry to the real ledger and replays
 * with the engine's own `fold`. The receipt a manager reads is therefore
 * produced by the same reducer that will process the entry when they
 * confirm it, and the two cannot drift apart. A hand-written "here is what
 * will happen" calculation would be a second truth, and this product's whole
 * claim is that it has exactly one.
 *
 * `ledgerSteps` folds every prefix rather than keeping a running total, for
 * the same reason (decision D-E). It is O(n^2) at a few thousand entries,
 * which the spec's own scale note says is irrelevant, and it is the only
 * construction under which the ledger page cannot disagree with the desk —
 * both read the same `fold`, just at different prefixes of the same array.
 */
import type { Cents, Units } from "@/lib/compound/engine/money";
import { allocateValues, navTimes1e4, type PoolTotals } from "@/lib/compound/engine/nav";
import { quote, type Quote } from "@/lib/compound/engine/quote";
import {
  fold, totalsOf,
  type HolderSeed, type LedgerEntry, type LedgerEntryType, type PoolState,
} from "@/lib/compound/engine/replay";
import { allocateShares } from "./rail";

/** fold's voiding rule, restated: a reversal voids both the original entry and the reversal itself. */
function voidedIds(entries: readonly LedgerEntry[]): Set<number> {
  const voided = new Set<number>();
  for (const e of entries) {
    if (e.reversesId !== null) {
      voided.add(e.reversesId);
      voided.add(e.id);
    }
  }
  return voided;
}

function bySeq(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => a.seq - b.seq);
}

export interface LedgerStep {
  entry: LedgerEntry;
  /** True when this entry, or the entry that reverses it, is a reversal. */
  voided: boolean;
  before: PoolState;
  after: PoolState;
  /** Signed. Pool units issued or redeemed by this entry. */
  unitsDelta: Units;
  /** Signed, for the entry's own holder. Null for readings and adjustments, which carry no holderId. */
  holderUnitsDelta: Units | null;
  /** Signed. Cash that entered or left the account. */
  equityDelta: Cents;
}

/**
 * One row per ledger entry, each carrying the pool state immediately before
 * and after it — by folding the prefix up to that entry, not by threading a
 * running total forward. See the module doc and decision D-E.
 */
export function ledgerSteps(
  entries: readonly LedgerEntry[],
  seeds: readonly HolderSeed[],
): LedgerStep[] {
  const ordered = bySeq(entries);
  const voided = voidedIds(ordered);
  const empty = fold([], seeds);

  const steps: LedgerStep[] = [];
  let before = empty;
  for (let i = 0; i < ordered.length; i += 1) {
    const entry = ordered[i]!;
    const after = fold(ordered.slice(0, i + 1), seeds);
    const holderUnitsOf = (s: PoolState) =>
      entry.holderId === null
        ? null
        : (s.holders.find((h) => h.holderId === entry.holderId)?.units ?? 0n);
    const hb = holderUnitsOf(before);
    const ha = holderUnitsOf(after);
    steps.push({
      entry,
      voided: voided.has(entry.id),
      before,
      after,
      unitsDelta: after.units - before.units,
      holderUnitsDelta: hb === null || ha === null ? null : ha - hb,
      equityDelta: after.equityCents - before.equityCents,
    });
    before = after;
  }
  return steps;
}

export interface CapitalMark {
  /** YYYY-MM-DD, broker-server date. */
  occurredOn: string;
  type: "deposit" | "payout" | "exit";
  /** Always positive. The cash that actually moved. */
  amountCents: Cents;
  direction: "in" | "out";
}

/**
 * Capital events for an equity curve (spec R4).
 *
 * The amount is taken from the step's EQUITY DELTA, not from
 * `entry.amountCents`. For a deposit the two agree. For a payout they do
 * not: `fold` recomputes the payout from `quote()` and never reads
 * `amountCents` back — the ledger's own figure is the amount that was
 * requested, and the equity delta is the amount that actually left (a
 * fee retained as units leaves the pool's equity untouched). Marking the
 * requested figure would put a mark of the wrong height on the curve,
 * exactly the class of error R4 exists to prevent.
 *
 * Voided entries are excluded, so a reversed deposit leaves no phantom mark.
 */
export function capitalMarks(
  entries: readonly LedgerEntry[],
  seeds: readonly HolderSeed[],
): CapitalMark[] {
  const out: CapitalMark[] = [];
  for (const step of ledgerSteps(entries, seeds)) {
    if (step.voided) continue;
    const t = step.entry.type;
    if (t !== "deposit" && t !== "payout" && t !== "exit") continue;
    const delta = step.equityDelta;
    if (delta === 0n) continue;
    out.push({
      occurredOn: step.entry.occurredOn,
      type: t,
      amountCents: delta < 0n ? -delta : delta,
      direction: delta > 0n ? "in" : "out",
    });
  }
  return out;
}

export interface ProposedEntry {
  holderId: number | null;
  occurredOn: string;
  type: LedgerEntryType;
  amountCents: Cents;
  feeSettlement: "units" | "cash" | null;
  splitBpsApplied: number | null;
}

/**
 * What a preview was computed against. Carried through a sheet as decimal
 * strings and re-checked at commit time (Task 11+), so a receipt can never
 * be confirmed against a pool that moved after it was rendered.
 */
export interface Fingerprint {
  accountId: number;
  seq: number;
  /** Decimal string. A bigint does not survive JSON or a hidden form field. */
  equityCents: string;
  units: string;
}

export function fingerprintOf(accountId: number, state: PoolState): Fingerprint {
  return {
    accountId,
    seq: state.seq,
    equityCents: state.equityCents.toString(),
    units: state.units.toString(),
  };
}

/**
 * Spec section 3.5, invariant 3, enforced at the presentation boundary:
 * "Only an equity reading may move NAV downward. Every other operation
 * leaves NAV equal or very slightly higher, by at most the rounding
 * residual."
 *
 * An adjustment is a correction to equity and is exempt for the same reason
 * a reading is: it restates what the account is worth rather than moving
 * value through a holder. A deposit, payout or exit that lowers NAV means a
 * holder extracted more than they were owed, and a receipt must never be
 * able to render one — this is the last check `previewEntry` runs before
 * handing back a `Preview`.
 */
export function assertNavDidNotFall(
  type: LedgerEntryType,
  beforeX1e4: bigint,
  afterX1e4: bigint,
): void {
  if (type === "equity_reading" || type === "adjustment") return;
  if (afterX1e4 < beforeX1e4) {
    throw new Error(
      `${type} would move NAV down from ${beforeX1e4} to ${afterX1e4} (x1e4). ` +
        `Only an equity reading may lower NAV; a fall here means value left the pool.`,
    );
  }
}

export interface PreviewInput {
  accountId: number;
  entries: readonly LedgerEntry[];
  seeds: readonly HolderSeed[];
  proposed: ProposedEntry;
}

export interface Preview {
  before: PoolState;
  after: PoolState;
  navBeforeX1e4: bigint;
  navAfterX1e4: bigint;
  /** after - before. Non-negative for every type `assertNavDidNotFall` guards. */
  navResidualX1e4: bigint;
  equityDelta: Cents;
  unitsDelta: Units;
  /** Aligned to before.holders / after.holders, which `fold` keeps in seed order. */
  sharesBefore: number[];
  sharesAfter: number[];
  valuesBefore: Cents[];
  valuesAfter: Cents[];
  fingerprint: Fingerprint;
}

/**
 * A receipt, produced the only way this product produces one: by folding
 * the real ledger with the proposed entry appended (decision D-D). `after`
 * is not computed — it is `fold`'s own output, so the receipt a manager
 * reads and the state a confirm writes are, structurally, the same call.
 */
export function previewEntry(input: PreviewInput): Preview {
  const { accountId, entries, seeds, proposed } = input;
  const ordered = bySeq(entries);
  const before = fold(ordered, seeds);

  const nextSeq = (ordered[ordered.length - 1]?.seq ?? 0) + 1;
  const nextId = ordered.reduce((m, e) => (e.id > m ? e.id : m), 0) + 1;
  const after = fold(
    [...ordered, { ...proposed, id: nextId, seq: nextSeq, reversesId: null }],
    seeds,
  );

  const navBeforeX1e4 = navTimes1e4(totalsOf(before));
  const navAfterX1e4 = navTimes1e4(totalsOf(after));
  assertNavDidNotFall(proposed.type, navBeforeX1e4, navAfterX1e4);

  return {
    before,
    after,
    navBeforeX1e4,
    navAfterX1e4,
    navResidualX1e4: navAfterX1e4 - navBeforeX1e4,
    equityDelta: after.equityCents - before.equityCents,
    unitsDelta: after.units - before.units,
    sharesBefore: allocateShares(before.holders.map((h) => h.units), before.units),
    sharesAfter: allocateShares(after.holders.map((h) => h.units), after.units),
    valuesBefore: allocateValues(totalsOf(before), before.holders.map((h) => h.units)),
    valuesAfter: allocateValues(totalsOf(after), after.holders.map((h) => h.units)),
    fingerprint: fingerprintOf(accountId, before),
  };
}

export interface DeskRow {
  holderId: number;
  name: string;
  isManager: boolean;
  status: "active" | "closed";
  units: Units;
  /** Parts per million. The rows sum to 1,000,000. */
  ppm: number;
  basisCents: Cents;
  /** ALLOCATED, per decision D-A. The column sums to equity exactly. */
  valueCents: Cents;
  profitCents: Cents;
  splitBps: number;
  /** What the manager would earn if this holder exited today. Zero for the manager. */
  feeIfExitCents: Cents;
}

export interface DeskFigures {
  totals: PoolTotals;
  navX1e4: bigint;
  rows: DeskRow[];
  /** Active non-manager holders only. */
  investorBasisCents: Cents;
  investorValueCents: Cents;
  investorProfitCents: Cents;
  /** Sum of every holder's fee on a full exit today — the accrued, uncrystallised fee. */
  feeIfAllExitCents: Cents;
  managerValueCents: Cents;
  holderCount: number;
}

/**
 * Every figure on the desk, in one pass.
 *
 * `valueCents` is allocated (largest remainder) so the column sums to equity
 * exactly — invariant 2. `feeIfExitCents` comes from `quote()`, which values
 * the holding by FLOORING. The two can differ by a cent for the same holder,
 * and both are correct: see decision D-A. This function does not reconcile
 * them, and never should.
 */
export function deskFigures(state: PoolState, names: Record<number, string>): DeskFigures {
  const totals = totalsOf(state);
  const values = allocateValues(totals, state.holders.map((h) => h.units));
  const shares = allocateShares(state.holders.map((h) => h.units), state.units);

  const rows: DeskRow[] = state.holders.map((h, i) => {
    const q: Quote = quote({
      totals,
      holderUnits: h.units,
      basisCents: h.basisCents,
      splitBps: h.splitBps,
      isManager: h.isManager,
      mode: "exit",
    });
    return {
      holderId: h.holderId,
      name: names[h.holderId] ?? `Holder #${h.holderId}`,
      isManager: h.isManager,
      status: h.status,
      units: h.units,
      ppm: shares[i]!,
      basisCents: h.basisCents,
      valueCents: values[i]!,
      profitCents: values[i]! - h.basisCents,
      splitBps: h.splitBps,
      feeIfExitCents: q.feeCents,
    };
  });

  const investors = rows.filter((r) => !r.isManager && r.status === "active");
  return {
    totals,
    navX1e4: navTimes1e4(totals),
    rows,
    investorBasisCents: investors.reduce((s, r) => s + r.basisCents, 0n),
    investorValueCents: investors.reduce((s, r) => s + r.valueCents, 0n),
    investorProfitCents: investors.reduce((s, r) => s + r.profitCents, 0n),
    feeIfAllExitCents: rows.reduce((s, r) => s + r.feeIfExitCents, 0n),
    managerValueCents: rows.filter((r) => r.isManager).reduce((s, r) => s + r.valueCents, 0n),
    holderCount: rows.filter((r) => r.units > 0n).length,
  };
}
