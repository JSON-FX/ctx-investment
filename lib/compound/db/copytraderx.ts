/**
 * The CopyTraderX tables. Compound reads these and never writes to them.
 *
 * Types come from reconcile/types.ts, which is where the reconciler's
 * vocabulary is defined. Redefining DailySnapshot or ClosedDeal here would
 * create a second shape that can drift from the one detect.ts and dedupe.ts
 * are built against.
 *
 * Every day boundary is computed as (timestamp at time zone 'UTC')::date,
 * matching reconcile/date-key.ts's utcDateKey. Comparing a timestamptz
 * against a bare date would resolve the date in the session's timezone, which
 * moves trades across midnight on a machine that is not on UTC.
 *
 * Known gap: the deals table carries no open/closed discriminator, and every
 * row in the local fixture is a closed trade. If the real table ever holds
 * rows for open positions, the filter belongs in getClosedDeals — probably as
 * `close_time is not null` — and no fixture here would have caught its
 * absence.
 */
import type { Cents } from "@/lib/compound/engine/money";
import type { ClosedDeal, DailySnapshot } from "@/lib/compound/reconcile/types";
import type { Queryable } from "./types";
import {
  centsExpr,
  dateKeyExpr,
  milliLotsExpr,
  toCents,
  toDateKey,
  toId,
  toSide,
  utcIsoExpr,
} from "./sql";

export interface DateRange {
  /** YYYY-MM-DD, inclusive. */
  from?: string;
  /** YYYY-MM-DD, inclusive. */
  to?: string;
}

export interface LiveSnapshot {
  mt5Account: number;
  balanceCents: Cents;
  equityCents: Cents;
  floatingPnlCents: Cents;
  currency: string;
  server: string | null;
  /** ISO 8601, UTC. */
  pushedAt: string;
}

export async function getDailySnapshots(
  c: Queryable,
  mt5Account: number,
  range: DateRange = {},
): Promise<DailySnapshot[]> {
  const { rows } = await c.query<{
    trade_date: string;
    balance_close_cents: string;
    equity_close_cents: string;
  }>(
    `select ${dateKeyExpr("trade_date")} as trade_date,
            ${centsExpr("balance_close")} as balance_close_cents,
            ${centsExpr("equity_close")} as equity_close_cents
       from public.account_snapshots_daily
      where mt5_account = $1
        and ($2::date is null or trade_date >= $2::date)
        and ($3::date is null or trade_date <= $3::date)
      order by trade_date asc`,
    [mt5Account, range.from ?? null, range.to ?? null],
  );

  return rows.map((r) => ({
    tradeDate: toDateKey(r.trade_date, "account_snapshots_daily.trade_date"),
    balanceCloseCents: toCents(r.balance_close_cents, "account_snapshots_daily.balance_close"),
    equityCloseCents: toCents(r.equity_close_cents, "account_snapshots_daily.equity_close"),
  }));
}

export async function getClosedDeals(
  c: Queryable,
  mt5Account: number,
  range: DateRange = {},
): Promise<ClosedDeal[]> {
  const { rows } = await c.query<{
    ticket: string;
    symbol: string;
    side: string;
    volume_milli_lots: number;
    open_time: string;
    close_time: string;
    profit_cents: string;
    swap_cents: string;
    commission_cents: string;
  }>(
    `select ticket,
            symbol,
            side,
            ${milliLotsExpr("volume")} as volume_milli_lots,
            ${utcIsoExpr("open_time")} as open_time,
            ${utcIsoExpr("close_time")} as close_time,
            ${centsExpr("profit")} as profit_cents,
            ${centsExpr("swap")} as swap_cents,
            ${centsExpr("commission")} as commission_cents
       from public.deals
      where mt5_account = $1
        and ($2::date is null or (close_time at time zone 'UTC')::date >= $2::date)
        and ($3::date is null or (close_time at time zone 'UTC')::date <= $3::date)
      order by ticket asc`,
    [mt5Account, range.from ?? null, range.to ?? null],
  );

  return rows.map((r) => ({
    ticket: toId(r.ticket, "deals.ticket"),
    symbol: r.symbol,
    side: toSide(r.side, "deals.side"),
    volumeMilliLots: r.volume_milli_lots,
    openTime: r.open_time,
    closeTime: r.close_time,
    profitCents: toCents(r.profit_cents, "deals.profit"),
    swapCents: toCents(r.swap_cents, "deals.swap"),
    commissionCents: toCents(r.commission_cents, "deals.commission"),
  }));
}

export async function getLiveSnapshot(
  c: Queryable,
  mt5Account: number,
): Promise<LiveSnapshot | null> {
  const { rows } = await c.query<{
    mt5_account: string;
    balance_cents: string;
    equity_cents: string;
    floating_pnl_cents: string;
    currency: string;
    server: string | null;
    pushed_at: string;
  }>(
    `select mt5_account,
            ${centsExpr("balance")} as balance_cents,
            ${centsExpr("equity")} as equity_cents,
            ${centsExpr("floating_pnl")} as floating_pnl_cents,
            currency,
            server,
            ${utcIsoExpr("pushed_at")} as pushed_at
       from public.account_snapshots_current
      where mt5_account = $1`,
    [mt5Account],
  );

  const r = rows[0];
  if (!r) return null;
  return {
    mt5Account: toId(r.mt5_account, "account_snapshots_current.mt5_account"),
    balanceCents: toCents(r.balance_cents, "account_snapshots_current.balance"),
    equityCents: toCents(r.equity_cents, "account_snapshots_current.equity"),
    floatingPnlCents: toCents(r.floating_pnl_cents, "account_snapshots_current.floating_pnl"),
    currency: r.currency,
    server: r.server,
    pushedAt: r.pushed_at,
  };
}

/**
 * The public.users id that owns an MT5 account, via its licence.
 *
 * Returns null when no licence exists, rather than throwing: an MT5 account
 * with no licence is a real state, not a bug.
 */
export async function getAccountOwnerUserId(
  c: Queryable,
  mt5Account: number,
): Promise<string | null> {
  const { rows } = await c.query<{ user_id: string }>(
    `select user_id from public.licenses
      where mt5_account = $1 and status = 'active'
      order by id asc
      limit 1`,
    [mt5Account],
  );
  return rows[0]?.user_id ?? null;
}
