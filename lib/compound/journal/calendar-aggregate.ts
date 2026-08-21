/**
 * Calendar aggregation, keyed on the UTC day.
 *
 * WHY UTC AND NOT THE BROKER DAY. account_snapshots_daily.trade_date is a
 * broker-server date (spec section 4), but reconcile/date-key.ts keys deals on
 * UTC and detect.ts already reconciles the two against each other. A calendar
 * on broker days would put a second definition of "Tuesday" in the product.
 * One definition that is slightly off the broker's beats two that disagree.
 * The consequence is real and is stated in the UI: for a broker at +3, a trade
 * closing at 23:30 UTC shows one day earlier here than in the terminal.
 *
 * WHY NO Date. Every function below does integer calendar arithmetic. A grid
 * built from local Date objects and formatted locally puts the wrong day
 * numbers against UTC-keyed totals on any machine that is not on UTC, and the
 * failure is silent — the grid still looks like a calendar.
 * daysFromEpoch is Howard Hinnant's days_from_civil. Its divisions are on
 * small integers where floating-point division is exact, and none of them
 * touches money.
 */
import type { Cents } from "@/lib/compound/engine/money";
import { utcDateKey } from "@/lib/compound/reconcile/date-key";
import { dealNetCents } from "@/lib/compound/reconcile/types";
import type { DedupedDeals } from "./history";

export interface CalendarDay {
  /** YYYY-MM-DD, UTC. */
  date: string;
  /** profit + swap + commission. What the day did to the account. */
  netCents: Cents;
  /** profit only. What the setups earned before costs. */
  grossCents: Cents;
  tradeCount: number;
  /** Counted on gross profit, per this plan's decision 5. */
  wins: number;
  losses: number;
  flat: number;
}

export function aggregateCalendar(deals: DedupedDeals): Map<string, CalendarDay> {
  const out = new Map<string, CalendarDay>();
  for (const d of deals) {
    const key = utcDateKey(d.closeTime);
    const cur = out.get(key) ?? {
      date: key,
      netCents: 0n,
      grossCents: 0n,
      tradeCount: 0,
      wins: 0,
      losses: 0,
      flat: 0,
    };
    cur.netCents += dealNetCents(d);
    cur.grossCents += d.profitCents;
    cur.tradeCount += 1;
    if (d.profitCents > 0n) cur.wins += 1;
    else if (d.profitCents < 0n) cur.losses += 1;
    else cur.flat += 1;
    out.set(key, cur);
  }
  return out;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month1: number): number {
  if (month1 < 1 || month1 > 12) throw new RangeError(`month out of range: ${month1}`);
  if (month1 === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month1 - 1]!;
}

/** Days from 1970-01-01. Negative before it. */
export function daysFromEpoch(year: number, month1: number, day: number): number {
  const y = month1 <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month1 + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** 0 = Sunday. 1970-01-01 was a Thursday. */
export function dayOfWeekUtc(dateKey: string): number {
  const m = DATE_RE.exec(dateKey);
  if (!m) throw new RangeError(`not a date key: ${JSON.stringify(dateKey)}`);
  const days = daysFromEpoch(Number.parseInt(m[1]!, 10), Number.parseInt(m[2]!, 10), Number.parseInt(m[3]!, 10));
  return (((days + 4) % 7) + 7) % 7;
}

export function parseMonth(month: string): { year: number; month1: number } {
  const m = MONTH_RE.exec(month);
  if (!m) throw new RangeError(`not a month: ${JSON.stringify(month)}`);
  const year = Number.parseInt(m[1]!, 10);
  const month1 = Number.parseInt(m[2]!, 10);
  if (month1 < 1 || month1 > 12) throw new RangeError(`month out of range: ${month}`);
  return { year, month1 };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function shiftMonth(month: string, delta: number): string {
  const { year, month1 } = parseMonth(month);
  const zero = year * 12 + (month1 - 1) + delta;
  return `${Math.floor(zero / 12)}-${pad2((((zero % 12) + 12) % 12) + 1)}`;
}

/**
 * Week rows of YYYY-MM-DD keys, Sunday first, with null for cells outside the
 * month. The row count is natural — four to six — rather than always six. A
 * printed statement does not pad two blank weeks onto February.
 */
export function monthGrid(month: string): (string | null)[][] {
  const { year, month1 } = parseMonth(month);
  const first = `${year}-${pad2(month1)}-01`;
  const leading = dayOfWeekUtc(first);
  const count = daysInMonth(year, month1);
  const cells: (string | null)[] = [];
  for (let i = 0; i < leading; i += 1) cells.push(null);
  for (let d = 1; d <= count; d += 1) cells.push(`${year}-${pad2(month1)}-${pad2(d)}`);
  while (cells.length % 7 !== 0) cells.push(null);
  const rows: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

export interface MonthSummary {
  month: string;
  netCents: Cents;
  grossCents: Cents;
  tradeCount: number;
  wins: number;
  losses: number;
  /** Days in the month with at least one trade. */
  tradingDays: number;
}

export function monthSummary(
  days: Map<string, CalendarDay>,
  month: string,
): MonthSummary {
  const prefix = `${month}-`;
  const out: MonthSummary = {
    month,
    netCents: 0n,
    grossCents: 0n,
    tradeCount: 0,
    wins: 0,
    losses: 0,
    tradingDays: 0,
  };
  for (const [key, day] of days) {
    if (!key.startsWith(prefix)) continue;
    out.netCents += day.netCents;
    out.grossCents += day.grossCents;
    out.tradeCount += day.tradeCount;
    out.wins += day.wins;
    out.losses += day.losses;
    out.tradingDays += 1;
  }
  return out;
}
