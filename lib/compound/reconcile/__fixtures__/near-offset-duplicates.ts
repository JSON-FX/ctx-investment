/**
 * Regression fixture for the near-offset duplicate defect fixed alongside
 * OFFSET_TOLERANCE_MS in ../dedupe.ts.
 *
 * SHAPE IS REAL, IDENTIFIERS ARE NOT. These three pairs mirror three
 * confirmed duplicates found by running the reconciler against restored
 * production data, on a real MT5 account with a 3-hour broker offset. Per
 * the design spec §10 this is a public repository, so the account number
 * and every ticket below have been replaced with small fictional values —
 * nothing here resembles the real account or its actual (10-digit) ticket
 * numbers. What is preserved exactly, because the shape is the finding and
 * the identifiers are not:
 *
 *   - symbol, side and volume for each pair
 *   - profitCents and swapCents for each pair (commissionCents was 0 on all
 *     three in production; not separately called out in the original
 *     measurement, so it is included here only for type completeness)
 *   - the shift: EVERY pair moves open and close by exactly +10,799,000ms —
 *     one second short of the nominal 3-hour offset (10,800,000ms) — and
 *     that shift is identical at both ends of every pair, which is what
 *     makes this a genuine timezone-reinterpretation shape and not two
 *     unrelated trades
 *   - the calendar dates the trades closed on (not identifying on their
 *     own, and kept so this fixture's numbers can be checked against the
 *     day-level arithmetic in the fix's commit message / report)
 *
 * Before the fix, dedupe.ts compared Math.abs(openShift) === offsetMs
 * exactly. 10,799,000 !== 10,800,000, so the offset check failed on all
 * three pairs and every duplicate was KEPT. Each kept duplicate
 * double-counts its own dealNetCents (profitCents + swapCents +
 * commissionCents) on its close day:
 *
 *   pair                    dealNetCents   day if duplicate kept (wrong)
 *   GBPUSD sell 0.05 lot         -1,583¢   2026-05-06: explained -3,166¢
 *   GBPUSD buy  0.06 lot         -1,332¢   2026-05-07: explained -2,664¢
 *   GBPUSD buy  0.03 lot         -1,391¢   2026-05-12: explained -2,782¢
 *
 * Doubling a real loss makes the day look like it lost MORE than its
 * balance actually moved — reconcileDays' unexplained figure for each day
 * comes out positive by exactly the duplicated deal's own net, which reads
 * as an uncredited capital inflow that never happened. With
 * OFFSET_TOLERANCE_MS in place all three duplicates are dropped, each
 * day's explained figure matches its balance move exactly, and no
 * candidate is raised. See dedupe.test.ts, describe block "the near-offset
 * production shape", for the assertions.
 */
import type { ClosedDeal } from "../types";

/** The broker offset on the (fictional) account these pairs are drawn from. */
export const NEAR_OFFSET_BROKER_HOURS = 3;

/** The measured production shift: 1,000ms short of the nominal 3h offset. */
export const NEAR_OFFSET_SHIFT_MS = 10_799_000;

export interface DuplicatePair {
  /** Human-readable label for test failure output. */
  label: string;
  /** The lower-ticket row dedupeDeals must keep. */
  genuine: ClosedDeal;
  /** The higher-ticket, shifted-by-10,799,000ms row it must drop. */
  duplicate: ClosedDeal;
}

/** The duplicate row: `genuine` with both ends moved +10,799,000ms under `ticket`. */
function shiftedTwin(genuine: ClosedDeal, ticket: number): ClosedDeal {
  const move = (iso: string) => new Date(Date.parse(iso) + NEAR_OFFSET_SHIFT_MS).toISOString();
  return { ...genuine, ticket, openTime: move(genuine.openTime), closeTime: move(genuine.closeTime) };
}

function pair(label: string, genuine: ClosedDeal, duplicateTicket: number): DuplicatePair {
  return { label, genuine, duplicate: shiftedTwin(genuine, duplicateTicket) };
}

export const NEAR_OFFSET_DUPLICATE_PAIRS: readonly DuplicatePair[] = [
  pair(
    "GBPUSD sell 0.05, closes 2026-05-06",
    {
      ticket: 8101,
      symbol: "GBPUSD",
      side: "sell",
      volumeMilliLots: 50,
      openTime: "2026-05-06T09:14:00.000Z",
      closeTime: "2026-05-06T11:47:00.000Z",
      profitCents: -1_545n,
      swapCents: -38n,
      commissionCents: 0n,
    },
    8601,
  ),
  pair(
    "GBPUSD buy 0.06, closes 2026-05-07",
    {
      ticket: 8102,
      symbol: "GBPUSD",
      side: "buy",
      volumeMilliLots: 60,
      openTime: "2026-05-07T06:02:00.000Z",
      closeTime: "2026-05-07T08:55:00.000Z",
      profitCents: -1_332n,
      swapCents: 0n,
      commissionCents: 0n,
    },
    8602,
  ),
  pair(
    "GBPUSD buy 0.03, closes 2026-05-12",
    {
      ticket: 8103,
      symbol: "GBPUSD",
      side: "buy",
      volumeMilliLots: 30,
      openTime: "2026-05-12T13:21:00.000Z",
      closeTime: "2026-05-12T15:58:00.000Z",
      profitCents: -1_371n,
      swapCents: -20n,
      commissionCents: 0n,
    },
    8603,
  ),
];

/** All six rows (three genuine + three near-offset duplicates), ticket order. */
export const NEAR_OFFSET_RAW_DEALS: readonly ClosedDeal[] = NEAR_OFFSET_DUPLICATE_PAIRS.flatMap(
  (p) => [p.genuine, p.duplicate],
);
