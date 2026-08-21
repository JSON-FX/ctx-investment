/**
 * Compound's own tables, read into the shapes the engine and the reconciler
 * already speak.
 *
 * LedgerEntry, HolderSeed and ReconcileCursor are imported, never redefined.
 * fold() is written against those types; a parallel definition here would be a
 * second truth that drifts the first time either side changes.
 *
 * getLedgerEntries orders by seq. Section 6.2: seq is monotonic per account
 * and assigned server-side, and it — not occurred_on — defines replay order.
 * Two events on the same date still have a definite order, which is what makes
 * the same-day deposit-then-reading case deterministic.
 */
import type { Cents } from "@/lib/compound/engine/money";
import type { HolderSeed, LedgerEntry, LedgerEntryType } from "@/lib/compound/engine/replay";
import type { ReconcileCursor } from "@/lib/compound/reconcile/interlock";
import type { Queryable } from "./types";
import { dateKeyExpr, toCents, toDateKey, toId, utcIsoExpr } from "./sql";

export interface CompoundAccount {
  id: number;
  mt5Account: number;
  label: string;
  broker: string | null;
  currency: string;
  defaultSplitBps: number;
  /** YYYY-MM-DD. */
  inceptionDate: string;
  /** public.users id. */
  managerUserId: string;
}

export interface CapitalEventCandidateRow {
  id: number;
  accountId: number;
  /** YYYY-MM-DD. */
  tradeDate: string;
  balanceDeltaCents: Cents;
  explainedCents: Cents;
  unexplainedCents: Cents;
  status: "pending" | "classified" | "ignored";
  /** ISO 8601, UTC. */
  detectedAt: string;
}

const ACCOUNT_COLUMNS = `
  id,
  mt5_account,
  label,
  broker,
  currency,
  default_split_bps,
  ${dateKeyExpr("inception_date")} as inception_date,
  manager_user_id
`;

interface AccountRow {
  id: string;
  mt5_account: string;
  label: string;
  broker: string | null;
  currency: string;
  default_split_bps: number;
  inception_date: string;
  manager_user_id: string;
}

function toAccount(r: AccountRow): CompoundAccount {
  return {
    id: toId(r.id, "compound_account.id"),
    mt5Account: toId(r.mt5_account, "compound_account.mt5_account"),
    label: r.label,
    broker: r.broker,
    currency: r.currency,
    defaultSplitBps: r.default_split_bps,
    inceptionDate: toDateKey(r.inception_date, "compound_account.inception_date"),
    managerUserId: r.manager_user_id,
  };
}

export async function getAccountById(
  c: Queryable,
  accountId: number,
): Promise<CompoundAccount | null> {
  const { rows } = await c.query<AccountRow>(
    `select ${ACCOUNT_COLUMNS} from public.compound_account where id = $1`,
    [accountId],
  );
  const r = rows[0];
  return r ? toAccount(r) : null;
}

export async function getAccountByMt5(
  c: Queryable,
  mt5Account: number,
): Promise<CompoundAccount | null> {
  const { rows } = await c.query<AccountRow>(
    `select ${ACCOUNT_COLUMNS} from public.compound_account where mt5_account = $1`,
    [mt5Account],
  );
  const r = rows[0];
  return r ? toAccount(r) : null;
}

export async function listAccountsForManager(
  c: Queryable,
  managerUserId: string,
): Promise<CompoundAccount[]> {
  const { rows } = await c.query<AccountRow>(
    `select ${ACCOUNT_COLUMNS} from public.compound_account
      where manager_user_id = $1 order by id asc`,
    [managerUserId],
  );
  return rows.map(toAccount);
}

/**
 * Every holder on the account, closed ones included.
 *
 * Seeds define the universe fold() replays against, and an exited holder is
 * still part of that universe — their deposits and their exit are in the
 * ledger, and dropping them would make the fold throw on an unknown holderId.
 * The stored status column is deliberately not read: fold derives status.
 */
export async function getHolderSeeds(c: Queryable, accountId: number): Promise<HolderSeed[]> {
  const { rows } = await c.query<{ id: string; is_manager: boolean; split_bps: number }>(
    `select id, is_manager, split_bps from public.compound_holder
      where account_id = $1 order by id asc`,
    [accountId],
  );
  return rows.map((r) => ({
    holderId: toId(r.id, "compound_holder.id"),
    isManager: r.is_manager,
    splitBps: r.split_bps,
  }));
}

export async function getLedgerEntries(
  c: Queryable,
  accountId: number,
): Promise<LedgerEntry[]> {
  const { rows } = await c.query<{
    id: string;
    seq: string;
    holder_id: string | null;
    occurred_on: string;
    type: string;
    amount_cents: string;
    fee_settlement: string | null;
    split_bps_applied: number | null;
    reverses_id: string | null;
  }>(
    `select id,
            seq,
            holder_id,
            ${dateKeyExpr("occurred_on")} as occurred_on,
            type,
            amount_cents,
            fee_settlement,
            split_bps_applied,
            reverses_id
       from public.compound_ledger_entry
      where account_id = $1
      order by seq asc`,
    [accountId],
  );

  return rows.map((r) => ({
    id: toId(r.id, "compound_ledger_entry.id"),
    seq: toId(r.seq, "compound_ledger_entry.seq"),
    holderId: r.holder_id === null ? null : toId(r.holder_id, "compound_ledger_entry.holder_id"),
    occurredOn: toDateKey(r.occurred_on, "compound_ledger_entry.occurred_on"),
    type: r.type as LedgerEntryType,
    amountCents: toCents(r.amount_cents, "compound_ledger_entry.amount_cents"),
    feeSettlement: r.fee_settlement === null ? null : (r.fee_settlement as "units" | "cash"),
    splitBpsApplied: r.split_bps_applied,
    reversesId:
      r.reverses_id === null ? null : toId(r.reverses_id, "compound_ledger_entry.reverses_id"),
  }));
}

/**
 * Never null. An account with no cursor row has posted no readings, which is
 * { lastReadingDate: null } — the same value planReadings expects for a first
 * run. Returning null instead would push a second empty case onto every
 * caller for no gain.
 */
export async function getReconcileCursor(
  c: Queryable,
  accountId: number,
): Promise<ReconcileCursor> {
  const { rows } = await c.query<{ last_reading_date: string | null }>(
    `select ${dateKeyExpr("last_reading_date")} as last_reading_date
       from public.compound_reconcile_cursor
      where account_id = $1`,
    [accountId],
  );
  const raw = rows[0]?.last_reading_date ?? null;
  return {
    lastReadingDate:
      raw === null ? null : toDateKey(raw, "compound_reconcile_cursor.last_reading_date"),
  };
}

export async function listCandidates(
  c: Queryable,
  accountId: number,
  status?: "pending" | "classified" | "ignored",
): Promise<CapitalEventCandidateRow[]> {
  const { rows } = await c.query<{
    id: string;
    account_id: string;
    trade_date: string;
    balance_delta_cents: string;
    explained_cents: string;
    unexplained_cents: string;
    status: string;
    detected_at: string;
  }>(
    `select id,
            account_id,
            ${dateKeyExpr("trade_date")} as trade_date,
            balance_delta_cents,
            explained_cents,
            unexplained_cents,
            status,
            ${utcIsoExpr("detected_at")} as detected_at
       from public.compound_capital_event_candidate
      where account_id = $1
        and ($2::text is null or status = $2::text)
      order by trade_date asc`,
    [accountId, status ?? null],
  );

  return rows.map((r) => ({
    id: toId(r.id, "compound_capital_event_candidate.id"),
    accountId: toId(r.account_id, "compound_capital_event_candidate.account_id"),
    tradeDate: toDateKey(r.trade_date, "compound_capital_event_candidate.trade_date"),
    balanceDeltaCents: toCents(
      r.balance_delta_cents,
      "compound_capital_event_candidate.balance_delta_cents",
    ),
    explainedCents: toCents(
      r.explained_cents,
      "compound_capital_event_candidate.explained_cents",
    ),
    unexplainedCents: toCents(
      r.unexplained_cents,
      "compound_capital_event_candidate.unexplained_cents",
    ),
    status: r.status as "pending" | "classified" | "ignored",
    detectedAt: r.detected_at,
  }));
}
