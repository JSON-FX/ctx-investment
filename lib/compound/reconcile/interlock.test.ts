import { planReadings } from "./interlock";
import type { ClosedDeal, DailySnapshot } from "./types";

const FIXTURE_EPOCH = Date.parse("2026-01-01T00:00:00Z");

/**
 * A per-date stand-in for floating P/L, so equity is never equal to balance
 * and never differs from it by a constant. Reconciliation reads balance;
 * a posted reading carries equity. If a fixture makes them identical,
 * nothing can detect code that reads the wrong one.
 */
function floatingFor(tradeDate: string): bigint {
  const days = Math.floor((Date.parse(`${tradeDate}T00:00:00Z`) - FIXTURE_EPOCH) / 86_400_000);
  return BigInt(days) * 13n + 7n;
}

function snap(
  tradeDate: string,
  balance: bigint,
  equity = balance + floatingFor(tradeDate),
): DailySnapshot {
  return { tradeDate, balanceCloseCents: balance, equityCloseCents: equity };
}

let nextTicket = 1;
beforeEach(() => { nextTicket = 1; });

function closed(closeTime: string, netCents: bigint): ClosedDeal {
  nextTicket += 1;
  return {
    ticket: nextTicket, symbol: "GBPUSD", side: "buy", volumeMilliLots: 10,
    openTime: "2026-05-01T07:00:00Z", closeTime,
    profitCents: netCents, swapCents: 0n, commissionCents: 0n,
  };
}

const BASE = {
  brokerOffsetHours: 3,
  toleranceCents: 0n,
};

describe("planReadings — nothing to do", () => {
  it("is idle with no snapshots", () => {
    expect(planReadings({ ...BASE, snapshots: [], deals: [], cursor: { lastReadingDate: null } }))
      .toEqual({ kind: "idle" });
  });

  it("is idle when the cursor is already at the last snapshot", () => {
    expect(planReadings({
      ...BASE,
      snapshots: [snap("2026-05-02", 100n), snap("2026-05-03", 100n)],
      deals: [],
      cursor: { lastReadingDate: "2026-05-03" },
    })).toEqual({ kind: "idle" });
  });
});

describe("planReadings — a clean run", () => {
  it("posts the first snapshot as a baseline when the cursor is empty", () => {
    const plan = planReadings({
      ...BASE,
      snapshots: [snap("2026-05-02", 30_941n, 30_941n)],
      deals: [],
      cursor: { lastReadingDate: null },
    });
    expect(plan.kind).toBe("advance");
    if (plan.kind !== "advance") throw new Error("expected advance");
    expect(plan.readings).toEqual([{ occurredOn: "2026-05-02", equityCents: 30_941n }]);
    expect(plan.newCursorDate).toBe("2026-05-02");
  });

  it("posts equity, not balance", () => {
    const plan = planReadings({
      ...BASE,
      snapshots: [snap("2026-05-02", 30_941n, 31_500n)],
      deals: [],
      cursor: { lastReadingDate: null },
    });
    if (plan.kind !== "advance") throw new Error("expected advance");
    expect(plan.readings[0]!.equityCents).toBe(31_500n);
  });

  it("advances through every explained day", () => {
    const plan = planReadings({
      ...BASE,
      snapshots: [
        snap("2026-05-02", 100_000n, 100_000n),
        snap("2026-05-03", 101_000n, 101_200n),
        snap("2026-05-04", 102_500n, 102_500n),
      ],
      deals: [closed("2026-05-03T10:00:00Z", 1_000n), closed("2026-05-04T10:00:00Z", 1_500n)],
      cursor: { lastReadingDate: null },
    });
    if (plan.kind !== "advance") throw new Error("expected advance");
    expect(plan.readings.map((r) => r.occurredOn)).toEqual(["2026-05-02", "2026-05-03", "2026-05-04"]);
    expect(plan.readings.map((r) => r.equityCents)).toEqual([100_000n, 101_200n, 102_500n]);
    expect(plan.newCursorDate).toBe("2026-05-04");
  });

  it("resumes from a cursor without re-posting earlier days", () => {
    const plan = planReadings({
      ...BASE,
      snapshots: [
        snap("2026-05-02", 100_000n), snap("2026-05-03", 101_000n), snap("2026-05-04", 102_500n),
      ],
      deals: [closed("2026-05-03T10:00:00Z", 1_000n), closed("2026-05-04T10:00:00Z", 1_500n)],
      cursor: { lastReadingDate: "2026-05-03" },
    });
    if (plan.kind !== "advance") throw new Error("expected advance");
    expect(plan.readings.map((r) => r.occurredOn)).toEqual(["2026-05-04"]);
  });
});

describe("planReadings — THE INTERLOCK", () => {
  const snapshots = [
    snap("2026-06-22", 100_000n, 100_000n),
    snap("2026-06-23", 101_000n, 101_000n),
    snap("2026-06-24", 102_000n, 102_000n),
    snap("2026-06-25", 133_000n, 133_000n), // +31,000 with no trade — a deposit
    snap("2026-06-26", 134_000n, 134_000n),
    snap("2026-06-27", 135_000n, 135_000n),
  ];
  const deals = [
    closed("2026-06-23T10:00:00Z", 1_000n),
    closed("2026-06-24T10:00:00Z", 1_000n),
    closed("2026-06-26T10:00:00Z", 1_000n),
    closed("2026-06-27T10:00:00Z", 1_000n),
  ];

  function run() {
    return planReadings({ ...BASE, snapshots, deals, cursor: { lastReadingDate: null } });
  }

  it("halts rather than advancing", () => {
    expect(run().kind).toBe("halt");
  });

  it("reports the candidate with both ends and the unexplained amount", () => {
    const plan = run();
    if (plan.kind !== "halt") throw new Error("expected halt");
    expect(plan.candidate.tradeDate).toBe("2026-06-25");
    expect(plan.candidate.previousDate).toBe("2026-06-24");
    expect(plan.candidate.balanceDeltaCents).toBe(31_000n);
    expect(plan.candidate.explainedCents).toBe(0n);
    expect(plan.candidate.unexplainedCents).toBe(31_000n);
  });

  it("posts every day up to the one before, and NOT ONE DAY MORE", () => {
    const plan = run();
    if (plan.kind !== "halt") throw new Error("expected halt");
    expect(plan.readings.map((r) => r.occurredOn)).toEqual([
      "2026-06-22", "2026-06-23", "2026-06-24",
    ]);
    expect(plan.newCursorDate).toBe("2026-06-24");
  });

  it("never posts a reading on or after the unexplained day", () => {
    const plan = run();
    if (plan.kind !== "halt") throw new Error("expected halt");
    for (const r of plan.readings) {
      expect(r.occurredOn < plan.candidate.tradeDate).toBe(true);
    }
  });

  it("stays halted on the same day when re-run after posting", () => {
    // The manager posted what was offered. Running again must halt on the same
    // candidate, not step past it.
    const plan = planReadings({
      ...BASE, snapshots, deals, cursor: { lastReadingDate: "2026-06-24" },
    });
    if (plan.kind !== "halt") throw new Error("expected halt");
    expect(plan.readings).toEqual([]);
    expect(plan.candidate.tradeDate).toBe("2026-06-25");
    expect(plan.newCursorDate).toBe("2026-06-24");
  });

  it("halts on the FIRST unexplained day when there are several", () => {
    const withTwo = [...snapshots, snap("2026-06-28", 200_000n, 200_000n)];
    const plan = planReadings({
      ...BASE, snapshots: withTwo, deals, cursor: { lastReadingDate: null },
    });
    if (plan.kind !== "halt") throw new Error("expected halt");
    expect(plan.candidate.tradeDate).toBe("2026-06-25");
  });
});

describe("planReadings — dedupe is applied", () => {
  it("does not invent a candidate from duplicate deals", () => {
    // One genuine trade and its broker-offset twin. Counting both would double
    // the explained figure and manufacture an unexplained shortfall.
    const genuine = closed("2026-05-03T08:31:00Z", 1_000n);
    const twin: ClosedDeal = {
      ...genuine,
      ticket: 9_000,
      openTime: new Date(Date.parse(genuine.openTime) + 3 * 3_600_000).toISOString(),
      closeTime: new Date(Date.parse(genuine.closeTime) + 3 * 3_600_000).toISOString(),
    };
    const plan = planReadings({
      ...BASE,
      snapshots: [snap("2026-05-02", 100_000n), snap("2026-05-03", 101_000n)],
      deals: [genuine, twin],
      cursor: { lastReadingDate: null },
    });
    expect(plan.kind).toBe("advance");
  });
});
