/**
 * Closed-trade statistics and win/loss streaks, side by side.
 *
 * Rendered as two <table>s rather than a <dl>: every other figure display in
 * this product — trades, positions, orders, the ledger, the holder table —
 * is a <table>, and reusing that primitive costs no new CSS at all (the
 * bare `table`/`th`/`td` rules in globals.css already give a label column
 * and a value column, tabular figures, and a caption). Task 12 touches only
 * the `.curve` and `.hist` families; a third family for this panel would be
 * unnecessary given the existing element carries the layout for free.
 *
 * grossProfitCents, grossLossCents, avgWinCents and avgLossCents are stored
 * as non-negative MAGNITUDES (see trade-stats.ts) — grossLossCents is a
 * positive bigint that represents a loss. Calling toneOf() on it would
 * report "pos" (its sign bit really is positive) and paint a loss green.
 * Those four rows are therefore plain money() with a hand-assigned tone;
 * toneOf() is reserved for the fields that are genuinely signed
 * (net after fees, total fees, expected payoff, best, worst trade).
 */
import type { StreakStats } from "@/lib/compound/journal/streaks";
import type { TradeStats } from "@/lib/compound/journal/trade-stats";
import {
  money, pctFromBps, ratioFromMilli, signedMoney, toneOf,
} from "@/lib/compound/present/figures";

interface Row {
  key: string;
  label: string;
  value: string;
  tone?: "pos" | "neg" | "";
}

function statRows(stats: TradeStats): Row[] {
  return [
    { key: "trades", label: "Trades", value: String(stats.totalTrades) },
    { key: "wins", label: "Wins", value: String(stats.wins) },
    { key: "losses", label: "Losses", value: String(stats.losses) },
    { key: "flat", label: "Flat", value: String(stats.flat) },
    { key: "winRate", label: "Win rate", value: pctFromBps(stats.winRateBps) },
    { key: "profitFactor", label: "Profit factor", value: ratioFromMilli(stats.profitFactorMilli) },
    { key: "grossProfit", label: "Gross profit", value: money(stats.grossProfitCents), tone: "pos" },
    { key: "grossLoss", label: "Gross loss", value: money(stats.grossLossCents), tone: "neg" },
    {
      key: "netAfterFees", label: "Net after fees",
      value: signedMoney(stats.netAfterFeesCents), tone: toneOf(stats.netAfterFeesCents),
    },
    {
      key: "totalFees", label: "Total fees",
      value: signedMoney(stats.totalFeesCents), tone: toneOf(stats.totalFeesCents),
    },
    { key: "avgWin", label: "Average win", value: money(stats.avgWinCents), tone: "pos" },
    { key: "avgLoss", label: "Average loss", value: money(stats.avgLossCents), tone: "neg" },
    {
      key: "expectedPayoff", label: "Expected payoff",
      value: signedMoney(stats.expectedPayoffCents), tone: toneOf(stats.expectedPayoffCents),
    },
    {
      key: "best", label: "Best trade",
      value: signedMoney(stats.bestTradeCents), tone: toneOf(stats.bestTradeCents),
    },
    {
      key: "worst", label: "Worst trade",
      value: signedMoney(stats.worstTradeCents), tone: toneOf(stats.worstTradeCents),
    },
  ];
}

function streakLabel(streaks: StreakStats): string {
  if (streaks.currentStreakKind === "none") return "None";
  const noun = streaks.currentStreakKind === "win" ? "win" : "loss";
  return `${streaks.currentStreak} ${noun}${streaks.currentStreak === 1 ? "" : "s"}`;
}

function streakRows(streaks: StreakStats): Row[] {
  return [
    { key: "maxWinStreak", label: "Maximum win streak", value: String(streaks.maxWinStreak) },
    { key: "maxLossStreak", label: "Maximum loss streak", value: String(streaks.maxLossStreak) },
    {
      key: "currentStreak", label: "Current streak", value: streakLabel(streaks),
      tone: streaks.currentStreakKind === "win" ? "pos" : streaks.currentStreakKind === "loss" ? "neg" : "",
    },
  ];
}

function StatTable({ caption, rows }: { caption: string; rows: Row[] }) {
  return (
    <table>
      <caption>{caption}</caption>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row">{r.label}</th>
            <td className={`num${r.tone ? ` ${r.tone}` : ""}`}>{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function StatsPanel({ stats, streaks }: { stats: TradeStats; streaks: StreakStats }) {
  return (
    <section className="panel">
      <span className="eyebrow">Statistics and streaks</span>
      <div className="scroller">
        <StatTable caption="Statistics" rows={statRows(stats)} />
        <StatTable caption="Streaks" rows={streakRows(streaks)} />
      </div>
    </section>
  );
}
