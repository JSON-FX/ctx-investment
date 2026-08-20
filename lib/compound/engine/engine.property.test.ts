import fc from "fast-check";
import { fold, type HolderSeed, type LedgerEntry, type PoolState } from "./replay";
import { checkInvariants } from "./invariants";

const MANAGER: HolderSeed = { holderId: 0, isManager: true, splitBps: 0 };

/** A generated operation, before it is turned into a ledger entry. */
type Op =
  | { kind: "deposit"; holderId: number; amountCents: bigint }
  | { kind: "reading"; equityCents: bigint }
  | { kind: "payout"; holderId: number; feeCash: boolean }
  | { kind: "exit"; holderId: number; feeCash: boolean };

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
 * payout, 8 exit. Biased toward the extraction paths (payout/exit), which
 * are what the NAV-monotonicity property exists to protect. An even split
 * across the four kinds left payout/exit as a small minority of the already-
 * legal ops in a sequence, undercounting the paths that matter most.
 */
const opArb: fc.Arbitrary<Op> = fc
  .record({
    kind: fc.integer({ min: 0, max: 8 }),
    holderId: fc.integer({ min: 0, max: HOLDER_COUNT - 1 }),
    amountCents: fc.bigInt({ min: 100n, max: 100_000_00n }),
    equityCents: fc.bigInt({ min: 1n, max: 500_000_00n }),
    feeCash: fc.boolean(),
  })
  .map((r): Op => {
    // 0-2 deposit, 3-5 reading, 6-7 payout, 8 exit. Biased toward the
    // extraction paths, which are what the NAV property exists to protect.
    if (r.kind <= 2) {
      return { kind: "deposit", holderId: r.holderId, amountCents: r.amountCents };
    }
    if (r.kind <= 5) {
      return { kind: "reading", equityCents: r.equityCents };
    }
    const holderId = 1 + (r.holderId % (HOLDER_COUNT - 1));
    return r.kind <= 7
      ? { kind: "payout", holderId, feeCash: r.feeCash }
      : { kind: "exit", holderId, feeCash: r.feeCash };
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
        const state: PoolState = fold(buildLedger(founding, ops), seeds());
        for (const h of state.holders) {
          if (h.status === "closed") {
            expect(h.units).toBe(0n);
            expect(h.basisCents).toBe(0n);
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
