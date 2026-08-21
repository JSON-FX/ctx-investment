-- ============================================================================
-- LOCAL FIXTURE / STAND-IN TABLES — NOT FOR PRODUCTION
-- ============================================================================
--
-- positions and orders are owned by CopyTraderX and populated by an Expert
-- Advisor pushing to the live production Supabase project. Compound reads
-- both and writes to neither.
--
-- This migration exists solely so a LOCAL Supabase instance has something
-- shaped like them for lib/compound/db/ to read against. It must NEVER be
-- applied to the live CopyTraderX project — those tables already exist there,
-- next to real trading data.
--
-- Columns are reproduced from the real migrations at
-- ~/Documents/development/EA/JSONFX-IMPULSE/supabase/migrations/
-- (20260502000003_create_positions.sql and 20260502000005_create_orders.sql)
-- rather than guessed. That path is local-machine context, not something this
-- repo can assume exists, so it is recorded here for whoever next needs to
-- re-verify. Cross-checked column-for-column against those two files while
-- writing this migration: every column name, type and precision below matches
-- the real tables exactly. The real ea_source CHECK against a fixed product
-- list is omitted here because Compound never writes these rows and a
-- fixture that rejects a test insert helps nobody.
-- ============================================================================

create table public.positions (
  mt5_account    bigint        not null,
  ticket         bigint        not null,
  ea_source      text          not null,
  symbol         text          not null,
  side           text          not null,
  volume         numeric(10,2) not null,
  open_price     numeric(18,5) not null,
  current_price  numeric(18,5) not null,
  sl             numeric(18,5),
  tp             numeric(18,5),
  profit         numeric(18,2) not null,
  swap           numeric(18,2) not null,
  commission     numeric(18,2) not null,
  open_time      timestamptz   not null,
  comment        text,
  magic          bigint,
  primary key (mt5_account, ticket),
  constraint positions_side_chk check (side in ('buy','sell'))
);

comment on table public.positions is
  'LOCAL FIXTURE stand-in for a table owned by CopyTraderX. Do not apply to the live project.';

create table public.orders (
  mt5_account     bigint        not null,
  ticket          bigint        not null,
  ea_source       text          not null,
  symbol          text          not null,
  type            text          not null,
  state           text          not null,
  volume_initial  numeric(10,2) not null,
  volume_current  numeric(10,2) not null,
  price_open      numeric(18,5),
  price_current   numeric(18,5),
  sl              numeric(18,5),
  tp              numeric(18,5),
  time_setup      timestamptz   not null,
  time_done       timestamptz,
  comment         text,
  magic           bigint,
  primary key (mt5_account, ticket)
);

create index orders_account_time_setup_idx
  on public.orders (mt5_account, time_setup desc);

comment on table public.orders is
  'LOCAL FIXTURE stand-in for a table owned by CopyTraderX. Do not apply to the live project.';

-- ----------------------------------------------------------------------------
-- RLS and grants: same shape as the other five CopyTraderX stand-ins in
-- 20260821004302_copytraderx_fixture_tables.sql, and for the same two
-- reasons documented there.
--
-- 1. RLS enabled, deliberately with no anon/authenticated policies —
--    default-deny, the closest local approximation of "not Compound's
--    tables to expose" without guessing at CopyTraderX's real policies.
--
-- 2. The explicit `grant select ... to service_role` is not decorative here.
--    Confirmed empirically against this same local stack (Supabase's
--    `auto_expose_new_tables` is unset, i.e. off by the current cloud
--    default — see api.auto_expose_new_tables in config.toml): a plain
--    `create table` with RLS left disabled and no grant still returns
--    `42501 permission denied` for a session that has done `set role
--    service_role`, which is exactly what db/client.ts's withDb() does on
--    every borrowed connection. Without this grant, getOpenPositions and
--    getOrders would fail on their first call, RLS enabled or not — table
--    ownership alone does not hand out SELECT to a non-owner role, service
--    role included.
-- ----------------------------------------------------------------------------
alter table public.positions enable row level security;
alter table public.orders    enable row level security;

grant select on public.positions, public.orders to service_role;
