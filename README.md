# Compound — Investor Desk

Fund administration for pooled MetaTrader accounts.

Compound answers one question with certainty: **if this investor asked for their
money today, exactly how much would they get, and how much would the manager
keep?**

It replaces the spreadsheet that quietly breaks the moment a second investor
joins at a different account size — with proper unit accounting, an append-only
ledger, and a payout flow that computes the profit split correctly the first time.

> **Status:** design approved, implementation not started.
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
TypeScript · Jest + fast-check · Docker behind Traefik at `investment.lan`

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
