# Architecture

Compound is a fund administration desk for pooled MetaTrader accounts. This
document describes how the system fits together. For *why* each choice was made,
see [the design spec](docs/superpowers/specs/2026-08-21-compound-investor-desk-design.md).

---

## 1. System context

```
┌─────────────────┐        writes         ┌──────────────────────────┐
│  CopyTraderX    │──────────────────────▶│  Supabase (Postgres)     │
│  EA on MT5      │  snapshots, deals,    │                          │
└─────────────────┘  orders, positions    │  ── CopyTraderX tables ──│
                                          │  account_snapshots_current│
┌─────────────────┐        reads only     │  account_snapshots_daily  │
│  copytraderx-   │◀─────────────────────▶│  deals · orders           │
│  license        │                       │  positions · licenses     │
└─────────────────┘                       │                           │
                                          │  ── Compound tables ──────│
┌─────────────────┐   reads CTX tables    │  compound_account         │
│  ctx-investment │◀──────────────────────│  compound_holder          │
│  (this repo)    │   read+write compound_│  compound_ledger_entry    │
│  investment.lan │──────────────────────▶│  compound_capital_event_* │
└─────────────────┘                       │  compound_reconcile_cursor│
                                          │  compound_audit           │
                                          └──────────────────────────┘
```

**Compound never writes to CopyTraderX tables.** It reads market truth and owns
its own accounting truth. The two apps share a database and a user directory,
nothing else.

Compound holds no trading credentials and can place no orders. Permanently.

---

## 2. The accounting core is event-sourced

`compound_ledger_entry` is the only truth. Every figure on every screen — units,
cost basis, NAV, holder value, accrued fee — is derived by replaying it.

`compound_holder` stores identity and terms. It stores **no balances**. There is
no `units` column and no `cost_basis` column, deliberately.

```
compound_ledger_entry (ordered by seq)
        │
        ▼
   replay.fold()
        │
        ▼
    PoolState  ──────▶  every screen, every API response
```

```ts
interface PoolState {
  accountId: number
  equityCents: bigint
  units: bigint                 // scaled 1e-10
  holders: HolderState[]        // units, basisCents, status, splitBps
  lastReadingOn: string | null
  seq: number
}
```

This makes the PRD's goal G1 — *any investor's balance is reproducible from the
ledger alone* — true by construction rather than by discipline. It also means
invariants 1 and 2 hold **exactly**, not within a tolerance, because units are
integers that sum exactly and value is a pure function of units.

Scale makes this affordable: a live account produces roughly 250 daily readings
and a few dozen trades a year. At 20 holders over a decade the ledger stays in
the low thousands of rows.

---

## 3. Module layout

```
lib/compound/
  engine/          PURE. no I/O. must never import db/
    money.ts       integer minor units, bigint unit scaling, rounding
    nav.ts         nav, unitsForDeposit, valueOf, profitOf
    quote.ts       payout arithmetic — returns without committing
    replay.ts      fold(LedgerEntry[]) -> PoolState
    invariants.ts  the five assertions
  reconcile/       PURE
    dedupe.ts      upstream duplicate-deal guard
    detect.ts      balance vs closed-trade P/L -> candidate events
  db/              the ONLY I/O. queries + append-only writer

lib/journal/       copied verbatim from copytraderx-license
                   calendar-aggregate · streaks · trade-stats · trade-equity
                   histogram · filters · export · format-pnl
```

**The boundary that matters: `engine/` never imports `db/`.** The whole
accounting model is exercisable with generated ledgers and no database, which is
what makes property-based testing cheap enough to actually run.

`lib/journal/` is copied rather than shared. Its functions are pure, stable and
already unit-tested; the components that consume them are rebuilt, because the
visual language differs.

---

## 4. Data flow

```
EA push
   │
   ├──▶ account_snapshots_daily ──┐
   │                              │
   └──▶ deals ──▶ dedupe.ts ──────┤
                                  ▼
                            detect.ts
                                  │
                 ┌────────────────┴────────────────┐
                 │                                 │
          explained by trades              unexplained
                 │                                 │
                 ▼                                 ▼
        append equity_reading          compound_capital_event_candidate
        advance cursor                 ⛔ cursor does NOT advance
                 │                                 │
                 │                       manager classifies in /review
                 │                                 │
                 └────────────┬────────────────────┘
                              ▼
                    compound_ledger_entry
                              │
                          replay.fold()
                              ▼
                          PoolState
                              │
        ┌──────────┬──────────┼──────────┬──────────────┐
        ▼          ▼          ▼          ▼              ▼
      desk      ledger     review     journal      calendar /
                                                  performance
```

### Two distinctions that must stay right

**Reconcile on `balance`, post readings on `equity`.**
Deposits move balance; floating P/L does not. Detection therefore reads
`balance_close`. NAV reads `equity_close`, because a holder's value includes
their share of open positions.

**Committed NAV versus live NAV.**
The desk displays live NAV computed from `account_snapshots_current`. A payout
may never settle against a drifting intraday figure. Committing a payout writes
an equity reading capturing the exact equity used, then the payout entry, in one
transaction — which generalises the PRD's same-day atomicity rule to every money
event.

---

## 5. The safety interlock

> When the reconciler finds a balance move that closed trades do not explain, it
> creates a candidate and **stops advancing readings past the preceding day**.
> NAV never crosses an unclassified capital event.

A single unresolved candidate freezes the figures until it is classified. That
is the intended behaviour, not a limitation.

The failure it prevents is the most expensive one available in this product: an
unrecorded deposit is indistinguishable from profit, and profit gets split.
Without the interlock, wiring money into the account and letting the next reading
land silently redistributes that capital — either to investors who did not earn
it, or to the manager, depending on who held units at the time.

The interlock trades freshness for correctness, and says so on screen. Staleness
you can see beats freshness you cannot trust.

---

## 6. Numeric representation

No floating point appears anywhere in `engine/`.

| Quantity | Representation |
|---|---|
| Money | integer minor units (cents), `bigint` |
| Units | `bigint` scaled 1e-10 · `numeric(28,10)` in Postgres |
| Splits | basis points, integer — 40% is `4000` |
| NAV | never stored; computed from `(equityCents, units)` |

**Rounding principle:** round in the direction that never lets a holder extract
more value than they are entitled to. The residual is always sub-cent and
accrues to the pool, so it is shared pro-rata.

| Operation | Direction |
|---|---|
| Units issued on deposit | floor |
| Units redeemed on payout | ceil |
| Fee units retained | floor |
| Fee amount | floor — favours the investor |

---

## 7. Surfaces

| Route | Contents |
|---|---|
| `/` | account list, or redirect when there is one |
| `/a/[id]` | the desk — statement head, unit rail, KPI strip, holder table |
| `/a/[id]/ledger` | chronological activity: deposits, payouts, readings |
| `/a/[id]/review` | capital-event queue |
| `/a/[id]/holders/[hid]` | per-holder statement and history |
| `/a/[id]/journal` | closed trades, open positions, orders |
| `/a/[id]/calendar` | month calendar with day drill-down |
| `/a/[id]/performance` | equity curve with capital events marked, streaks, histogram |

Every money modal — post reading, add investor, add capital, pay out, classify
event — shows complete arithmetic before commit. Nothing is estimated.

---

## 8. Access control

The existing Supabase Auth directory is reused. It has `admin` and `user`;
Compound adds `investor`.

| Role | Sees |
|---|---|
| `admin` | everything. The manager is an admin — single operator |
| `user` | unchanged, no Compound access |
| `investor` | own holder record only — unused until v2 |

Manager identity is data, not a role: `compound_account.manager_user_id`. That
leaves the multi-account and multi-manager paths open without a role migration.

RLS is on every `compound_*` table from day one. `compound_ledger_entry` grants
`INSERT` and `SELECT` only — no `UPDATE`, no `DELETE`, to any role. That makes
"the ledger is append-only" a database guarantee rather than a convention, and
corrections happen as reversing entries.

---

## 9. Deployment

Mirrors copytraderx-license: multi-stage Node 23 alpine, Next.js standalone
output, behind the existing Traefik instance on the external `dev-net` network.

| Tier | URL | Entrypoint |
|---|---|---|
| Dev | `http://investment.test` | `web` |
| Local prod | `https://investment.lan` | `websecure` + TLS |

`NEXT_PUBLIC_*` variables are baked into the bundle at build time.
`SUPABASE_SERVICE_ROLE_KEY` is read at runtime and never reaches the browser.

### This repository is public

No `.env`, no Supabase project ref, no MT5 account number, no broker server name,
no real holder name, no real balance in any tracked file. Fixtures and seeds use
fictional data. Real figures live only in the runtime environment and in
git-ignored `*.local.md` notes.

---

## 10. Testing

| Layer | Approach |
|---|---|
| `engine/` | property-based (`fast-check`) — random operation sequences, replay, assert all five invariants |
| `engine/` | worked examples as regression fixtures |
| `reconcile/` | fixtures shaped from real history: duplicate-deal pairs, an unexplained balance move |
| `db/` | integration against a test project; append-only enforcement |
| UI | payout receipt and review queue arithmetic |

The property-based suite is the highest-value testing investment in the product.
A UI bug is an annoyance. An accounting bug is a dispute with someone who
trusted you with money.

**Gates:** `tsc --noEmit` and `jest`.

> `pnpm lint` is broken in copytraderx-license (eslint-config-next 16 against
> ESLint 9). Do not copy that configuration across without fixing it first.

---

## 11. Known upstream issue

The `deals` table contains duplicate rows for some trades: identical symbol,
side, volume, profit and swap, with times shifted by exactly the broker's UTC
offset, under an out-of-sequence ticket. Cause is broker server time stored as
if it were UTC on a subset of pushes.

Left unhandled they inflate trade counts, distort P/L, and generate false
capital-event candidates. `reconcile/dedupe.ts` defends against this rather than
depending on an upstream fix. The same defect affects the existing
copytraderx-license journal, calendar and performance pages and is tracked
separately.
