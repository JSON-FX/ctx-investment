-- ============================================================================
-- LOCAL FIXTURE / STAND-IN TABLES — NOT FOR PRODUCTION
-- ============================================================================
--
-- account_snapshots_daily, account_snapshots_current, deals and licenses are
-- NOT owned by ctx-investment (Compound). In the real environment they are
-- owned by CopyTraderX and populated by an Expert Advisor pushing to a live
-- production Supabase project that an EA also uses to validate trading
-- licences. Compound only ever reads these tables; it never writes to them.
--
-- This migration exists solely so a LOCAL Supabase instance has something
-- shaped like those tables for `lib/compound/db/` queries and integration
-- tests to read against. It must NEVER be applied to the live CopyTraderX
-- Supabase project — doing so would attempt to recreate tables that already
-- exist there, next to real trading data.
--
-- If you are about to run this against anything other than a local dev
-- stack: stop. This migration belongs only in the local `ctx-investment`
-- dev environment.
-- ============================================================================

-- account_snapshots_daily: one row per account per trading day, pushed by
-- the CopyTraderX EA at end of day. Compound's reconciler walks this day
-- over day, comparing the balance_close delta against deals closed in the
-- same window to detect capital events (deposits/withdrawals) that trades
-- alone cannot explain.
create table public.account_snapshots_daily (
  mt5_account    bigint         not null,
  trade_date     date           not null,
  balance_close  numeric(18,2)  not null,
  equity_close   numeric(18,2)  not null,
  daily_pnl      numeric(18,2)  not null,
  primary key (mt5_account, trade_date)
);

comment on table public.account_snapshots_daily is
  'LOCAL FIXTURE stand-in for a table owned by CopyTraderX. Do not apply to the live project.';

-- account_snapshots_current: one row per account, overwritten in place on
-- every EA push with the latest live account state. Compound's desk reads
-- this for "live NAV"; a *committed* NAV is derived from
-- account_snapshots_daily instead, never from this table, so a payout can
-- never settle against a figure that is still moving.
create table public.account_snapshots_current (
  mt5_account   bigint         not null primary key,
  balance       numeric(18,2)  not null,
  equity        numeric(18,2)  not null,
  margin        numeric(18,2)  not null,
  free_margin   numeric(18,2)  not null,
  margin_level  numeric,
  floating_pnl  numeric(18,2)  not null,
  drawdown_pct  numeric        not null,
  leverage      int            not null,
  currency      text           not null,
  server        text,
  pushed_at     timestamptz    not null
);

comment on table public.account_snapshots_current is
  'LOCAL FIXTURE stand-in for a table owned by CopyTraderX. Do not apply to the live project.';

-- deals: closed trades pushed by the EA. Every row in this fixture is a
-- closed trade — open_time and close_time are both required here. The real
-- table may also carry rows for open positions; this fixture does not model
-- that case, since Compound's reconciler only reasons about closed P/L.
--
-- Known upstream defect (see ARCHITECTURE.md section 11 in the parent repo):
-- a subset of EA pushes store broker server time as if it were UTC, which
-- produces a second, duplicate row for the same trade with both timestamps
-- shifted by the broker's UTC offset, under an out-of-sequence ticket.
-- reconcile/dedupe.ts exists to catch this; the seed data plants one such
-- pair on purpose so the dedupe logic has something real to catch.
create table public.deals (
  mt5_account  bigint         not null,
  ticket       bigint         not null,
  ea_source    text           not null,
  symbol       text           not null,
  side         text           not null,
  volume       numeric        not null,
  open_price   numeric        not null,
  close_price  numeric        not null,
  sl           numeric,
  tp           numeric,
  open_time    timestamptz    not null,
  close_time   timestamptz    not null,
  profit       numeric(18,2)  not null,
  swap         numeric(18,2)  not null,
  commission   numeric(18,2)  not null,
  comment      text,
  magic        bigint,
  primary key (mt5_account, ticket)
);

create index deals_mt5_account_close_time_idx
  on public.deals (mt5_account, close_time);

comment on table public.deals is
  'LOCAL FIXTURE stand-in for a table owned by CopyTraderX. Do not apply to the live project.';

-- licenses: only the columns Compound needs to resolve an mt5_account to
-- the auth.users row that owns it. The real table certainly has more
-- columns (licence keys, EA version pins, issue/expiry dates, etc.);
-- Compound has no reason to read those, so this fixture does not model
-- them. The FK to auth.users is this repo's own local-testing choice (to
-- catch orphaned test fixtures early) — it is not a confirmed fact about
-- the production schema.
create table public.licenses (
  id          bigint generated always as identity primary key,
  mt5_account bigint not null,
  product     text   not null,
  status      text   not null,
  user_id     uuid   not null references auth.users (id)
);

create index licenses_mt5_account_idx on public.licenses (mt5_account);

comment on table public.licenses is
  'LOCAL FIXTURE stand-in for a table owned by CopyTraderX. Do not apply to the live project.';

-- ----------------------------------------------------------------------------
-- RLS: enabled on every fixture table, deliberately with NO policies for
-- anon/authenticated.
--
-- Compound reads these tables server-side only, via the service-role key
-- (ARCHITECTURE.md section 9: SUPABASE_SERVICE_ROLE_KEY is read at runtime
-- and never reaches the browser). service_role bypasses RLS unconditionally,
-- so default-deny-everyone-else is the closest local approximation of
-- "these are not Compound's tables to expose" without guessing at
-- CopyTraderX's actual policies, which this repo cannot see and must not
-- invent.
-- ----------------------------------------------------------------------------
alter table public.account_snapshots_daily   enable row level security;
alter table public.account_snapshots_current enable row level security;
alter table public.deals                     enable row level security;
alter table public.licenses                  enable row level security;

-- ----------------------------------------------------------------------------
-- Grants: service_role only.
--
-- Supabase's current default does NOT auto-expose newly created tables to
-- the Data API roles (see config.toml's `auto_expose_new_tables` comment) —
-- anon/authenticated/service_role get no SELECT until it is granted
-- explicitly, regardless of RLS. This block makes that explicit rather than
-- relying on it silently: service_role (which carries BYPASSRLS locally,
-- confirmed via `select rolbypassrls from pg_roles`) can read; anon and
-- authenticated intentionally get nothing, because these are not Compound's
-- tables to expose to a client at all.
-- ----------------------------------------------------------------------------
grant select on
  public.account_snapshots_daily,
  public.account_snapshots_current,
  public.deals,
  public.licenses
to service_role;
