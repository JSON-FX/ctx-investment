# Compound — Investor Desk

Fund administration for pooled MetaTrader accounts.

Compound answers one question with certainty: **if this investor asked for their
money today, exactly how much would they get, and how much would the manager
keep?**

It replaces the spreadsheet that quietly breaks the moment a second investor
joins at a different account size — with proper unit accounting, an append-only
ledger, and a payout flow that computes the profit split correctly the first time.

> **Status:** accounting engine complete and merged (125 tests). The desk
> itself is not built yet — the app currently serves a deployment shell that
> replays a fixture ledger through the engine.
> Read [ARCHITECTURE.md](ARCHITECTURE.md) first.

---

## What it does

- **Unit accounting.** Every holder, including the manager, holds units rather
  than a fixed percentage. A deposit issues units at the prevailing NAV, so a
  late joiner cannot claim a share of profit earned before they arrived.
- **High-water marks, automatically.** Profit is measured against capital
  actually contributed, so a losing stretch must be recovered before a
  performance fee applies again. Nobody is charged twice on the same dollar.
- **Payouts computed, not estimated.** Full arithmetic — value, basis, profit,
  both shares, units redeemed — shown before anything commits.
- **An append-only ledger.** Every figure traces to a dated, immutable entry.
  Corrections are reversing entries, never edits.
- **Capital events detected, not remembered.** Balance moves that closed trades
  cannot explain are held out of NAV until classified. An unrecorded deposit can
  never silently become profit.
- **The trading picture too.** Journal, calendar and performance surfaces read
  the same account, so "how much am I owed" and "how is it actually trading" are
  answered on one screen.

## What it does not do

- It never places, modifies or closes a trade, and holds no credentials that could.
- No money moves through it. It records transfers that happen at the broker or bank.
- It is not tax software. It exports data a preparer can use.

## Relationship to CopyTraderX

CopyTraderX is the source of truth for market data. Its EA pushes account
snapshots, deals, orders and positions to Supabase. Compound reads those tables
and never writes to them, and owns its own `compound_*` accounting tables in the
same project.

## Stack

Next.js 16 App Router · React 19 · Tailwind v4 · shadcn/ui · Supabase ·
TypeScript · Jest + fast-check · Docker behind Traefik at `ctxinvestment.lan`

## Running it

Requires Docker, and the local Traefik on the external `dev-net` network that
already fronts the sibling projects. `*.lan` resolves to 127.0.0.1 via
`/etc/resolver/lan`, so no hosts-file entry is needed.

```bash
docker compose up -d --build
open https://ctxinvestment.lan
```

| Tier | URL |
|---|---|
| Local prod | `https://ctxinvestment.lan` (TLS, self-signed) |
| Dev | `http://ctxinvestment.test` |

Locally, without Docker:

```bash
pnpm install
pnpm dev
```

Gates are `pnpm typecheck` and `pnpm test`. There is deliberately no ESLint —
`eslint-config-next` is broken against ESLint 9 in the sibling project.

## Local Supabase (dev stack)

`compound_*` tables will live in the same CopyTraderX Supabase project this
app reads market data from — a production project an Expert Advisor uses to
validate trading licences. Migrations are written and proven against a
local instance first; this repo never connects to, queries, or modifies the
remote project from automation.

```bash
supabase start    # first run pulls images, can take a few minutes
supabase status    # ports, API URL, anon/service-role keys
supabase db reset  # re-apply every migration + supabase/seed.sql from scratch
supabase stop      # tear the stack down
```

The local stack binds to `127.0.0.1:54621` (API/REST), `:54622` (Postgres),
`:54623` (Studio) — offset from Supabase's `54321` defaults because other
local Supabase projects on this machine already occupy the `54320s` and
`54520s` ranges. See `supabase/config.toml` for the full port list.

`supabase/migrations/` currently holds one migration: local fixture
stand-ins for the five CopyTraderX/copytraderx-license-owned tables
Compound reads (`users`, `account_snapshots_daily`,
`account_snapshots_current`, `deals`, `licenses`), including the two
triggers that mirror `users`/`auth.users` role in production. These are
**not** Compound's tables and this migration must never be applied to the
live project — see the warning comment at the top of the file.
`supabase/seed.sql` fills them with one fictional MT5 account, two
fictional users (a manager and an investor), and a scripted scenario — a
clean run of days, one unexplained balance jump, one duplicate-deal pair,
one weekend gap — shaped for testing `lib/compound/reconcile/`.

## Database tests

The `db/` integration suite runs against a local Supabase, never against a
hosted project.

```bash
supabase start          # ports come from supabase/config.toml
supabase db reset       # apply every migration, re-run the seed
pnpm test:db
```

`pnpm test` stays offline and never touches Postgres.

**Never run `supabase link` or `supabase db push` in this repository.** The
`compound_*` migrations are applied to CopyTraderX by hand, as a reviewed step,
not by any command in this repo.

## What the page shows today

A deployment shell, not the desk. It replays a fictional 15-entry ledger
through `fold()` and renders the resulting `PoolState` — NAV, the ownership
rail, per-holder units, values, open P/L and accrued fee — then checks the
invariants live and reports whether the sums are exact. It exists so that a
running container proves two things at once: the deployment works, and the
engine computes. Plan 3 replaces it with the real desk.

## Documentation

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | how the system fits together |
| [Design spec](docs/superpowers/specs/2026-08-21-compound-investor-desk-design.md) | decisions, domain model, schema, rationale |

## A note on this repository

This repository is public and deliberately carries no real data. No credentials,
no Supabase project ref, no MT5 account numbers, no broker server names, no real
holder names, no real balances. Fixtures and seeds are fictional. Real figures
exist only in the runtime environment and in git-ignored `*.local.md` notes.

## Regulatory note

Pooling third-party capital and charging a performance fee is very likely an
investment contract under Philippine SEC rules, and equivalent rules apply in
most jurisdictions. That risk attaches to the trading operation, not to this
software. Anyone operating a pooled account should take securities advice before
onboarding investors beyond a private circle.
