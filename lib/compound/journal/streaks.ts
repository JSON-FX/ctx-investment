/**
 * Win and loss runs over closed trades.
 *
 * A zero-profit trade is skipped rather than counted as a loss: it neither
 * continues nor breaks a run. Upstream does the same; it is restated here
 * because the obvious `profit > 0 ? "win" : "loss"` gets it wrong and the
 * error only shows on accounts that have a scratch trade.
 *
 * The sort tie-breaks on ticket. Two deals closing in the same second have no
 * inherent order, and a comparator that returns 0 for them leaves the run
 * length dependent on the order the database happened to return.
 */
import type { DedupedDeals } from "./history";

export type StreakKind = "win" | "loss" | "none";

export interface StreakStats {
  maxWinStreak: number;
  maxLossStreak: number;
  currentStreak: number;
  currentStreakKind: StreakKind;
  /** Trades excluded because gross profit was exactly zero. */
  skippedFlat: number;
}

export function computeStreaks(deals: DedupedDeals): StreakStats {
  const decisive = deals
    .filter((d) => d.profitCents !== 0n)
    .slice()
    .sort((a, b) => {
      if (a.closeTime < b.closeTime) return -1;
      if (a.closeTime > b.closeTime) return 1;
      return a.ticket - b.ticket;
    });

  const skippedFlat = deals.length - decisive.length;

  if (decisive.length === 0) {
    return {
      maxWinStreak: 0,
      maxLossStreak: 0,
      currentStreak: 0,
      currentStreakKind: "none",
      skippedFlat,
    };
  }

  let maxWin = 0;
  let maxLoss = 0;
  let run = 0;
  let kind: StreakKind = "none";

  for (const d of decisive) {
    const thisKind: StreakKind = d.profitCents > 0n ? "win" : "loss";
    if (thisKind === kind) run += 1;
    else {
      run = 1;
      kind = thisKind;
    }
    if (kind === "win" && run > maxWin) maxWin = run;
    if (kind === "loss" && run > maxLoss) maxLoss = run;
  }

  return {
    maxWinStreak: maxWin,
    maxLossStreak: maxLoss,
    currentStreak: run,
    currentStreakKind: kind,
    skippedFlat,
  };
}
