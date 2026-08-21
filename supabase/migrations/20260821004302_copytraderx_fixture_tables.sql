-- ============================================================================
-- LOCAL FIXTURE / STAND-IN TABLES — NOT FOR PRODUCTION
-- ============================================================================
--
-- public.users, account_snapshots_daily, account_snapshots_current, deals
-- and licenses are NOT owned by ctx-investment (Compound). In the real
-- environment account_snapshots_*/deals are owned by CopyTraderX and
-- populated by an Expert Advisor pushing to a live production Supabase
-- project that the same EA uses to validate trading licences. `users` and
-- `licenses` are owned by the copytraderx-license web app that sits in
-- front of that project. Compound only ever reads any of these five
-- tables; it never writes to them.
--
-- This migration exists solely so a LOCAL Supabase instance has something
-- shaped like those tables for `lib/compound/db/` queries and integration
-- tests to read against. It must NEVER be applied to the live CopyTraderX
-- Supabase project — doing so would attempt to recreate tables that already
-- exist there, next to real trading data and real user accounts.
--
-- If you are about to run this against anything other than a local dev
-- stack: stop. This migration belongs only in the local `ctx-investment`
-- dev environment.
--
-- `users` and the FK from `licenses.user_id` below are verified against the
-- real migrations at
-- ~/Documents/development/EA/JSONFX-IMPULSE/supabase/migrations/
-- (20260506000001_create_users_table.sql and
-- 20260506000003_alter_licenses_add_user_subscription.sql) rather than
-- guessed — that path is local-machine-only context, not something this
-- repo can assume exists elsewhere, so it is recorded here for whoever
-- next needs to re-verify.
-- ============================================================================

-- users: application-level projection of auth.users, owned by
-- copytraderx-license, not by Compound. Real columns verified against
-- 20260506000001_create_users_table.sql above; reproduced close to
-- verbatim, including its two mirror triggers, because getting this one
-- wrong silently breaks any RLS test that keys off role.
create table public.users (
  id                    uuid primary key references auth.users(id) on delete cascade,
  email                 text not null unique,
  role                  text not null default 'user' check (role in ('admin', 'user')),
  full_name             text,
  must_change_password  boolean not null default true,
  created_at            timestamptz not null default now(),
  created_by            uuid references public.users(id)
);

create index idx_users_role on public.users(role);

comment on table public.users is
  'LOCAL FIXTURE stand-in for a table owned by copytraderx-license. Do not apply to the live project.';

-- Mirror trigger: an auth.users insert creates the matching public.users
-- row. Role is read from raw_user_meta_data (signup-time input, e.g.
-- {"role":"admin"}), defaults to 'user' if absent or invalid, and is then
-- stamped onto auth.users.raw_app_meta_data so it rides in the JWT as
-- `auth.jwt() -> 'app_metadata' ->> 'role'`. Reproduced verbatim from
-- 20260506000001_create_users_table.sql.
create or replace function public.handle_auth_user_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_role text;
  resolved_full_name text;
begin
  resolved_role := coalesce(new.raw_user_meta_data ->> 'role', 'user');
  if resolved_role not in ('admin', 'user') then
    resolved_role := 'user';
  end if;
  resolved_full_name := new.raw_user_meta_data ->> 'full_name';

  insert into public.users (id, email, role, full_name)
  values (new.id, new.email, resolved_role, resolved_full_name)
  on conflict (id) do nothing;

  update auth.users
     set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                             || jsonb_build_object('role', resolved_role)
   where id = new.id;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_auth_user_insert();

-- Sync trigger: a public.users.role update mirrors back onto
-- auth.users.raw_app_meta_data, same as production.
create or replace function public.handle_users_role_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role then
    update auth.users
       set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                               || jsonb_build_object('role', new.role)
     where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_users_role_change on public.users;
create trigger on_users_role_change
  after update of role on public.users
  for each row execute function public.handle_users_role_sync();

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
-- the user that owns it. The real table has several more columns (license
-- keys, subscription linkage, EA version pins, issue/expiry dates, etc.);
-- Compound has no reason to read those, so this fixture does not model
-- them. user_id references public.users, NOT auth.users directly — verified
-- against 20260506000003_alter_licenses_add_user_subscription.sql (see the
-- path noted in the banner comment at the top of this file). product and
-- status CHECKs mirror the real allowed values as of that same check
-- (20260425000001_create_licenses_table.sql for status,
-- 20260506000003 for product) — if the live schema grows a new product
-- code or status, this CHECK will go stale and start rejecting it loudly,
-- which is the intended failure mode: loud beats silently accepting a
-- value that could never occur in production.
create table public.licenses (
  id          bigint generated always as identity primary key,
  mt5_account bigint not null,
  product     text   not null
                     check (product in (
                       'impulse', 'ctx-core', 'ctx-live',
                       'ctx-prop-passer', 'ctx-prop-funded'
                     )),
  status      text   not null default 'active'
                     check (status in ('active', 'revoked', 'expired')),
  user_id     uuid   not null references public.users (id)
);

create index licenses_mt5_account_idx on public.licenses (mt5_account);

comment on table public.licenses is
  'LOCAL FIXTURE stand-in for a table owned by CopyTraderX. Do not apply to the live project.';

-- ----------------------------------------------------------------------------
-- RLS: enabled on every fixture table, deliberately with NO policies for
-- anon/authenticated. This matches production for `users` exactly (its own
-- migration says as much — "for now the table is server-side only") and is
-- this repo's own choice, made the same way, for the other four.
--
-- Compound reads these tables server-side only, via the service-role key
-- (ARCHITECTURE.md section 9: SUPABASE_SERVICE_ROLE_KEY is read at runtime
-- and never reaches the browser). service_role bypasses RLS unconditionally,
-- so default-deny-everyone-else is the closest local approximation of
-- "these are not Compound's tables to expose" without guessing at
-- CopyTraderX's actual policies, which this repo cannot see and must not
-- invent.
-- ----------------------------------------------------------------------------
alter table public.users                     enable row level security;
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
  public.users,
  public.account_snapshots_daily,
  public.account_snapshots_current,
  public.deals,
  public.licenses
to service_role;
