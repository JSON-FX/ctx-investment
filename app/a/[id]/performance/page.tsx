/**
 * Two curves, capital events marked, streaks and a histogram. Spec R4.
 *
 * Renders only its own <section>/<Panel> content (agreement A1) — no
 * masthead, no account resolution beyond requireAccount, no navigation, and
 * NO <InterlockBanner> here: app/a/[id]/layout.tsx (plan 4) already renders
 * it on every route under this account, unconditionally, because a frozen
 * reconciler means every figure on every page is as of the frozen date, not
 * just this one. The plan's own Task 12 draft imported InterlockBanner and
 * rendered it again on this page; verified against the merged layout instead
 * of trusted, and doing so would show the banner twice. loadInterlock is
 * still called here — it is cheap (React cache() dedupes it against the
 * layout's own call within one request) and this page needs its OWN read of
 * it for a reason the layout does not have: marksCompleteThrough, the cursor
 * equity-series.ts uses to flag a point's capital marks as possibly
 * incomplete.
 *
 * capitalMarks takes the ledger AND the holder seeds — present/derive.ts
 * folds the ledger to work out what actually left the pool on a payout
 * (fee-retained-as-units vs cash), and fold() needs the seeds to do that.
 * The plan's draft called capitalMarks(ledger) with one argument; that does
 * not typecheck against the real (merged) signature, caught by running
 * `tsc`, not by reading the plan.
 */
import { requireAccount } from "@/lib/compound/load/account";
import { loadDailySnapshots, loadTradeHistory } from "@/lib/compound/load/trades";
import { loadLedger, loadSeeds } from "@/lib/compound/load/ledger";
import { loadInterlock } from "@/lib/compound/load/interlock";
import { capitalMarks } from "@/lib/compound/present/derive";
import { buildAccountEquitySeries } from "@/lib/compound/journal/equity-series";
import { binNetPnl } from "@/lib/compound/journal/histogram";
import { computeStreaks } from "@/lib/compound/journal/streaks";
import { computeTradeEquity } from "@/lib/compound/journal/trade-equity";
import { computeTradeStats } from "@/lib/compound/journal/trade-stats";
import { GuardNotice } from "@/lib/compound/ui/journal/guard-notice";
import { Eyebrow, Panel } from "@/lib/compound/ui/primitives";
import { EquityChart } from "@/lib/compound/ui/performance/equity-chart";
import { HistogramChart } from "@/lib/compound/ui/performance/histogram-chart";
import { PnlCurve } from "@/lib/compound/ui/performance/pnl-curve";
import { StatsPanel } from "@/lib/compound/ui/performance/stats-panel";

export const dynamic = "force-dynamic";

const BIN_COUNT = 12;

export default async function PerformancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = await requireAccount(id);

  const [history, snapshots, ledger, seeds, interlock] = await Promise.all([
    loadTradeHistory(account.mt5Account, account.brokerOffsetHours),
    loadDailySnapshots(account.mt5Account),
    loadLedger(account.id),
    loadSeeds(account.id),
    loadInterlock(account.id),
  ]);

  const series = buildAccountEquitySeries({
    snapshots,
    marks: capitalMarks(ledger, seeds),
    marksCompleteThrough: interlock.frozenAt,
  });
  const equity = computeTradeEquity(history.deals);
  const stats = computeTradeStats(history.deals);
  const streaks = computeStreaks(history.deals);
  const distribution = binNetPnl(equity.curve.map((p) => p.netCents), BIN_COUNT);

  return (
    <>
      <GuardNotice history={history} />

      <Panel>
        <Eyebrow>Account equity and capital</Eyebrow>
        <EquityChart series={series} />
      </Panel>

      <Panel>
        <Eyebrow>Trading profit and loss — capital excluded</Eyebrow>
        <PnlCurve result={equity} />
      </Panel>

      <Panel>
        <Eyebrow>Distribution of trade results</Eyebrow>
        <HistogramChart result={distribution} />
      </Panel>

      <StatsPanel stats={stats} streaks={streaks} />
    </>
  );
}
