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
  // Every existing test in this file predates classification. Spelled out
  // explicitly, not omitted, so a reader never has to guess whether "no
  // classifiedDates" means "none" or "forgotten" — same reasoning as
  // droppedDeals on ReadingPlan. Tests about classifiedDates itself override
  // this below.
  classifiedDates: [] as readonly string[],
};

describe("planReadings — nothing to do", () => {
  it("is idle with no snapshots", () => {
    expect(planReadings({ ...BASE, snapshots: [], deals: [], cursor: { lastReadingDate: null } }))
      .toEqual({ kind: "idle", droppedDeals: [] });
  });

  it("is idle when the cursor is already at the last snapshot", () => {
    expect(planReadings({
      ...BASE,
      snapshots: [snap("2026-05-02", 100n), snap("2026-05-03", 100n)],
      deals: [],
      cursor: { lastReadingDate: "2026-05-03" },
    })).toEqual({ kind: "idle", droppedDeals: [] });
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

  it("sorts the window, so input order does not change the plan", () => {
    const plan = planReadings({
      ...BASE,
      snapshots: [
        snap("2026-05-04", 102_500n),
        snap("2026-05-02", 100_000n),
        snap("2026-05-03", 101_000n),
      ],
      deals: [closed("2026-05-03T10:00:00Z", 1_000n), closed("2026-05-04T10:00:00Z", 1_500n)],
      cursor: { lastReadingDate: null },
    });
    if (plan.kind !== "advance") throw new Error("expected advance");
    expect(plan.readings.map((r) => r.occurredOn)).toEqual([
      "2026-05-02", "2026-05-03", "2026-05-04",
    ]);
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
    closed("2026-06-25T10:00:00Z", 1_000n),
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
    expect(plan.candidate.explainedCents).toBe(1_000n);
    expect(plan.candidate.unexplainedCents).toBe(30_000n);
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

describe("planReadings — classifiedDates (the classified-cursor deadlock)", () => {
  // Resumes exactly where "planReadings — THE INTERLOCK" left off: that
  // block's own fixture halts with readings through 06-24 and
  // newCursorDate "2026-06-24" — the state a real refreshReadings leaves in
  // the database after the first refresh. This block starts from THAT
  // cursor, the same way planFor's second call would after a manager
  // classifies 06-25, and proves the run can now get past it.
  const snapshots = [
    snap("2026-06-22", 100_000n, 100_000n),
    snap("2026-06-23", 101_000n, 101_000n),
    snap("2026-06-24", 102_000n, 102_000n),
    snap("2026-06-25", 133_000n, 133_000n), // +31,000 with no trade — the deposit
    snap("2026-06-26", 134_000n, 134_000n),
    snap("2026-06-27", 135_000n, 135_000n),
  ];
  const deals = [
    closed("2026-06-23T10:00:00Z", 1_000n),
    closed("2026-06-24T10:00:00Z", 1_000n),
    closed("2026-06-25T10:00:00Z", 1_000n),
    closed("2026-06-26T10:00:00Z", 1_000n),
    closed("2026-06-27T10:00:00Z", 1_000n),
  ];
  const resumedFromHalt = { cursor: { lastReadingDate: "2026-06-24" } };

  it("without classifiedDates, resuming from the halt cursor halts on the SAME day forever — this is the deadlock", () => {
    // The reproduction, exactly: refresh already happened once (the cursor
    // is at 06-24, from THE INTERLOCK's own "stays halted on the same day
    // when re-run after posting" test). Running again with nothing new
    // classified must halt again, on the same candidate — proving the
    // deadlock is real before the rest of this block proves the fix.
    const plan = planReadings({ ...BASE, snapshots, deals, ...resumedFromHalt });
    expect(plan.kind).toBe("halt");
    if (plan.kind !== "halt") throw new Error("expected halt");
    expect(plan.candidate.tradeDate).toBe("2026-06-25");
    expect(plan.readings).toEqual([]);
  });

  it("posts the classified day as an ordinary reading and advances past it", () => {
    const plan = planReadings({
      ...BASE, snapshots, deals, ...resumedFromHalt,
      classifiedDates: ["2026-06-25"],
    });
    expect(plan.kind).toBe("advance");
    if (plan.kind !== "advance") throw new Error("expected advance");
    expect(plan.readings.map((r) => r.occurredOn)).toEqual([
      "2026-06-25", "2026-06-26", "2026-06-27",
    ]);
    expect(plan.newCursorDate).toBe("2026-06-27");
  });

  it("posts the classified day's own equity, not a placeholder or zero", () => {
    const plan = planReadings({
      ...BASE, snapshots, deals, ...resumedFromHalt,
      classifiedDates: ["2026-06-25"],
    });
    if (plan.kind !== "advance") throw new Error("expected advance");
    expect(plan.readings[0]).toEqual({ occurredOn: "2026-06-25", equityCents: 133_000n });
  });

  it("classifying a DIFFERENT date does not unfreeze this one", () => {
    const plan = planReadings({
      ...BASE, snapshots, deals, ...resumedFromHalt,
      classifiedDates: ["2026-06-26"],
    });
    expect(plan.kind).toBe("halt");
    if (plan.kind !== "halt") throw new Error("expected halt");
    expect(plan.candidate.tradeDate).toBe("2026-06-25");
  });

  describe("a second, later capital event nothing has classified yet", () => {
    // Adversarial variant 1 (report): a classified event followed by a
    // LATER unclassified one must halt at the later one, not sail past it.
    // 06-28 is a second, independent +40,000 move with no covering deal —
    // 135,000 -> 175,000 — layered on top of the already-classified 06-25.
    const withSecondEvent = [...snapshots, snap("2026-06-28", 175_000n, 175_000n)];

    it("halts at the later, unclassified day — classifying 06-25 does not also excuse 06-28", () => {
      const plan = planReadings({
        ...BASE, deals, ...resumedFromHalt,
        snapshots: withSecondEvent,
        classifiedDates: ["2026-06-25"],
      });
      expect(plan.kind).toBe("halt");
      if (plan.kind !== "halt") throw new Error("expected halt");
      expect(plan.candidate.tradeDate).toBe("2026-06-28");
      // 06-25 through 06-27 still post — classifying 06-25 does its job —
      // NOT ONE reading lands on or after the still-unclassified 06-28.
      expect(plan.readings.map((r) => r.occurredOn)).toEqual([
        "2026-06-25", "2026-06-26", "2026-06-27",
      ]);
      expect(plan.newCursorDate).toBe("2026-06-27");
    });

    it("two candidates, the earlier classified and the later still pending, does not skip the pending one", () => {
      // Restated from the run's-eye view rather than the fixture's: exactly
      // the shape a real database leaves behind after two halts and only
      // one classification — classifiedDates carries only the earlier date,
      // the later candidate is simply absent from it, same as a genuinely
      // pending row would be.
      const plan = planReadings({
        ...BASE, deals, ...resumedFromHalt,
        snapshots: withSecondEvent,
        classifiedDates: ["2026-06-25"], // 06-28 deliberately NOT included
      });
      if (plan.kind !== "halt") throw new Error("expected halt");
      for (const r of plan.readings) {
        expect(r.occurredOn < "2026-06-28").toBe(true);
      }
      expect(plan.candidate.tradeDate).toBe("2026-06-28");
    });

    it("classifying BOTH dates lets the run advance past both", () => {
      const plan = planReadings({
        ...BASE, deals, ...resumedFromHalt,
        snapshots: withSecondEvent,
        classifiedDates: ["2026-06-25", "2026-06-28"],
      });
      expect(plan.kind).toBe("advance");
      if (plan.kind !== "advance") throw new Error("expected advance");
      expect(plan.readings.map((r) => r.occurredOn)).toEqual([
        "2026-06-25", "2026-06-26", "2026-06-27", "2026-06-28",
      ]);
    });
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

describe("planReadings — dropped deals are surfaced, not thrown away (I2)", () => {
  // dedupe.ts's own module doc: dropping a genuine trade "destroys real P/L
  // silently." interlock.ts used to do exactly that to dedupeDeals' own
  // `dropped` list — `const { kept } = dedupeDeals(...)` — so a suppressed
  // deal was invisible to every caller of planReadings. There was no way for
  // a run to be audited: nothing downstream could learn a deal was dropped,
  // let alone which ticket it was judged a duplicate of.
  function genuineAndTwin(closeTime: string, netCents: bigint, twinTicket: number) {
    const genuine = closed(closeTime, netCents);
    const twin: ClosedDeal = {
      ...genuine,
      ticket: twinTicket,
      openTime: new Date(Date.parse(genuine.openTime) + 3 * 3_600_000).toISOString(),
      closeTime: new Date(Date.parse(genuine.closeTime) + 3 * 3_600_000).toISOString(),
    };
    return { genuine, twin };
  }

  it("names the dropped deal and what it duplicates, on an advancing run", () => {
    const { genuine, twin } = genuineAndTwin("2026-05-03T08:31:00Z", 1_000n, 9_000);
    const plan = planReadings({
      ...BASE,
      snapshots: [snap("2026-05-02", 100_000n), snap("2026-05-03", 101_000n)],
      deals: [genuine, twin],
      cursor: { lastReadingDate: null },
    });
    expect(plan.droppedDeals).toEqual([
      { deal: twin, duplicateOfTicket: genuine.ticket },
    ]);
  });

  it("is empty when nothing was dropped", () => {
    const plan = planReadings({
      ...BASE,
      snapshots: [snap("2026-05-02", 100_000n), snap("2026-05-03", 101_000n)],
      deals: [closed("2026-05-03T08:31:00Z", 1_000n)],
      cursor: { lastReadingDate: null },
    });
    expect(plan.droppedDeals).toEqual([]);
  });

  it("is still reported on a halted run", () => {
    // 06-23 and 06-24 are each fully explained by one deal; 06-25's +31,000
    // has no explaining deal at all (an unrecorded deposit), so the plan
    // halts there. The 06-23 deal also carries a broker-offset twin. Both the
    // halt AND the drop must be visible in the same result.
    const { genuine, twin } = genuineAndTwin("2026-06-23T10:00:00Z", 1_000n, 9_001);
    const plan = planReadings({
      ...BASE,
      snapshots: [
        snap("2026-06-22", 100_000n, 100_000n),
        snap("2026-06-23", 101_000n, 101_000n),
        snap("2026-06-24", 102_000n, 102_000n),
        snap("2026-06-25", 133_000n, 133_000n),
      ],
      deals: [genuine, twin, closed("2026-06-24T10:00:00Z", 1_000n)],
      cursor: { lastReadingDate: null },
    });
    expect(plan.kind).toBe("halt");
    if (plan.kind !== "halt") throw new Error("expected halt");
    expect(plan.candidate.tradeDate).toBe("2026-06-25");
    expect(plan.droppedDeals).toEqual([{ deal: twin, duplicateOfTicket: genuine.ticket }]);
  });

  it("is still reported when the run is idle because the cursor is already caught up", () => {
    // Nothing new to post, but dedupeDeals still ran over the full deals
    // array the caller handed in, so a dropped duplicate is still knowable —
    // and must still be reported, not silently lost because there was
    // nothing to advance.
    const { genuine, twin } = genuineAndTwin("2026-05-03T08:31:00Z", 1_000n, 9_002);
    const plan = planReadings({
      ...BASE,
      snapshots: [snap("2026-05-02", 100_000n), snap("2026-05-03", 101_000n)],
      deals: [genuine, twin],
      cursor: { lastReadingDate: "2026-05-03" },
    });
    expect(plan.kind).toBe("idle");
    expect(plan.droppedDeals).toEqual([{ deal: twin, duplicateOfTicket: genuine.ticket }]);
  });
});

describe("planReadings — the window must reach back to the cursor", () => {
  it("refuses a window that begins after the cursor", () => {
    expect(() =>
      planReadings({
        ...BASE,
        snapshots: [snap("2026-06-25", 133_000n), snap("2026-06-26", 134_000n)],
        deals: [],
        cursor: { lastReadingDate: "2026-06-24" },
      }),
    ).toThrow(/begin at 2026-06-25, after the cursor at 2026-06-24/);
  });

  it("accepts a window that starts exactly at the cursor", () => {
    const plan = planReadings({
      ...BASE,
      snapshots: [snap("2026-06-24", 102_000n), snap("2026-06-25", 103_000n)],
      deals: [closed("2026-06-25T10:00:00Z", 1_000n)],
      cursor: { lastReadingDate: "2026-06-24" },
    });
    expect(plan.kind).toBe("advance");
  });

  it("does not refuse when the cursor is empty", () => {
    expect(() =>
      planReadings({
        ...BASE,
        snapshots: [snap("2026-06-25", 133_000n)],
        deals: [],
        cursor: { lastReadingDate: null },
      }),
    ).not.toThrow();
  });
});

describe("planReadings — a duplicate tradeDate must not swallow the halt (C1)", () => {
  // The exact C1 reproduction. Two rows both dated 2026-06-25: a genuine
  // 102,000 balance and a 133,000 balance after an unrecorded 31,000 deposit.
  // 06-26 follows with 134,000 (a fully explained +1,000 trading day).
  //
  // Before the guard: `ordered[0]` (the 102,000 row) becomes the baseline and
  // sets cursorDate = "2026-06-25". reconcileDays correctly flags the interval
  // ending 06-25 as unexplained by 31,000 — but planReadings' cursor skip
  // (`day.tradeDate <= cursorDate`) discards that exact row, because it is
  // also dated 06-25. The halt that reaches the caller is on 06-26 with a
  // candidate of only 1,000n. The 31,000 deposit never surfaces, and a run
  // that classifies the 1,000 candidate and resumes steps NAV 102,000 →
  // 134,000 while only 1,000 is ever accounted for. That is the loss
  // spec §5.3 exists to prevent.
  const duplicatedSnapshots = [
    { tradeDate: "2026-06-25", balanceCloseCents: 102_000n, equityCloseCents: 102_000n },
    { tradeDate: "2026-06-25", balanceCloseCents: 133_000n, equityCloseCents: 133_000n },
    { tradeDate: "2026-06-26", balanceCloseCents: 134_000n, equityCloseCents: 134_000n },
  ];

  it("throws instead of halting on 06-26 with the wrong (1,000n) candidate", () => {
    expect(() =>
      planReadings({
        ...BASE,
        snapshots: duplicatedSnapshots,
        deals: [],
        cursor: { lastReadingDate: null },
      }),
    ).toThrow(/before calling planReadings/);
  });

  it("names the offending date in the error", () => {
    expect(() =>
      planReadings({
        ...BASE,
        snapshots: duplicatedSnapshots,
        deals: [],
        cursor: { lastReadingDate: null },
      }),
    ).toThrow(/2026-06-25/);
  });

  it("also refuses when the duplicate sits at the incoming cursor date — the ordinary resume shape", () => {
    // The window precondition requires a snapshot at or before the cursor, so
    // the "duplicate equals cursorDate" shape is not an edge case — it is how
    // every ordinary resume window is built.
    expect(() =>
      planReadings({
        ...BASE,
        snapshots: duplicatedSnapshots,
        deals: [],
        cursor: { lastReadingDate: "2026-06-25" },
      }),
    ).toThrow(/2026-06-25/);
  });
});
