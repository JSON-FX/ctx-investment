/**
 * The month calendar with day drill-down. `?month=YYYY-MM` moves the grid,
 * `?day=YYYY-MM-DD` opens the panel beneath it — both are links, both are
 * shareable, neither needs a modal (plan 5's decisions 2 and 3).
 *
 * Renders only its own <section> content (agreement A1) — no masthead, no
 * account resolution beyond requireAccount, no navigation. Plan 4's
 * app/a/[id]/layout.tsx supplies all of that.
 *
 * The default month is derived from the data (latestMonth), never from the
 * clock — a `new Date()` read here would make the render non-deterministic
 * and open a quiet account on an empty grid.
 */
import { requireAccount } from "@/lib/compound/load/account";
import { loadTradeHistory } from "@/lib/compound/load/trades";
import {
  aggregateCalendar,
  dayIntensity,
  latestMonth,
  monthSummary,
  parseMonth,
} from "@/lib/compound/journal/calendar-aggregate";
import { flattenParams } from "@/lib/compound/journal/table-state";
import { utcDateKey } from "@/lib/compound/reconcile/date-key";
import { GuardNotice } from "@/lib/compound/ui/journal/guard-notice";
import { DayPanel } from "@/lib/compound/ui/calendar/day-panel";
import { MonthGrid } from "@/lib/compound/ui/calendar/month-grid";
import { calendarHref } from "@/lib/compound/ui/routes";

export const dynamic = "force-dynamic";

const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const account = await requireAccount(id);
  const sp = flattenParams(await searchParams);
  const basePath = calendarHref(account.id);

  const history = await loadTradeHistory(account.mt5Account, account.brokerOffsetHours);
  const days = aggregateCalendar(history.deals);
  const latest = latestMonth(days, account.inceptionDate.slice(0, 7));

  // Untrusted input: validate the shape, then validate that parseMonth
  // accepts it, before it reaches monthGrid. A regex pass alone is not
  // enough — "2026-13" matches \d{4}-\d{2} and is still not a month.
  const requestedMonth = sp.month;
  let month = latest;
  if (requestedMonth !== undefined && MONTH_RE.test(requestedMonth)) {
    try {
      parseMonth(requestedMonth);
      month = requestedMonth;
    } catch {
      month = latest;
    }
  }

  const requestedDay = sp.day;
  const day =
    requestedDay !== undefined && DAY_RE.test(requestedDay) && requestedDay.startsWith(`${month}-`)
      ? requestedDay
      : null;

  const dayDeals = day === null ? [] : history.deals.filter((d) => utcDateKey(d.closeTime) === day);

  return (
    <>
      <GuardNotice history={history} />
      <MonthGrid
        month={month}
        days={days}
        summary={monthSummary(days, month)}
        tierOf={dayIntensity(days, month)}
        selectedDay={day}
        latest={latest}
        basePath={basePath}
        params={sp}
      />
      {day === null ? null : (
        <DayPanel
          day={day}
          cell={days.get(day) ?? null}
          deals={dayDeals}
          basePath={basePath}
          params={sp}
        />
      )}
    </>
  );
}
