# Compound — Investor Desk · Design Spec

| | |
|---|---|
| **Version** | 1.0 — approved for planning |
| **Date** | 21 August 2026 |
| **Status** | Approved |
| **Source PRD** | `compound-prd.md` v0.1 |
| **Prototype** | `compound-investor-desk.html` |
| **Repo** | `ctx-investment` |

---

## 1. What this is

Compound is a fund administration desk for a single manager running pooled
MetaTrader accounts on behalf of themselves and a small number of investors.

It answers one question with certainty: **if this investor asked for their money
today, exactly how much would they get, and how much would I keep?**

It reuses the CopyTraderX journal, calendar and performance surfaces so the same
screen answers a second question — *how is the account actually trading* — which
the PRD defers to Phase 3.

### Relationship to CopyTraderX

CopyTraderX is the source of truth for market data. Its EA pushes to Supabase
tables that Compound reads and never writes:

| Table | Read for |
|---|---|
| `account_snapshots_current` | live equity, floating P/L, broker metadata |
| `account_snapshots_daily` | dated equity readings, balance reconciliation |
| `deals` | closed trades — journal, calendar, performance, reconciliation |
| `orders`, `positions` | journal surfaces |
| `licenses` | resolving an MT5 account to its owner |

Compound owns six new `compound_*` tables in the same Supabase project.

---

## 2. Decisions

Each of these overrides or extends the PRD. The rationale matters more than the
choice, because the rationale is what to re-examine if circumstances change.

| # | Decision | PRD said | Why we differ |
|---|---|---|---|
| D1 | Single-tenant, one manager | "confirm: multi-tenant SaaS" (§1) | Halves the build. Validate the accounting model on a real quarter before building tenancy. |
| D2 | Same Supabase project, `compound_`-prefixed tables | — | No sync layer means no staleness. The MT5 data is already there. |
| D3 | Automated equity readings with a capital-event review queue | manual entry, Phase 1 (§10) | The data already arrives. Deposits are *detectable*, so the PRD's most expensive bug can be prevented structurally rather than warned about. |
| D4 | Existing Supabase Auth, add an `investor` role | — | One user directory. Manager signs in with an existing account. |
| D5 | Multi-account from day one | A4 is P2 (§6.1) | An `account_id` foreign key is cheap now and painful to retrofit. Starts with the manager's live account as the only one. |
| D6 | Copy `lib/journal/`, rebuild the components | — | The pure functions are stable and tested. The components are exactly what should look different. |
| D7 | **Event-sourced accounting** | materialised `holder.units` + `cost_basis` (§8) | See below. |
| D8 | Equity readings live in the ledger, not a side table | separate `equity_reading` table (§8) | Readings are the only events that move NAV, so they must share one ordered log with deposits and payouts. |
| D9 | Investor portal deferred to v2 | V1–V3 are P1 (§6.6) | Matches the PRD's own Phase 2. Keeps v1 focused on correctness. |

### D7 — Event-sourced, in detail

`compound_ledger_entry` is the only truth. Units, cost basis, NAV and every
holder figure are derived by replaying it. `compound_holder` carries identity
and terms; it carries no balances.

Four reasons:

1. Goal G1 is *"any investor's balance is reproducible from the ledger alone."*
   Deriving makes that true by construction rather than by hope.
2. Scale is negligible. Four months of live trading is 111 daily snapshots and
   26 deals. At 20 holders over ten years this stays in the low thousands of rows.
3. E5 — void a reading via a reversing entry and recompute downstream state — is
   free when deriving and a backfill when materialising.
4. Property-based testing gets much cheaper. Generate a random sequence of
   operations, replay, assert the invariants. There is no second mutation path
   to verify.

If a page ever becomes slow, add a cached projection then. Cache invalidation
over an append-only log is easy; repairing a corrupted materialised balance is not.

---

## 3. Domain model

Unchanged from PRD §5, restated here so this document stands alone.

### 3.1 Units

```
NAV per unit      = account_equity / units_issued
Units on deposit  = deposit_amount / NAV
Holder value      = holder_units × NAV
Holder profit     = holder_value − cost_basis
```

A deposit issues units at the prevailing NAV, which is arithmetically incapable
of moving anyone else's NAV. That is what solves staggered entry.

**Genesis.** When `units_issued = 0`, NAV is defined as 1.00 and the first
deposit issues one unit per dollar.

### 3.2 Cost basis and the high-water mark

Each holder carries a cost basis — lifetime capital contributed and not yet
withdrawn. Profit is measured against it, which produces a high-water mark as a
side effect rather than as a separate mechanism.

- Increases on deposit.
- **Unchanged** by a profit-only withdrawal.
- Resets to zero on full exit.
- While `value < basis`, profit is negative, fee is zero, and the account must
  recover before any fee applies again.

### 3.3 The split

Performance fee crystallises **only on withdrawal**, never on a paper gain.
Default 60% investor / 40% manager, overridable per holder.

```
fee            = max(0, profit) × manager_split
investor_gets  = (mode = exit) ? value − fee : max(0, profit) − fee
units_redeemed = ((mode = exit) ? value : max(0, profit)) / NAV
```

### 3.4 Fee settlement

- **Retain as units** — cash stays in the account; the manager is issued
  `fee / NAV` units.
- **Withdraw as cash** — equity reduces by the fee; no units issued.

Both settle at constant NAV. Proof over the rationals, writing `d = gross − fee`
— see §3.5 invariant 3 for what integer rounding does to this in practice:

```
retain: equity₁ = equity₀ − d          units₁ = units₀ − d/NAV₀
        NAV₁ = (equity₀−d) / (units₀ − d/NAV₀) = NAV₀
cash:   equity₁ = equity₀ − gross      units₁ = units₀ − gross/NAV₀
        NAV₁ = (equity₀−gross) / (units₀ − gross/NAV₀) = NAV₀
```

### 3.5 Invariants

Asserted in property-based tests and in a nightly job.

| # | Invariant | Holds |
|---|---|---|
| 1 | `Σ holder_units = units_issued` | **exactly** — units are integers that sum exactly |
| 2 | `Σ holder_value = account_equity` | **exactly** — value is a pure function of units |
| 3 | A deposit, payout, exit or fee settlement **never decreases** NAV | see below — the exact-equality form is false under integer rounding |
| 4 | `fee ≥ 0` | always |
| 5 | Ledger is append-only; corrections are reversing entries | enforced by policy + no UPDATE grant |

Invariants 1 and 2 are exact rather than "within tolerance" — a direct
consequence of D7. Materialised balances would make them approximate.

**Invariant 3 was originally stated as "NAV is unchanged", and that is wrong.**
The algebra in §3.4 is exact over the rationals, but the engine works in
integers: `valueOfUnits` floors, `unitsForDeposit` floors, `unitsToRedeem`
ceils. Each of those leaves a sub-cent residual in the pool, which nudges NAV
*upward*. Simulating 25,043 randomised transitions found exact NAV equality
violated in 2.80% of them — and NAV decreasing in none.

So the true invariant is monotonic, not static:

> Only an equity reading may move NAV downward. Every other operation leaves
> NAV equal or very slightly higher, by at most the rounding residual.

This is not a weakening. It is the §4 rounding policy — *the residual accrues
to the pool* — restated as something testable, and it asserts the property that
actually matters: **value can never leak out of the pool.** A NAV decrease on a
deposit or payout would mean a holder extracted more than they were owed, and
that is what invariant 3 now forbids. Exact equality still holds, and is still
asserted, wherever the divisions terminate.

### 3.6 Validation against live data

The model was replayed against the manager's real account history before this
spec was written, using the actual `account_snapshots_daily` series and the
detected capital event. The replay confirmed:

- A deposit mid-series issued units at the prevailing NAV and left NAV unchanged
  to the fourth decimal, as §3.1 requires.
- Holder values summed to account equity **exactly**, to the cent — invariant 2.
- Unit totals summed to units issued exactly — invariant 1.
- Since-inception NAV growth matched the balance series independently derived
  from closed trades plus the classified deposit.

Figures are deliberately omitted here; the repository is public and they are the
manager's own position. The full worked replay is kept locally at
`docs/design/validation-real-data.local.md`, which is git-ignored. Those figures
are reproduced as fixtures in the test suite with fictional amounts that exercise
the same cases.

## 4. Numeric representation and rounding

The prototype uses JavaScript numbers. That is acceptable for a visual mock and
not for production.

| Quantity | Representation | Notes |
|---|---|---|
| Money | integer minor units (cents), `bigint` | never float |
| Units | `bigint` scaled 1e-10; `numeric(28,10)` in Postgres | rounding at 2dp accumulates visible drift against invariant 1 |
| Splits | basis points, integer — 40% is `4000` | avoids float comparison entirely |
| NAV | **never stored**; computed from the `(equity_cents, units)` pair | a division that rarely terminates |
| Dates | `occurred_on` is a broker-server date; `recorded_at` is UTC | different facts, both matter in a dispute |

### Rounding policy

The governing principle: **round in the direction that never lets a holder
extract more value than they are entitled to.** The residual — always sub-cent —
accrues to the pool and is therefore shared pro-rata by all holders.

| Operation | Formula | Direction |
|---|---|---|
| Units issued on deposit | `amount_cents × units / equity_cents` | **floor** |
| Units redeemed on payout | `gross_cents × units / equity_cents` | **ceil** |
| Fee units retained | `fee_cents × units / equity_cents` | **floor** |
| Fee amount | `profit_cents × split_bps / 10000` | **floor** (favours the investor) |

All four are exact integer operations on `bigint`. No floating point appears
anywhere in `engine/`.

**Valuation is allocated, not floored.** The rule above governs operations that
*move* value. Reporting a holder's value is different: flooring each holder
independently loses up to one cent per holder, which would make invariant 2
approximate. `allocateValues()` therefore uses largest-remainder allocation —
floor everyone, then award the shortfall to the largest fractional entitlements,
ties broken by holder order. That keeps `Σ holder_value = equity` exact while
never letting a rounding artefact leave the pool.

`equity_reading.nav` is not stored. Where a NAV figure must be displayed it is
computed and rounded to 4dp at the presentation boundary only.

---

## 5. Architecture

### 5.1 Module boundaries

```
lib/compound/
  engine/          pure. no I/O. never imports db/
    money.ts       integer minor units, bigint unit scaling, rounding helpers
    nav.ts         nav, unitsForDeposit, valueOf, profitOf
    quote.ts       payout arithmetic (§3.3) — returns without committing
    replay.ts      fold(LedgerEntry[]) -> PoolState
    invariants.ts  the five assertions from §3.5
  reconcile/       pure. daily balance vs closed-trade P/L -> candidate events
    dedupe.ts      upstream duplicate-deal guard (§6.3)
    detect.ts      the reconciliation algorithm
  db/              the only I/O. queries + the append-only writer
lib/journal/       copied verbatim from copytraderx-license, unchanged
```

**The rule that matters: `engine/` never imports `db/`.** The entire accounting
model is testable with generated ledgers and no database. That is what makes
property-based testing cheap enough to actually do.

`PoolState` is the single output of replay and the single input to every screen:

```ts
interface PoolState {
  accountId: number
  equityCents: bigint
  units: bigint                    // scaled 1e-10
  holders: HolderState[]           // units, basisCents, status, splitBps
  lastReadingOn: string | null     // YYYY-MM-DD
  seq: number                      // last applied ledger seq
}
```

### 5.2 Data flow

```
EA ──push──> account_snapshots_daily ─┐
             deals ──> dedupe ────────┤
                                      ├─> reconciler ──unexplained──> candidate
                                      │        │                          │
                                      │        └──explained──┐      (blocks here)
                                      │                      ▼
                                      └────────────> compound_ledger_entry
                                                             │
                                                          replay
                                                             ▼
                                                         PoolState
                                                             │
                                              desk · journal · calendar · performance
```

Two distinctions that must be right:

- **Reconcile on `balance`, post readings on `equity`.** Deposits move balance;
  floating P/L does not. Detection needs balance. NAV needs equity, because a
  holder's value includes their share of open positions.
- **Committed NAV versus live NAV.** The desk displays live NAV from
  `account_snapshots_current`. A payout may never settle against a drifting
  intraday figure — it writes an equity reading capturing the exact equity used,
  then the payout entry, in one transaction.

### 5.3 The safety interlock

> When the reconciler finds an unexplained balance move on day D, it creates a
> candidate and **stops advancing readings past D−1**. NAV never crosses an
> unclassified capital event.

One unresolved candidate freezes the figures until it is classified. This is
deliberate, and it is the structural answer to PRD §6.2's E4 note. On the real
account it would have paused on 25 June and asked one question, instead of
silently recording an investor's $310 as manager profit.

The PRD's own risk section makes the argument: transparency about staleness is
more valuable than the appearance of freshness.

---

## 6. Data model

Six tables, all prefixed `compound_`. Sketch, not final DDL.

```sql
compound_account
  id                 bigserial primary key
  mt5_account        bigint not null unique
  label              text not null
  broker             text
  currency           text not null default 'USD'
  default_split_bps  int  not null default 4000
  inception_date     date not null
  manager_user_id    uuid not null references auth.users
  created_at         timestamptz not null default now()

compound_holder
  id           bigserial primary key
  account_id   bigint not null references compound_account
  name         text not null
  email        text
  user_id      uuid references auth.users        -- set when portal access lands (v2)
  is_manager   boolean not null default false
  split_bps    int not null
  joined_at    date
  status       text not null check (status in ('active','closed'))
  created_at   timestamptz not null default now()
  -- deliberately absent: units, cost_basis, lifetime_deposited,
  -- lifetime_withdrawn, lifetime_fees. All derived from the ledger.

compound_ledger_entry
  id                 bigserial primary key
  account_id         bigint not null references compound_account
  holder_id          bigint references compound_holder     -- null for readings
  seq                bigint not null                       -- replay order
  occurred_on        date not null                         -- broker-server date
  recorded_at        timestamptz not null default now()    -- UTC
  type               text not null check (type in
                       ('deposit','payout','exit','equity_reading','adjustment'))
  amount_cents       bigint not null
  fee_settlement     text check (fee_settlement in ('units','cash'))
  split_bps_applied  int
  note               text
  reverses_id        bigint references compound_ledger_entry
  created_by         uuid references auth.users
  unique (account_id, seq)
  -- deliberately absent: units_delta, nav_at_entry. Both derived.

compound_capital_event_candidate
  id                        bigserial primary key
  account_id                bigint not null references compound_account
  trade_date                date not null
  balance_delta_cents       bigint not null
  explained_cents           bigint not null
  unexplained_cents         bigint not null
  status                    text not null default 'pending'
                              check (status in ('pending','classified','ignored'))
  resolved_ledger_entry_id  bigint references compound_ledger_entry
  detected_at               timestamptz not null default now()
  resolved_at               timestamptz
  resolved_by               uuid references auth.users
  unique (account_id, trade_date)

compound_reconcile_cursor
  account_id         bigint primary key references compound_account
  last_reading_date  date
  last_run_at        timestamptz

compound_audit
  id           bigserial primary key
  actor        uuid references auth.users
  action       text not null
  entity       text not null
  entity_id    bigint
  prior_state  jsonb
  at           timestamptz not null default now()
```

### 6.1 Why the ledger stores inputs, not outputs

No `units_delta`, no `nav_at_entry`. Both are derived, and storing them creates a
second truth that can disagree with the engine after any change to it.

`split_bps_applied` is the exception: the terms in force at the moment of a
payout are an *input*, since a holder's split may change afterwards.

Two types from the PRD's sketch are also absent. There is no `fee` entry — a fee
is always settled inside the payout that crystallised it, and a separate applied
entry would double-count; `fee_settlement` carries the units-or-cash choice.
There is no `payout_mode` column either, because `type` is already `payout` or
`exit` and the mode is derived from it.

### 6.2 Why `seq`, not `occurred_on`, defines replay order

`seq` is monotonic per account and assigned server-side. Two events on the same
date still have a definite order, which is what makes the same-day
deposit-then-reading case deterministic. This satisfies PRD §7.1's atomicity
requirement without relying on the manager sequencing two actions correctly.

### 6.3 Upstream duplicate deals — known issue

The `deals` table contains duplicate rows for some trades: identical symbol,
side, volume, profit and swap, with `open_time` and `close_time` shifted by
exactly the broker's UTC offset, under an out-of-sequence ticket. The cause is
broker server time being stored as if it were UTC on a subset of pushes.

On the live account three such pairs exist, clustered in a single week, shifted
by the broker's GMT offset. Left in place they inflate trade counts and distort
P/L; they would also generate three false capital-event candidates.

`reconcile/dedupe.ts` groups on `(symbol, side, volume, profit, swap)` and, where
close times differ by exactly the broker offset, keeps the lowest ticket.

**Verified on real history:** with dedup applied, summed closed-trade P/L
reconciles against the balance series to a residual of exactly zero across the
whole period, and the reconciler produces exactly one candidate — the real
deposit — with zero false positives. Without dedup the residual is non-zero and
three spurious candidates appear. Specific tickets and amounts are in the
git-ignored local validation note.

This is an upstream defect that also affects the existing copytraderx-license
journal, calendar and performance pages. It is tracked separately. Compound
defends against it rather than depending on it being fixed.

## 7. Surfaces

| Route | Contents | Source |
|---|---|---|
<!-- "reused logic" = lib/journal pure functions copied per D6; components rebuilt against §8 -->
| `/` | account list, or redirect when there is only one | new |
| `/a/[id]` | the desk — statement head, unit rail, KPI strip, holder table | new |
| `/a/[id]/ledger` | chronological activity — deposits, payouts, readings (R3) | new |
| `/a/[id]/review` | capital-event queue | new |
| `/a/[id]/holders/[hid]` | per-holder statement and history | new |
| `/a/[id]/journal` | closed trades, open positions, orders | reused logic, new UI |
| `/a/[id]/calendar` | month calendar with day drill-down | reused logic, new UI |
| `/a/[id]/performance` | equity curve with capital events marked (R4), streaks, histogram | reused logic, new UI |

Modal flows: post equity reading, add investor, add capital, pay out, classify
capital event. Each shows full arithmetic before commit, per PRD P2.

**Requirements coverage.** v1 delivers PRD P0 in full — A1–A3, E1–E4, I1–I5,
P1–P5, R1–R5 — plus E6 and R4's capital-event marking, which the PRD scheduled
for later phases but which come nearly free given D3. Deferred: I6–I7, P6–P8,
R6–R8, and all of §6.6 (investor portal).

---

## 8. Design system

Direction: **Statement** — editorial, reads like a printed fund statement.
Selected from three mocked alternatives; the ownership rail uses a green ramp.

### 8.1 Tokens

```css
--paper:      #E7EAEF;   /* page ground */
--card:       #FFFFFF;
--ink:        #0F1B2D;   --ink-2: #4A5768;   --ink-3: #8A96A6;
--rule:       #D2D8E0;   --rule-soft: #E6EAEF;

--gain:       #0B6B45;   /* P/L positive  — 6.56:1 on white */
--loss:       #A32A2B;   /* P/L negative */

--own:        #14532D;   /* manager's rail segment — 9.11:1 on white */
--own-2:      #D6E9DE;   /* investor tint, hatched */

--fee:        #F59E0B;   /* structural only — fills, chips, marks */
--fee-ink:    #B45309;   /* fee text — 5.02:1 on white */
--fee-bg:     #FEF6E4;
```

### 8.2 Colour semantics

Three meanings, each with one hue, none overloaded:

| Hue | Means | Where |
|---|---|---|
| Green ramp | **the pool, divided** — darkest first | ownership rail, share bars |
| Gain/loss green & red | **P/L direction** | Open P/L, daily figures, equity curve |
| Amber | **the fee** | fee column, fee KPI, the one receipt line |

The ownership rail uses `--own` at 9.11:1 rather than reusing `--gain`. Reusing
the gain green would make green mean both "profitable" and "yours" on the same
screen. Teal and emerald were rejected: both sit at 1.20:1 against `--gain`, so
they separate by hue alone and disappear for a colourblind reader. Only a
markedly darker green separates by lightness.

Additional holders take progressively lighter tints of the same green, so the
palette scales without inventing a hue per person.

### 8.3 Type

| Role | Face |
|---|---|
| Display — brand mark, modal headings | Instrument Serif |
| UI — labels, body, controls | Inter |
| All figures | IBM Plex Mono, `font-variant-numeric: tabular-nums` |

Every number in the product is monospaced and tabular. Columns of money must not
shift width between renders.

### 8.4 Accessibility floor

- Body and figure text ≥ 4.5:1; large display text ≥ 3:1.
- Colour never sole carrier of meaning — the rail is labelled, P/L carries sign.
- Visible focus rings; `prefers-reduced-motion` respected.
- Verified at 375 / 768 / 1024 / 1440.

---

## 9. Auth and access

Reuses the existing Supabase Auth directory.

The existing directory has two roles, `admin` and `user`. Compound adds one.

| Role | Sees |
|---|---|
| `admin` | everything, all accounts. **The manager is an admin** — single-tenant, single operator (D1) |
| `user` | unchanged; no Compound access |
| `investor` | own holder record only — **new, and unused until v2** |

Manager identity is modelled as data, not as a role:
`compound_account.manager_user_id`. That keeps D5's multi-account path open
without a role per manager, and means D1 can be relaxed later without a role
migration.

RLS on every `compound_*` table from day one, keyed on
`compound_account.manager_user_id`. `compound_ledger_entry` grants INSERT and
SELECT only; no UPDATE or DELETE to any role, which is what makes invariant 5
structural rather than a convention.

Compound stores no trading credentials. It reads MT5 data that the EA already
pushed and can place no trades.

---

## 10. Deployment

Mirrors copytraderx-license: multi-stage Node 23 alpine, Next.js standalone
output, behind the existing Traefik on the external `dev-net` network.

| Tier | URL | Entrypoint |
|---|---|---|
| Dev | `http://investment.test` | `web` |
| Local prod | `https://investment.lan` | `websecure`, TLS |

`NEXT_PUBLIC_*` variables are baked at build time; `SUPABASE_SERVICE_ROLE_KEY`
is read at runtime and never reaches the browser.

### Secrets discipline

The repository is public. Therefore:

- No `.env` committed; `.env.example` carries empty values and no project ref.
- No Supabase project ref, account number, broker name or real holder name in
  tracked files.
- Fixtures and seeds use fictional names and amounts.
- A pre-commit check greps for key patterns and known identifiers.

Real data exists only in the runtime environment and in this spec's validation
section, which uses the manager's own account and no third-party names.

---

## 11. Testing

| Layer | Approach |
|---|---|
| `engine/` | **property-based** (`fast-check`) — generate random sequences of deposits, readings, payouts and exits; replay; assert all five invariants |
| `engine/` | worked examples from PRD §5.1 and §3.6 as regression fixtures |
| `reconcile/` | fixtures derived from real account history — anonymised amounts, same shapes: the duplicate-deal pairs, and an unexplained balance move that must become a candidate |
| `db/` | integration against a test Supabase project; append-only enforcement |
| UI | component tests for the payout receipt and review queue arithmetic |

The property-based suite is the highest-value investment in the product. A UI
bug is an annoyance; an accounting bug is a dispute with someone who trusted you.

**Gates:** `tsc --noEmit` and `jest`. Note that `pnpm lint` is currently broken
in copytraderx-license (eslint-config-next 16 against ESLint 9); do not copy that
configuration across without fixing it.

---

## 12. Out of scope for v1

- Investor portal, magic links, statements (PRD §6.6, R6) — v2
- Partial capital withdrawal (P6), payout PDF (P7), scheduled payouts (P8)
- Time-weighted return (R7), manager earnings report (R8)
- Multi-currency
- Multi-tenancy — deferred, not designed out
- Trading. Compound places no orders and holds no credentials, permanently

---

## 13. Open questions

Carried from PRD §13, none blocking implementation.

1. **Is the manager's own capital visible to investors?** Matters when the portal
   lands in v2, not before. Default: hidden.
2. **Withdrawal-only crystallisation, or optional periodic?** v1 implements
   withdrawal-only — simpler and more generous to the investor.
3. **Partial withdrawal: pro-rata basis reduction or LIFO?** Deferred with P6.
4. **Multi-currency.** FX at deposit is straightforward; FX at payout is not.
   Deferred, not designed out.
5. **Regulatory.** Pooling third-party capital and charging a performance fee is
   very likely an investment contract under Philippine SEC rules. This attaches
   to the trading operation, not to Compound as software, but it governs whether
   the desk can be operated beyond the current circle. Securities counsel before
   onboarding further investors or any public marketing. Not a software task, and
   not one this spec can discharge.
