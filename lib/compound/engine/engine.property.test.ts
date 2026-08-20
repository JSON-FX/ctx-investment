import fc from "fast-check";
import { UNIT_SCALE } from "./money";
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

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("deposit" as const),
    holderId: fc.integer({ min: 0, max: HOLDER_COUNT - 1 }),
    amountCents: fc.bigInt({ min: 100n, max: 100_000_00n }),
  }),
  fc.record({
    kind: fc.constant("reading" as const),
    equityCents: fc.bigInt({ min: 1n, max: 500_000_00n }),
  }),
  fc.record({
    kind: fc.constant("payout" as const),
    holderId: fc.integer({ min: 1, max: HOLDER_COUNT - 1 }),
    feeCash: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("exit" as const),
    holderId: fc.integer({ min: 1, max: HOLDER_COUNT - 1 }),
    feeCash: fc.boolean(),
  }),
);

/**
 * Turn generated ops into a ledger, dropping any that cannot legally apply at
 * that point (a payout before the holder exists, a reading before genesis).
 * Replaying the prefix is what tells us whether an op is legal.
 */
function buildLedger(ops: readonly Op[]): LedgerEntry[] {
  const ledger: LedgerEntry[] = [];
  let seq = 0;

  for (const op of ops) {
    const state = fold(ledger, seeds());
    const holders = new Map(state.holders.map((h) => [h.holderId, h]));

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

    switch (op.kind) {
      case "deposit": {
        // The founding deposit must come from the manager.
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
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 25 }), (ops) => {
        const ledger = buildLedger(ops);
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
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 25 }), (ops) => {
        const ledger = buildLedger(ops);
        for (let i = 1; i <= ledger.length; i += 1) {
          const before = fold(ledger.slice(0, i - 1), seeds());
          const after = fold(ledger.slice(0, i), seeds());
          const entry = ledger[i - 1]!;

          if (entry.type === "equity_reading") continue;
          if (before.units === 0n || after.units === 0n) continue;
          if (before.equityCents <= 0n || after.equityCents <= 0n) continue;

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
  });

  it("replay is deterministic — the same ledger always yields the same state", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 20 }), (ops) => {
        const ledger = buildLedger(ops);
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
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 25 }), (ops) => {
        const ledger = buildLedger(ops);
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
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 25 }), (ops) => {
        const state: PoolState = fold(buildLedger(ops), seeds());
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

  it("units are never fractional below the scale floor", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 20 }), (ops) => {
        const state = fold(buildLedger(ops), seeds());
        expect(state.units >= 0n).toBe(true);
        expect(state.units % 1n).toBe(0n);
        expect(UNIT_SCALE).toBe(10_000_000_000n);
        return true;
      }),
      { numRuns: 100 },
    );
  });
});
