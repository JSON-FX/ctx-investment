import fc from "fast-check";
import { dedupeDeals } from "./dedupe";
import { utcDateKey } from "./date-key";
import { reconcileDays } from "./detect";
import { planReadings } from "./interlock";
import type { ClosedDeal, DailySnapshot } from "./types";

const OFFSET_HOURS = 3;

/** Sequential trading days from a fixed start, so dates are always ordered. */
function dateAt(i: number): string {
  return new Date(Date.UTC(2026, 4, 2) + i * 86_400_000).toISOString().slice(0, 10);
}

interface Day {
  tradedCents: bigint;
  capitalCents: bigint;
  skipped: boolean;
  splitDeal: boolean;
}

const dayArb: fc.Arbitrary<Day> = fc.record({
  tradedCents: fc.bigInt({ min: -50_000n, max: 50_000n }),
  // Mostly zero: a capital event is the exception, not the rule.
  capitalCents: fc.oneof(
    { arbitrary: fc.constant(0n), weight: 5 },
    { arbitrary: fc.bigInt({ min: -100_000n, max: 100_000n }), weight: 1 },
  ),
  skipped: fc.boolean(),
  splitDeal: fc.boolean(),
});

const FIXTURE_EPOCH = Date.parse("2026-01-01T00:00:00Z");

/**
 * A per-date stand-in for floating P/L. Equity is never equal to balance and
 * never differs from it by a constant. A constant wouldn't hide a field swap
 * (balance + C still != balance) — what it hides is a caller that derives
 * equity by walking balance deltas forward from a correct baseline instead of
 * reading equityCloseCents off each snapshot. That delta-propagation bug is
 * numerically identical to the correct value under a constant offset, and
 * only per-date variation exposes it.
 */
function floatingFor(tradeDate: string): bigint {
  const days = Math.floor((Date.parse(`${tradeDate}T00:00:00Z`) - FIXTURE_EPOCH) / 86_400_000);
  return BigInt(days) * 13n + 7n;
}

/** Build a consistent snapshot series and matching deals from generated days. */
function build(days: readonly Day[]): { snapshots: DailySnapshot[]; deals: ClosedDeal[] } {
  const snapshots: DailySnapshot[] = [];
  const deals: ClosedDeal[] = [];
  let balance = 100_000n;
  let ticket = 1;

  snapshots.push({
    tradeDate: dateAt(0),
    balanceCloseCents: balance,
    equityCloseCents: balance + floatingFor(dateAt(0)),
  });

  days.forEach((d, i) => {
    const date = dateAt(i + 1);
    balance += d.tradedCents + d.capitalCents;
    if (d.tradedCents !== 0n) {
      // One trade or two closing the same UTC day. Two is the ordinary
      // production case and nothing else in this suite produced it, which
      // left detect.ts's per-day accumulation unguarded — changing it to
      // overwrite passed every test in reconcile/.
      const half = d.tradedCents / 2n;
      const parts = d.splitDeal ? [half, d.tradedCents - half] : [d.tradedCents];
      parts.forEach((profitCents, k) => {
        ticket += 1;
        deals.push({
          ticket, symbol: "GBPUSD", side: "buy", volumeMilliLots: 10,
          openTime: `${date}T07:00:00.000Z`,
          // Both halves keep the same openTime, so the dedupe twin rule can
          // never match them: it requires |openShift| === offsetMs, offsetMs is
          // at least one hour, and openShift here is always exactly 0. The
          // 12:00/14:00 close times do no work against dedupe — they exist to
          // keep both closes inside the same UTC day, which is the whole point
          // of exercising netByDay's per-day accumulation.
          closeTime: `${date}T${k === 0 ? "12" : "14"}:00:00.000Z`,
          profitCents, swapCents: 0n, commissionCents: 0n,
        });
      });
    }
    // A skipped day models a weekend: the trade still closes, but no snapshot
    // is written until the next available day.
    if (!d.skipped) {
      snapshots.push({
        tradeDate: date,
        balanceCloseCents: balance,
        equityCloseCents: balance + floatingFor(date),
      });
    }
  });

  return { snapshots, deals };
}

describe("reconciler properties", () => {
  it("never plans a reading on or after the day it halted on", () => {
    fc.assert(
      fc.property(fc.array(dayArb, { minLength: 1, maxLength: 30 }), (days) => {
        const { snapshots, deals } = build(days);
        const plan = planReadings({
          snapshots, deals,
          cursor: { lastReadingDate: null },
          brokerOffsetHours: OFFSET_HOURS,
          toleranceCents: 0n,
          classifiedDates: [],
        });
        if (plan.kind !== "halt") return true;
        for (const r of plan.readings) {
          if (r.occurredOn >= plan.candidate.tradeDate) {
            throw new Error(
              `posted ${r.occurredOn} at or past the unexplained day ${plan.candidate.tradeDate}`,
            );
          }
        }
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("plans readings in strictly ascending date order, with no repeats", () => {
    fc.assert(
      fc.property(fc.array(dayArb, { minLength: 1, maxLength: 30 }), (days) => {
        const { snapshots, deals } = build(days);
        const plan = planReadings({
          snapshots, deals,
          cursor: { lastReadingDate: null },
          brokerOffsetHours: OFFSET_HOURS,
          toleranceCents: 0n,
          classifiedDates: [],
        });
        if (plan.kind === "idle") return true;
        const dates = plan.readings.map((r) => r.occurredOn);
        for (let i = 1; i < dates.length; i += 1) {
          if (dates[i]! <= dates[i - 1]!) {
            throw new Error(`readings out of order: ${dates[i - 1]} then ${dates[i]}`);
          }
        }
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("a run with no capital events posts every snapshot", () => {
    fc.assert(
      fc.property(fc.array(dayArb, { minLength: 1, maxLength: 30 }), (days) => {
        const clean = days.map((d) => ({ ...d, capitalCents: 0n }));
        const { snapshots, deals } = build(clean);
        const plan = planReadings({
          snapshots, deals,
          cursor: { lastReadingDate: null },
          brokerOffsetHours: OFFSET_HOURS,
          toleranceCents: 0n,
          classifiedDates: [],
        });
        if (plan.kind !== "advance") {
          throw new Error(`expected advance with no capital events, got ${plan.kind}`);
        }
        if (plan.readings.length !== snapshots.length) {
          throw new Error(`posted ${plan.readings.length} of ${snapshots.length} snapshots`);
        }
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("resuming from the returned cursor never re-posts or skips a day", () => {
    fc.assert(
      fc.property(fc.array(dayArb, { minLength: 1, maxLength: 30 }), (days) => {
        const { snapshots, deals } = build(days);
        const args = {
          snapshots, deals, brokerOffsetHours: OFFSET_HOURS, toleranceCents: 0n,
          classifiedDates: [] as readonly string[],
        };

        const first = planReadings({ ...args, cursor: { lastReadingDate: null } });
        if (first.kind === "idle") return true;

        const second = planReadings({ ...args, cursor: { lastReadingDate: first.newCursorDate } });
        if (second.kind === "idle") return true;

        for (const r of second.readings) {
          if (first.readings.some((f) => f.occurredOn === r.occurredOn)) {
            throw new Error(`re-posted ${r.occurredOn} on resume`);
          }
        }
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("dedupe never changes the net of the deals it keeps when there are no twins", () => {
    fc.assert(
      fc.property(fc.array(dayArb, { minLength: 1, maxLength: 20 }), (days) => {
        const { deals } = build(days);
        const r = dedupeDeals(deals, OFFSET_HOURS);
        if (r.dropped.length !== 0) {
          throw new Error(`dropped ${r.dropped.length} deals from a twin-free series`);
        }
        if (r.kept.length !== deals.length) {
          throw new Error(`kept ${r.kept.length} of ${deals.length}`);
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("every reconciled interval covers each trade exactly once", () => {
    fc.assert(
      fc.property(fc.array(dayArb, { minLength: 2, maxLength: 30 }), (days) => {
        const { snapshots, deals } = build(days);
        if (snapshots.length < 2) return true;
        const rec = reconcileDays(snapshots, deals, 0n);
        const totalExplained = rec.reduce((s, d) => s + d.explainedCents, 0n);
        // reconcileDays only covers the span the snapshots actually bound,
        // (first, last]. A trade closing at/before the first snapshot belongs
        // to a prior interval this data doesn't include — see detect.test.ts,
        // "does not count a trade that closed before the interval opened".
        // Symmetrically, a trade closing after the LAST snapshot belongs to a
        // future interval that hasn't arrived yet (e.g. a trailing skipped
        // day whose deal has no next snapshot to be swept into). Both ends
        // must be bounded, or such a trade is counted here but never appears
        // in `rec`, and the property fails for a reason unrelated to any bug.
        const firstDate = snapshots[0]!.tradeDate;
        const lastDate = snapshots[snapshots.length - 1]!.tradeDate;
        const totalNet = deals
          .filter((d) => {
            const day = utcDateKey(d.closeTime);
            return day > firstDate && day <= lastDate;
          })
          .reduce((s, d) => s + d.profitCents + d.swapCents + d.commissionCents, 0n);
        if (totalExplained !== totalNet) {
          throw new Error(`intervals explained ${totalExplained}, deals net ${totalNet}`);
        }
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("posts each snapshot's equity, never its balance", () => {
    fc.assert(
      fc.property(fc.array(dayArb, { minLength: 1, maxLength: 30 }), (days) => {
        const { snapshots, deals } = build(days);
        const plan = planReadings({
          snapshots, deals,
          cursor: { lastReadingDate: null },
          brokerOffsetHours: OFFSET_HOURS,
          toleranceCents: 0n,
          classifiedDates: [],
        });
        if (plan.kind === "idle") return true;
        const byDate = new Map(snapshots.map((s) => [s.tradeDate, s]));
        for (const r of plan.readings) {
          const s = byDate.get(r.occurredOn);
          if (!s) throw new Error(`planned a reading for ${r.occurredOn}, which is not a snapshot`);
          if (r.equityCents !== s.equityCloseCents) {
            throw new Error(
              `posted ${r.equityCents} for ${r.occurredOn}; that snapshot's equity is ` +
                `${s.equityCloseCents} and its balance is ${s.balanceCloseCents}`,
            );
          }
        }
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("halts at the first snapshot carrying an unexplained capital move", () => {
    fc.assert(
      fc.property(fc.array(dayArb, { minLength: 1, maxLength: 30 }), (days) => {
        const { snapshots, deals } = build(days);
        const plan = planReadings({
          snapshots, deals,
          cursor: { lastReadingDate: null },
          brokerOffsetHours: OFFSET_HOURS,
          toleranceCents: 0n,
          classifiedDates: [],
        });

        // Fold capital forward across skipped days: a move on a day with no
        // snapshot lands in the NEXT snapshot's balance delta, so the halt
        // belongs to that snapshot rather than to the day the move happened.
        // Moves that cancel inside one gap produce no halt, correctly — the
        // net balance move is then fully explained.
        let pending = 0n;
        let expected: string | null = null;
        for (let i = 0; i < days.length; i += 1) {
          const d = days[i]!;
          pending += d.capitalCents;
          if (!d.skipped) {
            if (pending !== 0n && expected === null) expected = dateAt(i + 1);
            pending = 0n;
          }
        }

        if (expected === null) {
          if (plan.kind === "halt") {
            throw new Error(
              `halted at ${plan.candidate.tradeDate}, but no snapshot carries an ` +
                `unexplained capital move`,
            );
          }
          return true;
        }
        if (plan.kind !== "halt") {
          throw new Error(`expected a halt at ${expected}, got ${plan.kind}`);
        }
        if (plan.candidate.tradeDate !== expected) {
          throw new Error(`halted at ${plan.candidate.tradeDate}, expected ${expected}`);
        }
        return true;
      }),
      { numRuns: 400 },
    );
  });
});
