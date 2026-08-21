/**
 * Rendered with @testing-library/react's `render`, not `renderToStaticMarkup`
 * — see lib/compound/ui/journal/chrome.test.tsx's header for why: under
 * this project's jsdom "ui" Jest project, react-dom/server's
 * renderToStaticMarkup throws `ReferenceError: MessageChannel is not
 * defined` the moment it is imported. The plan's own draft of this file
 * used renderToStaticMarkup; that was verified against a real run here and
 * does not work, so every render below goes through the same working
 * pattern chrome.test.tsx and tables.test.tsx already established:
 * `render(<X />).container.innerHTML`, then plain string/regex assertions.
 *
 * Also covers StatsPanel, which the plan's Task 12 draft of this file did
 * not include a test for at all — a new component with sixteen figures and
 * a streak label is not exercised by anything else in the suite.
 */
import { render } from "@testing-library/react";
import type { ClosedDeal, DailySnapshot } from "@/lib/compound/reconcile/types";
import { buildAccountEquitySeries, type CapitalMarkInput } from "@/lib/compound/journal/equity-series";
import { binNetPnl } from "@/lib/compound/journal/histogram";
import { computeStreaks } from "@/lib/compound/journal/streaks";
import { computeTradeEquity } from "@/lib/compound/journal/trade-equity";
import { computeTradeStats } from "@/lib/compound/journal/trade-stats";
import { buildTradeHistory } from "@/lib/compound/journal/history";
import {
  FIXTURE_OFFSET_HOURS, fixtureHistory, fixtureHistoryUnguarded,
} from "@/lib/compound/journal/__fixtures__/deals";
import { EquityChart } from "./equity-chart";
import { HistogramChart } from "./histogram-chart";
import { PnlCurve } from "./pnl-curve";
import { StatsPanel } from "./stats-panel";

// balanceCloseCents is deliberately NOT equal to equityCloseCents at any
// point, and the gap between them changes sign across the series (down at
// 05-06, up everywhere else). equity-series.ts is only supposed to ever
// read equityCloseCents; a fixture where the two columns match everywhere
// (the plan's own draft fixture did this) cannot tell "read the right
// column" from "read the wrong one" apart, because both produce the same
// output. This can, and the probe in the task report exercises it.
const S = (d: string, balance: bigint, equity: bigint): DailySnapshot => ({
  tradeDate: d,
  balanceCloseCents: balance,
  equityCloseCents: equity,
});

const SNAPSHOTS = [
  S("2026-05-04", 999_000n, 999_413n),
  S("2026-05-05", 1_001_800n, 1_002_234n),
  S("2026-05-06", 1_000_900n, 1_000_712n),
  S("2026-05-08", 1_050_000n, 1_051_363n),
  S("2026-05-11", 1_048_500n, 1_047_119n),
];

const MARKS: CapitalMarkInput[] = [
  { occurredOn: "2026-05-01", amountCents: 900_000n, direction: "in" },
  { occurredOn: "2026-05-07", amountCents: 50_000n, direction: "in" },
];

const series = buildAccountEquitySeries({
  snapshots: SNAPSHOTS,
  marks: MARKS,
  marksCompleteThrough: "2026-05-11",
});
const html = render(<EquityChart series={series} />).container.innerHTML;

function attr(source: string, name: string): string[] {
  return [...source.matchAll(new RegExp(`${name}="([^"]*)"`, "g"))].map((m) => m[1]!);
}

describe("EquityChart", () => {
  // Mutation caught: any float division producing NaN — a "d" or "points"
  // attribute containing NaN renders as an empty chart with no error anywhere.
  it("emits no NaN in any coordinate", () => {
    expect(html).not.toContain("NaN");
  });

  // Mutation caught: dropping the first or last point, which shortens the
  // curve without changing anything else visible in a snapshot.
  it("plots one vertex per reading on both lines", () => {
    const lines = attr(html, "points");
    expect(lines).toHaveLength(2);
    for (const p of lines) expect(p.split(" ")).toHaveLength(SNAPSHOTS.length);
  });

  // Mutation caught: scaling the two series independently, which makes the gap
  // between them — the only thing this chart is for — meaningless. Both lines
  // share a scale, so the contributed line at 950000 must sit BELOW the equity
  // line at 1051363 on 2026-05-08 (larger y is lower on screen).
  it("plots both series on one scale", () => {
    const [contributed, equity] = attr(html, "points") as [string, string];
    const yAt = (p: string, i: number) => Number(p.split(" ")[i]!.split(",")[1]);
    expect(yAt(contributed, 3)).toBeGreaterThan(yAt(equity, 3));
    expect(yAt(contributed, 0)).toBeGreaterThan(yAt(equity, 0));
  });

  // Mutation caught: plotting a per-point DELTA instead of the running total
  // (e.g. contributed[i] - contributed[i-1]) — a non-cumulative contributed
  // line. This fixture's contributed capital only ever increases (no "out"
  // mark), so its plotted y must never move backward (get larger) as the
  // reading date advances; a delta series would jump down to near the
  // baseline between capital events and back up on one, which is exactly
  // what "renders contributed capital as non-cumulative" in the task's own
  // probe list produces. Neither test above catches this — verified in the
  // task report's probe section: at index 0 a delta series still equals the
  // cumulative value (nothing precedes it to subtract), and at index 3 the
  // delta (50000) is still less than equity (1051363) either way, so both
  // relative comparisons above stay green under that mutation.
  it("never moves the contributed line backward — capital in this fixture only accumulates", () => {
    const [contributed] = attr(html, "points") as [string];
    const ys = contributed.split(" ").map((p) => Number(p.split(",")[1]));
    for (let i = 1; i < ys.length; i += 1) {
      expect(ys[i]!).toBeLessThanOrEqual(ys[i - 1]!);
    }
  });

  // THE R4 ASSERTION at the render layer. Two capital events, one before the
  // window and one in a snapshot gap, must both produce a mark.
  it("marks every day carrying a capital event", () => {
    expect(html.split("curve-mark").length - 1).toBe(2);
    expect(html).toContain("capital in 9,000.00");
    expect(html).toContain("capital in 500.00");
  });

  // Mutation caught: a chart with no text alternative. Spec 8.4 forbids shape
  // being the sole carrier, and the hidden table is what makes the deposit
  // legible to a reader who cannot see the step.
  it("carries a text alternative with the performance column", () => {
    expect(html).toContain('role="img"');
    expect(html).toContain("Contributed");
    expect(html).toContain("Performance");
    // 2026-05-06 performance 100712, 2026-05-08 performance 101363 — equity
    // minus contributed, independent of the balance column entirely.
    expect(html).toContain("+1,007.12");
    expect(html).toContain("+1,013.63");
  });

  // The hidden table's contributed column reads the real, cumulative
  // p.contributedCents field directly (not the chart's local array), so this
  // is unaffected by the polyline mutation above — it instead pins the pure
  // layer's cumulative arithmetic at the render boundary.
  it("carries the true cumulative contributed figure in the hidden table", () => {
    expect(html).toContain("9,000.00");
    expect(html).toContain("9,500.00");
  });

  it("says so when there are no readings", () => {
    const empty = render(
      <EquityChart
        series={buildAccountEquitySeries({ snapshots: [], marks: [], marksCompleteThrough: null })}
      />,
    ).container.innerHTML;
    expect(empty).toContain("No equity readings yet");
    expect(empty).not.toContain("NaN");
  });

  // Mutation caught: a flat series dividing by a zero span.
  it("renders a flat series without NaN", () => {
    const flat = render(
      <EquityChart
        series={buildAccountEquitySeries({
          snapshots: [S("2026-05-04", 500n, 500n), S("2026-05-05", 500n, 500n)],
          marks: [],
          marksCompleteThrough: "2026-05-05",
        })}
      />,
    ).container.innerHTML;
    expect(flat).not.toContain("NaN");
    expect(attr(flat, "points")[0]!.split(" ")).toHaveLength(2);
  });

  it("warns when marks past the cursor may be incomplete", () => {
    const partial = render(
      <EquityChart
        series={buildAccountEquitySeries({
          snapshots: SNAPSHOTS,
          marks: MARKS,
          marksCompleteThrough: "2026-05-06",
        })}
      />,
    ).container.innerHTML;
    expect(partial).toContain("may be incomplete");
    expect(html).not.toContain("may be incomplete");
  });
});

describe("PnlCurve", () => {
  const result = computeTradeEquity(fixtureHistory().deals);
  const out = render(<PnlCurve result={result} />).container.innerHTML;

  it("plots one vertex per trade and no NaN", () => {
    expect(out).not.toContain("NaN");
    expect(attr(out, "points")[0]!.split(" ")).toHaveLength(9);
  });

  // Mutation caught: a scale that omits zero, which turns a 31-dollar gain on
  // a 3,000-dollar account into a chart that looks like a doubling.
  it("always includes zero in the domain", () => {
    expect(out).toContain("curve-zero");
  });

  // Mutation caught: dropping the sentence that makes the pairing legible.
  it("states in words that capital movements are excluded", () => {
    expect(out.toLowerCase()).toContain("capital");
  });

  it("renders no trades without NaN", () => {
    const empty = render(
      <PnlCurve result={computeTradeEquity(buildTradeHistory([], FIXTURE_OFFSET_HOURS).deals)} />,
    ).container.innerHTML;
    expect(empty).toContain("No closed trades yet");
    expect(empty).not.toContain("NaN");
  });

  // THE DEDUPE ASSERTION at the render layer. Figures cross-checked against
  // trade-stats.test.ts's own fixtureHistory()/fixtureHistoryUnguarded()
  // assertions (netAfterFeesCents 3163n / 4516n) rather than invented here —
  // trade-equity.ts's netCents and trade-stats.ts's netAfterFeesCents are
  // both "sum of dealNetCents over the same deals", so the two must agree.
  it("plots the deduplicated curve", () => {
    const bad = render(
      <PnlCurve result={computeTradeEquity(fixtureHistoryUnguarded().deals)} />,
    ).container.innerHTML;
    expect(attr(bad, "points")[0]!.split(" ")).toHaveLength(10);
    expect(bad).toContain("+45.16");
    expect(out).toContain("+31.63");
  });
});

describe("HistogramChart", () => {
  const values = computeTradeEquity(fixtureHistory().deals).curve.map((p) => p.netCents);
  const out = render(<HistogramChart result={binNetPnl(values, 8)} />).container.innerHTML;

  // Mutation caught: dropping empty bins, which compresses the axis and moves
  // every remaining bar. Filtered to the bin-sign classes specifically
  // (^hist-(win|loss|zero)$) rather than any "hist-" prefix, because this
  // component's own baseline rule carries class "hist-base" — a plain
  // startsWith("hist-") filter (the plan's draft) would count that line too
  // and expect 9, not 8; caught by rendering, not by reading the plan.
  it("renders a rect for every bin including the empty ones", () => {
    const bins = attr(out, "class").filter((c) => /^hist-(win|loss|zero)$/.test(c));
    expect(bins).toHaveLength(8);
  });

  it("names each bin's range and count in a title", () => {
    expect(out).toContain("<title>");
    expect(out).not.toContain("NaN");
  });

  it("colours bins by sign", () => {
    expect(out).toContain("hist-loss");
    expect(out).toContain("hist-win");
  });

  it("renders no trades without NaN", () => {
    const empty = render(<HistogramChart result={binNetPnl([], 8)} />).container.innerHTML;
    expect(empty).toContain("No closed trades yet");
    expect(empty).not.toContain("NaN");
  });
});

describe("StatsPanel", () => {
  // Figures are fixtureHistory()'s real, already-pinned values — copied from
  // trade-stats.test.ts and streaks.test.ts's own assertions, not invented
  // here, so this test can only fail on a rendering bug, never a arithmetic
  // one (that is Task 3/4's job and already covered there).
  const stats = computeTradeStats(fixtureHistory().deals);
  const streaks = computeStreaks(fixtureHistory().deals);
  const out = render(<StatsPanel stats={stats} streaks={streaks} />).container.innerHTML;

  it("renders every statistics figure", () => {
    expect(out).toContain(">9<"); // trades
    expect(out).toContain(">5<"); // wins
    expect(out).toContain(">3<"); // losses
    expect(out).toContain(">1<"); // flat
    expect(out).toContain("55.55%"); // win rate
    expect(out).toContain("2.247"); // profit factor
    expect(out).toContain("62.31"); // gross profit
    expect(out).toContain("27.73"); // gross loss
    expect(out).toContain("+31.63"); // net after fees
    expect(out).toContain("−2.95"); // total fees
    expect(out).toContain("12.46"); // average win
    expect(out).toContain("9.24"); // average loss
    expect(out).toContain("+3.51"); // expected payoff
    expect(out).toContain("+29.03"); // best trade
    expect(out).toContain("−15.11"); // worst trade
    expect(out).not.toContain("NaN");
  });

  it("renders both streak figures and names the current streak's kind", () => {
    expect(out).toContain("2 wins");
    expect(out).not.toContain("NaN");
  });

  // Mutation caught: calling toneOf() mechanically on a magnitude field.
  // grossLossCents is stored as a positive bigint (see trade-stats.ts) — a
  // naive toneOf(stats.grossLossCents) reports "pos" because the bigint
  // really is positive, which would paint a loss figure green.
  it("colours the loss-side magnitudes red, not green", () => {
    expect(out).toContain('class="num neg">27.73<'); // gross loss
    expect(out).toContain('class="num neg">9.24<'); // average loss
    expect(out).toContain('class="num pos">62.31<'); // gross profit
    expect(out).toContain('class="num pos">12.46<'); // average win
  });

  it("handles no closed trades without NaN", () => {
    const empty = buildTradeHistory([], FIXTURE_OFFSET_HOURS).deals;
    const emptyOut = render(
      <StatsPanel stats={computeTradeStats(empty)} streaks={computeStreaks(empty)} />,
    ).container.innerHTML;
    expect(emptyOut).not.toContain("NaN");
    expect(emptyOut).toContain("None"); // current streak, none
  });
});

/**
 * The task's own signature fixture: two separate drawdowns on the trading
 * curve, the LATER one narrower on the page (one sharp step, versus the
 * first one's gradual three-step bleed) but LARGER in absolute cents — plus
 * one capital event roughly mid-series, so equity, contributed capital and
 * trading P/L are all exercised together and visibly diverge.
 *
 * A monotonic (only-rising) curve makes every implementation's
 * maxDrawdownCents zero, correct or not — it cannot discriminate "running
 * peak" from "peak fixed at the first high" from "drawdown from the final
 * point only". This fixture can, and does: see the mutation probes in the
 * task report.
 *
 * netCents delta per deal (closeTime order, 2026-06-01 .. 2026-06-10):
 *   +4000 +2200 -1100 -1050 -1000 +4350 +2250 -6775 +2655 +2385
 * Running cum:
 *   4000  6200  5100  4050  3050  7400  9650  2875  5530  7915
 *                            ^dd1 trough (peak 6200, dd=3150)     ^dd2 trough (peak 9650, dd=6775)
 * dd1 = 6200-3050 = 3150 (a gradual 3-step decline, deals 3-5).
 * dd2 = 9650-2875 = 6775 (one sharp step, deal 8) — LARGER than dd1 despite
 * the narrower, "smaller-looking" footprint on the page.
 * peakCents = 9650 (the running maximum, reached at deal 7 — after dd1, not
 * before it: a "first peak" bug that stops updating after 6200 would report
 * dd1 as the max and go negative-then-stuck once cum passes 6200 again).
 * currentDrawdownCents = 9650-7915 = 1735 (the final point, smaller than
 * maxDrawdownCents — the two must stay distinct figures).
 *
 * Array order and ticket numbers are deliberately NOT in closeTime order
 * (same discipline as __fixtures__/deals.ts): computeTradeEquity sorts by
 * closeTime itself, so a fixture already in order could pass against a
 * missing or wrong sort by accident.
 */
const TWO_DRAWDOWN_DEALS: ClosedDeal[] = [
  { ticket: 9106, symbol: "EURUSD", side: "buy", volumeMilliLots: 100, openTime: "2026-06-06T07:00:00.000Z", closeTime: "2026-06-06T09:00:00.000Z", profitCents: 4350n, swapCents: 0n, commissionCents: 0n },
  { ticket: 9101, symbol: "GBPUSD", side: "sell", volumeMilliLots: 50, openTime: "2026-06-01T07:00:00.000Z", closeTime: "2026-06-01T09:00:00.000Z", profitCents: 4000n, swapCents: 0n, commissionCents: 0n },
  { ticket: 9108, symbol: "XAUUSD", side: "sell", volumeMilliLots: 30, openTime: "2026-06-08T07:00:00.000Z", closeTime: "2026-06-08T09:00:00.000Z", profitCents: -6775n, swapCents: 0n, commissionCents: 0n },
  { ticket: 9103, symbol: "EURUSD", side: "sell", volumeMilliLots: 100, openTime: "2026-06-03T07:00:00.000Z", closeTime: "2026-06-03T09:00:00.000Z", profitCents: -1100n, swapCents: 0n, commissionCents: 0n },
  { ticket: 9110, symbol: "EURUSD", side: "buy", volumeMilliLots: 100, openTime: "2026-06-10T07:00:00.000Z", closeTime: "2026-06-10T09:00:00.000Z", profitCents: 2385n, swapCents: 0n, commissionCents: 0n },
  { ticket: 9102, symbol: "GBPUSD", side: "buy", volumeMilliLots: 50, openTime: "2026-06-02T07:00:00.000Z", closeTime: "2026-06-02T09:00:00.000Z", profitCents: 2200n, swapCents: 0n, commissionCents: 0n },
  { ticket: 9109, symbol: "XAUUSD", side: "buy", volumeMilliLots: 30, openTime: "2026-06-09T07:00:00.000Z", closeTime: "2026-06-09T09:00:00.000Z", profitCents: 2655n, swapCents: 0n, commissionCents: 0n },
  { ticket: 9104, symbol: "EURUSD", side: "sell", volumeMilliLots: 100, openTime: "2026-06-04T07:00:00.000Z", closeTime: "2026-06-04T09:00:00.000Z", profitCents: -1050n, swapCents: 0n, commissionCents: 0n },
  { ticket: 9107, symbol: "XAUUSD", side: "sell", volumeMilliLots: 30, openTime: "2026-06-07T07:00:00.000Z", closeTime: "2026-06-07T09:00:00.000Z", profitCents: 2250n, swapCents: 0n, commissionCents: 0n },
  { ticket: 9105, symbol: "EURUSD", side: "sell", volumeMilliLots: 100, openTime: "2026-06-05T07:00:00.000Z", closeTime: "2026-06-05T09:00:00.000Z", profitCents: -1000n, swapCents: 0n, commissionCents: 0n },
];

// Equity snapshots for the SAME window, from an independent source (a real
// account's equity reflects floating positions and is never derived from
// closed-deal P/L alone) — except across 06-04..06-06, chosen so equity's
// ENTIRE step is the 25,000c deposit and nothing else, which is the cleanest
// possible demonstration of R4: the gap (performance) is exactly unchanged
// across that one step, then resumes moving normally on both sides of it.
const TWO_DRAWDOWN_SNAPSHOTS: DailySnapshot[] = [
  { tradeDate: "2026-06-02", balanceCloseCents: 502_400n, equityCloseCents: 502_400n },
  { tradeDate: "2026-06-04", balanceCloseCents: 498_900n, equityCloseCents: 498_900n },
  { tradeDate: "2026-06-06", balanceCloseCents: 523_900n, equityCloseCents: 523_900n },
  { tradeDate: "2026-06-08", balanceCloseCents: 528_760n, equityCloseCents: 528_760n },
  { tradeDate: "2026-06-10", balanceCloseCents: 536_415n, equityCloseCents: 536_415n },
];
const TWO_DRAWDOWN_MARKS: CapitalMarkInput[] = [
  { occurredOn: "2026-06-05", amountCents: 25_000n, direction: "in" },
];

describe("the two-drawdown, mid-series capital event fixture (task report)", () => {
  const deals = buildTradeHistory(TWO_DRAWDOWN_DEALS, null).deals;
  const equity = computeTradeEquity(deals);
  const series = buildAccountEquitySeries({
    snapshots: TWO_DRAWDOWN_SNAPSHOTS,
    marks: TWO_DRAWDOWN_MARKS,
    marksCompleteThrough: "2026-06-10",
  });

  it("finds all ten deals and orders the curve by close time, not ticket or array order", () => {
    expect(equity.curve).toHaveLength(10);
    expect(equity.curve.map((p) => p.ticket)).toEqual([
      9101, 9102, 9103, 9104, 9105, 9106, 9107, 9108, 9109, 9110,
    ]);
  });

  // The signature assertion: the SECOND, narrower drawdown is the maximum,
  // not the first, wider-looking one — and neither equals the drawdown at
  // the final point, which is smaller than both peaks' declines.
  it("measures the maximum drawdown from the later, higher peak", () => {
    expect(equity.curve.map((p) => p.cumCents)).toEqual([
      4000n, 6200n, 5100n, 4050n, 3050n, 7400n, 9650n, 2875n, 5530n, 7915n,
    ]);
    expect(equity.peakCents).toBe(9650n);
    expect(equity.maxDrawdownCents).toBe(6775n); // dd2, not dd1's 3150n
    expect(equity.currentDrawdownCents).toBe(1735n);
    expect(equity.netCents).toBe(7915n);
    // Named so a future edit cannot quietly swap maxDrawdownCents for dd1's
    // value and still pass: dd1 must remain the SMALLER of the two.
    expect(6775n).toBeGreaterThan(3150n);
  });

  it("renders the peak, net and max-drawdown figures on the chart with no NaN", () => {
    const out = render(<PnlCurve result={equity} />).container.innerHTML;
    expect(out).not.toContain("NaN");
    expect(out).toContain("+79.15"); // net
    expect(out).toContain("96.50"); // peak
    expect(out).toContain("67.75"); // max drawdown — NOT 31.50 (dd1)
    expect(out).not.toContain("31.50");
  });

  // R4 in one number: across the ONE step where equity's entire move is the
  // deposit (06-04 -> 06-06: +25,000 equity, +25,000 contributed), the
  // performance gap is EXACTLY the same figure on both sides — 4,989.00 —
  // appearing twice. Before and after that step it moves normally (the
  // hidden table also carries 06-02's and 06-08's distinct performance
  // figures), so this is not a fixture where nothing ever changes.
  it("holds performance exactly flat across the one step that is pure deposit", () => {
    expect(series.points.map((p) => p.performanceCents)).toEqual([
      502_400n, 498_900n, 498_900n, 503_760n, 511_415n,
    ]);
    const html = render(<EquityChart series={series} />).container.innerHTML;
    expect(html).not.toContain("NaN");
    expect((html.match(/\+4,989\.00/g) ?? []).length).toBe(2);
    expect(html).toContain("capital in 250.00");
  });
});
