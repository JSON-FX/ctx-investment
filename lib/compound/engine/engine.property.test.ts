import fc from "fast-check";
import { mulDivFloor } from "./money";
import { valueOfUnits } from "./nav";
import { fold, totalsOf, type HolderSeed, type LedgerEntry, type PoolState } from "./replay";
import { checkInvariants } from "./invariants";

const MANAGER: HolderSeed = { holderId: 0, isManager: true, splitBps: 0 };

/** A generated operation, before it is turned into a ledger entry. */
type Op =
  | { kind: "deposit"; holderId: number; amountCents: bigint }
  | { kind: "reading"; equityCents: bigint }
  | { kind: "payout"; holderId: number; feeCash: boolean }
  | { kind: "exit"; holderId: number; feeCash: boolean }
  /**
   * P6. Unlike payout/exit, a withdrawal's amount is not derived from state
   * — it is the arbitrary figure a manager types in, capped at the holder's
   * value. fractionBps carries THAT choice instead of an absolute amountCents,
   * because the cap is only known once buildLedger has folded the prefix; a
   * pre-generated absolute amount could not be guaranteed legal against
   * whatever value the holder happens to have at that point in the sequence.
   */
  | { kind: "withdrawal"; holderId: number; feeCash: boolean; fractionBps: number };

const HOLDER_COUNT = 4; // manager (0) plus three investors

function seeds(): HolderSeed[] {
  return [
    MANAGER,
    { holderId: 1, isManager: false, splitBps: 4000 },
    { holderId: 2, isManager: false, splitBps: 3500 },
    { holderId: 3, isManager: false, splitBps: 5000 },
  ];
}

/**
 * Weighted by hand rather than fc.oneof's frequency option, so this does not
 * depend on fast-check's weighted-oneof API: 0-2 deposit, 3-5 reading, 6-7
 * payout, 8 exit, 9-10 withdrawal. Biased toward the extraction paths
 * (payout/exit/withdrawal), which are what the NAV-monotonicity property
 * exists to protect. An even split across the five kinds left the extraction
 * paths as a small minority of the already-legal ops in a sequence,
 * undercounting the paths that matter most. Withdrawal gets the same weight
 * as payout, on the same reasoning.
 */
const opArb: fc.Arbitrary<Op> = fc
  .record({
    kind: fc.integer({ min: 0, max: 10 }),
    holderId: fc.integer({ min: 0, max: HOLDER_COUNT - 1 }),
    amountCents: fc.bigInt({ min: 100n, max: 100_000_00n }),
    equityCents: fc.bigInt({ min: 1n, max: 500_000_00n }),
    feeCash: fc.boolean(),
    // 1..10000 basis points of the holder's CURRENT value at the point this
    // op applies — see the Op type's own doc comment for why this is a
    // fraction rather than an absolute amount.
    fractionBps: fc.integer({ min: 1, max: 10_000 }),
  })
  .map((r): Op => {
    // 0-2 deposit, 3-5 reading, 6-7 payout, 8 exit, 9-10 withdrawal. Biased
    // toward the extraction paths, which are what the NAV property exists to
    // protect.
    if (r.kind <= 2) {
      return { kind: "deposit", holderId: r.holderId, amountCents: r.amountCents };
    }
    if (r.kind <= 5) {
      return { kind: "reading", equityCents: r.equityCents };
    }
    // Any holder, the manager included, and uniformly: r.holderId is already
    // a uniform 0..HOLDER_COUNT-1. Excluding holder 0 here kept the manager
    // out of every extraction path, so a manager exit — and a retained fee
    // landing on an exited manager — was never generated.
    const holderId = r.holderId;
    if (r.kind <= 7) return { kind: "payout", holderId, feeCash: r.feeCash };
    if (r.kind === 8) return { kind: "exit", holderId, feeCash: r.feeCash };
    return { kind: "withdrawal", holderId, feeCash: r.feeCash, fractionBps: r.fractionBps };
  });

const foundingArb = fc.bigInt({ min: 10_000n, max: 1_000_000n }); // $100 .. $10,000

/**
 * Turn generated ops into a ledger. Always opens with a founding deposit from
 * the manager, so every generated sequence reaches genesis: requiring a
 * generated "deposit" op with holderId 0 to happen first (6.25% per op) left
 * most sequences never reaching genesis at all, contributing no checks.
 * Genesis-from-nothing itself stays covered by replay.test.ts. Ops that
 * cannot legally apply at that point (e.g. a payout before the holder has
 * units) are dropped; replaying the prefix is what tells us whether an op is
 * legal.
 *
 * Known narrowings — "any legal sequence" is not quite the whole legal space:
 *
 *  - No `adjustment` entries. An adjustment is a manual correction carrying an
 *    arbitrary signed amount, so it can legitimately move NAV in either
 *    direction and does not belong under the NAV property below.
 *  - No zero or negative equity readings, so the wiped-out and corrupt-state
 *    paths never appear here. replay.test.ts and nav.test.ts cover those.
 *  - No reversal entries; replay.test.ts covers voiding an entry and its
 *    reversal.
 *  - A holder's split never changes, so `splitBpsApplied` always equals the
 *    holder's current terms and the two can never be seen to diverge.
 */
function buildLedger(foundingCents: bigint, ops: readonly Op[]): LedgerEntry[] {
  const ledger: LedgerEntry[] = [];
  let seq = 0;
  const push = (e: Omit<LedgerEntry, "id" | "seq">) => {
    seq += 1;
    ledger.push({ id: seq, seq, ...e });
  };
  const base = {
    occurredOn: "2026-01-01",
    feeSettlement: null,
    splitBpsApplied: null,
    reversesId: null,
  };

  push({ ...base, holderId: 0, type: "deposit", amountCents: foundingCents });

  for (const op of ops) {
    const state = fold(ledger, seeds());
    const holders = new Map(state.holders.map((h) => [h.holderId, h]));

    switch (op.kind) {
      case "deposit": {
        // The founding deposit must come from the manager. Unreachable now
        // that genesis is always pre-seeded above, but kept so this still
        // reads correctly if buildLedger is ever called without a founding
        // deposit again.
        if (state.units === 0n && op.holderId !== 0) continue;
        push({ ...base, holderId: op.holderId, type: "deposit", amountCents: op.amountCents });
        break;
      }
      case "reading": {
        if (state.units === 0n) continue;         // NAV is undefined before genesis
        push({ ...base, holderId: null, type: "equity_reading", amountCents: op.equityCents });
        break;
      }
      case "payout":
      case "exit": {
        const h = holders.get(op.holderId);
        if (!h || h.units === 0n || state.equityCents <= 0n) continue;
        push({
          ...base,
          holderId: op.holderId,
          type: op.kind,
          amountCents: 0n,
          feeSettlement: op.feeCash ? "cash" : "units",
          splitBpsApplied: h.splitBps,
        });
        break;
      }
      case "withdrawal": {
        const h = holders.get(op.holderId);
        if (!h || h.units === 0n || state.equityCents <= 0n) continue;
        // The cap, computed against the SAME totals fold() will use to
        // apply this entry — quote.ts's own valueOfUnits call, not a
        // separate derivation, so the generator can never manufacture an
        // amount the engine itself would refuse.
        const value = valueOfUnits(totalsOf(state), h.units);
        if (value <= 0n) continue; // wiped out: nothing legal to withdraw
        const amountCents = mulDivFloor(value, BigInt(op.fractionBps), 10_000n);
        if (amountCents <= 0n) continue; // fraction too small to reach one cent
        push({
          ...base,
          holderId: op.holderId,
          type: "withdrawal",
          amountCents,
          feeSettlement: op.feeCash ? "cash" : "units",
          splitBpsApplied: h.splitBps,
        });
        break;
      }
    }
  }
  return ledger;
}

describe("engine properties", () => {
  it("invariants hold after every operation in any legal sequence", () => {
    fc.assert(
      fc.property(foundingArb, fc.array(opArb, { minLength: 1, maxLength: 25 }), (founding, ops) => {
        const ledger = buildLedger(founding, ops);
        for (let i = 1; i <= ledger.length; i += 1) {
          const state = fold(ledger.slice(0, i), seeds());
          const violations = checkInvariants(state);
          if (violations.length > 0) {
            throw new Error(
              `after entry ${i} (${ledger[i - 1]!.type}): ` +
                violations.map((v) => `${v.code} ${v.detail}`).join("; "),
            );
          }
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("NAV never decreases on anything but an equity reading", () => {
    let comparisons = 0;
    let extractions = 0;

    fc.assert(
      fc.property(foundingArb, fc.array(opArb, { minLength: 1, maxLength: 25 }), (founding, ops) => {
        const ledger = buildLedger(founding, ops);
        for (let i = 1; i <= ledger.length; i += 1) {
          const before = fold(ledger.slice(0, i - 1), seeds());
          const after = fold(ledger.slice(0, i), seeds());
          const entry = ledger[i - 1]!;

          if (entry.type === "equity_reading") continue;
          // Adjustments are manual corrections and may legitimately move NAV
          // in either direction, so they are not bound by this invariant.
          // The generator does not currently emit them; the skip is here so
          // that adding them later does not produce a false failure.
          if (entry.type === "adjustment") continue;
          if (before.units === 0n || after.units === 0n) continue;
          if (before.equityCents <= 0n || after.equityCents <= 0n) continue;

          comparisons += 1;
          if (entry.type !== "deposit") extractions += 1;

          // Compare NAV exactly, as a rational. navTimes1e4 truncates to four
          // places and would hide a decrease smaller than 0.0001.
          //   navAfter < navBefore  <=>  E1/U1 < E0/U0  <=>  E1*U0 < E0*U1
          const lhs = after.equityCents * before.units;
          const rhs = before.equityCents * after.units;
          if (lhs < rhs) {
            throw new Error(
              `${entry.type} at seq ${entry.seq} DECREASED NAV: ` +
                `${before.equityCents}/${before.units} -> ` +
                `${after.equityCents}/${after.units}`,
            );
          }
        }
        return true;
      }),
      { numRuns: 300 },
    );

    // Ratchets, not targets. This property was previously reaching only ~20-30
    // payout/exit comparisons per session while appearing to run 300 cases.
    // If these fail, the generator has drifted — widen it rather than lowering
    // these numbers.
    expect(comparisons).toBeGreaterThan(150);
    expect(extractions).toBeGreaterThan(40);
  });

  it("replay is deterministic — the same ledger always yields the same state", () => {
    fc.assert(
      fc.property(foundingArb, fc.array(opArb, { minLength: 1, maxLength: 20 }), (founding, ops) => {
        const ledger = buildLedger(founding, ops);
        const a = fold(ledger, seeds());
        const b = fold([...ledger].reverse(), seeds()); // seq ordering must win
        expect(b).toEqual(a);
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("a holder's cost basis never goes negative and never exceeds lifetime deposits", () => {
    fc.assert(
      fc.property(foundingArb, fc.array(opArb, { minLength: 1, maxLength: 25 }), (founding, ops) => {
        const ledger = buildLedger(founding, ops);
        const state = fold(ledger, seeds());
        const deposited = new Map<number, bigint>();
        for (const e of ledger) {
          if (e.type === "deposit" && e.holderId !== null) {
            deposited.set(e.holderId, (deposited.get(e.holderId) ?? 0n) + e.amountCents);
          }
        }
        for (const h of state.holders) {
          if (h.isManager) continue; // the manager's basis also grows from retained fees
          expect(h.basisCents >= 0n).toBe(true);
          expect(h.basisCents <= (deposited.get(h.holderId) ?? 0n)).toBe(true);
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("an exited holder holds no units and no basis", () => {
    fc.assert(
      fc.property(foundingArb, fc.array(opArb, { minLength: 1, maxLength: 25 }), (founding, ops) => {
        const ledger = buildLedger(founding, ops);
        // Every prefix, not just the end of the ledger. A retained fee can
        // credit units to a manager who has already exited, and a later
        // deposit or exit tidies the state up again — so checking only the
        // final state cannot see the transition that broke the rule.
        for (let i = 1; i <= ledger.length; i += 1) {
          const state: PoolState = fold(ledger.slice(0, i), seeds());
          for (const h of state.holders) {
            if (h.status === "closed") {
              expect(h.units).toBe(0n);
              expect(h.basisCents).toBe(0n);
            }
          }
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("an equity reading never changes the units issued", () => {
    fc.assert(
      fc.property(foundingArb, fc.array(opArb, { minLength: 1, maxLength: 25 }), (founding, ops) => {
        const ledger = buildLedger(founding, ops);
        for (let i = 1; i <= ledger.length; i += 1) {
          const entry = ledger[i - 1]!;
          if (entry.type !== "equity_reading") continue;
          const before = fold(ledger.slice(0, i - 1), seeds());
          const after = fold(ledger.slice(0, i), seeds());
          if (after.units !== before.units) {
            throw new Error(
              `equity reading at seq ${entry.seq} changed units ` +
                `${before.units} -> ${after.units}`,
            );
          }
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });
});
