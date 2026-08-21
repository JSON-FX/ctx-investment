import { reconcileDays } from "./detect";
import type { ClosedDeal, DailySnapshot } from "./types";

const FIXTURE_EPOCH = Date.parse("2026-01-01T00:00:00Z");

/**
 * A per-date stand-in for floating P/L, so equity is never equal to balance
 * and never differs from it by a CONSTANT.
 *
 * reconcileDays only ever reads these as `cur.X - prev.X`, and a constant
 * offset cancels on both sides — which is exactly why an earlier fixed
 * `balance + 137n` divergence left the reconcile-on-equity probe passing.
 * Monotone in the date, so distinct dates never share a value and no
 * consecutive pair cancels.
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
    ticket: nextTicket,
    symbol: "GBPUSD",
    side: "buy",
    volumeMilliLots: 10,
    openTime: "2026-05-01T07:00:00Z",
    closeTime,
    profitCents: netCents,
    swapCents: 0n,
    commissionCents: 0n,
  };
}

describe("reconcileDays — the happy path", () => {
  it("returns nothing for a single snapshot, which has no predecessor", () => {
    expect(reconcileDays([snap("2026-05-02", 30_941n)], [], 0n)).toEqual([]);
  });

  it("returns nothing for no snapshots", () => {
    expect(reconcileDays([], [], 0n)).toEqual([]);
  });

  it("explains a day whose balance move matches its closed trades", () => {
    const days = reconcileDays(
      [snap("2026-05-02", 30_941n), snap("2026-05-03", 32_486n)],
      [closed("2026-05-03T14:00:00Z", 1_545n)],
      0n,
    );
    expect(days).toHaveLength(1);
    expect(days[0]!.balanceDeltaCents).toBe(1_545n);
    expect(days[0]!.explainedCents).toBe(1_545n);
    expect(days[0]!.unexplainedCents).toBe(0n);
    expect(days[0]!.isExplained).toBe(true);
  });

  it("names both ends of the interval it reconciled", () => {
    const days = reconcileDays([snap("2026-05-02", 100n), snap("2026-05-05", 100n)], [], 0n);
    expect(days[0]!.previousDate).toBe("2026-05-02");
    expect(days[0]!.tradeDate).toBe("2026-05-05");
  });

  it("sorts snapshots before reconciling, and does not mutate the input", () => {
    const input = [snap("2026-05-03", 32_486n), snap("2026-05-02", 30_941n)];
    const copy = [...input];
    const days = reconcileDays(input, [closed("2026-05-03T14:00:00Z", 1_545n)], 0n);
    expect(days[0]!.tradeDate).toBe("2026-05-03");
    expect(input).toEqual(copy);
  });
});

describe("reconcileDays — gaps in the snapshot series", () => {
  it("attributes trades closing inside a gap to the next available day", () => {
    // Friday to Monday. A trade closes on the Saturday. Counting only Monday's
    // closes would leave the Saturday P/L unexplained and manufacture a
    // capital event that never happened.
    const days = reconcileDays(
      [snap("2026-05-01", 100_000n), snap("2026-05-04", 103_000n)],
      [closed("2026-05-02T10:00:00Z", 1_000n), closed("2026-05-04T10:00:00Z", 2_000n)],
      0n,
    );
    expect(days[0]!.explainedCents).toBe(3_000n);
    expect(days[0]!.isExplained).toBe(true);
  });

  it("does not count a trade that closed before the interval opened", () => {
    const days = reconcileDays(
      [snap("2026-05-03", 100_000n), snap("2026-05-04", 100_000n)],
      [closed("2026-05-03T10:00:00Z", 5_000n)],
      0n,
    );
    // The 05-03 close belongs to the interval ending 05-03, not the one
    // ending 05-04. The 05-04 interval saw no trades and no balance move.
    expect(days[0]!.explainedCents).toBe(0n);
    expect(days[0]!.isExplained).toBe(true);
  });
});

describe("reconcileDays — unexplained moves", () => {
  it("flags a balance move no trade explains", () => {
    const days = reconcileDays(
      [snap("2026-06-24", 35_647n), snap("2026-06-25", 66_647n)],
      [],
      0n,
    );
    expect(days[0]!.balanceDeltaCents).toBe(31_000n);
    expect(days[0]!.explainedCents).toBe(0n);
    expect(days[0]!.unexplainedCents).toBe(31_000n);
    expect(days[0]!.isExplained).toBe(false);
  });

  it("flags a withdrawal — unexplained moves are signed", () => {
    const days = reconcileDays(
      [snap("2026-06-24", 66_647n), snap("2026-06-25", 35_647n)],
      [],
      0n,
    );
    expect(days[0]!.unexplainedCents).toBe(-31_000n);
    expect(days[0]!.isExplained).toBe(false);
  });

  it("flags a deposit that partly hides behind a losing day", () => {
    // Balance rose 29,000 while trading lost 2,000: a 31,000 deposit.
    const days = reconcileDays(
      [snap("2026-06-24", 35_647n), snap("2026-06-25", 64_647n)],
      [closed("2026-06-25T09:00:00Z", -2_000n)],
      0n,
    );
    expect(days[0]!.unexplainedCents).toBe(31_000n);
    expect(days[0]!.isExplained).toBe(false);
  });
});

describe("reconcileDays — the tolerance boundary", () => {
  it("treats a gap exactly at tolerance as explained", () => {
    const days = reconcileDays(
      [snap("2026-05-02", 100_000n), snap("2026-05-03", 100_005n)],
      [],
      5n,
    );
    expect(days[0]!.unexplainedCents).toBe(5n);
    expect(days[0]!.isExplained).toBe(true);
  });

  it("treats one cent past tolerance as unexplained", () => {
    const days = reconcileDays(
      [snap("2026-05-02", 100_000n), snap("2026-05-03", 100_006n)],
      [],
      5n,
    );
    expect(days[0]!.unexplainedCents).toBe(6n);
    expect(days[0]!.isExplained).toBe(false);
  });

  it("applies tolerance to negative gaps too", () => {
    const days = reconcileDays(
      [snap("2026-05-02", 100_000n), snap("2026-05-03", 99_995n)],
      [],
      5n,
    );
    expect(days[0]!.isExplained).toBe(true);
    const past = reconcileDays(
      [snap("2026-05-02", 100_000n), snap("2026-05-03", 99_994n)],
      [],
      5n,
    );
    expect(past[0]!.isExplained).toBe(false);
  });

  it("rejects a negative tolerance", () => {
    expect(() => reconcileDays([], [], -1n)).toThrow(/tolerance/);
  });
});

describe("reconcileDays — duplicate trade dates (C1)", () => {
  it("rejects two snapshot rows that both claim the same tradeDate", () => {
    // The exact C1 reproduction: two rows both dated 2026-06-25. Without a
    // guard this silently produces a zero-width (previousDate === tradeDate)
    // interval with explainedCents always 0n — nonsense, not a diagnosis.
    expect(() =>
      reconcileDays(
        [snap("2026-06-25", 102_000n), snap("2026-06-25", 133_000n), snap("2026-06-26", 134_000n)],
        [],
        0n,
      ),
    ).toThrow(/before calling reconcileDays/);
  });

  it("names the offending date in the error", () => {
    expect(() =>
      reconcileDays(
        [snap("2026-06-25", 102_000n), snap("2026-06-25", 133_000n), snap("2026-06-26", 134_000n)],
        [],
        0n,
      ),
    ).toThrow(/2026-06-25/);
  });

  it("still works when the duplicate is not the first pair", () => {
    expect(() =>
      reconcileDays(
        [snap("2026-06-24", 100_000n), snap("2026-06-25", 102_000n), snap("2026-06-25", 133_000n)],
        [],
        0n,
      ),
    ).toThrow(/2026-06-25/);
  });
});
