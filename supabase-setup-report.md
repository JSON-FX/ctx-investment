# Local Supabase setup — report

Branch `chore/local-supabase`, worktree
`/Users/jsonse/Documents/development/ctx-investment/.worktrees/supabase`.

Goal: a local Supabase instance so `compound_*` migrations can be written
and proven before anything touches the live CopyTraderX Supabase project.
**No remote Supabase project was connected to, queried, or modified.** See
"Note on `supabase projects list`" near the end — one read-only CLI command
incidentally touched Supabase's hosted *management* API (not any project's
database) and is disclosed there in full.

## What was created

```
supabase/
├── .gitignore                                          (from `supabase init`)
├── config.toml                                         project_id + all ports remapped
├── migrations/
│   └── 20260821004302_copytraderx_fixture_tables.sql   fixture tables + RLS + grants
└── seed.sql                                             fictional seed data
```

Plus a short "Local Supabase (dev stack)" section added to the root
`README.md`, between "Running it" and "What the page shows today".

### `supabase/config.toml`

`supabase init` defaults to `project_id = "supabase"` and the standard
`5432x` ports. Both were changed:

- `project_id = "ctx-investment"` (so container names are unambiguous —
  `supabase_db_ctx-investment`, etc.)
- Every port offset into an unused `5462x` block, because this machine
  already runs two other local Supabase stacks:
  - `labaan-backend` on the `5432x` block (`54321` API, `54322` DB, `54323`
    Studio, `54324` Inbucket, `54327` analytics)
  - `race-pace` on the `5452x` block (`54521`/`54522`/`54523`/`54524`/`54527`)

  So `ctx-investment` now uses:

  | Service | Default | Used here |
  |---|---|---|
  | API (Kong/PostgREST) | 54321 | **54621** |
  | Postgres | 54322 | **54622** |
  | DB shadow (for `db diff`) | 54320 | **54620** |
  | Studio | 54323 | **54623** |
  | Inbucket/Mailpit | 54324 | **54624** |
  | Analytics (Logflare) | 54327 | **54627** |
  | Pooler (disabled by default) | 54329 | **54629** |

All three stacks were confirmed running side by side with no port conflicts
(see `docker ps` output below).

### The fixture migration

`supabase/migrations/20260821004302_copytraderx_fixture_tables.sql` creates
four tables — **not owned by Compound**, local stand-ins for tables that
already exist in the live CopyTraderX project:

- `account_snapshots_daily` — `mt5_account bigint`, `trade_date date`,
  `balance_close/equity_close/daily_pnl numeric(18,2)`. PK
  `(mt5_account, trade_date)`.
- `account_snapshots_current` — one row per account,
  `balance/equity/margin/free_margin/floating_pnl numeric(18,2)`,
  `margin_level numeric null`, `drawdown_pct numeric`, `leverage int`,
  `currency text`, `server text null`, `pushed_at timestamptz`. PK
  `mt5_account`.
- `deals` — `mt5_account bigint`, `ticket bigint`, `ea_source/symbol/side
  text`, `volume/open_price/close_price numeric`, `sl/tp numeric null`,
  `open_time/close_time timestamptz`, `profit/swap/commission
  numeric(18,2)`, `comment text null`, `magic bigint null`. PK
  `(mt5_account, ticket)`. Index on `(mt5_account, close_time)`.
- `licenses` — `id bigint identity`, `mt5_account bigint`, `product/status
  text`, `user_id uuid references auth.users(id)`. Index on `mt5_account`.

**Money is decimal dollars (`numeric(18,2)`), not integer cents.** Volume is
stored in lots (e.g. `0.10`), not milli-lots. `open_time`/`close_time` are
`timestamptz`. The account identifier is `mt5_account bigint` on all four
tables — consistent naming throughout. `deals` has no open/closed
discriminator column; **every row in this fixture is a closed trade**
(`open_time` and `close_time` both populated) because the reconciler this
fixture serves only reasons about closed P/L — the real table may also
carry open-position rows, which this fixture does not model.

The file opens with an explicit, impossible-to-miss comment block stating
these are local stand-ins and must never be applied to the live project.

**RLS:** enabled on all four tables, no policies for `anon`/`authenticated`.
**Grants:** `SELECT` granted to `service_role` only, added explicitly — see
"Gotcha" below for why that grant turned out to be necessary even with RLS
on. This mirrors Compound's own architecture (`SUPABASE_SERVICE_ROLE_KEY`
read server-side only, per `ARCHITECTURE.md` §9): the fixture tables are
reachable exactly the way the app will actually reach the real ones, and
`anon`/`authenticated` get nothing, because these were never Compound's
tables to expose to a client.

The FK from `licenses.user_id` to `auth.users(id)` is **this repo's own
local-testing choice**, not a confirmed fact about the production schema —
flagged as such in the migration's comments.

### The seed (`supabase/seed.sql`)

All fictional. One MT5 account: **`90000001`** (obviously-synthetic,
non-sequential-looking number). Ten weekday `account_snapshots_daily` rows,
**2026-08-03 through 2026-08-14**, ten `deals` rows, one `account_snapshots_current`
row, one `licenses` row, and two `auth.users` rows.

`swap` and `commission` are `0.00` on every deal on purpose, so `profit`
alone carries each day's delta and the arithmetic is exact and easy to
eyeball. `equity_close == balance_close` on every daily row — nothing is
left open overnight in this fixture, so there's no floating P/L at any
day's close (floating P/L only shows up on the separate "current" row).

| trade_date | balance_close | daily_pnl | explained by |
|---|---|---|---|
| 2026-08-03 | 50120.00 |  120.00 | ticket 90010001 |
| 2026-08-04 | 50075.00 |  -45.00 | ticket 90010002 |
| 2026-08-05 | 50375.00 |  300.00 | ticket 90010003 |
| 2026-08-06 | 50455.00 |   80.00 | ticket 90010004 (see duplicate pair below) |
| 2026-08-07 | 50395.00 |  -60.00 | ticket 90010005 |
| *(weekend gap — see below)* | | | |
| 2026-08-10 | 50595.00 |  200.00 | ticket 90010006, closed Sat 2026-08-08 |
| 2026-08-11 | 50745.00 |  150.00 | ticket 90010007 |
| **2026-08-12** | **55745.00** | **0.00** | **nothing — the deposit** |
| 2026-08-13 | 55835.00 |   90.00 | ticket 90010008 |
| 2026-08-14 | 55805.00 |  -30.00 | ticket 90010009 |

**The unexplained jump:** `2026-08-12`, balance moves **+5000.00** with
`daily_pnl = 0.00` and zero `deals` rows that day. This is the case
`reconcile/detect.ts` exists to catch.

**The duplicate-deal pair:** tickets **`90010004`** and **`90019999`**, both
`EURUSD sell 0.10`, both `profit 80.00` / `swap 0.00`. Real fill:
`open_time 2026-08-06T07:00:00+00`, `close_time 2026-08-06T08:00:00+00`.
Duplicate: `open_time 2026-08-06T10:00:00+00`, `close_time
2026-08-06T11:00:00+00` — **both timestamps shifted by exactly +3h**, ticket
`90019999` deliberately out of sequence (every other ticket for this
account runs `90010001`-`90010009`). A naive same-day sum over `deals` for
`2026-08-06` gets `160.00`, double the true `80.00` delta — the gap between
those two numbers is exactly what a working dedupe should remove.

**The weekend gap:** daily rows exist for Friday `2026-08-07` and Monday
`2026-08-10` with no `2026-08-08`/`2026-08-09` rows in between. Ticket
`90010006` (`BTCUSD`, trades 24/7 unlike the FX pairs used elsewhere in this
seed) closes **Saturday 2026-08-08** and its `+200.00` is exactly the
Friday→Monday delta. A reconciler that only looks at "deals closed on the
snapshot's own date" will not find this trade under `2026-08-10`; one that
looks at "deals closed since the previous snapshot" will.

**`account_snapshots_current`:** balance `55805.00` (matches the last daily
close), equity `55930.00` — **+125.00 of floating P/L on a still-open
position**, present nowhere in `deals` or the `2026-08-14` daily row. This
exercises the "committed NAV vs. live NAV" distinction in `ARCHITECTURE.md`
§5.

**`auth.users`** (fictional, `@example.com`): a "manager"
(`00000000-0000-0000-0000-000000000001`, `manager@example.com`,
`raw_app_meta_data->>'role' = 'admin'`) and an "investor"
(`00000000-0000-0000-0000-000000000002`, `investor@example.com`,
`raw_app_meta_data->>'role' = 'investor'`), each with a matching
`auth.identities` row. **The `role` value in `raw_app_meta_data` is this
fixture's own guess at where Compound will look for it — not a confirmed
fact about the live CopyTraderX auth schema**, which lives in a sibling
repo this task did not inspect. Verify before relying on it.

**`licenses`:** one row, `mt5_account 90000001`, `product
'copytraderx-impulse'`, `status 'active'`, `user_id` = the manager's UUID
(an MT5 account is owned by the manager running it; investors hold pool
units, not the account itself).

`db.seed.enabled = true` and `sql_paths = ["./seed.sql"]` are the
`supabase init` defaults (unchanged) — `supabase db reset` re-runs this
seed automatically every time. No `compound_*` rows exist anywhere in the
seed; those tables don't exist until the persistence-layer migration lands.

## Verification — actual query output

After `supabase start`, then again after `supabase db reset` (full
recreate-from-scratch, to prove the migration + seed pipeline works, not
just that a previous manual run happened to work):

```
$ supabase db reset
Resetting local database...
Recreating database...
Initialising schema...
Seeding globals from roles.sql...
Applying migration 20260821004302_copytraderx_fixture_tables.sql...
Seeding data from supabase/seed.sql...
Restarting containers...
Finished supabase db reset on branch main.
```

Tables + row counts (`docker exec -u postgres supabase_db_ctx-investment psql -U postgres -d postgres`):

```
=== tables in public schema ===
        table_name         
---------------------------
 account_snapshots_current
 account_snapshots_daily
 deals
 licenses
(4 rows)

=== row counts ===
             t             | count 
---------------------------+-------
 account_snapshots_daily   |    10
 account_snapshots_current |     1
 deals                     |    10
 licenses                  |     1
 auth.users                |     2
(5 rows)
```

`account_snapshots_daily` (full table):

```
 mt5_account | trade_date | balance_close | equity_close | daily_pnl 
-------------+------------+---------------+--------------+-----------
    90000001 | 2026-08-03 |      50120.00 |     50120.00 |    120.00
    90000001 | 2026-08-04 |      50075.00 |     50075.00 |    -45.00
    90000001 | 2026-08-05 |      50375.00 |     50375.00 |    300.00
    90000001 | 2026-08-06 |      50455.00 |     50455.00 |     80.00
    90000001 | 2026-08-07 |      50395.00 |     50395.00 |    -60.00
    90000001 | 2026-08-10 |      50595.00 |     50595.00 |    200.00
    90000001 | 2026-08-11 |      50745.00 |     50745.00 |    150.00
    90000001 | 2026-08-12 |      55745.00 |     55745.00 |      0.00
    90000001 | 2026-08-13 |      55835.00 |     55835.00 |     90.00
    90000001 | 2026-08-14 |      55805.00 |     55805.00 |    -30.00
(10 rows)
```

`account_snapshots_current` (full table):

```
 mt5_account | balance  |  equity  | margin | free_margin | margin_level | floating_pnl | drawdown_pct | leverage | currency |       server       |       pushed_at        
-------------+----------+----------+--------+-------------+--------------+--------------+--------------+----------+----------+--------------------+------------------------
    90000001 | 55805.00 | 55930.00 | 500.00 |    55430.00 |     11186.00 |       125.00 |         0.00 |      100 | USD      | FixtureBroker-Demo | 2026-08-14 18:45:00+00
(1 row)
```

`deals`, ordered by `close_time` (duplicate pair visible: `90010004` /
`90019999`):

```
  ticket  | symbol | side | volume |       open_time        |       close_time       | profit | swap | commission 
----------+--------+------+--------+------------------------+------------------------+--------+------+------------
 90010001 | EURUSD | buy  |   0.10 | 2026-08-03 07:00:00+00 | 2026-08-03 09:00:00+00 | 120.00 | 0.00 |       0.00
 90010002 | GBPUSD | sell |   0.05 | 2026-08-04 08:00:00+00 | 2026-08-04 10:30:00+00 | -45.00 | 0.00 |       0.00
 90010003 | XAUUSD | buy  |   0.02 | 2026-08-05 06:00:00+00 | 2026-08-05 13:00:00+00 | 300.00 | 0.00 |       0.00
 90010004 | EURUSD | sell |   0.10 | 2026-08-06 07:00:00+00 | 2026-08-06 08:00:00+00 |  80.00 | 0.00 |       0.00
 90019999 | EURUSD | sell |   0.10 | 2026-08-06 10:00:00+00 | 2026-08-06 11:00:00+00 |  80.00 | 0.00 |       0.00
 90010005 | GBPUSD | buy  |   0.05 | 2026-08-07 09:00:00+00 | 2026-08-07 14:00:00+00 | -60.00 | 0.00 |       0.00
 90010006 | BTCUSD | buy  |   0.01 | 2026-08-08 10:00:00+00 | 2026-08-08 15:00:00+00 | 200.00 | 0.00 |       0.00
 90010007 | EURUSD | sell |   0.15 | 2026-08-11 07:30:00+00 | 2026-08-11 12:00:00+00 | 150.00 | 0.00 |       0.00
 90010008 | GBPUSD | buy  |   0.05 | 2026-08-13 08:00:00+00 | 2026-08-13 11:00:00+00 |  90.00 | 0.00 |       0.00
 90010009 | XAUUSD | sell |   0.01 | 2026-08-14 06:00:00+00 | 2026-08-14 09:00:00+00 | -30.00 | 0.00 |       0.00
(10 rows)
```

`licenses` joined to `auth.users`, and the seeded `auth.users` rows:

```
 id | mt5_account |       product       | status |               user_id                |        email        
----+-------------+---------------------+--------+--------------------------------------+---------------------
  1 |    90000001 | copytraderx-impulse | active | 00000000-0000-0000-0000-000000000001 | manager@example.com
(1 row)

                  id                  |        email         |   role   
--------------------------------------+----------------------+----------
 00000000-0000-0000-0000-000000000002 | investor@example.com | investor
 00000000-0000-0000-0000-000000000001 | manager@example.com  | admin
(2 rows)
```

RLS flags (`pg_class.relrowsecurity`):

```
          relname          | relrowsecurity | relforcerowsecurity 
---------------------------+----------------+---------------------
 account_snapshots_current | t              | f
 account_snapshots_daily   | t              | f
 deals                     | t              | f
 licenses                  | t              | f
(4 rows)
```

**End-to-end through the real REST API** (`curl` against
`http://127.0.0.1:54621/rest/v1/...`, exactly the path `supabase-js` would
use):

```
--- anon key against /deals ---
{"code":"42501","details":null,"hint":"Grant the required privileges to the current role with: GRANT SELECT ON public.deals TO anon;","message":"permission denied for table deals"}

--- service role key against /deals ---
[{"ticket":90010001,"symbol":"EURUSD","profit":120.00},
 {"ticket":90010002,"symbol":"GBPUSD","profit":-45.00},
 {"ticket":90010003,"symbol":"XAUUSD","profit":300.00}]

--- service role key against /licenses ---
[{"id":1,"mt5_account":90000001,"product":"copytraderx-impulse","status":"active","user_id":"00000000-0000-0000-0000-000000000001"}]
```

`supabase migration list --local`:

```
{"migrations":[{"local":"20260821004302","remote":"20260821004302","time":"2026-08-21 00:43:02"}],"message":"Migrations listed"}
```

`docker ps` confirmed all three local Supabase stacks running side by side
with no port collisions: `supabase_*_ctx-investment` on `5462x`,
`supabase_*_race-pace` on `5452x`, `supabase_*_labaan-backend` on `5432x`.

## Connection details

| | |
|---|---|
| API URL | `http://127.0.0.1:54621` |
| REST URL | `http://127.0.0.1:54621/rest/v1` |
| DB URL | `postgresql://postgres:postgres@127.0.0.1:54622/postgres` |
| Studio | `http://127.0.0.1:54623` |
| Inbucket/Mailpit | `http://127.0.0.1:54624` |
| anon key / service-role key | the standard fixed Supabase **local demo** keys (same on every machine, not a secret) — run `supabase status` from `supabase/` to print them, do not hardcode them anywhere |

`psql` is not installed on the host; reach Postgres either via
`docker exec -u postgres supabase_db_ctx-investment psql -U postgres -d postgres`,
or from the host with the `DB_URL` above once a Postgres client is
available.

## Commands

Run from `/Users/jsonse/Documents/development/ctx-investment/.worktrees/supabase`
(or anywhere under this worktree — the CLI walks up to find `supabase/`):

```bash
supabase start                              # start the stack (first run pulls images)
supabase stop                               # tear it down (keeps the DB volume)
supabase stop --no-backup                   # tear down AND delete the DB volume
supabase status                             # ports, URLs, anon/service-role keys
supabase db reset                           # drop, recreate, re-apply every migration, re-run seed.sql
supabase migration new <descriptive_name>   # scaffold a new empty migration file with a fresh timestamp
supabase migration list --local             # confirm which migrations are applied locally
docker exec -u postgres supabase_db_ctx-investment psql -U postgres -d postgres   # raw psql
```

There is no `supabase link` anywhere in this worktree and no project ref is
stored — `supabase db reset`/`start`/`stop` only ever touch the local Docker
containers.

## Gotcha worth knowing

**RLS being enabled does not expose a table, and it does not restrict
`service_role` either — grants are a separate, independent layer.** My
first pass enabled RLS on all four tables with zero policies and assumed
that alone made them readable only by `service_role` (which carries
`BYPASSRLS` locally — confirmed via `select rolbypassrls from pg_roles`).
Wrong: Postgres also requires an explicit `GRANT SELECT` before *any* role
other than the table owner can touch a table at all, RLS or not, bypass or
not. Supabase's current default does not auto-grant this to new tables
(see the `auto_expose_new_tables` comment in `config.toml` — this used to
default to `true`, now defaults to unset/false to match the cloud default).
First `supabase db reset` showed `service_role` getting
`permission denied for table deals` through the REST API exactly like
`anon` did. Fixed by adding an explicit `grant select ... to service_role`
block at the end of the migration (present in the file now), then reran
`db reset` and re-verified through the actual REST API with both keys —
output above. Worth remembering for the `compound_*` migration too: RLS
policies alone will not be enough, `service_role` needs its `GRANT SELECT`
stated explicitly, same as any other role.

## Note on `supabase projects list`

While confirming this worktree had no remote link (`supabase/.temp` has no
project-ref file, and no `supabase link` was ever run here), I ran
`supabase projects list` as a read-only sanity check. It succeeded and
returned metadata for one project (`whaqarofxdlzxrelbcrq`, owned by
`support.racepace@gmail.com`, `linked: false`) — meaning the Supabase CLI
on this machine already carries a stored, machine-wide login session
(presumably from earlier work on the sibling `race-pace` project), separate
from this worktree. That project is not identified anywhere as CopyTraderX,
I did not query or modify anything in it, and I did not run `supabase link`
or any other command against it. I stopped there rather than exploring
further. Flagging this because it means the constraint "don't connect to a
remote project" has to be upheld by *not running* linking/pushing commands,
not by assuming the CLI has no way to reach one — the ambient credential
already exists on this machine for at least one hosted project.

## Everything worked

`supabase start` succeeded on the first real attempt (after fixing the
ports). No image pulls were needed — this machine already has every
`supabase/*` image cached from the other two local stacks. The only
non-trivial issue was the grants gotcha above, caught during verification
and fixed before this report was written.

The stack was stopped (`supabase stop`) after this report was written and
verification was complete — see the reply to the coordinator for
confirmation. Bring it back with `supabase start` from this worktree; the
DB volume persists across `stop`/`start` (not `stop --no-backup`), so data
survives a stop/start cycle without needing `db reset`.

## Update: added `public.users` (fifth fixture table)

The plan-authoring agent relayed a finding from the controller: the real
`licenses.user_id` references `public.users(id)`, not `auth.users(id)`
directly — there's an application-level projection table in between, owned
by copytraderx-license, with two triggers that mirror role between it and
`auth.users`. That's a real gap in my original four-table migration (my
`licenses.user_id -> auth.users(id)` FK and my `raw_app_meta_data.role`
guess were both my own local-testing choices, explicitly flagged as
unconfirmed in my first pass).

Rather than trust the relay, I read the real migrations directly at
`~/Documents/development/EA/JSONFX-IMPULSE/supabase/migrations/`
(`20260506000001_create_users_table.sql`,
`20260506000003_alter_licenses_add_user_subscription.sql`,
`20260425000001_create_licenses_table.sql`, and the RLS policy file) rather
than build on a second-hand paraphrase of something I could just go check
myself. That confirmed the relayed DDL exactly, and also surfaced two
things nobody had mentioned yet:

- **`licenses.product` and `licenses.status` are both CHECK-constrained** in
  production (`product in ('impulse','ctx-core','ctx-live',
  'ctx-prop-passer','ctx-prop-funded')`, `status in
  ('active','revoked','expired')` default `'active'`). My seed's
  `product = 'copytraderx-impulse'` was not a real value at all — fixed to
  `'impulse'` (the actual code for the CopyTraderX-Impulse EA, confirmed
  from the same file). Added matching CHECKs to the fixture table so a
  wrong product/status string now fails loudly instead of silently seeding
  data that could never exist in production.
- **Role on signup comes from `raw_user_meta_data`, not
  `raw_app_meta_data`.** A trigger (`on_auth_user_created`) reads
  `raw_user_meta_data ->> 'role'` on `auth.users` insert, creates the
  `public.users` row, and only then stamps `raw_app_meta_data.role` itself
  (that's the field `auth.jwt() -> 'app_metadata' ->> 'role'` reads at
  request time — confirmed against the actual RLS policy file). My first
  seed set `raw_app_meta_data.role` directly, skipping that whole
  mechanism. Fixed by moving `role` into `raw_user_meta_data` and letting
  the (now-implemented) trigger do the rest, exactly like production.

### What changed

`supabase/migrations/20260821004302_copytraderx_fixture_tables.sql`
(same file, not a new migration — see rationale below):

- Added `public.users` (`id uuid primary key references auth.users(id) on
  delete cascade`, `email text not null unique`, `role text not null
  default 'user' check (role in ('admin','user'))`, `full_name text`,
  `must_change_password boolean not null default true`, `created_at
  timestamptz not null default now()`, `created_by uuid references
  public.users(id)`), reproduced close to verbatim from the real migration.
- Added both trigger functions (`handle_auth_user_insert`,
  `handle_users_role_sync`) and their triggers, also reproduced close to
  verbatim, `security definer` + `set search_path = public` exactly as the
  real ones are.
- `licenses.user_id` now references `public.users(id)`. Added the
  `product`/`status` CHECKs described above, and `status default 'active'`.
- Added `public.users` to the RLS-enable and `grant select ... to
  service_role` blocks, same pattern as the other four tables.
- Updated the top banner comment to cover five tables and to record the
  local path to the real migrations, for whoever needs to re-verify later.

`supabase/seed.sql`:

- `encrypted_password` changed from a `crypt()`/`gen_salt()` bcrypt hash to
  the sentinel string `'!!disabled-no-login!!'` — copytraderx-license's own
  convention for a synthetic user that must never authenticate with a
  password (confirmed in the backfill migration), and it removes this
  seed's only `pgcrypto` dependency.
- `role` moved from `raw_app_meta_data` into `raw_user_meta_data` on both
  seeded users (`admin` for the manager, `user` — not `investor` — for the
  investor, since the real CHECK only allows `admin`/`user`). No manual
  `insert into public.users` — the trigger creates both rows automatically
  from the `auth.users` insert, which is itself a live proof the trigger
  works, not just that a hand-written row looks right.
- `licenses.product` fixed from the invented `'copytraderx-impulse'` to the
  real `'impulse'`.

**Why edited in place rather than a second migration file:** nothing has
built persistent state on top of this migration — every verification cycle
is a full `supabase db reset` (drop, recreate, replay everything), and no
one outside this local loop has applied it to a database that has to keep
working across the edit. `supabase/migrations/` still represents exactly
one thing — "local stand-ins for tables this repo doesn't own" — and
splitting that into two files for what is one concept seemed worse than
one accurate file. A real second migration remains the right move for any
*future* change to these fixtures, once other work has been built on top of
this one.

### Verification — actual output, after `supabase db reset`

```
=== tables in public schema ===
        table_name         
---------------------------
 account_snapshots_current
 account_snapshots_daily
 deals
 licenses
 users
(5 rows)

=== public.users (created by the trigger, not a manual insert) ===
                  id                  |        email         | role  |    full_name     | must_change_password 
--------------------------------------+----------------------+-------+------------------+----------------------
 00000000-0000-0000-0000-000000000002 | investor@example.com | user  | Fixture Investor | t
 00000000-0000-0000-0000-000000000001 | manager@example.com  | admin | Fixture Manager  | t
(2 rows)

=== auth.users raw_app_meta_data (trigger should have stamped role) ===
        email         |                       raw_app_meta_data                        |                raw_user_meta_data                 
----------------------+----------------------------------------------------------------+---------------------------------------------------
 investor@example.com | {"role": "user", "provider": "email", "providers": ["email"]}  | {"role": "user", "full_name": "Fixture Investor"}
 manager@example.com  | {"role": "admin", "provider": "email", "providers": ["email"]} | {"role": "admin", "full_name": "Fixture Manager"}
(2 rows)

=== licenses (FK now to public.users, product/status now checked) ===
 id | mt5_account | product | status |               user_id                
----+-------------+---------+--------+--------------------------------------
  1 |    90000001 | impulse | active | 00000000-0000-0000-0000-000000000001
(1 row)

=== licenses joined through public.users to confirm the FK really works ===
 mt5_account | product |        email        | role  
-------------+---------+---------------------+-------
    90000001 | impulse | manager@example.com | admin
(1 row)
```

Grants + REST API, confirming `public.users` follows the exact same
service-role-only pattern as the other four tables:

```
=== grants on public.users ===
   grantee    | privilege_type 
--------------+----------------
 postgres     | SELECT
 service_role | SELECT
(2 rows)

--- anon key against /users ---
{"code":"42501","details":null,"hint":"Grant the required privileges to the current role with: GRANT SELECT ON public.users TO anon;","message":"permission denied for table users"}

--- service role key against /users ---
[{"email":"investor@example.com","role":"user"},
 {"email":"manager@example.com","role":"admin"}]
```

Stack stopped again after this verification, same as before — zero
`supabase_*_ctx-investment` containers left running. Restart with
`supabase start` from this worktree.
