# Compound Persistence Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Compound's persistence layer — the six `compound_*` tables with RLS, a database-enforced append-only ledger, the query layer that maps CopyTraderX and Compound rows onto the types `engine/` and `reconcile/` already define, and the writer that commits a reading plan in one transaction — all proven against a local Supabase and stopping short of the live project.

**Architecture:** Four SQL migrations under `supabase/migrations/` create the schema, the RLS policies, the append-only enforcement, and one `plpgsql` function. Six TypeScript modules under `lib/compound/db/` are the only place in the product that performs I/O. They talk to Postgres directly through `pg`, never through PostgREST, because PostgREST serialises `bigint` and `numeric` as JSON numbers and spec §4 forbids float on money. Every money value is converted to integer minor units **in SQL**, using Postgres `numeric` arithmetic, and arrives in JavaScript as a string that `BigInt()` parses exactly. `db/` imports types from `engine/replay.ts` and `reconcile/`; it never redefines them, and neither of those modules ever imports `db/`.

**Tech Stack:** TypeScript 5 (strict), Jest 29 + ts-jest, `pg` 8 (node-postgres), Supabase CLI local stack (Postgres 17), pnpm 10, Node 23. No ORM, no query builder, no `@supabase/supabase-js` in this layer.

**Spec:** [`docs/superpowers/specs/2026-08-21-compound-investor-desk-design.md`](../specs/2026-08-21-compound-investor-desk-design.md) — §5.2 (data flow), §6 (data model), §6.1 (inputs not outputs), §6.2 (`seq`, not `occurred_on`), §9 (auth and RLS), §10 (deployment and secrets discipline).

---

## Scope note — read before starting

This is one plan, deliberately, but it is a large one: schema, RLS, append-only enforcement, a read layer and an atomic writer. It is held together as a single plan because the pieces are not separable in practice — the writer's tests are meaningless without the schema, and the append-only guarantee is only observable through the query layer that respects it.

It is structured in two phases with a hard checkpoint between them:

| Phase | Tasks | Ends at |
|---|---|---|
| **A — the database** | 1–4 | Schema, RLS and append-only enforcement all proven locally, with every test shown to fail when its protection is removed |
| **B — the TypeScript layer** | 5–9 | `lib/compound/db/` reads and writes those tables, and a full round trip folds to a `PoolState` that passes `assertInvariants` |

**If the executor wants two plans, split after Task 4.** Phase A is independently mergeable and independently valuable. Phase B cannot start before it. Do not split anywhere else — Tasks 5–9 share one test harness and one set of fixtures.

## Prerequisites — this plan cannot start until these are merged

- [ ] **`chore/local-supabase`** — provides `supabase/config.toml`, the local stack, the CopyTraderX fixture tables and the seed. See "The local stack" below for exactly what it gives you.
- [ ] **`feat/reconciler` and `feat/reconcile-detect`** — Tasks 7, 8 and 9 import `ReconcileCursor`, `PlannedReading`, `CapitalEventCandidate` and `ReadingPlan` from `lib/compound/reconcile/interlock.ts`, and `dedupeDeals` from `lib/compound/reconcile/dedupe.ts`. Tasks 1–6 do not, so Phase A can proceed in parallel with the reconciler.

## Where this plan stops

**This plan never touches the live CopyTraderX Supabase project.** Every migration is developed and proven against the local stack only. Applying them to CopyTraderX is a separate, human-approved step that happens after this plan is merged and reviewed. Task 9's final step is a written STOP, not a deploy.

> **Never run `supabase link` or `supabase db push` in this repository.** The Supabase CLI on this machine carries an ambient login session for an unrelated organisation, so a stray `link` can genuinely reach a real hosted project. There is no project ref stored in this worktree and none may be added. `supabase db reset` is local-only and is the command you want.

---

## The local stack — what it actually provides

Verified against the running containers, not assumed. Everything below comes from `supabase/config.toml` on `chore/local-supabase`.

| Thing | Value |
|---|---|
| API | `http://127.0.0.1:54621` |
| Database | `postgresql://postgres:postgres@127.0.0.1:54622/postgres` |
| Studio | `http://127.0.0.1:54623` |
| Keys | The standard fixed Supabase **local demo** keys — same on every machine, not secret, not project-specific. `supabase status` prints them. This plan never needs them: it connects on the database port. |

Two other Supabase stacks already run on this machine (`labaan-backend` on 5432x, `race-pace` on 5452x), which is why this one is on 5462x. Do not "correct" the ports back to defaults.

**Commands**, all from the repository root:

```bash
supabase start                        # bring the stack up — it is stopped by default
supabase stop                         # down, keeping the volume
supabase status                       # ports, URLs, keys
supabase db reset                     # drop, recreate, reapply every migration, rerun seed.sql
supabase migration new <name>         # scaffold a migration with a real timestamp
supabase migration list --local       # what is applied
docker exec -u postgres supabase_db_ctx-investment psql -U postgres -d postgres
```

There is no apply-one-migration path — this is an imperative-migrations project with no `supabase/schemas/`, so **`supabase db reset` is the iteration loop**. That is normal here, not a limitation to design around. The host has no `psql` client; use the `docker exec` form above.

**Always generate migration filenames with `supabase migration new <name>`.** Never hand-invent a timestamp. The filenames shown in this plan are illustrative; use whatever the CLI produces, and it will sort after the fixture migration automatically.

**The CopyTraderX fixture tables** (`supabase/migrations/*_copytraderx_fixture_tables.sql`) are local stand-ins for tables Compound reads and never writes. They must never be applied to the live project — the migration says so loudly at the top. Their shapes:

| Table | Shape that matters |
|---|---|
| `account_snapshots_daily` | `mt5_account bigint`, `trade_date date`, `balance_close/equity_close/daily_pnl numeric(18,2)` — **decimal dollars, not cents** |
| `account_snapshots_current` | `mt5_account bigint`, `balance/equity/floating_pnl numeric(18,2)`, `currency text`, `server text`, `pushed_at timestamptz` |
| `deals` | `mt5_account bigint`, `ticket bigint`, `symbol/side text`, `volume numeric` **in lots, not milli-lots**, `open_time/close_time timestamptz`, `profit/swap/commission numeric(18,2)` |
| `licenses` | `mt5_account bigint`, `user_id uuid` → `public.users(id)` |
| `users` | The application-level projection of `auth.users`: `id`, `email`, `role text check (role in ('admin','user'))`, `full_name`, `must_change_password` |

RLS is on for all of them with **no** anon/authenticated policies and `SELECT` granted to `service_role` only. Note what that implies and do not forget it for the `compound_*` grants: **RLS bypass and table grants are independent layers.** `service_role` has `BYPASSRLS` and still cannot read a table it has no `SELECT` grant on.

**The seed** (`supabase/seed.sql`, re-run on every `supabase db reset`) — all fictional:

| Fact | Value |
|---|---|
| MT5 account | `90000001` |
| `account_snapshots_daily` | 10 weekday rows, `2026-08-03` … `2026-08-14` |
| Unexplained balance jump | `2026-08-12`, **+5000.00** (50745.00 → 55745.00), `daily_pnl 0.00`, no deals that day |
| Duplicate deal pair | tickets `90010004` (real, closes `2026-08-06T08:00:00Z`) and `90019999` (duplicate, closes `2026-08-06T11:00:00Z`); both `open_time` **and** `close_time` shifted +3h in the same direction; `EURUSD sell 0.10, profit 80.00, swap 0.00` |
| Weekend gap | daily rows Fri `2026-08-07` and Mon `2026-08-10`, nothing between; ticket `90010006` (`BTCUSD`) closes Sat `2026-08-08` for `200.00`, exactly the Fri→Mon delta |
| `account_snapshots_current` | balance `55805.00`, equity `55930.00` — a `+125.00` floating P/L present in no deal, there to exercise the committed-versus-live NAV distinction |
| Auth users | `00000000-0000-0000-0000-000000000001` `manager@example.com` (`admin`), `00000000-0000-0000-0000-000000000002` `investor@example.com` |
| `compound_*` rows | none — those tables do not exist until Task 2 |

**A known gap, stated rather than assumed away:** the fixture `deals` table has no open/closed discriminator, and every seeded row is a closed trade. If the real `deals` table ever carries rows for open positions, nothing in this plan's fixtures would catch a query that failed to filter them out. Task 6 notes where that filter would go.

---

## Decisions this plan makes that the spec did not settle

Each of these is a visible choice, not silent drift. Fold them back into the spec before plan 4.

| # | Decision | Why |
|---|---|---|
| **P1** | **`manager_user_id` references `public.users(id)`, not `auth.users`.** Same for `holder.user_id`, `ledger.created_by`, `candidate.resolved_by`, `audit.actor`. | Spec §6's sketch says `auth.users`. CopyTraderX's own migrations put an application-level projection table in between, and `licenses`, `subscriptions` and `subscription_extensions` — the tables Compound sits closest to — all reference `public.users(id)`. Compound's account is owned by an application user *with a role*, which is exactly what `public.users` models. Following the established convention beats inventing a third pattern. |
| **P2** | **`db/` talks to Postgres through `pg`, not through PostgREST / `supabase-js`.** | PostgREST serialises `bigint` and `numeric` as JSON numbers. Spec §4 forbids float on money, and `9007199254740993` becomes `9007199254740992` on that path. `pg` returns `int8` as a string, which `BigInt()` parses exactly. The atomic writer also needs a real row lock and the concurrency test needs two sessions, neither of which PostgREST offers. |
| **P3** | **Money is converted to integer cents in SQL, never in JavaScript.** | `round(balance_close * 100)::bigint` on a `numeric` column is exact decimal arithmetic. Verified: `Math.trunc(10000.05 * 100)` is `1000004`, one cent short. Nothing in `db/` multiplies a money value by 100. |
| **P4** | **Every pooled connection runs `set role service_role`.** | Otherwise the application connects as `postgres`, which owns the tables and carries `BYPASSRLS` — and a table owner's implicit privileges make every grant in this plan decorative at runtime. Under `service_role` the grants actually bind. |
| **P5** | **Policies gate on the admin claim with `AND`, and isolate on `manager_user_id`.** They do not give admins a bypass arm. | Spec §9 says both "`admin` sees everything, all accounts" and "RLS … keyed on `compound_account.manager_user_id`". Under D1 those coincide, because there is one admin. An `OR is_admin()` arm would make RLS a no-op for the only role that uses the product, and would make every isolation test in Task 3 unfalsifiable. The role claim keeps a `user`-role account out of Compound entirely; ownership decides which account's rows you see. |
| **P6** | **`compound_audit` gains a nullable `account_id`.** | Spec §9 requires RLS "keyed on `compound_account.manager_user_id`" on every `compound_*` table, and the §6 sketch of `compound_audit` has no column that key can reach. Nullable, because an action may precede any account existing; the actor arm of the policy covers those rows. |
| **P7** | **The append-only guarantee is enforced by triggers as well as grants.** | Grants do not apply to a table's owner, and this plan's own migrations run as the owner. Verified: a `before update or delete or truncate` trigger refuses even `postgres`. Spec §9 asks for the grants; the triggers are what make the guarantee hold against every role there is. Also verified: on this Supabase version the default privileges grant no `UPDATE` to anyone, so **a test of the revoke alone passes with the revoke deleted** — see Task 4. |
| **P8** | **The ledger carries two check constraints and one foreign key** turning three of `replay.ts`'s four runtime throws into row refusals, and **`compound_holder` gets a one-manager-per-account partial unique index.** | `replay.ts` resolves the fee-receiving manager with `find(h => h.isManager)`. With two managers it silently picks whichever row came back first. A refusal at write time beats a wrong number at render time. **Corrected after implementation:** this entry originally read "three check constraints" for three throws. There are four throws, and one of the three that are covered is enforced by the `holder_id` foreign key (`contype = 'f'`), not a CHECK. The fourth is P9. |
| **P9** | **The "fee crystallised but no manager holder was seeded" throw is enforced by the writer, not the database.** Account creation seeds its manager holder in the same transaction, and a writer-level integration test covers it. | It cannot be a CHECK at all — Postgres rejects subqueries and cross-row references in CHECK outright, so this is a hard limit rather than a style preference. A deferred constraint trigger counting `is_manager` rows per account would work, and Task 4 already uses that mechanism family for append-only. But it would only prove the invariant for the `compound_holder` table, and the actual failure path is the `HolderSeed[]` array the query layer hands to `fold()` — one step removed, and reachable through a query bug the trigger never sees. Guarding the table while the array stays unguarded buys confidence, not safety. |

**One spec observation, no action needed.** §4 specifies units as `numeric(28,10)` in Postgres. Under D7 and §6.1 no table stores units at all — they are derived by folding. That clause is vestigial and no column in this schema implements it. Worth deleting from the spec rather than leaving as a trap for the next reader.

---

## Global Constraints

Values below are copied from the spec, not paraphrased.

- **Money:** integer minor units (cents) as `bigint` in TypeScript, `bigint` in Postgres. Never float, anywhere, in any direction. (§4)
- **Units:** `bigint` scaled 1e-10 in TypeScript. **No `compound_*` table stores units.** (§4, §6.1)
- **Splits:** basis points, integer. 40% is `4000`. Valid range `0..10000`. `compound_account.default_split_bps` defaults to `4000`. (§4, §6)
- **NAV:** never stored. Computed from an `(equity_cents, units)` pair at the point of use. No column named `nav` exists in this schema. (§4, §6.1)
- **Dates:** `occurred_on` is a broker-server date (`date`); `recorded_at` is UTC (`timestamptz default now()`). Different facts, both kept. (§4, §6)
- **The ledger stores inputs, not outputs.** No `units_delta`, no `nav_at_entry`. `split_bps_applied` is the single exception — the terms in force at the moment of a payout are an input. (§6.1)
- **`seq`, not `occurred_on`, defines replay order.** `seq` is monotonic per account and **assigned server-side**, inside the writer function, under a row lock. (§6.2)
- **Ledger entry types:** exactly `('deposit','payout','exit','equity_reading','adjustment')`. There is no `fee` type and no `payout_mode` column. (§6, §6.1)
- **Candidate status:** exactly `('pending','classified','ignored')`. **Holder status:** exactly `('active','closed')`. (§6)
- **RLS on every `compound_*` table from day one, keyed on `compound_account.manager_user_id`.** (§9)
- **`compound_ledger_entry` grants `INSERT` and `SELECT` only — no `UPDATE`, no `DELETE`, to any role.** This is what makes invariant 5 structural rather than a convention. (§9, §3.5)
- **The project's two RLS idioms, and no third.** Ownership is `<column> = auth.uid()`. The admin claim is `(auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'`. Reading `raw_app_meta_data` directly works in a SQL session and **not** inside a policy evaluating a request; do not write it.
- **Single-tenant (D1).** The manager is an `admin`. There is **no `investor` role** — `public.users.role` is `check (role in ('admin','user'))`, and a third value would mean altering a constraint on a table the EA depends on. Investor access is data, not a claim: `compound_holder.user_id` links a holder to a user, and a v2 policy can ask whether the requesting user is that holder. Do not write investor policies, investor tables, or investor tests.
- **Same Supabase project (D2).** The `compound_*` tables live beside the CopyTraderX tables. No separate database, no sync layer.
- **Multi-account from day one (D5).** Every table except `compound_account` carries `account_id`. No query may assume there is only one account, and no test may use only one.
- **The repository is public (§10).** No project ref, no real account number, no broker name, no real holder name, no key, in any tracked file. All fixtures use fictional values. The only connection string in tracked source is the local `postgres:postgres@127.0.0.1` one, which is not a secret.
- **TypeScript** `strict: true`, `target: "ES2022"`, `noUncheckedIndexedAccess: true`.
- **Gates:** `pnpm typecheck`, `pnpm test` (unit), `pnpm test:db` (integration). Do not add ESLint; `eslint-config-next` is broken against ESLint 9 in the sibling project.
- **Use `127.0.0.1`, never `localhost`.** Docker on this machine resolves `localhost` to IPv6 first and the Postgres container publishes on IPv4.

---

## Lessons from the engine build — apply these, they are the point

The engine build shipped **nine assertions that could not fail**, in five shapes: fixtures where floor equals ceil, divisions that terminate, tautologies, reflexivity, and a guard shadowed by a deeper guard of the same error class. Two structural variants followed: a property whose skip conditions swallowed two-thirds of its cases, and one that inspected only final state so a later operation tidied the violation away. Every one was written by a plan author.

Database tests have their own versions of the same disease. Each row below is a real trap, checked against the running local stack before this plan was written:

| Shape | What it looks like here | Why it hides |
|---|---|---|
| **Insert, read back, call it proof** | `insert …; select …; expect(rows).toHaveLength(1)` | Proves the connection works. Says nothing about any constraint. |
| **RLS tested as the wrong role** | Running the query as `postgres` | Verified: `postgres` has `rolbypassrls = true` and owns the tables. RLS never runs. Passes with RLS disabled. |
| **RLS tested as `service_role`** | Same, via the service key | Verified: `service_role` has `rolbypassrls = true`. RLS never runs. |
| **A filter that already excludes the other rows** | `select … where account_id = $mine` | Identical results with RLS on or off. **Every RLS test here selects unfiltered.** |
| **One account, one manager** | "I can see my data" | Passes with RLS disabled. **Every RLS test here uses two managers and two accounts, and asserts the other's rows are absent.** |
| **A revoke that was already the default** | `revoke update … from service_role`, then asserting UPDATE fails | Verified: this Supabase version's default privileges grant only `REFERENCES, TRIGGER, TRUNCATE` — **not** `UPDATE`. The revoke is a local no-op, so the test passes with the revoke deleted. Task 4 confronts this directly. |
| **`.rejects.toThrow()` with no message** | Any Postgres error satisfies it, "relation does not exist" included | **Every rejection assertion here matches the SQLSTATE *and* the message.** |
| **A suite that skips when the database is down** | `if (!reachable) return;` | Silent vacuity: green having tested nothing. **Task 1's harness fails loudly and counts rows, so an empty database cannot pass.** |
| **An atomicity test whose failure fires before any write** | Guard at the top; "nothing was persisted" is trivially true | Task 8 pins the final guard to the **last** statement and ratchets on the sequence counter, which advances across a rollback — so the test can prove rows really were written before the rollback undid them. |

Three rules, applied in every task below:

1. **Prove the test bites.** Every task ends with a step that breaks the code or drops the protection and confirms the right test — and ideally only that test — goes red. Where a probe *cannot* make a test go red, the task says so out loud rather than pretending.
2. **Ratchet on counts.** Where a test could pass by doing nothing, assert a floor on what it actually touched.
3. **Pick awkward values.** `10000.05` beats `10000.00`. Verified: `Math.trunc(10000.05 * 100)` is `1000004`, one cent short of the correct `1000005`. Round numbers are chosen for legibility and are exactly the inputs where a correct and an incorrect implementation agree.

---

### Task 1: An integration-test harness that cannot pass vacuously

Everything else in this plan is an integration test. If the harness can go green against a database that is down, empty, or unmigrated, none of the later tasks mean anything. So the harness is built first, and it is built to fail loudly.

It also establishes the four primitives every later task needs: running a query **as a specific Postgres role with a specific `auth.uid()` and a specific app-metadata role claim**, resetting the `compound_*` tables despite the append-only trigger, reading a sequence counter — which survives rollback and is therefore the only way to observe work that was undone — and asserting *why* a query was refused rather than merely that it was.

**Files:**
- Modify: `package.json`
- Modify: `jest.config.mjs`
- Modify: `.env.example`
- Create: `jest.db.config.mjs`
- Create: `lib/compound/db/types.ts`
- Create: `lib/compound/db/testing/env.ts`
- Create: `lib/compound/db/testing/harness.ts`
- Create: `lib/compound/db/testing/global-setup.ts`
- Create: `lib/compound/db/testing/harness.db.test.ts`

**Interfaces:**
- Consumes: nothing from `engine/` or `reconcile/`
- Produces:
  - `type Queryable = PoolClient | Client` — defined once, in `db/types.ts`, and imported by every other module in `db/`
  - `type DbRole = "anon" | "authenticated" | "service_role"`
  - `type AppRole = "admin" | "user"`
  - `LOCAL_SUPABASE_DB_URL: string`
  - `testDatabaseUrl(): string`
  - `testPool(): Pool`
  - `closeTestPool(): Promise<void>`
  - `withTestClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>`
  - `withSeparateSession<T>(fn: (c: Client) => Promise<T>): Promise<T>`
  - `asRole<T>(c: Queryable, role: DbRole, opts: { userId?: string | null; appRole?: AppRole | null }, fn: () => Promise<T>): Promise<T>`
  - `resetCompoundTables(c: Queryable): Promise<void>`
  - `sequenceConsumed(c: Queryable, table: string, column: string): Promise<number>`
  - `seedUser(c: Queryable, id: string, email: string, role?: AppRole): Promise<void>`
  - `expectPgError(p: Promise<unknown>, code: string, message: RegExp): Promise<void>`

- [ ] **Step 1: Add `pg` and split the Jest configuration**

Integration tests are a separate Jest project so that `pnpm test` stays fast and offline. They are **not** skipped when the database is unavailable — they fail.

```bash
pnpm add pg@^8
pnpm add -D @types/pg@^8
```

Edit `package.json` so the `scripts` block reads exactly:

```json
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:db": "jest --config jest.db.config.mjs",
    "test:all": "jest && jest --config jest.db.config.mjs"
  },
```

- [ ] **Step 2: Keep `pnpm test` free of database tests**

Edit `jest.config.mjs` to add `testPathIgnorePatterns`:

```javascript
/** @type {import('jest').Config} */
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/lib"],
  moduleNameMapper: { "^@/(.*)$": "<rootDir>/$1" },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { target: "ES2022", module: "CommonJS" } }],
  },
  // Integration tests need a live Postgres. pnpm test must stay runnable offline.
  testPathIgnorePatterns: ["/node_modules/", "\\.db\\.test\\.ts$"],
};
```

- [ ] **Step 3: Create `jest.db.config.mjs`**

`maxWorkers: 1` is not a performance choice. These suites truncate shared tables; running two in parallel makes them delete each other's fixtures and the failures read as logic bugs.

```javascript
import base from "./jest.config.mjs";

/** @type {import('jest').Config} */
export default {
  ...base,
  testPathIgnorePatterns: ["/node_modules/"],
  testMatch: ["**/*.db.test.ts"],
  // These suites truncate shared tables. Parallel workers would corrupt each
  // other's fixtures and the failures would read as logic bugs.
  maxWorkers: 1,
  testTimeout: 30_000,
  globalSetup: "<rootDir>/lib/compound/db/testing/global-setup.ts",
};
```

- [ ] **Step 4: Create `lib/compound/db/types.ts` and `lib/compound/db/testing/env.ts`**

`Queryable` lives in its own module so that a query function can accept either
a pooled client or a standalone session without every module inventing its own
copy of the union.

```typescript
import type { Client, PoolClient } from "pg";

/**
 * Anything a query can be run on: a client borrowed from the pool, or a
 * standalone session. Every read and write in db/ takes one of these rather
 * than reaching for the pool itself, so a caller can compose several of them
 * inside one transaction.
 */
export type Queryable = PoolClient | Client;
```

Then `lib/compound/db/testing/env.ts`:

```typescript
/**
 * Where the integration tests connect.
 *
 * The default is the local Supabase stack defined in supabase/config.toml
 * (db.port = 54622). It is a local-only credential — postgres/postgres on the
 * loopback — so it is safe in a public repository, and hard-coding it means a
 * fresh clone can run `pnpm test:db` without setting anything up.
 *
 * 127.0.0.1 rather than localhost: Docker on this machine resolves localhost
 * to ::1 first, and the Postgres container publishes on IPv4 only.
 */
export const LOCAL_SUPABASE_DB_URL =
  "postgresql://postgres:postgres@127.0.0.1:54622/postgres";

export function testDatabaseUrl(): string {
  const override = process.env.COMPOUND_TEST_DATABASE_URL;
  if (override && override.trim() !== "") return override;
  return LOCAL_SUPABASE_DB_URL;
}
```

- [ ] **Step 5: Create `lib/compound/db/testing/harness.ts`**

```typescript
/**
 * Test-only helpers. Never imported by application code.
 *
 * Four of these exist because of specific properties of this schema:
 *
 * - asRole, because RLS does not apply to a table's owner or to any role with
 *   BYPASSRLS. postgres and service_role both have BYPASSRLS, so an RLS test
 *   that runs as either of them passes with RLS switched off entirely. Every
 *   RLS assertion in this repository runs through asRole(c, "authenticated").
 *
 * - resetCompoundTables, because compound_ledger_entry refuses DELETE and
 *   TRUNCATE by trigger, including from its owner. Clearing it is a deliberate
 *   owner-level act and it should look like one.
 *
 * - sequenceConsumed, because sequences are exempt from transaction rollback.
 *   That makes them the only way to observe that rows really were inserted
 *   before a failure rolled them back — which is what separates a genuine
 *   atomicity test from one whose guard fired before anything was written.
 *
 * - expectPgError, because asserting a rejection by error class alone passes
 *   when a different, earlier failure throws the same class. The engine build
 *   shipped exactly that bug.
 */
import { Client, Pool, type PoolClient } from "pg";
import type { Queryable } from "../types";
import { testDatabaseUrl } from "./env";

// Re-exported so a test file imports its whole vocabulary from one place. The
// definition lives in types.ts.
export type { Queryable };
export type DbRole = "anon" | "authenticated" | "service_role";
export type AppRole = "admin" | "user";

let pool: Pool | null = null;

export function testPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: testDatabaseUrl(), max: 4 });
  return pool;
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function withTestClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await testPool().connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

/**
 * A second, fully independent backend. The concurrency test in Task 8 needs
 * two sessions holding locks at the same time, which one pooled client cannot.
 */
export async function withSeparateSession<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: testDatabaseUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/**
 * Run fn with current_user switched to `role`, auth.uid() resolving to
 * opts.userId, and the app_metadata role claim set to opts.appRole
 * (default "admin", since the manager is an admin under D1).
 *
 * Both settings are transaction-local, so the role is restored on commit or
 * rollback and cannot leak into the next test.
 *
 * The claim shape mirrors a real Supabase JWT, because policies read it with
 * auth.jwt() -> 'app_metadata' ->> 'role'. Reading raw_app_meta_data instead
 * works in a SQL session and does not work inside a policy evaluating a
 * request, which is exactly the sort of difference a harness must not paper
 * over.
 */
export async function asRole<T>(
  c: Queryable,
  role: DbRole,
  opts: { userId?: string | null; appRole?: AppRole | null },
  fn: () => Promise<T>,
): Promise<T> {
  await c.query("begin");
  try {
    const appRole = opts.appRole === undefined ? "admin" : opts.appRole;
    const claims = JSON.stringify({
      sub: opts.userId ?? null,
      role,
      app_metadata: appRole === null ? {} : { role: appRole },
    });
    await c.query("select set_config('request.jwt.claims', $1, true)", [claims]);
    // `role` is a closed TypeScript union, never caller-supplied text. SET does
    // not accept bind parameters, so interpolation is the only option here.
    await c.query(`set local role ${role}`);
    const out = await fn();
    await c.query("commit");
    return out;
  } catch (err) {
    await c.query("rollback");
    throw err;
  }
}

/**
 * Clear every compound_* table. Must run as the owner: the append-only
 * triggers on compound_ledger_entry refuse DELETE and TRUNCATE for everyone,
 * owner included, so they are disabled for the length of this statement and
 * re-enabled immediately.
 *
 * RESTART IDENTITY makes ids and sequence counters deterministic per test,
 * which the sequence ratchets in Task 8 depend on.
 */
export async function resetCompoundTables(c: Queryable): Promise<void> {
  await c.query(`
    alter table public.compound_ledger_entry disable trigger user;
    truncate table
      public.compound_audit,
      public.compound_capital_event_candidate,
      public.compound_reconcile_cursor,
      public.compound_ledger_entry,
      public.compound_holder,
      public.compound_account
      restart identity;
    alter table public.compound_ledger_entry enable trigger user;
  `);
}

/**
 * How many values the table's identity sequence has handed out.
 *
 * A fresh or RESTART IDENTITY'd sequence reports last_value = 1 with
 * is_called = false, meaning nothing consumed. After n nextval calls it
 * reports last_value = n with is_called = true. Normalising the two into one
 * count is what lets a test say "three rows were inserted" about a transaction
 * that rolled back.
 */
export async function sequenceConsumed(
  c: Queryable,
  table: string,
  column: string,
): Promise<number> {
  const named = await c.query<{ seq: string | null }>(
    "select pg_get_serial_sequence($1, $2) as seq",
    [table, column],
  );
  const seqName = named.rows[0]?.seq;
  if (!seqName) throw new Error(`no identity sequence for ${table}.${column}`);
  // seqName is a schema-qualified, already-quoted identifier produced by
  // Postgres itself, not caller input. A sequence name cannot be bound.
  const { rows } = await c.query<{ last_value: string; is_called: boolean }>(
    `select last_value, is_called from ${seqName}`,
  );
  const row = rows[0];
  if (!row) throw new Error(`sequence ${seqName} returned no row`);
  const last = Number(row.last_value);
  return row.is_called ? last : last - 1;
}

/**
 * Insert a user the way a real signup does, plus a fallback.
 *
 * The role goes in raw_user_meta_data, NOT raw_app_meta_data. CopyTraderX's
 * handle_auth_user_insert trigger reads raw_user_meta_data ->> 'role' at
 * signup, creates the public.users row from it, and only then stamps
 * raw_app_meta_data.role itself. Writing raw_app_meta_data directly looks like
 * it works — the value is right there in the row — and produces no
 * public.users row at all, so every RLS policy keyed on manager_user_id fails
 * with a foreign key error that reads like a fixture bug.
 *
 * The public.users insert afterwards is a fallback for a local stack whose
 * trigger is absent. ON CONFLICT DO NOTHING makes it a no-op when the trigger
 * did fire, so the helper is correct either way and a test fixture never
 * depends on a trigger happening to exist. Fictional values only.
 */
export async function seedUser(
  c: Queryable,
  id: string,
  email: string,
  role: AppRole = "admin",
): Promise<void> {
  await c.query(
    `insert into auth.users
       (id, instance_id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated',
             'authenticated', $2, '', now(), now(), now(),
             '{}'::jsonb, jsonb_build_object('role', $3::text))
     on conflict (id) do nothing`,
    [id, email, role],
  );
  await c.query(
    `insert into public.users (id, email, role, must_change_password)
     values ($1, $2, $3, false)
     on conflict (id) do nothing`,
    [id, email, role],
  );
}

/**
 * Assert a query is refused for a specific reason.
 *
 * Both the SQLSTATE and the message must match. Asserting the class alone is
 * how the engine build shipped a test that passed with the guard it covered
 * deleted, because a deeper guard threw the same class first. "relation does
 * not exist" and "permission denied" are both errors; only one of them means
 * the protection worked.
 */
export async function expectPgError(
  p: Promise<unknown>,
  code: string,
  message: RegExp,
): Promise<void> {
  let caught: unknown = null;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  if (caught === null) {
    throw new Error(`expected a Postgres error with code ${code}, but the query succeeded`);
  }
  const err = caught as { code?: string; message?: string };
  expect({ code: err.code, message: err.message }).toEqual({
    code,
    message: expect.stringMatching(message),
  });
}
```

- [ ] **Step 6: Create `lib/compound/db/testing/global-setup.ts`**

This is the piece that refuses to be vacuous. It runs once, before any DB suite, and throws with instructions rather than skipping.

```typescript
import { Client } from "pg";
import { testDatabaseUrl } from "./env";

/** Tables the CopyTraderX fixture migration must have created. */
const REQUIRED_UPSTREAM = [
  "account_snapshots_current",
  "account_snapshots_daily",
  "deals",
  "licenses",
  "users",
];

export default async function globalSetup(): Promise<void> {
  const url = testDatabaseUrl();
  const client = new Client({ connectionString: url });

  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach Postgres at ${url}.\n` +
        `Start the local stack first:  supabase start\n` +
        `Then re-run:                  pnpm test:db\n` +
        `These suites do not skip themselves — a green run must mean the ` +
        `assertions actually ran.\n` +
        `Underlying error: ${String(err)}`,
    );
  }

  try {
    const { rows } = await client.query<{ tablename: string }>(
      `select tablename from pg_tables
        where schemaname = 'public' and tablename = any($1::text[])`,
      [REQUIRED_UPSTREAM],
    );
    const found = new Set(rows.map((r) => r.tablename));
    const missing = REQUIRED_UPSTREAM.filter((t) => !found.has(t));
    if (missing.length > 0) {
      throw new Error(
        `The database at ${url} is missing CopyTraderX fixture tables: ` +
          `${missing.join(", ")}.\n` +
          `Apply the migrations:  supabase db reset`,
      );
    }
  } finally {
    await client.end();
  }
}
```

- [ ] **Step 7: Add the two connection strings to `.env.example`**

Empty values only — the repository is public (§10).

```bash
# Supabase — fill locally, never commit real values.
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Compound talks to Postgres directly rather than through PostgREST: PostgREST
# serialises bigint and numeric as JSON numbers, and spec section 4 forbids
# float on money. Runtime connection string:
COMPOUND_DATABASE_URL=
# Integration tests fall back to the local Supabase in supabase/config.toml
# when this is empty, so it can normally stay empty.
COMPOUND_TEST_DATABASE_URL=
```

- [ ] **Step 8: Write the harness's own tests**

The harness is load-bearing, so it is tested like anything else. `sequenceConsumed` in particular is the ratchet Task 8 depends on, and a ratchet that does not ratchet is worse than none.

Create `lib/compound/db/testing/harness.db.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import {
  asRole,
  closeTestPool,
  expectPgError,
  seedUser,
  sequenceConsumed,
  withSeparateSession,
  withTestClient,
} from "./harness";

afterAll(async () => {
  await closeTestPool();
});

describe("the harness reaches a real, migrated database", () => {
  it("connects as postgres", async () => {
    const user = await withTestClient(async (c) => {
      const { rows } = await c.query<{ current_user: string }>("select current_user");
      return rows[0]?.current_user;
    });
    expect(user).toBe("postgres");
  });

  it("finds every CopyTraderX fixture table", async () => {
    const found = await withTestClient(async (c) => {
      const { rows } = await c.query<{ tablename: string }>(
        `select tablename from pg_tables
          where schemaname = 'public'
            and tablename in ('account_snapshots_current', 'account_snapshots_daily',
                              'deals', 'licenses', 'users')
          order by tablename`,
      );
      return rows.map((r) => r.tablename);
    });
    expect(found).toEqual([
      "account_snapshots_current",
      "account_snapshots_daily",
      "deals",
      "licenses",
      "users",
    ]);
  });
});

describe("asRole switches current_user, auth.uid() and the role claim", () => {
  const uid = "aaaaaaaa-0000-4000-8000-00000000000a";

  it("reports the requested role, uid and app_metadata role", async () => {
    const seen = await withTestClient((c) =>
      asRole(c, "authenticated", { userId: uid }, async () => {
        const { rows } = await c.query<{ who: string; uid: string | null; claim: string | null }>(
          `select current_user as who,
                  auth.uid()::text as uid,
                  (auth.jwt() -> 'app_metadata' ->> 'role') as claim`,
        );
        return rows[0];
      }),
    );
    expect(seen).toEqual({ who: "authenticated", uid, claim: "admin" });
  });

  it("can present a user-role claim instead", async () => {
    const claim = await withTestClient((c) =>
      asRole(c, "authenticated", { userId: uid, appRole: "user" }, async () => {
        const { rows } = await c.query<{ claim: string | null }>(
          `select (auth.jwt() -> 'app_metadata' ->> 'role') as claim`,
        );
        return rows[0]?.claim ?? null;
      }),
    );
    expect(claim).toBe("user");
  });

  it("can present no claim at all", async () => {
    const claim = await withTestClient((c) =>
      asRole(c, "authenticated", { userId: uid, appRole: null }, async () => {
        const { rows } = await c.query<{ claim: string | null }>(
          `select (auth.jwt() -> 'app_metadata' ->> 'role') as claim`,
        );
        return rows[0]?.claim ?? null;
      }),
    );
    expect(claim).toBeNull();
  });

  it("restores postgres afterwards, so a role cannot leak into the next test", async () => {
    const after = await withTestClient(async (c) => {
      await asRole(c, "authenticated", { userId: uid }, async () => undefined);
      const { rows } = await c.query<{ who: string }>("select current_user as who");
      return rows[0]?.who;
    });
    expect(after).toBe("postgres");
  });

  it("restores postgres even when fn throws", async () => {
    const after = await withTestClient(async (c) => {
      await expect(
        asRole(c, "authenticated", { userId: uid }, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const { rows } = await c.query<{ who: string }>("select current_user as who");
      return rows[0]?.who;
    });
    expect(after).toBe("postgres");
  });

  it("gives anon a null uid", async () => {
    const uidSeen = await withTestClient((c) =>
      asRole(c, "anon", {}, async () => {
        const { rows } = await c.query<{ uid: string | null }>("select auth.uid()::text as uid");
        return rows[0]?.uid ?? null;
      }),
    );
    expect(uidSeen).toBeNull();
  });
});

describe("sequenceConsumed is a ratchet", () => {
  // A scratch table, so this test depends on no Compound schema.
  const table = `zz_ratchet_${randomUUID().replace(/-/g, "")}`;

  beforeAll(async () => {
    await withTestClient((c) =>
      c.query(`create table public.${table} (id bigserial primary key, v int not null)`),
    );
  });

  afterAll(async () => {
    await withTestClient((c) => c.query(`drop table if exists public.${table}`));
  });

  it("starts at zero consumed", async () => {
    const n = await withTestClient((c) => sequenceConsumed(c, `public.${table}`, "id"));
    expect(n).toBe(0);
  });

  it("counts committed inserts", async () => {
    await withTestClient((c) => c.query(`insert into public.${table} (v) values (1), (2)`));
    const n = await withTestClient((c) => sequenceConsumed(c, `public.${table}`, "id"));
    expect(n).toBe(2);
  });

  it("counts inserts that were rolled back — this is the whole point", async () => {
    const before = await withTestClient((c) => sequenceConsumed(c, `public.${table}`, "id"));
    await withTestClient(async (c) => {
      await c.query("begin");
      await c.query(`insert into public.${table} (v) values (3)`);
      await c.query(`insert into public.${table} (v) values (4)`);
      await c.query(`insert into public.${table} (v) values (5)`);
      await c.query("rollback");
    });
    const after = await withTestClient((c) => sequenceConsumed(c, `public.${table}`, "id"));
    const rowsNow = await withTestClient(async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `select count(*)::text as n from public.${table}`,
      );
      return Number(rows[0]?.n);
    });

    expect(after - before).toBe(3);
    expect(rowsNow).toBe(2); // the three inserts really did not survive
  });
});

describe("expectPgError distinguishes the reason, not just the failure", () => {
  it("passes when both code and message match", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query("select 1 from public.zz_definitely_not_a_table"),
        "42P01",
        /zz_definitely_not_a_table/,
      ),
    );
  });

  it("rejects a matching code with a non-matching message", async () => {
    await withTestClient(async (c) => {
      await expect(
        expectPgError(
          c.query("select 1 from public.zz_definitely_not_a_table"),
          "42P01",
          /permission denied/,
        ),
      ).rejects.toThrow();
    });
  });

  it("rejects a query that succeeded", async () => {
    await withTestClient(async (c) => {
      await expect(expectPgError(c.query("select 1"), "42P01", /./)).rejects.toThrow(
        /the query succeeded/,
      );
    });
  });
});

describe("seedUser lands a public.users row with the right role", () => {
  // The role rides in raw_user_meta_data and the trigger derives everything
  // else. If a future change moves it back to raw_app_meta_data this test goes
  // red immediately, rather than a dozen RLS tests failing on a foreign key.
  const uid = "aaaaaaaa-0000-4000-8000-00000000000b";

  it("creates the projection row and stores the role", async () => {
    const row = await withTestClient(async (c) => {
      await c.query("delete from public.users where id = $1", [uid]);
      await c.query("delete from auth.users where id = $1", [uid]);
      await seedUser(c, uid, "harness-seed@example.test", "admin");
      const { rows } = await c.query<{ role: string; email: string }>(
        "select role, email from public.users where id = $1",
        [uid],
      );
      return rows[0];
    });
    expect(row).toEqual({ role: "admin", email: "harness-seed@example.test" });
  });

  it("can create a user-role account too", async () => {
    const uid2 = "aaaaaaaa-0000-4000-8000-00000000000c";
    const role = await withTestClient(async (c) => {
      await c.query("delete from public.users where id = $1", [uid2]);
      await c.query("delete from auth.users where id = $1", [uid2]);
      await seedUser(c, uid2, "harness-seed-2@example.test", "user");
      const { rows } = await c.query<{ role: string }>(
        "select role from public.users where id = $1",
        [uid2],
      );
      return rows[0]?.role;
    });
    expect(role).toBe("user");
  });
});

describe("bigint never becomes a float on the way out", () => {
  it("returns int8 as a string, and 2^53 + 1 survives it", async () => {
    const raw = await withTestClient(async (c) => {
      const { rows } = await c.query<{ v: unknown }>("select 9007199254740993::bigint as v");
      return rows[0]?.v;
    });
    expect(typeof raw).toBe("string");
    expect(BigInt(raw as string)).toBe(9007199254740993n);
    // The same value through a JavaScript number, for contrast.
    expect(Number(raw as string)).toBe(9007199254740992);
  });
});

describe("a second session is genuinely a second backend", () => {
  it("has a different backend pid from the pooled client", async () => {
    const a = await withTestClient(async (c) => {
      const { rows } = await c.query<{ pid: number }>("select pg_backend_pid() as pid");
      return rows[0]?.pid;
    });
    const b = await withSeparateSession(async (c) => {
      const { rows } = await c.query<{ pid: number }>("select pg_backend_pid() as pid");
      return rows[0]?.pid;
    });
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 9: Run both gates**

```bash
supabase start
pnpm typecheck && pnpm test && pnpm test:db
```

Expected: `pnpm test` runs the existing engine and reconcile suites and picks up **none** of the new `.db.test.ts` files. `pnpm test:db` runs only the harness suite, and it passes.

- [ ] **Step 10: Prove the harness bites**

Five probes. Run each, confirm the stated failure, then restore.

1. **The database is not there.** `COMPOUND_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:1/postgres pnpm test:db`
   Expected: the run **fails** in `globalSetup` with `Cannot reach Postgres at …`. It must not report zero tests and exit green.
2. **The fixture tables are missing.** Point at a database without them — one of the neighbouring stacks will do: `COMPOUND_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54522/postgres pnpm test:db`
   Expected: fails with `missing CopyTraderX fixture tables`, naming them. If that port is not in use, create an empty database instead. **Do not skip this probe** — it is the one that proves an empty database cannot pass.
3. **Neuter the ratchet.** In `sequenceConsumed`, return `0` unconditionally.
   Expected red: `"counts committed inserts"`, `"counts inserts that were rolled back"`. Restore.
4. **Neuter the role switch.** Delete the `set local role ${role}` line in `asRole`.
   Expected red: `"reports the requested role, uid and app_metadata role"`. Note that `"gives anon a null uid"` still **passes** — `auth.uid()` is null either way — which is why the role is asserted explicitly rather than inferred from behaviour. Restore.
5. **Neuter the claim.** Remove `app_metadata` from the claims object in `asRole`.
   Expected red: `"reports the requested role, uid and app_metadata role"` and `"can present a user-role claim instead"`. `"can present no claim at all"` still passes, because it expects `null` — a reminder that a test asserting absence cannot detect a mechanism that never worked. Restore.
6. **Move the role back to `raw_app_meta_data`** in `seedUser`, swapping the two jsonb arguments.
   Expected red: `"creates the projection row and stores the role"` and `"can create a user-role account too"` — no `public.users` row is produced, because the trigger reads `raw_user_meta_data`. Restore. This probe exists because writing `raw_app_meta_data` directly *looks* correct: the value is visibly in the row, and the failure surfaces much later as a foreign key error in an unrelated suite.

- [ ] **Step 11: Commit**

```bash
git add package.json pnpm-lock.yaml jest.config.mjs jest.db.config.mjs .env.example lib/compound/db/
git commit -m "test(db): integration harness that fails loudly instead of skipping"
```

---

### Task 2: The six `compound_*` tables

Spec §6, with decisions P1, P6 and P8 applied. The check constraints turn three of `replay.ts`'s runtime throws into database refusals, which matters because a fold happens on a page render and a refusal happens at the writer.

**Files:**
- Create: `supabase/migrations/<generated>_compound_core_tables.sql`
- Create: `lib/compound/db/schema.db.test.ts`

**Interfaces:**
- Consumes: `public.users` (the CopyTraderX projection of `auth.users`); the harness from Task 1
- Produces: tables `compound_account`, `compound_holder`, `compound_ledger_entry`, `compound_capital_event_candidate`, `compound_reconcile_cursor`, `compound_audit`

- [ ] **Step 1: Generate the migration file**

```bash
supabase migration new compound_core_tables
```

Write into the generated file:

```sql
-- ============================================================================
-- Compound's own six tables. Design spec section 6.
-- ============================================================================
--
-- Unlike the copytraderx_fixture_tables migration, these tables DO eventually
-- belong in the live CopyTraderX Supabase project (decision D2: same project,
-- compound_ prefix, no sync layer). Applying them there is a separate,
-- human-approved step. Nothing in this repository does it automatically.
--
-- Two things this schema deliberately does NOT store, per section 6.1:
--   * units and cost basis anywhere. Both are derived by folding the ledger.
--   * units_delta and nav_at_entry on a ledger entry. Storing a derived value
--     creates a second truth that can disagree with engine/replay.ts after any
--     change to it.
-- split_bps_applied is the single exception: the terms in force at the moment
-- of a payout are an input, because a holder's split may change afterwards.
--
-- Every uuid foreign key points at public.users, not auth.users. The spec's
-- section 6 sketch says auth.users; CopyTraderX puts an application-level
-- projection table in between, and licenses, subscriptions and
-- subscription_extensions all reference public.users(id). Compound's account
-- is owned by an application user with a role, which is what public.users
-- models. See decision P1 in the plan.
-- ============================================================================

create table public.compound_account (
  id                bigserial   primary key,
  mt5_account       bigint      not null unique,
  label             text        not null,
  broker            text,
  currency          text        not null default 'USD',
  default_split_bps int         not null default 4000
                      check (default_split_bps between 0 and 10000),
  inception_date    date        not null,
  manager_user_id   uuid        not null references public.users (id),
  created_at        timestamptz not null default now()
);

-- Every RLS policy in the next migration resolves through manager_user_id.
create index compound_account_manager_user_id_idx
  on public.compound_account (manager_user_id);

comment on column public.compound_account.manager_user_id is
  'Manager identity is data, not a role (section 9). Keeps D5 multi-account open '
  'without inventing a role per manager, and lets D1 be relaxed later without a '
  'role migration.';

create table public.compound_holder (
  id         bigserial   primary key,
  account_id bigint      not null references public.compound_account (id),
  name       text        not null,
  email      text,
  user_id    uuid        references public.users (id),
  is_manager boolean     not null default false,
  split_bps  int         not null check (split_bps between 0 and 10000),
  joined_at  date,
  status     text        not null check (status in ('active','closed')),
  created_at timestamptz not null default now()
);

create index compound_holder_account_id_idx on public.compound_holder (account_id);

-- engine/replay.ts resolves the fee-receiving manager with
-- holders.find(h => h.isManager) and throws when there is none. With two, it
-- would silently pick whichever came back first and the choice would depend on
-- row order. One per account, enforced here.
create unique index compound_holder_one_manager_per_account
  on public.compound_holder (account_id)
  where is_manager;

comment on table public.compound_holder is
  'Identity and terms only. units, cost_basis, lifetime_deposited, '
  'lifetime_withdrawn and lifetime_fees are deliberately absent — all derived '
  'from the ledger (section 6.1).';

create table public.compound_ledger_entry (
  id                bigserial   primary key,
  account_id        bigint      not null references public.compound_account (id),
  holder_id         bigint      references public.compound_holder (id),
  seq               bigint      not null check (seq > 0),
  occurred_on       date        not null,
  recorded_at       timestamptz not null default now(),
  type              text        not null check (type in
                      ('deposit','payout','exit','equity_reading','adjustment')),
  amount_cents      bigint      not null,
  fee_settlement    text        check (fee_settlement in ('units','cash')),
  split_bps_applied int         check (split_bps_applied between 0 and 10000),
  note              text,
  reverses_id       bigint      references public.compound_ledger_entry (id),
  created_by        uuid        references public.users (id),

  -- seq, not occurred_on, defines replay order (section 6.2). Monotonic per
  -- account, assigned server-side by compound_commit_reading_plan.
  constraint compound_ledger_entry_account_seq_key unique (account_id, seq),

  -- replay.ts refuses to fold a payout or exit with no splitBpsApplied,
  -- because replaying against the holder's *current* split would make history
  -- depend on mutable state. Refuse the row instead of the fold.
  constraint compound_ledger_entry_payout_needs_split check (
    type not in ('payout','exit') or split_bps_applied is not null
  ),

  -- A reading and an adjustment move the pool; they belong to no holder.
  -- A deposit, payout or exit always belongs to one.
  constraint compound_ledger_entry_holder_presence check (
    (type in ('equity_reading','adjustment') and holder_id is null)
    or (type in ('deposit','payout','exit') and holder_id is not null)
  ),

  -- fee_settlement carries the units-or-cash choice for the fee crystallised
  -- inside a payout. There is no separate 'fee' entry type — a separate
  -- applied entry would double-count (section 6.1).
  constraint compound_ledger_entry_fee_settlement_scope check (
    fee_settlement is null or type in ('payout','exit')
  )
);

create index compound_ledger_entry_account_occurred_idx
  on public.compound_ledger_entry (account_id, occurred_on);

create index compound_ledger_entry_holder_idx
  on public.compound_ledger_entry (holder_id)
  where holder_id is not null;

comment on table public.compound_ledger_entry is
  'The only truth. Append-only: corrections are reversing entries pointing at '
  'reverses_id, never edits. Enforced by grants and triggers in the '
  'compound_ledger_append_only migration.';

create table public.compound_capital_event_candidate (
  id                       bigserial   primary key,
  account_id               bigint      not null references public.compound_account (id),
  trade_date               date        not null,
  balance_delta_cents      bigint      not null,
  explained_cents          bigint      not null,
  unexplained_cents        bigint      not null,
  status                   text        not null default 'pending'
                             check (status in ('pending','classified','ignored')),
  resolved_ledger_entry_id bigint      references public.compound_ledger_entry (id),
  detected_at              timestamptz not null default now(),
  resolved_at              timestamptz,
  resolved_by              uuid        references public.users (id),

  -- One candidate per account per day. This is what makes a repeated
  -- reconciler run against an unresolved event a no-op rather than a pile of
  -- duplicate review items.
  constraint compound_capital_event_candidate_account_date_key
    unique (account_id, trade_date)
);

create index compound_capital_event_candidate_pending_idx
  on public.compound_capital_event_candidate (account_id, trade_date)
  where status = 'pending';

create table public.compound_reconcile_cursor (
  account_id        bigint primary key references public.compound_account (id),
  last_reading_date date,
  last_run_at       timestamptz
);

comment on table public.compound_reconcile_cursor is
  'How far equity readings have been posted. The safety interlock (section 5.3) '
  'is this cursor refusing to cross an unclassified capital event.';

-- account_id is not in the spec sketch. Added so compound_audit can carry the
-- same RLS key as the other five tables (decision P6). Nullable, because an
-- action may precede any account existing.
create table public.compound_audit (
  id          bigserial   primary key,
  account_id  bigint      references public.compound_account (id),
  actor       uuid        references public.users (id),
  action      text        not null,
  entity      text        not null,
  entity_id   bigint,
  prior_state jsonb,
  at          timestamptz not null default now()
);

create index compound_audit_account_idx on public.compound_audit (account_id, at desc);
```

- [ ] **Step 2: Apply it locally**

```bash
supabase db reset
```

Expected: every migration applies, no errors.

- [ ] **Step 3: Write the structural tests**

Every constraint test inserts a row that **should** be refused and matches the constraint **by name** — not by error class, which would also match a typo in the table name.

Create `lib/compound/db/schema.db.test.ts`:

```typescript
import {
  closeTestPool,
  expectPgError,
  resetCompoundTables,
  seedUser,
  withTestClient,
} from "./testing/harness";

const MANAGER = "aaaaaaaa-0000-4000-8000-000000000001";
const MANAGER_TWO = "aaaaaaaa-0000-4000-8000-000000000002";

/** Fictional. Not a real MT5 account (section 10). */
const MT5 = 9_900_001;

async function seedAccount(): Promise<number> {
  return withTestClient(async (c) => {
    await seedUser(c, MANAGER, "schema-manager@example.test");
    const { rows } = await c.query<{ id: string }>(
      `insert into public.compound_account
         (mt5_account, label, broker, currency, default_split_bps,
          inception_date, manager_user_id)
       values ($1, 'Schema Fixture', 'Fictional Markets', 'USD', 4000,
               '2026-05-01', $2)
       returning id`,
      [MT5, MANAGER],
    );
    return Number(rows[0]!.id);
  });
}

beforeEach(async () => {
  await withTestClient((c) => resetCompoundTables(c));
});

afterAll(async () => {
  await withTestClient((c) => resetCompoundTables(c));
  await closeTestPool();
});

describe("all six tables exist", () => {
  it("and no more, and no fewer", async () => {
    const found = await withTestClient(async (c) => {
      const { rows } = await c.query<{ tablename: string }>(
        `select tablename from pg_tables
          where schemaname = 'public' and tablename like 'compound\\_%'
          order by tablename`,
      );
      return rows.map((r) => r.tablename);
    });
    expect(found).toEqual([
      "compound_account",
      "compound_audit",
      "compound_capital_event_candidate",
      "compound_holder",
      "compound_ledger_entry",
      "compound_reconcile_cursor",
    ]);
  });
});

describe("the ledger stores inputs, not outputs (section 6.1)", () => {
  it("has no units, cost basis or NAV column anywhere in the schema", async () => {
    const offenders = await withTestClient(async (c) => {
      const { rows } = await c.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name
           from information_schema.columns
          where table_schema = 'public'
            and table_name like 'compound\\_%'
            and (column_name like '%unit%'
                 or column_name like '%nav%'
                 or column_name like '%cost_basis%'
                 or column_name like '%lifetime%')
          order by table_name, column_name`,
      );
      return rows;
    });
    expect(offenders).toEqual([]);
  });

  it("stores every money column as bigint, never numeric or float", async () => {
    const moneyColumns = await withTestClient(async (c) => {
      const { rows } = await c.query<{ qualified: string; data_type: string }>(
        `select table_name || '.' || column_name as qualified, data_type
           from information_schema.columns
          where table_schema = 'public'
            and table_name like 'compound\\_%'
            and column_name like '%\\_cents'
          order by table_name, column_name`,
      );
      return rows;
    });
    expect(moneyColumns.map((r) => r.qualified)).toEqual([
      "compound_capital_event_candidate.balance_delta_cents",
      "compound_capital_event_candidate.explained_cents",
      "compound_capital_event_candidate.unexplained_cents",
      "compound_ledger_entry.amount_cents",
    ]);
    expect(moneyColumns.map((r) => r.data_type)).toEqual([
      "bigint",
      "bigint",
      "bigint",
      "bigint",
    ]);
  });

  it("points every uuid foreign key at public.users, not auth.users", async () => {
    const targets = await withTestClient(async (c) => {
      const { rows } = await c.query<{ src: string; target: string }>(
        `select src.relname || '.' || a.attname as src,
                tns.nspname || '.' || tgt.relname as target
           from pg_constraint con
           join pg_class src on src.oid = con.conrelid
           join pg_class tgt on tgt.oid = con.confrelid
           join pg_namespace tns on tns.oid = tgt.relnamespace
           join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
          where con.contype = 'f'
            and src.relname like 'compound\\_%'
            and a.atttypid = 'uuid'::regtype
          order by src`,
      );
      return rows;
    });
    expect(targets).toEqual([
      { src: "compound_account.manager_user_id", target: "public.users" },
      { src: "compound_audit.actor", target: "public.users" },
      { src: "compound_capital_event_candidate.resolved_by", target: "public.users" },
      { src: "compound_holder.user_id", target: "public.users" },
      { src: "compound_ledger_entry.created_by", target: "public.users" },
    ]);
  });
});

describe("compound_ledger_entry constraints", () => {
  let accountId = 0;
  let holderId = 0;

  beforeEach(async () => {
    accountId = await seedAccount();
    holderId = await withTestClient(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into public.compound_holder
           (account_id, name, is_manager, split_bps, joined_at, status)
         values ($1, 'Fixture Manager', true, 4000, '2026-05-01', 'active')
         returning id`,
        [accountId],
      );
      return Number(rows[0]!.id);
    });
  });

  it("accepts an equity reading with no holder", async () => {
    const n = await withTestClient(async (c) => {
      const { rowCount } = await c.query(
        `insert into public.compound_ledger_entry
           (account_id, holder_id, seq, occurred_on, type, amount_cents)
         values ($1, null, 1, '2026-05-02', 'equity_reading', 3094100)`,
        [accountId],
      );
      return rowCount;
    });
    expect(n).toBe(1);
  });

  it("refuses an equity reading attached to a holder", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_ledger_entry
             (account_id, holder_id, seq, occurred_on, type, amount_cents)
           values ($1, $2, 1, '2026-05-02', 'equity_reading', 3094100)`,
          [accountId, holderId],
        ),
        "23514",
        /compound_ledger_entry_holder_presence/,
      ),
    );
  });

  it("refuses a deposit with no holder", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_ledger_entry
             (account_id, holder_id, seq, occurred_on, type, amount_cents)
           values ($1, null, 1, '2026-05-02', 'deposit', 500000)`,
          [accountId],
        ),
        "23514",
        /compound_ledger_entry_holder_presence/,
      ),
    );
  });

  it("refuses a payout with no split_bps_applied", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_ledger_entry
             (account_id, holder_id, seq, occurred_on, type, amount_cents)
           values ($1, $2, 1, '2026-05-02', 'payout', 25000)`,
          [accountId, holderId],
        ),
        "23514",
        /compound_ledger_entry_payout_needs_split/,
      ),
    );
  });

  it("accepts a payout that carries the terms in force", async () => {
    const n = await withTestClient(async (c) => {
      const { rowCount } = await c.query(
        `insert into public.compound_ledger_entry
           (account_id, holder_id, seq, occurred_on, type, amount_cents,
            fee_settlement, split_bps_applied)
         values ($1, $2, 1, '2026-05-02', 'payout', 25000, 'units', 4000)`,
        [accountId, holderId],
      );
      return rowCount;
    });
    expect(n).toBe(1);
  });

  it("refuses fee_settlement on an equity reading", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_ledger_entry
             (account_id, holder_id, seq, occurred_on, type, amount_cents, fee_settlement)
           values ($1, null, 1, '2026-05-02', 'equity_reading', 3094100, 'cash')`,
          [accountId],
        ),
        "23514",
        /compound_ledger_entry_fee_settlement_scope/,
      ),
    );
  });

  it("refuses a type outside the five in section 6", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_ledger_entry
             (account_id, holder_id, seq, occurred_on, type, amount_cents,
              split_bps_applied)
           values ($1, $2, 1, '2026-05-02', 'fee', 25000, 4000)`,
          [accountId, holderId],
        ),
        "23514",
        /compound_ledger_entry_type_check/,
      ),
    );
  });

  it("refuses a duplicate seq within an account", async () => {
    await withTestClient(async (c) => {
      await c.query(
        `insert into public.compound_ledger_entry
           (account_id, seq, occurred_on, type, amount_cents)
         values ($1, 7, '2026-05-02', 'equity_reading', 100)`,
        [accountId],
      );
      await expectPgError(
        c.query(
          `insert into public.compound_ledger_entry
             (account_id, seq, occurred_on, type, amount_cents)
           values ($1, 7, '2026-05-03', 'equity_reading', 200)`,
          [accountId],
        ),
        "23505",
        /compound_ledger_entry_account_seq_key/,
      );
    });
  });

  it("allows the same seq under a different account — seq is per account", async () => {
    const second = await withTestClient(async (c) => {
      await seedUser(c, MANAGER_TWO, "schema-manager-2@example.test");
      const { rows } = await c.query<{ id: string }>(
        `insert into public.compound_account
           (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
         values ($1, 'Second Fixture', 'USD', 4000, '2026-05-01', $2)
         returning id`,
        [MT5 + 1, MANAGER_TWO],
      );
      return Number(rows[0]!.id);
    });

    const n = await withTestClient(async (c) => {
      await c.query(
        `insert into public.compound_ledger_entry
           (account_id, seq, occurred_on, type, amount_cents)
         values ($1, 1, '2026-05-02', 'equity_reading', 100)`,
        [accountId],
      );
      const { rowCount } = await c.query(
        `insert into public.compound_ledger_entry
           (account_id, seq, occurred_on, type, amount_cents)
         values ($1, 1, '2026-05-02', 'equity_reading', 200)`,
        [second],
      );
      return rowCount;
    });
    expect(n).toBe(1);
  });

  it("keeps a cent value above 2^53 exact", async () => {
    // 9007199254740993 is the first integer a JavaScript number cannot hold.
    // Anything on this path that parses it as a number returns one less.
    const back = await withTestClient(async (c) => {
      await c.query(
        `insert into public.compound_ledger_entry
           (account_id, seq, occurred_on, type, amount_cents)
         values ($1, 1, '2026-05-02', 'equity_reading', 9007199254740993)`,
        [accountId],
      );
      const { rows } = await c.query<{ amount_cents: string }>(
        `select amount_cents from public.compound_ledger_entry where account_id = $1`,
        [accountId],
      );
      return rows[0]!.amount_cents;
    });
    expect(typeof back).toBe("string");
    expect(BigInt(back)).toBe(9007199254740993n);
  });
});

describe("compound_holder constraints", () => {
  it("allows only one manager per account", async () => {
    const accountId = await seedAccount();
    await withTestClient(async (c) => {
      await c.query(
        `insert into public.compound_holder
           (account_id, name, is_manager, split_bps, status)
         values ($1, 'Manager', true, 4000, 'active')`,
        [accountId],
      );
      await expectPgError(
        c.query(
          `insert into public.compound_holder
             (account_id, name, is_manager, split_bps, status)
           values ($1, 'Also Manager', true, 4000, 'active')`,
          [accountId],
        ),
        "23505",
        /compound_holder_one_manager_per_account/,
      );
    });
  });

  it("allows many non-manager holders per account", async () => {
    const accountId = await seedAccount();
    const n = await withTestClient(async (c) => {
      const { rowCount } = await c.query(
        `insert into public.compound_holder
           (account_id, name, is_manager, split_bps, status)
         values ($1, 'Investor One', false, 4000, 'active'),
                ($1, 'Investor Two', false, 3500, 'active'),
                ($1, 'Investor Three', false, 4000, 'closed')`,
        [accountId],
      );
      return rowCount;
    });
    expect(n).toBe(3);
  });

  it("refuses a split outside 0..10000 basis points", async () => {
    const accountId = await seedAccount();
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_holder
             (account_id, name, is_manager, split_bps, status)
           values ($1, 'Impossible Terms', false, 10001, 'active')`,
          [accountId],
        ),
        "23514",
        /compound_holder_split_bps_check/,
      ),
    );
  });

  it("refuses a status outside active and closed", async () => {
    const accountId = await seedAccount();
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_holder
             (account_id, name, is_manager, split_bps, status)
           values ($1, 'Neither', false, 4000, 'pending')`,
          [accountId],
        ),
        "23514",
        /compound_holder_status_check/,
      ),
    );
  });
});

describe("compound_capital_event_candidate constraints", () => {
  it("allows one candidate per account per day and refuses the second", async () => {
    const accountId = await seedAccount();
    await withTestClient(async (c) => {
      await c.query(
        `insert into public.compound_capital_event_candidate
           (account_id, trade_date, balance_delta_cents, explained_cents, unexplained_cents)
         values ($1, '2026-06-25', 3100000, 0, 3100000)`,
        [accountId],
      );
      await expectPgError(
        c.query(
          `insert into public.compound_capital_event_candidate
             (account_id, trade_date, balance_delta_cents, explained_cents, unexplained_cents)
           values ($1, '2026-06-25', 3100000, 0, 3100000)`,
          [accountId],
        ),
        "23505",
        /compound_capital_event_candidate_account_date_key/,
      );
    });
  });

  it("refuses a status outside pending, classified and ignored", async () => {
    const accountId = await seedAccount();
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_capital_event_candidate
             (account_id, trade_date, balance_delta_cents, explained_cents,
              unexplained_cents, status)
           values ($1, '2026-06-25', 3100000, 0, 3100000, 'maybe')`,
          [accountId],
        ),
        "23514",
        /compound_capital_event_candidate_status_check/,
      ),
    );
  });
});

describe("compound_account constraints", () => {
  it("refuses a second account on the same MT5 login", async () => {
    await seedAccount();
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_account
             (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
           values ($1, 'Duplicate', 'USD', 4000, '2026-05-01', $2)`,
          [MT5, MANAGER],
        ),
        "23505",
        /compound_account_mt5_account_key/,
      ),
    );
  });

  it("refuses a manager who is not a public.users row", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_account
             (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
           values ($1, 'Orphan', 'USD', 4000, '2026-05-01',
                   'ffffffff-0000-4000-8000-ffffffffffff')`,
          [MT5 + 99],
        ),
        "23503",
        /compound_account_manager_user_id_fkey/,
      ),
    );
  });
});
```

- [ ] **Step 4: Run the gates**

```bash
pnpm typecheck && pnpm test:db
```

- [ ] **Step 5: Prove these tests bite**

Five probes. Each removes one thing and names the tests that must go red. Restore after each and re-run `supabase db reset`.

1. **Drop the holder-presence check.** Delete `compound_ledger_entry_holder_presence` from the migration, reset, re-run.
   Expected red: `"refuses an equity reading attached to a holder"`, `"refuses a deposit with no holder"`. Nothing else.
2. **Drop the one-manager index.** Delete `compound_holder_one_manager_per_account`, reset, re-run.
   Expected red: `"allows only one manager per account"`. Confirm `"allows many non-manager holders per account"` still passes — a partial index on `where is_manager` must not constrain the others, and if that test also goes red the predicate is wrong.
3. **Make `seq` globally unique.** Change the constraint to `unique (seq)`, reset, re-run.
   Expected red: `"allows the same seq under a different account"`. That test is what holds §6.2's "monotonic **per account**" clause.
4. **Change `amount_cents` to `numeric`.** Reset, re-run.
   Expected red: `"stores every money column as bigint, never numeric or float"`. Note that `"keeps a cent value above 2^53 exact"` still **passes**, because `pg` also returns `numeric` as a string — which is exactly why the column type is asserted separately rather than inferred from a round trip.
5. **Repoint one FK at `auth.users`.** Change `compound_holder.user_id` to `references auth.users (id)`, reset, re-run.
   Expected red: `"points every uuid foreign key at public.users, not auth.users"`, and only that. This is the test that holds decision P1 in place after the next person edits the migration.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations lib/compound/db/schema.db.test.ts
git commit -m "feat(db): the six compound_* tables, with the constraints replay.ts assumes"
```

---

### Task 3: RLS on all six tables, keyed on `manager_user_id`

Spec §9. Two conditions, ANDed, on every policy:

- **the gate** — `(auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'`, the project's own idiom, verbatim. A `user`-role account gets nothing from Compound at all.
- **the key** — ownership resolved through `compound_account.manager_user_id`. This is what decides *which* account's rows you see.

They are ANDed, not ORed. An `or is_admin()` bypass arm would make RLS a no-op for the only role that uses the product and would make every isolation test below unfalsifiable — see decision P5.

**The single most important thing in this task:** an RLS test that passes when RLS is off is worthless. Three properties make each test here discriminating, and all three are needed together:

1. It runs as `authenticated`. `postgres` and `service_role` both carry `BYPASSRLS`, so a test as either exercises nothing.
2. It selects **unfiltered** — no `where account_id = …`. A filter that already excludes the other manager's rows returns the same result with RLS disabled.
3. There are **two** managers with **two** accounts, and each test asserts the other manager's rows are *absent*, not merely that its own are present.

**Files:**
- Create: `supabase/migrations/<generated>_compound_rls.sql`
- Create: `lib/compound/db/rls.db.test.ts`

**Interfaces:**
- Consumes: the tables from Task 2; `auth.uid()`, `auth.jwt()`
- Produces: `public.compound_is_admin() returns boolean`; `public.compound_manages_account(bigint) returns boolean`; RLS enabled with policies on all six tables; DML grants for `authenticated` and `service_role`

- [ ] **Step 1: Generate the migration file**

```bash
supabase migration new compound_rls
```

Write into the generated file:

```sql
-- ============================================================================
-- Row-level security. Design spec section 9.
-- ============================================================================
--
-- Every policy is `gate AND key`:
--   gate: (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
--   key : ownership resolved through compound_account.manager_user_id
--
-- The gate is CopyTraderX's own admin idiom, used verbatim. Note that reading
-- raw_app_meta_data instead works in a direct SQL session and does NOT work
-- inside a policy evaluating a request — the role has to come from the JWT.
--
-- The two are ANDed. An `or is_admin()` bypass arm would make RLS a no-op for
-- the only role that uses this product, since the manager IS an admin (D1),
-- and would make every isolation test unfalsifiable. Ownership decides which
-- account's rows you see; the gate decides whether you see Compound at all.
--
-- D1 is single-tenant. There is no investor role to write a policy against:
-- public.users.role is check (role in ('admin','user')). Investor access,
-- when it lands in v2, keys on compound_holder.user_id = auth.uid() — data,
-- not a claim. Adding it later is additive and needs no constraint change.
--
-- On grants: on this Supabase version ALTER DEFAULT PRIVILEGES grants only
-- REFERENCES, TRIGGER and TRUNCATE to anon/authenticated/service_role, so a
-- new table starts with no DML privileges for anyone but its owner. RLS bypass
-- and table grants are independent layers: service_role has BYPASSRLS and
-- still cannot read a table it has no SELECT grant on. Every grant below is
-- required, not decoration.
-- ============================================================================

create or replace function public.compound_is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin';
$$;

revoke execute on function public.compound_is_admin() from public;
grant execute on function public.compound_is_admin() to authenticated, service_role;

-- Resolves "does the caller manage this account?" once, rather than making
-- every child policy re-enter compound_account's own policy.
--
-- SECURITY DEFINER for that reason alone. search_path is pinned empty and
-- every name is schema-qualified, so the definer's privileges cannot be
-- redirected at a different table by a caller's search_path.
create or replace function public.compound_manages_account(p_account_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.compound_account a
     where a.id = p_account_id
       and a.manager_user_id = (select auth.uid())
  );
$$;

revoke execute on function public.compound_manages_account(bigint) from public;
grant execute on function public.compound_manages_account(bigint)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- compound_account
-- ---------------------------------------------------------------------------
alter table public.compound_account enable row level security;

-- (select auth.uid()) rather than a bare auth.uid(): the subselect is
-- evaluated once per statement instead of once per row.
create policy compound_account_select on public.compound_account
  for select to authenticated
  using (public.compound_is_admin() and manager_user_id = (select auth.uid()));

create policy compound_account_insert on public.compound_account
  for insert to authenticated
  with check (public.compound_is_admin() and manager_user_id = (select auth.uid()));

create policy compound_account_update on public.compound_account
  for update to authenticated
  using (public.compound_is_admin() and manager_user_id = (select auth.uid()))
  with check (public.compound_is_admin() and manager_user_id = (select auth.uid()));

-- No delete policy, and no DELETE grant below. An account with a ledger behind
-- it is not a thing to delete.

grant select, insert, update on public.compound_account to authenticated, service_role;
grant usage, select on sequence public.compound_account_id_seq
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- compound_holder
-- ---------------------------------------------------------------------------
alter table public.compound_holder enable row level security;

create policy compound_holder_select on public.compound_holder
  for select to authenticated
  using (public.compound_is_admin() and public.compound_manages_account(account_id));

create policy compound_holder_insert on public.compound_holder
  for insert to authenticated
  with check (public.compound_is_admin() and public.compound_manages_account(account_id));

create policy compound_holder_update on public.compound_holder
  for update to authenticated
  using (public.compound_is_admin() and public.compound_manages_account(account_id))
  with check (public.compound_is_admin() and public.compound_manages_account(account_id));

grant select, insert, update on public.compound_holder to authenticated, service_role;
grant usage, select on sequence public.compound_holder_id_seq
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- compound_ledger_entry — SELECT and INSERT only, in the policies and in the
-- grants. The next migration takes UPDATE, DELETE and TRUNCATE away from
-- everyone including the owner. Section 3.5 invariant 5.
-- ---------------------------------------------------------------------------
alter table public.compound_ledger_entry enable row level security;

create policy compound_ledger_entry_select on public.compound_ledger_entry
  for select to authenticated
  using (public.compound_is_admin() and public.compound_manages_account(account_id));

create policy compound_ledger_entry_insert on public.compound_ledger_entry
  for insert to authenticated
  with check (public.compound_is_admin() and public.compound_manages_account(account_id));

grant select, insert on public.compound_ledger_entry to authenticated, service_role;
grant usage, select on sequence public.compound_ledger_entry_id_seq
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- compound_capital_event_candidate
-- ---------------------------------------------------------------------------
alter table public.compound_capital_event_candidate enable row level security;

create policy compound_capital_event_candidate_select
  on public.compound_capital_event_candidate
  for select to authenticated
  using (public.compound_is_admin() and public.compound_manages_account(account_id));

create policy compound_capital_event_candidate_insert
  on public.compound_capital_event_candidate
  for insert to authenticated
  with check (public.compound_is_admin() and public.compound_manages_account(account_id));

-- Classifying a candidate is an update, so this one needs UPDATE.
create policy compound_capital_event_candidate_update
  on public.compound_capital_event_candidate
  for update to authenticated
  using (public.compound_is_admin() and public.compound_manages_account(account_id))
  with check (public.compound_is_admin() and public.compound_manages_account(account_id));

grant select, insert, update on public.compound_capital_event_candidate
  to authenticated, service_role;
grant usage, select on sequence public.compound_capital_event_candidate_id_seq
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- compound_reconcile_cursor
-- ---------------------------------------------------------------------------
alter table public.compound_reconcile_cursor enable row level security;

create policy compound_reconcile_cursor_select on public.compound_reconcile_cursor
  for select to authenticated
  using (public.compound_is_admin() and public.compound_manages_account(account_id));

create policy compound_reconcile_cursor_insert on public.compound_reconcile_cursor
  for insert to authenticated
  with check (public.compound_is_admin() and public.compound_manages_account(account_id));

create policy compound_reconcile_cursor_update on public.compound_reconcile_cursor
  for update to authenticated
  using (public.compound_is_admin() and public.compound_manages_account(account_id))
  with check (public.compound_is_admin() and public.compound_manages_account(account_id));

grant select, insert, update on public.compound_reconcile_cursor
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- compound_audit — append-only by grant (no UPDATE, no DELETE).
--
-- account_id may be null for an action that precedes any account. The actor
-- arm covers those rows; the account arm covers the rest. `compound_manages_
-- account(null)` is false, so a null account_id can only ever be reached
-- through the actor arm.
-- ---------------------------------------------------------------------------
alter table public.compound_audit enable row level security;

create policy compound_audit_select on public.compound_audit
  for select to authenticated
  using (
    public.compound_is_admin()
    and (
      actor = (select auth.uid())
      or public.compound_manages_account(account_id)
    )
  );

create policy compound_audit_insert on public.compound_audit
  for insert to authenticated
  with check (
    public.compound_is_admin()
    and (
      actor = (select auth.uid())
      or public.compound_manages_account(account_id)
    )
  );

grant select, insert on public.compound_audit to authenticated, service_role;
grant usage, select on sequence public.compound_audit_id_seq
  to authenticated, service_role;
```

- [ ] **Step 2: Apply and confirm**

```bash
supabase db reset
```

- [ ] **Step 3: Write the RLS tests**

Create `lib/compound/db/rls.db.test.ts`:

```typescript
/**
 * RLS behaviour, from the only vantage point where RLS actually runs.
 *
 * Read the three rules in the plan before changing anything here:
 *   - as authenticated, never as postgres or service_role (both BYPASSRLS)
 *   - unfiltered selects, never `where account_id = mine`
 *   - two managers and two accounts, asserting the other's rows are ABSENT
 *
 * A test that breaks any one of those passes with RLS switched off.
 */
import {
  asRole,
  closeTestPool,
  expectPgError,
  resetCompoundTables,
  seedUser,
  withTestClient,
} from "./testing/harness";

const ALICE = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BOB = "bbbbbbbb-0000-4000-8000-0000000000b1";
/** Signed in as an admin, manages nothing. */
const CAROL = "cccccccc-0000-4000-8000-0000000000c1";

let alicesAccount = 0;
let bobsAccount = 0;
let alicesHolder = 0;

beforeEach(async () => {
  await withTestClient(async (c) => {
    await resetCompoundTables(c);
    await seedUser(c, ALICE, "alice@example.test");
    await seedUser(c, BOB, "bob@example.test");
    await seedUser(c, CAROL, "carol@example.test");

    const accounts = await c.query<{ id: string }>(
      `insert into public.compound_account
         (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
       values (9900101, 'Alice Desk', 'USD', 4000, '2026-05-01', $1),
              (9900102, 'Bob Desk',   'USD', 4000, '2026-05-01', $2)
       returning id`,
      [ALICE, BOB],
    );
    alicesAccount = Number(accounts.rows[0]!.id);
    bobsAccount = Number(accounts.rows[1]!.id);

    const holders = await c.query<{ id: string }>(
      `insert into public.compound_holder
         (account_id, name, is_manager, split_bps, status)
       values ($1, 'Alice', true, 4000, 'active'),
              ($2, 'Bob',   true, 4000, 'active')
       returning id`,
      [alicesAccount, bobsAccount],
    );
    alicesHolder = Number(holders.rows[0]!.id);

    await c.query(
      `insert into public.compound_ledger_entry
         (account_id, seq, occurred_on, type, amount_cents)
       values ($1, 1, '2026-05-02', 'equity_reading', 1000005),
              ($2, 1, '2026-05-02', 'equity_reading', 2000029)`,
      [alicesAccount, bobsAccount],
    );

    await c.query(
      `insert into public.compound_capital_event_candidate
         (account_id, trade_date, balance_delta_cents, explained_cents, unexplained_cents)
       values ($1, '2026-06-25', 3100000, 0, 3100000),
              ($2, '2026-06-26', 4100000, 0, 4100000)`,
      [alicesAccount, bobsAccount],
    );

    await c.query(
      `insert into public.compound_reconcile_cursor (account_id, last_reading_date, last_run_at)
       values ($1, '2026-05-02', now()), ($2, '2026-05-02', now())`,
      [alicesAccount, bobsAccount],
    );

    await c.query(
      `insert into public.compound_audit (account_id, actor, action, entity, entity_id)
       values ($1, $3, 'post_reading', 'compound_ledger_entry', 1),
              ($2, $4, 'post_reading', 'compound_ledger_entry', 2),
              (null, $3, 'sign_in', 'auth', null)`,
      [alicesAccount, bobsAccount, ALICE, BOB],
    );
  });
});

afterAll(async () => {
  await withTestClient((c) => resetCompoundTables(c));
  await closeTestPool();
});

/** Every row of a table, with no predicate. The predicate is the policy's job. */
async function readAllAs<T extends object>(
  userId: string,
  sql: string,
  appRole: "admin" | "user" | null = "admin",
): Promise<T[]> {
  return withTestClient((c) =>
    asRole(c, "authenticated", { userId, appRole }, async () => {
      const { rows } = await c.query<T>(sql);
      return rows;
    }),
  );
}

const ALL_TABLES = [
  "compound_account",
  "compound_holder",
  "compound_ledger_entry",
  "compound_capital_event_candidate",
  "compound_reconcile_cursor",
  "compound_audit",
] as const;

describe("the fixture itself is real", () => {
  // If this ever reports fewer than two of anything, every isolation assertion
  // below becomes vacuous. Ratchet on it.
  it("has two accounts, two holders, two ledger entries, two candidates", async () => {
    const counts = await withTestClient(async (c) => {
      const { rows } = await c.query<{ a: string; h: string; l: string; k: string }>(
        `select (select count(*) from public.compound_account)::text as a,
                (select count(*) from public.compound_holder)::text as h,
                (select count(*) from public.compound_ledger_entry)::text as l,
                (select count(*) from public.compound_capital_event_candidate)::text as k`,
      );
      return rows[0]!;
    });
    expect(counts).toEqual({ a: "2", h: "2", l: "2", k: "2" });
  });

  it("uses two distinct managers and two distinct accounts", () => {
    expect(ALICE).not.toBe(BOB);
    expect(alicesAccount).not.toBe(bobsAccount);
  });
});

describe("compound_account", () => {
  it("shows Alice her account and not Bob's", async () => {
    const rows = await readAllAs<{ label: string }>(
      ALICE,
      "select label from public.compound_account order by id",
    );
    expect(rows.map((r) => r.label)).toEqual(["Alice Desk"]);
  });

  it("shows Bob his account and not Alice's", async () => {
    const rows = await readAllAs<{ label: string }>(
      BOB,
      "select label from public.compound_account order by id",
    );
    expect(rows.map((r) => r.label)).toEqual(["Bob Desk"]);
  });

  it("shows Carol nothing at all", async () => {
    const rows = await readAllAs<{ label: string }>(
      CAROL,
      "select label from public.compound_account",
    );
    expect(rows).toEqual([]);
  });

  it("refuses Alice an account owned by Bob", async () => {
    await withTestClient((c) =>
      asRole(c, "authenticated", { userId: ALICE }, () =>
        expectPgError(
          c.query(
            `insert into public.compound_account
               (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
             values (9900199, 'Trojan', 'USD', 4000, '2026-05-01', $1)`,
            [BOB],
          ),
          "42501",
          /row-level security policy for table "compound_account"/,
        ),
      ),
    );
  });

  it("refuses Alice the ability to hand her account to Bob", async () => {
    await withTestClient((c) =>
      asRole(c, "authenticated", { userId: ALICE }, () =>
        expectPgError(
          c.query(`update public.compound_account set manager_user_id = $1`, [BOB]),
          "42501",
          /row-level security policy for table "compound_account"/,
        ),
      ),
    );
  });

  it("grants nobody DELETE, so an account with a ledger cannot vanish", async () => {
    await withTestClient((c) =>
      asRole(c, "authenticated", { userId: ALICE }, () =>
        expectPgError(
          c.query("delete from public.compound_account"),
          "42501",
          /permission denied for table compound_account/,
        ),
      ),
    );
  });
});

describe("compound_holder", () => {
  it("shows each manager only their own holders", async () => {
    const alice = await readAllAs<{ name: string }>(
      ALICE,
      "select name from public.compound_holder order by id",
    );
    const bob = await readAllAs<{ name: string }>(
      BOB,
      "select name from public.compound_holder order by id",
    );
    expect(alice.map((r) => r.name)).toEqual(["Alice"]);
    expect(bob.map((r) => r.name)).toEqual(["Bob"]);
  });

  it("refuses Alice a holder on Bob's account", async () => {
    await withTestClient((c) =>
      asRole(c, "authenticated", { userId: ALICE }, () =>
        expectPgError(
          c.query(
            `insert into public.compound_holder
               (account_id, name, is_manager, split_bps, status)
             values ($1, 'Interloper', false, 4000, 'active')`,
            [bobsAccount],
          ),
          "42501",
          /row-level security policy for table "compound_holder"/,
        ),
      ),
    );
  });

  it("refuses Alice the ability to move her holder onto Bob's account", async () => {
    await withTestClient((c) =>
      asRole(c, "authenticated", { userId: ALICE }, () =>
        expectPgError(
          c.query(`update public.compound_holder set account_id = $1 where id = $2`, [
            bobsAccount,
            alicesHolder,
          ]),
          "42501",
          /row-level security policy for table "compound_holder"/,
        ),
      ),
    );
  });
});

describe("compound_ledger_entry", () => {
  it("shows each manager only their own entries", async () => {
    const alice = await readAllAs<{ amount_cents: string }>(
      ALICE,
      "select amount_cents from public.compound_ledger_entry order by id",
    );
    const bob = await readAllAs<{ amount_cents: string }>(
      BOB,
      "select amount_cents from public.compound_ledger_entry order by id",
    );
    expect(alice.map((r) => r.amount_cents)).toEqual(["1000005"]);
    expect(bob.map((r) => r.amount_cents)).toEqual(["2000029"]);
  });

  it("refuses Alice an entry written into Bob's ledger", async () => {
    await withTestClient((c) =>
      asRole(c, "authenticated", { userId: ALICE }, () =>
        expectPgError(
          c.query(
            `insert into public.compound_ledger_entry
               (account_id, seq, occurred_on, type, amount_cents)
             values ($1, 99, '2026-05-03', 'equity_reading', 1)`,
            [bobsAccount],
          ),
          "42501",
          /row-level security policy for table "compound_ledger_entry"/,
        ),
      ),
    );
  });

  it("lets Alice append to her own ledger", async () => {
    const n = await withTestClient((c) =>
      asRole(c, "authenticated", { userId: ALICE }, async () => {
        const { rowCount } = await c.query(
          `insert into public.compound_ledger_entry
             (account_id, seq, occurred_on, type, amount_cents)
           values ($1, 2, '2026-05-03', 'equity_reading', 1000105)`,
          [alicesAccount],
        );
        return rowCount;
      }),
    );
    expect(n).toBe(1);
  });
});

describe("compound_capital_event_candidate and compound_reconcile_cursor", () => {
  it("isolates candidates by manager", async () => {
    const alice = await readAllAs<{ delta: string }>(
      ALICE,
      "select balance_delta_cents as delta from public.compound_capital_event_candidate",
    );
    const bob = await readAllAs<{ delta: string }>(
      BOB,
      "select balance_delta_cents as delta from public.compound_capital_event_candidate",
    );
    expect(alice.map((r) => r.delta)).toEqual(["3100000"]);
    expect(bob.map((r) => r.delta)).toEqual(["4100000"]);
  });

  it("isolates the cursor by manager", async () => {
    const alice = await readAllAs<{ account_id: string }>(
      ALICE,
      "select account_id from public.compound_reconcile_cursor",
    );
    expect(alice.map((r) => Number(r.account_id))).toEqual([alicesAccount]);
  });

  it("lets Alice classify only her own candidate", async () => {
    // Not an error: RLS filters the row out, so the UPDATE simply matches
    // fewer rows. The row count IS the assertion — and Bob's row is checked
    // afterwards, because "one row updated" alone would also be true if the
    // policy had picked the wrong one.
    const affected = await withTestClient((c) =>
      asRole(c, "authenticated", { userId: ALICE }, async () => {
        const { rowCount } = await c.query(
          `update public.compound_capital_event_candidate set status = 'ignored'`,
        );
        return rowCount;
      }),
    );
    expect(affected).toBe(1);

    const statuses = await withTestClient(async (c) => {
      const { rows } = await c.query<{ account_id: string; status: string }>(
        `select account_id, status from public.compound_capital_event_candidate
          order by account_id`,
      );
      return rows.map((r) => [Number(r.account_id), r.status] as const);
    });
    expect(statuses).toEqual([
      [alicesAccount, "ignored"],
      [bobsAccount, "pending"],
    ]);
  });
});

describe("compound_audit", () => {
  it("shows a manager their account's rows plus their own actor rows", async () => {
    const alice = await readAllAs<{ action: string }>(
      ALICE,
      "select action from public.compound_audit order by id",
    );
    // Her account row, and the account-less sign_in she performed.
    expect(alice.map((r) => r.action).sort()).toEqual(["post_reading", "sign_in"]);
  });

  it("does not show Bob Alice's account-less rows", async () => {
    const bob = await readAllAs<{ action: string; account_id: string | null }>(
      BOB,
      "select action, account_id from public.compound_audit order by id",
    );
    expect(bob).toHaveLength(1);
    expect(Number(bob[0]!.account_id)).toBe(bobsAccount);
  });

  it("is append-only by grant — no UPDATE, no DELETE", async () => {
    await withTestClient((c) =>
      asRole(c, "authenticated", { userId: ALICE }, () =>
        expectPgError(
          c.query("update public.compound_audit set action = 'rewritten'"),
          "42501",
          /permission denied for table compound_audit/,
        ),
      ),
    );
    await withTestClient((c) =>
      asRole(c, "authenticated", { userId: ALICE }, () =>
        expectPgError(
          c.query("delete from public.compound_audit"),
          "42501",
          /permission denied for table compound_audit/,
        ),
      ),
    );
  });
});

describe("the admin gate", () => {
  // Alice owns an account. These prove the gate, not ownership: same user,
  // same rows, different claim.
  it.each(ALL_TABLES)("%s is closed to Alice with a user-role claim", async (table) => {
    const rows = await readAllAs(ALICE, `select * from public.${table}`, "user");
    expect(rows).toEqual([]);
  });

  it.each(ALL_TABLES)("%s is closed to Alice with no claim at all", async (table) => {
    const rows = await readAllAs(ALICE, `select * from public.${table}`, null);
    expect(rows).toEqual([]);
  });

  it("still shows Alice her rows with the admin claim — the gate is not just deny-all", async () => {
    const rows = await readAllAs<{ label: string }>(
      ALICE,
      "select label from public.compound_account",
      "admin",
    );
    expect(rows.map((r) => r.label)).toEqual(["Alice Desk"]);
  });
});

describe("anon sees nothing on any compound table", () => {
  it.each(ALL_TABLES)("%s is closed to anon", async (table) => {
    await withTestClient((c) =>
      asRole(c, "anon", {}, () =>
        expectPgError(
          c.query(`select * from public.${table}`),
          "42501",
          new RegExp(`permission denied for table ${table}`),
        ),
      ),
    );
  });
});

describe("RLS is switched on, structurally", () => {
  // This does not replace the behavioural tests above. It catches the
  // different failure of someone disabling RLS in a later migration, and it
  // catches it with a clearer signal than a wall of isolation failures.
  it("all six tables have relrowsecurity", async () => {
    const off = await withTestClient(async (c) => {
      const { rows } = await c.query<{ relname: string }>(
        `select relname from pg_class
          where relnamespace = 'public'::regnamespace
            and relname like 'compound\\_%'
            and relkind = 'r'
            and not relrowsecurity
          order by relname`,
      );
      return rows.map((r) => r.relname);
    });
    expect(off).toEqual([]);
  });

  it("every compound table carries the policies it should", async () => {
    const counts = await withTestClient(async (c) => {
      const { rows } = await c.query<{ tablename: string; n: string }>(
        `select tablename, count(*)::text as n from pg_policies
          where schemaname = 'public' and tablename like 'compound\\_%'
          group by tablename order by tablename`,
      );
      return rows.map((r) => [r.tablename, Number(r.n)] as const);
    });
    expect(counts).toEqual([
      ["compound_account", 3],
      ["compound_audit", 2],
      ["compound_capital_event_candidate", 3],
      ["compound_holder", 3],
      ["compound_ledger_entry", 2],
      ["compound_reconcile_cursor", 3],
    ]);
  });

  it("grants no UPDATE or DELETE on compound_ledger_entry to any role", async () => {
    const grants = await withTestClient(async (c) => {
      const { rows } = await c.query<{ grantee: string; privilege_type: string }>(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'public' and table_name = 'compound_ledger_entry'
            and grantee <> 'postgres'
          order by grantee, privilege_type`,
      );
      return rows.map((r) => `${r.grantee}:${r.privilege_type}`);
    });
    expect(grants).toEqual([
      "authenticated:INSERT",
      "authenticated:SELECT",
      "service_role:INSERT",
      "service_role:SELECT",
    ]);
  });
});
```

- [ ] **Step 4: Run the gates**

```bash
pnpm typecheck && pnpm test:db
```

- [ ] **Step 5: Prove every RLS test bites**

This is the step the task exists for. Run each probe, confirm the named failures, restore, `supabase db reset`.

1. **Disable RLS on `compound_ledger_entry`.** Append `alter table public.compound_ledger_entry disable row level security;` to the migration, reset, re-run.
   Expected red: `"shows each manager only their own entries"` (Alice now sees both amounts), `"refuses Alice an entry written into Bob's ledger"` (the insert succeeds), `"all six tables have relrowsecurity"`, and the two `compound_ledger_entry` admin-gate cases. Nothing else. If `"shows each manager only their own entries"` stays green, the test is filtered somewhere and must be fixed before this task is finished.
2. **Do the same for each of the other five tables, one at a time.** For each, at least one *behavioural* test in that table's `describe` block must go red. Record which one. If any table's block stays green with its RLS off, that block is decorative and must be rewritten.
3. **Widen a policy.** Change `compound_holder_select`'s `using` clause to `using (true)`, reset, re-run.
   Expected red: `"shows each manager only their own holders"`, and the two `compound_holder` admin-gate cases. The structural tests stay green — a bad policy is still a policy, which is precisely why the structural tests are not a substitute.
4. **Remove the admin gate from one policy.** Drop `public.compound_is_admin() and` from `compound_account_select`, reset, re-run.
   Expected red: `"compound_account is closed to Alice with a user-role claim"` and `"compound_account is closed to Alice with no claim at all"`. Every ownership test stays green — which is the demonstration that the gate and the key are independent, and that neither one alone would have been caught by the other's tests.
5. **Turn the AND into an OR.** Change `compound_account_select` to `using (public.compound_is_admin() or manager_user_id = (select auth.uid()))`, reset, re-run.
   Expected red: `"shows Alice her account and not Bob's"`, `"shows Bob his account and not Alice's"`, `"shows Carol nothing at all"`. This is decision P5 made falsifiable: with an admin bypass arm, every admin sees every account.
6. **Break the account-less audit arm.** Remove `actor = (select auth.uid()) or` from `compound_audit_select`, reset, re-run.
   Expected red: `"shows a manager their account's rows plus their own actor rows"` — Alice loses the `sign_in` row. `"does not show Bob Alice's account-less rows"` stays green, because Bob never saw it either way.
7. **Confirm the wrong vantage point proves nothing.** Temporarily change `readAllAs` to use `service_role` instead of `authenticated`. Re-run.
   Expected: **every isolation test fails**, because `service_role` bypasses RLS and sees both managers' rows. That failure is the point — it demonstrates that had the suite been written from that vantage point, it would have been asserting on unfiltered data the whole time. Restore.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations lib/compound/db/rls.db.test.ts
git commit -m "feat(db): RLS on all six compound tables — admin gate AND manager_user_id key"
```

---

### Task 4: The ledger is append-only, and the database says so

Spec §9: `compound_ledger_entry` grants `INSERT` and `SELECT` only, "which is what makes invariant 5 structural rather than a convention". Spec §3.5 invariant 5: "Ledger is append-only; corrections are reversing entries."

**Read this before writing the tests, because it is the trap this task exists to avoid.** On this Supabase version, `ALTER DEFAULT PRIVILEGES` grants only `REFERENCES`, `TRIGGER` and `TRUNCATE` to `anon`, `authenticated` and `service_role` — **not** `UPDATE` or `DELETE`. Verified against the running stack. So:

- The `revoke` statement is a **no-op locally**. A test that asserts "service_role cannot UPDATE" passes with the `revoke` line deleted, because the privilege was never granted. That is an assertion that cannot fail.
- The `revoke` still belongs in the migration, because it is not a no-op everywhere. An older Supabase project — quite possibly the live CopyTraderX one — carries `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO anon, authenticated, service_role`, and there the `revoke` is the only thing standing between the ledger and an `UPDATE`.
- Grants do not apply to a table's **owner** at all. These migrations run as `postgres`, which owns everything, so a grant-only defence is silent about the one role that runs the migrations.

Hence decision P7: grants **and** triggers. The trigger is what bites locally, and what bites the owner. Verified: a `before update or delete or truncate` trigger refuses `postgres` itself.

Note also that `TRUNCATE` is in the default grant set. A migration that revokes only `UPDATE` and `DELETE` leaves the ledger truncatable, which is a strange way for an append-only table to end.

**Files:**
- Create: `supabase/migrations/<generated>_compound_ledger_append_only.sql`
- Create: `lib/compound/db/append-only.db.test.ts`

**Interfaces:**
- Consumes: `compound_ledger_entry` from Task 2; the grants from Task 3
- Produces: `public.compound_ledger_entry_is_append_only() returns trigger`; three triggers; the narrowed grant set

- [ ] **Step 1: Generate the migration file**

```bash
supabase migration new compound_ledger_append_only
```

Write into the generated file:

```sql
-- ============================================================================
-- The ledger is append-only. Design spec section 9 and invariant 5 of 3.5.
-- ============================================================================
--
-- Two layers, because neither one alone is enough:
--
--   1. GRANTS. Section 9 asks for exactly this: SELECT and INSERT, nothing
--      else, to anyone. On THIS Supabase version the default privileges grant
--      no UPDATE to begin with, so the revoke changes nothing locally — but an
--      older project carrying `ALTER DEFAULT PRIVILEGES ... GRANT ALL` would
--      hand UPDATE to service_role the moment the table is created, and there
--      the revoke is the whole defence. It is written explicitly and not
--      assumed. TRUNCATE is revoked too: it IS in the default grant set, and
--      an append-only table that can be truncated is not append-only.
--
--   2. TRIGGERS. Table grants do not apply to a table's owner, and these
--      migrations run as the owner. A BEFORE trigger does apply to the owner.
--      That is the difference between "the application cannot rewrite history"
--      and "history cannot be rewritten".
--
-- To correct a mistake, insert a reversing entry pointing at reverses_id.
-- engine/replay.ts voids both the original and the reversal when it folds.
-- ============================================================================

revoke all on public.compound_ledger_entry
  from public, anon, authenticated, service_role;

grant select, insert on public.compound_ledger_entry to authenticated, service_role;
grant usage, select on sequence public.compound_ledger_entry_id_seq
  to authenticated, service_role;

create or replace function public.compound_ledger_entry_is_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'compound_ledger_entry is append-only: % refused. Correct a mistake with a '
    'reversing entry (reverses_id), never by editing history.', tg_op
    using errcode = 'CX010';
end;
$$;

create trigger compound_ledger_entry_no_update
  before update on public.compound_ledger_entry
  for each row execute function public.compound_ledger_entry_is_append_only();

create trigger compound_ledger_entry_no_delete
  before delete on public.compound_ledger_entry
  for each row execute function public.compound_ledger_entry_is_append_only();

-- A BEFORE TRUNCATE trigger must be FOR EACH STATEMENT; there are no rows to
-- iterate.
create trigger compound_ledger_entry_no_truncate
  before truncate on public.compound_ledger_entry
  for each statement execute function public.compound_ledger_entry_is_append_only();
```

- [ ] **Step 2: Apply and confirm**

```bash
supabase db reset
```

- [ ] **Step 3: Write the append-only tests**

Create `lib/compound/db/append-only.db.test.ts`:

```typescript
/**
 * The ledger refuses to be rewritten — by anyone, including its owner.
 *
 * Note which vantage points these run from and why. As authenticated and as
 * service_role, the grant is the first thing that refuses. As postgres, the
 * grant is irrelevant (owners hold implicit privileges) and only the trigger
 * refuses. Testing all three is what turns "the app cannot" into "nobody can".
 */
import {
  asRole,
  closeTestPool,
  expectPgError,
  resetCompoundTables,
  seedUser,
  withTestClient,
} from "./testing/harness";

const MANAGER = "aaaaaaaa-0000-4000-8000-0000000000f1";
const MT5 = 9_900_401;

let accountId = 0;

beforeEach(async () => {
  await withTestClient(async (c) => {
    await resetCompoundTables(c);
    await seedUser(c, MANAGER, "append-only@example.test");
    const { rows } = await c.query<{ id: string }>(
      `insert into public.compound_account
         (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
       values ($1, 'Append Only', 'USD', 4000, '2026-05-01', $2)
       returning id`,
      [MT5, MANAGER],
    );
    accountId = Number(rows[0]!.id);
    await c.query(
      `insert into public.compound_ledger_entry
         (account_id, seq, occurred_on, type, amount_cents)
       values ($1, 1, '2026-05-02', 'equity_reading', 1000005),
              ($1, 2, '2026-05-03', 'equity_reading', 1000029)`,
      [accountId],
    );
  });
});

afterAll(async () => {
  await withTestClient((c) => resetCompoundTables(c));
  await closeTestPool();
});

async function ledgerAmounts(): Promise<string[]> {
  return withTestClient(async (c) => {
    const { rows } = await c.query<{ amount_cents: string }>(
      `select amount_cents from public.compound_ledger_entry order by seq`,
    );
    return rows.map((r) => r.amount_cents);
  });
}

describe("appending still works — the trigger must not block the only legal write", () => {
  it("lets the owner insert", async () => {
    const n = await withTestClient(async (c) => {
      const { rowCount } = await c.query(
        `insert into public.compound_ledger_entry
           (account_id, seq, occurred_on, type, amount_cents)
         values ($1, 3, '2026-05-04', 'equity_reading', 1000105)`,
        [accountId],
      );
      return rowCount;
    });
    expect(n).toBe(1);
    expect(await ledgerAmounts()).toEqual(["1000005", "1000029", "1000105"]);
  });

  it("lets a reversing entry in, since that is how corrections are made", async () => {
    const n = await withTestClient(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `select id from public.compound_ledger_entry where seq = 2 and account_id = $1`,
        [accountId],
      );
      const { rowCount } = await c.query(
        `insert into public.compound_ledger_entry
           (account_id, seq, occurred_on, type, amount_cents, reverses_id, note)
         values ($1, 3, '2026-05-04', 'equity_reading', 1000029, $2, 'mis-keyed reading')`,
        [accountId, Number(rows[0]!.id)],
      );
      return rowCount;
    });
    expect(n).toBe(1);
  });
});

describe("as authenticated", () => {
  it("refuses UPDATE", async () => {
    await withTestClient((c) =>
      asRole(c, "authenticated", { userId: MANAGER }, () =>
        expectPgError(
          c.query("update public.compound_ledger_entry set amount_cents = 1"),
          "42501",
          /permission denied for table compound_ledger_entry/,
        ),
      ),
    );
    expect(await ledgerAmounts()).toEqual(["1000005", "1000029"]);
  });

  it("refuses DELETE", async () => {
    await withTestClient((c) =>
      asRole(c, "authenticated", { userId: MANAGER }, () =>
        expectPgError(
          c.query("delete from public.compound_ledger_entry"),
          "42501",
          /permission denied for table compound_ledger_entry/,
        ),
      ),
    );
    expect(await ledgerAmounts()).toEqual(["1000005", "1000029"]);
  });

  it("refuses TRUNCATE", async () => {
    await withTestClient((c) =>
      asRole(c, "authenticated", { userId: MANAGER }, () =>
        expectPgError(
          c.query("truncate public.compound_ledger_entry"),
          "42501",
          /permission denied for table compound_ledger_entry/,
        ),
      ),
    );
    expect(await ledgerAmounts()).toEqual(["1000005", "1000029"]);
  });
});

describe("as service_role — the role the application actually runs as", () => {
  it("refuses UPDATE", async () => {
    await withTestClient((c) =>
      asRole(c, "service_role", {}, () =>
        expectPgError(
          c.query("update public.compound_ledger_entry set amount_cents = 1"),
          "42501",
          /permission denied for table compound_ledger_entry/,
        ),
      ),
    );
    expect(await ledgerAmounts()).toEqual(["1000005", "1000029"]);
  });

  it("refuses DELETE", async () => {
    await withTestClient((c) =>
      asRole(c, "service_role", {}, () =>
        expectPgError(
          c.query("delete from public.compound_ledger_entry"),
          "42501",
          /permission denied for table compound_ledger_entry/,
        ),
      ),
    );
  });

  it("refuses TRUNCATE", async () => {
    await withTestClient((c) =>
      asRole(c, "service_role", {}, () =>
        expectPgError(
          c.query("truncate public.compound_ledger_entry"),
          "42501",
          /permission denied for table compound_ledger_entry/,
        ),
      ),
    );
  });

  it("can still SELECT and INSERT", async () => {
    const seen = await withTestClient((c) =>
      asRole(c, "service_role", {}, async () => {
        await c.query(
          `insert into public.compound_ledger_entry
             (account_id, seq, occurred_on, type, amount_cents)
           values ($1, 3, '2026-05-04', 'equity_reading', 1000105)`,
          [accountId],
        );
        const { rows } = await c.query<{ n: string }>(
          `select count(*)::text as n from public.compound_ledger_entry`,
        );
        return Number(rows[0]!.n);
      }),
    );
    expect(seen).toBe(3);
  });
});

describe("as postgres, the owner — where grants stop applying and only the trigger is left", () => {
  it("refuses UPDATE", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query("update public.compound_ledger_entry set amount_cents = 1"),
        "CX010",
        /append-only: UPDATE refused/,
      ),
    );
    expect(await ledgerAmounts()).toEqual(["1000005", "1000029"]);
  });

  it("refuses DELETE", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query("delete from public.compound_ledger_entry"),
        "CX010",
        /append-only: DELETE refused/,
      ),
    );
    expect(await ledgerAmounts()).toEqual(["1000005", "1000029"]);
  });

  it("refuses TRUNCATE", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query("truncate public.compound_ledger_entry"),
        "CX010",
        /append-only: TRUNCATE refused/,
      ),
    );
    expect(await ledgerAmounts()).toEqual(["1000005", "1000029"]);
  });

  it("refuses an UPDATE that matches no rows, so the guard is not row-count dependent", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query("update public.compound_ledger_entry set amount_cents = 1 where seq = 9999"),
        "CX010",
        /append-only: UPDATE refused/,
      ),
    );
  });
});

describe("the trigger, not the grant, is what holds locally", () => {
  /**
   * This is the important one. It simulates a project whose default
   * privileges DO hand UPDATE and DELETE to service_role — which the live
   * CopyTraderX project may well be — by granting them back explicitly, and
   * shows the ledger is still not writable.
   *
   * Without it, every "service_role refuses UPDATE" test above would pass with
   * the revoke deleted AND with the triggers deleted, because on this Supabase
   * version UPDATE was never granted in the first place. Those tests prove the
   * grant set; this one proves the guarantee.
   */
  it("refuses UPDATE as service_role even when UPDATE is granted back", async () => {
    await withTestClient((c) =>
      c.query("grant update, delete on public.compound_ledger_entry to service_role"),
    );
    try {
      await withTestClient((c) =>
        asRole(c, "service_role", {}, () =>
          expectPgError(
            c.query("update public.compound_ledger_entry set amount_cents = 1"),
            "CX010",
            /append-only: UPDATE refused/,
          ),
        ),
      );
      await withTestClient((c) =>
        asRole(c, "service_role", {}, () =>
          expectPgError(
            c.query("delete from public.compound_ledger_entry"),
            "CX010",
            /append-only: DELETE refused/,
          ),
        ),
      );
      expect(await ledgerAmounts()).toEqual(["1000005", "1000029"]);
    } finally {
      await withTestClient((c) =>
        c.query("revoke update, delete on public.compound_ledger_entry from service_role"),
      );
    }
  });
});

describe("the guarantee is structurally in place", () => {
  it("has all three triggers", async () => {
    const triggers = await withTestClient(async (c) => {
      const { rows } = await c.query<{ tgname: string }>(
        `select tgname from pg_trigger
          where tgrelid = 'public.compound_ledger_entry'::regclass
            and not tgisinternal
          order by tgname`,
      );
      return rows.map((r) => r.tgname);
    });
    expect(triggers).toEqual([
      "compound_ledger_entry_no_delete",
      "compound_ledger_entry_no_truncate",
      "compound_ledger_entry_no_update",
    ]);
  });

  it("grants exactly SELECT and INSERT, to exactly two roles", async () => {
    const grants = await withTestClient(async (c) => {
      const { rows } = await c.query<{ grantee: string; privilege_type: string }>(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'public' and table_name = 'compound_ledger_entry'
            and grantee <> 'postgres'
          order by grantee, privilege_type`,
      );
      return rows.map((r) => `${r.grantee}:${r.privilege_type}`);
    });
    expect(grants).toEqual([
      "authenticated:INSERT",
      "authenticated:SELECT",
      "service_role:INSERT",
      "service_role:SELECT",
    ]);
  });
});
```

- [ ] **Step 4: Run the gates**

```bash
pnpm typecheck && pnpm test:db
```

- [ ] **Step 5: Prove these tests bite — and record which ones do not**

1. **Delete all three triggers** from the migration, reset, re-run.
   Expected red: every test in `"as postgres, the owner"`, and `"refuses UPDATE as service_role even when UPDATE is granted back"`, and `"has all three triggers"`.
   Expected **still green**, and this is the finding to record: every test in `"as authenticated"` and `"as service_role"`. They pass because those roles have no `UPDATE` grant on this Supabase version, trigger or no trigger. **If those had been the only tests, this probe would have been silent.** That is the exact shape of "a revoke that was already the default".
2. **Delete only the `revoke all` line**, reset, re-run.
   Expected: **nothing goes red at all**, on this Supabase version. Record that. It is not a reason to delete the line — it is the reason the trigger exists and the reason the grant-back test exists. Restore.
3. **Delete only the TRUNCATE trigger**, reset, re-run.
   Expected red: `"refuses TRUNCATE"` under `"as postgres"`, and `"has all three triggers"`. `"refuses TRUNCATE"` under `authenticated` and `service_role` stays green — the grant already stopped them.
4. **Change the trigger to `after update`** instead of `before update`, reset, re-run.
   Expected red: `"refuses an UPDATE that matches no rows"` stays green either way, but the other owner tests still pass, since an `AFTER` trigger that raises still aborts the statement. Record this: it means the `BEFORE`/`AFTER` choice is **not** covered by any test here. It is `BEFORE` because that is the cheaper and more conventional form, not because a test demands it. Restore.
5. **Break the message.** Change the exception text to `'nope'`, reset, re-run.
   Expected red: every owner test and the grant-back test, on the message match — confirming they assert the reason and not merely the failure.

- [ ] **Step 6: Phase A checkpoint**

```bash
pnpm typecheck && pnpm test && pnpm test:db
```

At this point the database is done: six tables, RLS keyed on `manager_user_id` behind an admin gate, and an append-only ledger that refuses even its owner. **This is a clean place to stop, review and merge** if the plan is being split.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations lib/compound/db/append-only.db.test.ts
git commit -m "feat(db): make the ledger append-only by grant and by trigger"
```

---

### Task 5: The connection, and the rule that money never becomes a float

Phase B starts here. This task builds the only two things every query in `db/` depends on: a pooled connection that runs as `service_role`, and a small set of SQL fragments and parsers that make it impossible for a money value to pass through a JavaScript `number`.

Two hazards drive the design, and both were verified against the running stack rather than assumed:

- **`pg` returns `date` as a JavaScript `Date`**, constructed at *local* midnight. `.toISOString().slice(0, 10)` on that is a different day west of UTC. Every date column is therefore cast to `text` in SQL and never parsed by the driver. `reconcile/date-key.ts` already makes the same argument for timestamps: attributing a trade to the wrong day is how a reconciler invents a capital event that never happened.
- **`Math.trunc(10000.05 * 100)` is `1000004`** — one cent short. `round(10000.05::numeric * 100)::bigint` is `1000005`. All conversion happens in SQL, in `numeric`, and arrives as an `int8` that `pg` hands over as a string.

**Files:**
- Create: `lib/compound/db/client.ts`
- Create: `lib/compound/db/sql.ts`
- Create: `lib/compound/db/sql.test.ts`
- Create: `lib/compound/db/purity.test.ts`
- Create: `lib/compound/db/client.db.test.ts`

**Interfaces:**
- Consumes: `Cents` from `@/lib/compound/engine/money`
- Produces:
  - `databaseUrl(): string`
  - `getPool(): Pool`
  - `closePool(): Promise<void>`
  - `withDb<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>`
  - `withDbTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>`
  - `centsExpr(column: string): string`
  - `milliLotsExpr(column: string): string`
  - `dateKeyExpr(column: string): string`
  - `utcIsoExpr(column: string): string`
  - `toCents(raw: unknown, field: string): Cents`
  - `toId(raw: unknown, field: string): number`
  - `toDateKey(raw: unknown, field: string): string`
  - `toSide(raw: unknown, field: string): "buy" | "sell"`

- [ ] **Step 1: Create `lib/compound/db/client.ts`**

```typescript
/**
 * The only connection Compound opens.
 *
 * pg rather than @supabase/supabase-js. PostgREST serialises bigint and
 * numeric as JSON numbers, so 9007199254740993 arrives as 9007199254740992 and
 * every cent figure becomes a float — which spec section 4 forbids outright.
 * pg returns int8 as a string, which BigInt() parses exactly. The writer also
 * needs a real row lock, and its concurrency test needs two sessions; neither
 * is available over PostgREST.
 *
 * Every borrowed connection switches to service_role. Without that the
 * application runs as postgres, which owns these tables and carries BYPASSRLS
 * — and a table owner's implicit privileges make every grant in this schema
 * decorative at runtime. Under service_role, the append-only grant on
 * compound_ledger_entry actually binds.
 */
import { Pool, type PoolClient } from "pg";

let pool: Pool | null = null;

export function databaseUrl(): string {
  const url = process.env.COMPOUND_DATABASE_URL;
  if (!url || url.trim() === "") {
    throw new Error(
      "COMPOUND_DATABASE_URL is not set. Compound connects to Postgres directly; " +
        "see .env.example.",
    );
  }
  return url;
}

export function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: databaseUrl(), max: 10 });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function withDb<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  let broken = false;
  try {
    await c.query("set role service_role");
    return await fn(c);
  } catch (err) {
    broken = true;
    throw err;
  } finally {
    if (broken) {
      // Discard rather than return a connection whose role or transaction
      // state we can no longer vouch for. A leaked service_role would be
      // harmless; a leaked open transaction would not.
      c.release(true);
    } else {
      await c.query("reset role");
      c.release();
    }
  }
}

export async function withDbTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withDb(async (c) => {
    await c.query("begin");
    try {
      const out = await fn(c);
      await c.query("commit");
      return out;
    } catch (err) {
      await c.query("rollback");
      throw err;
    }
  });
}
```

- [ ] **Step 2: Create `lib/compound/db/sql.ts`**

```typescript
/**
 * SQL fragments and row parsers. The boundary where Postgres types become
 * TypeScript types, and the only place in db/ allowed to think about it.
 *
 * Two rules, both load-bearing:
 *
 *   1. Money is converted to integer cents IN SQL, using numeric arithmetic,
 *      and returned as int8. Verified: Math.trunc(10000.05 * 100) is 1000004,
 *      one cent short, while round(10000.05::numeric * 100)::bigint is
 *      1000005. Nothing in db/ multiplies a money value by 100.
 *
 *   2. Dates and timestamps are rendered to text IN SQL. pg parses a `date`
 *      into a JavaScript Date at LOCAL midnight, so slicing its ISO string
 *      returns the previous day west of UTC. reconcile/date-key.ts makes the
 *      same argument: attributing a trade to the wrong day is how a
 *      reconciler invents a capital event that never happened.
 *
 * The column names passed to these helpers are literals in this repository's
 * own source, never caller input. Postgres does not accept an identifier as a
 * bind parameter, so interpolation is the only option.
 */
import type { Cents } from "@/lib/compound/engine/money";

/** A numeric dollar column, as integer cents. */
export function centsExpr(column: string): string {
  return `round(${column}::numeric * 100)::bigint`;
}

/** A numeric lots column, as integer milli-lots. 0.05 lots is 50. */
export function milliLotsExpr(column: string): string {
  return `round(${column}::numeric * 1000)::int`;
}

/** A date column, as YYYY-MM-DD, without going through the driver's Date. */
export function dateKeyExpr(column: string): string {
  return `to_char(${column}, 'YYYY-MM-DD')`;
}

/** A timestamptz column, as an ISO 8601 instant in UTC. */
export function utcIsoExpr(column: string): string {
  return `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

export function toCents(raw: unknown, field: string): Cents {
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number") {
    throw new TypeError(
      `${field}: got a JavaScript number (${raw}) where integer cents were expected. ` +
        `That means the query returned numeric or float instead of ::bigint, and the ` +
        `value has already lost precision by the time it reaches here. Use centsExpr().`,
    );
  }
  if (typeof raw !== "string") {
    throw new TypeError(`${field}: expected an integer cent string, got ${typeof raw}`);
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new RangeError(`${field}: not an integer cent string: ${JSON.stringify(raw)}`);
  }
  return BigInt(raw);
}

/** A bigserial id, narrowed to number. Ids are not money and stay well below 2^53. */
export function toId(raw: unknown, field: string): number {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return raw;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new TypeError(`${field}: expected an id, got ${JSON.stringify(raw)}`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new RangeError(`${field}: id out of safe range: ${raw}`);
  return n;
}

export function toDateKey(raw: unknown, field: string): string {
  if (raw instanceof Date) {
    throw new TypeError(
      `${field}: got a Date. pg builds a date at LOCAL midnight, so its calendar day ` +
        `is wrong west of UTC. Render the column with dateKeyExpr() instead.`,
    );
  }
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new TypeError(`${field}: expected YYYY-MM-DD, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

export function toSide(raw: unknown, field: string): "buy" | "sell" {
  if (raw === "buy" || raw === "sell") return raw;
  throw new RangeError(
    `${field}: expected "buy" or "sell", got ${JSON.stringify(raw)}. The upstream ` +
      `deals.side column is plain text and carries whatever the EA pushed.`,
  );
}
```

- [ ] **Step 3: Write the parser unit tests**

These need no database, so they live in a plain `.test.ts` and run under `pnpm test`.

Create `lib/compound/db/sql.test.ts`:

```typescript
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

describe("the SQL fragments do the arithmetic, not JavaScript", () => {
  it("centsExpr casts to numeric before multiplying, and back to bigint", () => {
    expect(centsExpr("balance_close")).toBe("round(balance_close::numeric * 100)::bigint");
  });

  it("milliLotsExpr does the same for lots", () => {
    expect(milliLotsExpr("volume")).toBe("round(volume::numeric * 1000)::int");
  });

  it("dateKeyExpr renders text rather than letting the driver build a Date", () => {
    expect(dateKeyExpr("occurred_on")).toBe("to_char(occurred_on, 'YYYY-MM-DD')");
  });

  it("utcIsoExpr pins the instant to UTC and emits ISO 8601", () => {
    expect(utcIsoExpr("close_time")).toBe(
      `to_char(close_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    );
  });
});

describe("toCents", () => {
  it("parses an integer cent string", () => {
    expect(toCents("1000005", "balance")).toBe(1000005n);
  });

  it("parses a negative one", () => {
    expect(toCents("-205", "swap")).toBe(-205n);
  });

  it("keeps a value above 2^53 exact", () => {
    expect(toCents("9007199254740993", "equity")).toBe(9007199254740993n);
  });

  it("passes a bigint straight through", () => {
    expect(toCents(29n, "commission")).toBe(29n);
  });

  it("refuses a JavaScript number, and says why", () => {
    expect(() => toCents(1000005, "balance")).toThrow(
      /got a JavaScript number \(1000005\) where integer cents were expected/,
    );
  });

  it("refuses a decimal string — that is dollars, not cents", () => {
    expect(() => toCents("10000.05", "balance")).toThrow(/not an integer cent string/);
  });

  it("refuses null", () => {
    expect(() => toCents(null, "balance")).toThrow(/expected an integer cent string, got object/);
  });
});

describe("toDateKey", () => {
  it("passes a well-formed key through", () => {
    expect(toDateKey("2026-08-12", "trade_date")).toBe("2026-08-12");
  });

  it("refuses a Date, and explains the local-midnight hazard", () => {
    expect(() => toDateKey(new Date("2026-08-12T00:00:00Z"), "trade_date")).toThrow(
      /pg builds a date at LOCAL midnight/,
    );
  });

  it("refuses a timestamp string", () => {
    expect(() => toDateKey("2026-08-12T00:00:00Z", "trade_date")).toThrow(/expected YYYY-MM-DD/);
  });

  it("refuses a two-digit year", () => {
    expect(() => toDateKey("26-08-12", "trade_date")).toThrow(/expected YYYY-MM-DD/);
  });
});

describe("toId", () => {
  it("parses a bigserial string", () => {
    expect(toId("42", "id")).toBe(42);
  });

  it("accepts a number that is already safe", () => {
    expect(toId(42, "id")).toBe(42);
  });

  it("refuses an id past the safe integer range rather than rounding it", () => {
    expect(() => toId("9007199254740993", "id")).toThrow(/id out of safe range/);
  });

  it("refuses a negative id", () => {
    expect(() => toId("-1", "id")).toThrow(/expected an id/);
  });
});

describe("toSide", () => {
  it("accepts buy and sell", () => {
    expect(toSide("buy", "side")).toBe("buy");
    expect(toSide("sell", "side")).toBe("sell");
  });

  it("refuses a differently cased value rather than casting it", () => {
    expect(() => toSide("BUY", "side")).toThrow(/expected "buy" or "sell", got "BUY"/);
  });

  it("refuses an unexpected value and names it", () => {
    expect(() => toSide("balance", "side")).toThrow(/got "balance"/);
  });
});
```

- [ ] **Step 4: Write the `db/` purity guard**

`engine/purity.test.ts` scans only `lib/compound/engine/`, and `reconcile/purity.test.ts` only `lib/compound/reconcile/`. `db/` is unguarded, and it is the one directory where a stray `* 100` would silently cost a cent.

Create `lib/compound/db/purity.test.ts`:

```typescript
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DB_DIR = join(__dirname);

/**
 * Money arithmetic belongs in SQL (see sql.ts). Any of these in a db/ source
 * file means a cent value is being scaled in JavaScript, which is where
 * Math.trunc(10000.05 * 100) quietly returns 1000004.
 *
 * Number() is deliberately NOT here: ids legitimately use it, and they are not
 * money.
 */
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ["parseFloat", /\bparseFloat\s*\(/],
  ["Math.round", /\bMath\.round\s*\(/],
  ["Math.trunc", /\bMath\.trunc\s*\(/],
  ["Math.floor", /\bMath\.floor\s*\(/],
  ["multiply by 100", /\*\s*100\b/],
  ["multiply by 1000", /\*\s*1000\b/],
  ["divide by 100", /\/\s*100\b/],
  ["next import", /from\s+["']next/],
  ["react import", /from\s+["']react/],
  ["supabase-js import", /from\s+["']@supabase/],
];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".test.ts"))
    .map((f) => join(dir, f));
}

describe("db purity", () => {
  const files = sourceFiles(DB_DIR);

  // Ratchet. If the glob ever stops matching, the loop below iterates nothing
  // and passes having checked nothing. The floor is raised as db/ grows —
  // Task 8 takes it to 6.
  it("scans every source file in db/", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it("never scales money in JavaScript, and never imports the UI stack", () => {
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const [label, pattern] of FORBIDDEN) {
        expect({ file, label, matched: pattern.test(src) }).toEqual({
          file,
          label,
          matched: false,
        });
      }
    }
  });
});
```

Note: `sql.ts` contains the strings `* 100` and `* 1000` **inside SQL fragments**, which this guard would flag. Write those fragments so the guard passes without weakening it — the multiplication is inside a template literal and the pattern matches text, not intent. Resolve it by building the fragments from a constant:

```typescript
const CENTS_PER_UNIT = "100";
const MILLI_PER_LOT = "1000";

export function centsExpr(column: string): string {
  return `round(${column}::numeric * ${CENTS_PER_UNIT})::bigint`;
}

export function milliLotsExpr(column: string): string {
  return `round(${column}::numeric * ${MILLI_PER_LOT})::int`;
}
```

The scale factors are now strings spliced into SQL, which is exactly what they are — they are never JavaScript operands. The `sql.test.ts` assertions on the emitted text are unchanged and still pin the output.

- [ ] **Step 5: Write the connection integration test**

Create `lib/compound/db/client.db.test.ts`:

```typescript
import { closePool, withDb, withDbTransaction } from "./client";
import { LOCAL_SUPABASE_DB_URL } from "./testing/env";
import { closeTestPool, expectPgError, withTestClient } from "./testing/harness";

const ORIGINAL = process.env.COMPOUND_DATABASE_URL;

beforeAll(() => {
  process.env.COMPOUND_DATABASE_URL =
    process.env.COMPOUND_TEST_DATABASE_URL || LOCAL_SUPABASE_DB_URL;
});

afterAll(async () => {
  await closePool();
  await closeTestPool();
  process.env.COMPOUND_DATABASE_URL = ORIGINAL;
});

describe("withDb runs as service_role, not as the owner", () => {
  it("reports service_role inside the callback", async () => {
    const who = await withDb(async (c) => {
      const { rows } = await c.query<{ who: string }>("select current_user as who");
      return rows[0]?.who;
    });
    expect(who).toBe("service_role");
  });

  it("resets the role before returning the connection to the pool", async () => {
    await withDb(async () => undefined);
    const who = await withDb(async (c) => {
      // A fresh borrow re-applies the role; check the reset happened by
      // inspecting the session's default rather than the current setting.
      const { rows } = await c.query<{ who: string }>("select session_user as who");
      return rows[0]?.who;
    });
    expect(who).toBe("postgres");
  });

  it("cannot UPDATE compound_audit — the grant binds because the role does", async () => {
    // compound_audit has SELECT and INSERT grants only, and no trigger. If the
    // pool ran as postgres (the owner), this UPDATE would succeed: an owner's
    // implicit privileges ignore grants entirely. This is the test that holds
    // `set role service_role` in place.
    await withDb((c) =>
      expectPgError(
        c.query("update public.compound_audit set action = 'rewritten'"),
        "42501",
        /permission denied for table compound_audit/,
      ),
    );
  });
});

describe("withDbTransaction", () => {
  it("commits on success", async () => {
    await withTestClient((c) => c.query("drop table if exists public.zz_txn"));
    await withTestClient((c) =>
      c.query("create table public.zz_txn (v int not null)"),
    );
    await withTestClient((c) => c.query("grant insert, select on public.zz_txn to service_role"));
    try {
      await withDbTransaction(async (c) => {
        await c.query("insert into public.zz_txn (v) values (1)");
      });
      const n = await withTestClient(async (c) => {
        const { rows } = await c.query<{ n: string }>("select count(*)::text as n from public.zz_txn");
        return Number(rows[0]!.n);
      });
      expect(n).toBe(1);
    } finally {
      await withTestClient((c) => c.query("drop table if exists public.zz_txn"));
    }
  });

  it("rolls back on failure and leaves nothing behind", async () => {
    await withTestClient((c) => c.query("drop table if exists public.zz_txn"));
    await withTestClient((c) => c.query("create table public.zz_txn (v int not null)"));
    await withTestClient((c) => c.query("grant insert, select on public.zz_txn to service_role"));
    try {
      await expect(
        withDbTransaction(async (c) => {
          await c.query("insert into public.zz_txn (v) values (1)");
          await c.query("insert into public.zz_txn (v) values (2)");
          throw new Error("deliberate");
        }),
      ).rejects.toThrow("deliberate");

      const n = await withTestClient(async (c) => {
        const { rows } = await c.query<{ n: string }>("select count(*)::text as n from public.zz_txn");
        return Number(rows[0]!.n);
      });
      expect(n).toBe(0);
    } finally {
      await withTestClient((c) => c.query("drop table if exists public.zz_txn"));
    }
  });
});

describe("the driver's date and timestamp handling, documented by test", () => {
  it("hands back a Date for a date column — which is why sql.ts casts to text", async () => {
    const { raw, asText } = await withDb(async (c) => {
      const { rows } = await c.query<{ raw: unknown; as_text: string }>(
        `select '2026-08-12'::date as raw, to_char('2026-08-12'::date, 'YYYY-MM-DD') as as_text`,
      );
      return { raw: rows[0]!.raw, asText: rows[0]!.as_text };
    });
    expect(raw).toBeInstanceOf(Date);
    expect(asText).toBe("2026-08-12");
  });

  it("renders a timestamptz as an ISO instant in UTC regardless of the stored offset", async () => {
    const iso = await withDb(async (c) => {
      const { rows } = await c.query<{ iso: string }>(
        `select to_char(timestamptz '2026-08-06 11:00:00+03' at time zone 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as iso`,
      );
      return rows[0]!.iso;
    });
    expect(iso).toBe("2026-08-06T08:00:00.000Z");
  });
});

describe("databaseUrl refuses to guess", () => {
  it("throws when COMPOUND_DATABASE_URL is empty", async () => {
    const saved = process.env.COMPOUND_DATABASE_URL;
    process.env.COMPOUND_DATABASE_URL = "";
    await closePool();
    try {
      await expect(withDb(async () => undefined)).rejects.toThrow(
        /COMPOUND_DATABASE_URL is not set/,
      );
    } finally {
      process.env.COMPOUND_DATABASE_URL = saved;
    }
  });
});
```

- [ ] **Step 6: Run the gates**

```bash
pnpm typecheck && pnpm test && pnpm test:db
```

- [ ] **Step 7: Prove these tests bite**

1. **Remove `set role service_role`** from `withDb`, re-run.
   Expected red: `"reports service_role inside the callback"` and `"cannot UPDATE compound_audit"`. The second is the one that matters — it is the behavioural consequence, and it would still be green if the role had merely been reported wrong.
2. **Make `toCents` accept a number** by adding `if (typeof raw === "number") return BigInt(Math.round(raw));`, re-run.
   Expected red: `"refuses a JavaScript number, and says why"` and `"never scales money in JavaScript"` in the purity guard. Two independent tests catching one change is the intent.
3. **Change `centsExpr` to `(${column} * 100)::bigint`** — dropping the `numeric` cast and the `round`, re-run.
   Expected red: `"centsExpr casts to numeric before multiplying"`. Note this probe does **not** go red anywhere else until Task 6 seeds an awkward value; record that, and confirm it in Task 6's probes.
4. **Make `toDateKey` accept a Date** by returning `raw.toISOString().slice(0, 10)`, re-run.
   Expected red: `"refuses a Date, and explains the local-midnight hazard"`.
5. **Empty the purity guard's file list** by changing the filter to `f.endsWith(".nope")`, re-run.
   Expected red: `"scans every source file in db/"`. Confirm `"never scales money in JavaScript"` goes **green** with nothing to scan — which is the ratchet earning its place.

- [ ] **Step 8: Commit**

```bash
git add lib/compound/db/
git commit -m "feat(db): service_role pool, and money that converts in SQL rather than in JS"
```

---

### Task 6: Reading the CopyTraderX tables

The four tables Compound reads and never writes, mapped onto the types `reconcile/types.ts` already defines. **Do not redefine `DailySnapshot` or `ClosedDeal`** — import them. A second definition is a second truth, and the reconciler is built against the first one.

Three conversions happen here, all in SQL: `numeric(18,2)` dollars to integer cents, `numeric` lots to integer milli-lots, and `date`/`timestamptz` to text.

**Files:**
- Create: `lib/compound/db/copytraderx.ts`
- Create: `lib/compound/db/copytraderx.db.test.ts`

**Interfaces:**
- Consumes: `DailySnapshot`, `ClosedDeal` from `@/lib/compound/reconcile/types`; `Cents` from `@/lib/compound/engine/money`; everything from `./sql`
- Produces:
  - `interface DateRange { from?: string; to?: string }`
  - `interface LiveSnapshot { mt5Account: number; balanceCents: Cents; equityCents: Cents; floatingPnlCents: Cents; currency: string; server: string | null; pushedAt: string }`
  - `getDailySnapshots(c: Queryable, mt5Account: number, range?: DateRange): Promise<DailySnapshot[]>`
  - `getClosedDeals(c: Queryable, mt5Account: number, range?: DateRange): Promise<ClosedDeal[]>`
  - `getLiveSnapshot(c: Queryable, mt5Account: number): Promise<LiveSnapshot | null>`
  - `getAccountOwnerUserId(c: Queryable, mt5Account: number): Promise<string | null>`

- [ ] **Step 1: Create `lib/compound/db/copytraderx.ts`**

```typescript
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
```

- [ ] **Step 2: Write the tests**

The fixture is inserted by the test and torn down by the test, so it does not depend on the shipped seed and cannot be broken by a change to it. The **values are chosen to discriminate, not to read nicely** — each awkward one is annotated with the wrong answer it catches.

Create `lib/compound/db/copytraderx.db.test.ts`:

```typescript
import {
  getAccountOwnerUserId,
  getClosedDeals,
  getDailySnapshots,
  getLiveSnapshot,
} from "./copytraderx";
import { closeTestPool, seedUser, withTestClient } from "./testing/harness";

/** Fictional. Isolated from the shipped seed's 90000001. */
const MT5 = 9_900_601;
const OTHER_MT5 = 9_900_602;
const OWNER = "aaaaaaaa-0000-4000-8000-0000000006a1";

beforeAll(async () => {
  await withTestClient(async (c) => {
    await c.query("delete from public.deals where mt5_account = any($1::bigint[])", [
      [MT5, OTHER_MT5],
    ]);
    await c.query(
      "delete from public.account_snapshots_daily where mt5_account = any($1::bigint[])",
      [[MT5, OTHER_MT5]],
    );
    await c.query(
      "delete from public.account_snapshots_current where mt5_account = any($1::bigint[])",
      [[MT5, OTHER_MT5]],
    );
    await c.query("delete from public.licenses where mt5_account = any($1::bigint[])", [
      [MT5, OTHER_MT5],
    ]);
    await seedUser(c, OWNER, "ctx-owner@example.test");

    // Every money value below is picked because a float path gets it wrong.
    //   10000.05 * 100 is 1000004.9999999998836 in IEEE 754 → trunc gives 1000004
    //   10000.29 * 100 → trunc gives 1000028
    //        0.29 * 100 is 28.999999999999996  → trunc gives 28
    //       -2.05 * 100 is -204.99999999999997 → trunc gives -204
    // 1234.56 is included as a control: it converts correctly either way, and
    // is here so the suite does not look like it only ever uses odd numbers.
    await c.query(
      `insert into public.account_snapshots_daily
         (mt5_account, trade_date, balance_close, equity_close, daily_pnl)
       values ($1, '2026-08-03', 10000.05, 10000.29, 0.00),
              ($1, '2026-08-04', 10123.45, 10123.45, 123.40),
              ($1, '2026-08-05', 10250.13, 10199.87, 126.68),
              ($2, '2026-08-04', 55555.55, 55555.55, 0.00)`,
      [MT5, OTHER_MT5],
    );

    await c.query(
      `insert into public.deals
         (mt5_account, ticket, ea_source, symbol, side, volume,
          open_price, close_price, open_time, close_time,
          profit, swap, commission)
       values
         ($1, 9901001, 'impulse', 'EURUSD', 'buy',  0.05, 1.0, 1.0,
          '2026-08-04T07:00:00+00', '2026-08-04T08:00:00+00', 1234.56, -2.05, -0.29),
         ($1, 9901002, 'impulse', 'BTCUSD', 'sell', 0.03, 1.0, 1.0,
          '2026-08-05T07:00:00+00', '2026-08-05T09:30:00+00', -50.26, 0.00, -0.29),
         ($2, 9901099, 'impulse', 'GBPUSD', 'buy',  1.00, 1.0, 1.0,
          '2026-08-04T07:00:00+00', '2026-08-04T08:00:00+00', 10.00, 0.00, 0.00)`,
      [MT5, OTHER_MT5],
    );

    await c.query(
      `insert into public.account_snapshots_current
         (mt5_account, balance, equity, margin, free_margin, margin_level,
          floating_pnl, drawdown_pct, leverage, currency, server, pushed_at)
       values ($1, 10250.13, 10199.87, 100.00, 10099.87, 1000.0,
               -50.26, 0.5, 500, 'USD', 'Fictional-Demo', '2026-08-05T21:00:00+00')`,
      [MT5],
    );

    await c.query(
      `insert into public.licenses (mt5_account, product, status, user_id)
       values ($1, 'impulse', 'active', $2)`,
      [MT5, OWNER],
    );
  });
});

afterAll(async () => {
  await withTestClient(async (c) => {
    await c.query("delete from public.deals where mt5_account = any($1::bigint[])", [
      [MT5, OTHER_MT5],
    ]);
    await c.query(
      "delete from public.account_snapshots_daily where mt5_account = any($1::bigint[])",
      [[MT5, OTHER_MT5]],
    );
    await c.query(
      "delete from public.account_snapshots_current where mt5_account = any($1::bigint[])",
      [[MT5, OTHER_MT5]],
    );
    await c.query("delete from public.licenses where mt5_account = any($1::bigint[])", [
      [MT5, OTHER_MT5],
    ]);
  });
  await closeTestPool();
});

describe("getDailySnapshots", () => {
  it("returns every day for the account, in date order", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, MT5));
    expect(rows.map((r) => r.tradeDate)).toEqual(["2026-08-03", "2026-08-04", "2026-08-05"]);
  });

  it("converts dollars to cents without a float in sight", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, MT5));
    // 1000005, not 1000004. This is the assertion the whole SQL-side
    // conversion exists for.
    expect(rows[0]!.balanceCloseCents).toBe(1000005n);
    expect(rows[0]!.equityCloseCents).toBe(1000029n);
    expect(rows[1]!.balanceCloseCents).toBe(1012345n);
    expect(rows[2]!.balanceCloseCents).toBe(1025013n);
  });

  it("keeps balance and equity distinct — they are different facts", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, MT5));
    expect(rows[2]!.balanceCloseCents).toBe(1025013n);
    expect(rows[2]!.equityCloseCents).toBe(1019987n);
    expect(rows[2]!.balanceCloseCents).not.toBe(rows[2]!.equityCloseCents);
  });

  it("returns bigints, not numbers", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, MT5));
    expect(typeof rows[0]!.balanceCloseCents).toBe("bigint");
  });

  it("does not leak another account's rows", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, MT5));
    expect(rows.map((r) => r.balanceCloseCents)).not.toContain(5555555n);
  });

  it("honours an inclusive from bound", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, MT5, { from: "2026-08-04" }));
    expect(rows.map((r) => r.tradeDate)).toEqual(["2026-08-04", "2026-08-05"]);
  });

  it("honours an inclusive to bound", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, MT5, { to: "2026-08-04" }));
    expect(rows.map((r) => r.tradeDate)).toEqual(["2026-08-03", "2026-08-04"]);
  });

  it("returns nothing for an account with no snapshots", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, 9_909_999));
    expect(rows).toEqual([]);
  });
});

describe("getClosedDeals", () => {
  it("returns the account's deals in ticket order", async () => {
    const deals = await withTestClient((c) => getClosedDeals(c, MT5));
    expect(deals.map((d) => d.ticket)).toEqual([9901001, 9901002]);
  });

  it("converts profit, swap and commission to exact cents including negatives", async () => {
    const deals = await withTestClient((c) => getClosedDeals(c, MT5));
    expect(deals[0]!.profitCents).toBe(123456n);
    // -205, not -204.
    expect(deals[0]!.swapCents).toBe(-205n);
    // -29, not -28.
    expect(deals[0]!.commissionCents).toBe(-29n);
    expect(deals[1]!.profitCents).toBe(-5026n);
  });

  it("converts lots to milli-lots as an integer", async () => {
    const deals = await withTestClient((c) => getClosedDeals(c, MT5));
    expect(deals[0]!.volumeMilliLots).toBe(50);
    expect(deals[1]!.volumeMilliLots).toBe(30);
    expect(Number.isInteger(deals[0]!.volumeMilliLots)).toBe(true);
  });

  it("renders both timestamps as ISO instants in UTC", async () => {
    const deals = await withTestClient((c) => getClosedDeals(c, MT5));
    expect(deals[0]!.openTime).toBe("2026-08-04T07:00:00.000Z");
    expect(deals[0]!.closeTime).toBe("2026-08-04T08:00:00.000Z");
    expect(deals[1]!.closeTime).toBe("2026-08-05T09:30:00.000Z");
  });

  it("produces timestamps reconcile/date-key.ts can parse", async () => {
    const { utcDateKey } = await import("@/lib/compound/reconcile/date-key");
    const deals = await withTestClient((c) => getClosedDeals(c, MT5));
    expect(utcDateKey(deals[0]!.closeTime)).toBe("2026-08-04");
    expect(utcDateKey(deals[1]!.closeTime)).toBe("2026-08-05");
  });

  it("feeds dealNetCents correctly", async () => {
    const { dealNetCents } = await import("@/lib/compound/reconcile/types");
    const deals = await withTestClient((c) => getClosedDeals(c, MT5));
    // 123456 + (-205) + (-29)
    expect(dealNetCents(deals[0]!)).toBe(123222n);
  });

  it("filters on the UTC calendar day of close_time", async () => {
    const deals = await withTestClient((c) => getClosedDeals(c, MT5, { from: "2026-08-05" }));
    expect(deals.map((d) => d.ticket)).toEqual([9901002]);
  });

  it("does not leak another account's deals", async () => {
    const deals = await withTestClient((c) => getClosedDeals(c, MT5));
    expect(deals.map((d) => d.ticket)).not.toContain(9901099);
  });

  it("refuses a side value it does not recognise rather than casting it", async () => {
    await withTestClient(async (c) => {
      await c.query(
        `insert into public.deals
           (mt5_account, ticket, ea_source, symbol, side, volume,
            open_price, close_price, open_time, close_time, profit, swap, commission)
         values ($1, 9901003, 'impulse', 'EURUSD', 'BUY', 0.01, 1.0, 1.0,
                 '2026-08-06T07:00:00+00', '2026-08-06T08:00:00+00', 1.00, 0.00, 0.00)`,
        [MT5],
      );
    });
    try {
      await expect(withTestClient((c) => getClosedDeals(c, MT5))).rejects.toThrow(
        /deals\.side: expected "buy" or "sell", got "BUY"/,
      );
    } finally {
      await withTestClient((c) =>
        c.query("delete from public.deals where ticket = 9901003 and mt5_account = $1", [MT5]),
      );
    }
  });
});

describe("getLiveSnapshot", () => {
  it("returns the live figures with equity and balance apart", async () => {
    const snap = await withTestClient((c) => getLiveSnapshot(c, MT5));
    expect(snap).toEqual({
      mt5Account: MT5,
      balanceCents: 1025013n,
      equityCents: 1019987n,
      floatingPnlCents: -5026n,
      currency: "USD",
      server: "Fictional-Demo",
      pushedAt: "2026-08-05T21:00:00.000Z",
    });
  });

  it("returns null when the account has never pushed", async () => {
    const snap = await withTestClient((c) => getLiveSnapshot(c, 9_909_999));
    expect(snap).toBeNull();
  });
});

describe("getAccountOwnerUserId", () => {
  it("resolves an MT5 account to its public.users owner", async () => {
    const owner = await withTestClient((c) => getAccountOwnerUserId(c, MT5));
    expect(owner).toBe(OWNER);
  });

  it("returns null for an unlicensed account rather than throwing", async () => {
    const owner = await withTestClient((c) => getAccountOwnerUserId(c, 9_909_999));
    expect(owner).toBeNull();
  });

  it("ignores a revoked licence", async () => {
    await withTestClient((c) =>
      c.query(
        `insert into public.licenses (mt5_account, product, status, user_id)
         values ($1, 'impulse', 'revoked', $2)`,
        [OTHER_MT5, OWNER],
      ),
    );
    try {
      const owner = await withTestClient((c) => getAccountOwnerUserId(c, OTHER_MT5));
      expect(owner).toBeNull();
    } finally {
      await withTestClient((c) =>
        c.query("delete from public.licenses where mt5_account = $1", [OTHER_MT5]),
      );
    }
  });
});

describe("the 2^53 boundary", () => {
  /**
   * A balance of $90,071,992,547,409.93 is deliberately absurd. It is here
   * because 90071992547409.93 * 100 is exactly 2^53 + 1 — the first integer a
   * JavaScript number cannot represent — so any path that touches a float
   * returns 9007199254740992 and this test says so.
   */
  const BIG_MT5 = 9_900_699;

  beforeAll(async () => {
    await withTestClient((c) =>
      c.query(
        `insert into public.account_snapshots_daily
           (mt5_account, trade_date, balance_close, equity_close, daily_pnl)
         values ($1, '2026-08-03', 90071992547409.93, 90071992547409.93, 0.00)`,
        [BIG_MT5],
      ),
    );
  });

  afterAll(async () => {
    await withTestClient((c) =>
      c.query("delete from public.account_snapshots_daily where mt5_account = $1", [BIG_MT5]),
    );
  });

  it("survives the round trip exactly", async () => {
    const rows = await withTestClient((c) => getDailySnapshots(c, BIG_MT5));
    expect(rows[0]!.balanceCloseCents).toBe(9007199254740993n);
    expect(Number(rows[0]!.balanceCloseCents)).toBe(9007199254740992); // for contrast
  });
});
```

- [ ] **Step 3: Run the gates**

```bash
pnpm typecheck && pnpm test:db
```

- [ ] **Step 4: Prove these tests bite**

1. **Convert money in JavaScript.** Change `centsExpr` back to returning the raw column, and have `getDailySnapshots` compute `BigInt(Math.trunc(Number(r.balance_close_cents) * 100))`.
   Expected red: `"converts dollars to cents without a float in sight"` (`1000004n` instead of `1000005n`), `"survives the round trip exactly"`, and the `db/` purity guard from Task 5. This is the probe that closes out Task 5 Step 7's probe 3, which had nothing to bite on yet.
2. **Drop the `round` from `centsExpr`**, leaving `(${column}::numeric * 100)::bigint`.
   Expected: still **green** — `::bigint` from `numeric` rounds anyway. Record that. `round` is there so the intent is on the page, not because a test forces it. Restore.
3. **Use `x::text` for timestamps** instead of `utcIsoExpr`.
   Expected red: `"renders both timestamps as ISO instants in UTC"` — the value becomes `2026-08-04 08:00:00+00`. `"produces timestamps reconcile/date-key.ts can parse"` may stay **green**, because V8 happens to parse that non-standard form; record it, because it means the exact-string assertion is the one holding the line, not the parse.
4. **Return the raw `date` column** instead of `dateKeyExpr`.
   Expected red: `"returns every day for the account, in date order"` — `toDateKey` throws on the `Date`, naming the local-midnight hazard.
5. **Cast `side` instead of validating it** — `side: r.side as "buy" | "sell"`.
   Expected red: `"refuses a side value it does not recognise"`. Every other deal test stays green, which is the point: a silent cast is invisible until the data is wrong.
6. **Drop the `mt5_account = $1` filter** from `getDailySnapshots`.
   Expected red: `"returns every day for the account, in date order"` and `"does not leak another account's rows"`. The second is the one written for this probe, and it is why a second account is in the fixture at all.
7. **Compare `close_time` against a bare date** — `close_time >= $2::date` instead of the `at time zone 'UTC'` form. Then run the suite with `TZ=Pacific/Kiritimati pnpm test:db`.
   Expected: `"filters on the UTC calendar day of close_time"` behaviour depends on the session timezone rather than on UTC. Record what you observe. If it stays green under both timezones, note that the fixture's close times are too far from midnight to discriminate, and move ticket 9901002's close time to `2026-08-05T23:30:00+00` so it does.

- [ ] **Step 5: Commit**

```bash
git add lib/compound/db/copytraderx.ts lib/compound/db/copytraderx.db.test.ts
git commit -m "feat(db): read the CopyTraderX tables into reconcile/types shapes"
```

---

### Task 7: Reading the `compound_*` tables into engine and reconcile shapes

The read side of Compound's own tables. Every return type is imported: `LedgerEntry` and `HolderSeed` from `engine/replay.ts`, `ReconcileCursor` from `reconcile/interlock.ts`. **Nothing here redefines them.** `fold()` is built against those shapes and a parallel definition would drift from it silently.

The one behaviour worth stating up front: `getLedgerEntries` orders by **`seq`**, not by `id` and not by `occurred_on`. Spec §6.2 is explicit that `seq` defines replay order, and the fixture below is built so that `id` order, `occurred_on` order and `seq` order all disagree — otherwise the assertion would pass under any of the three.

**Files:**
- Create: `lib/compound/db/compound.ts`
- Create: `lib/compound/db/compound.db.test.ts`

**Interfaces:**
- Consumes: `LedgerEntry`, `LedgerEntryType`, `HolderSeed` from `@/lib/compound/engine/replay`; `ReconcileCursor` from `@/lib/compound/reconcile/interlock`; `Cents` from `@/lib/compound/engine/money`; everything from `./sql`
- Produces:
  - `interface CompoundAccount { id: number; mt5Account: number; label: string; broker: string | null; currency: string; defaultSplitBps: number; inceptionDate: string; managerUserId: string }`
  - `interface CapitalEventCandidateRow { id: number; accountId: number; tradeDate: string; balanceDeltaCents: Cents; explainedCents: Cents; unexplainedCents: Cents; status: "pending" | "classified" | "ignored"; detectedAt: string }`
  - `getAccountById(c: Queryable, accountId: number): Promise<CompoundAccount | null>`
  - `getAccountByMt5(c: Queryable, mt5Account: number): Promise<CompoundAccount | null>`
  - `listAccountsForManager(c: Queryable, managerUserId: string): Promise<CompoundAccount[]>`
  - `getHolderSeeds(c: Queryable, accountId: number): Promise<HolderSeed[]>`
  - `getLedgerEntries(c: Queryable, accountId: number): Promise<LedgerEntry[]>`
  - `getReconcileCursor(c: Queryable, accountId: number): Promise<ReconcileCursor>`
  - `listCandidates(c: Queryable, accountId: number, status?: "pending" | "classified" | "ignored"): Promise<CapitalEventCandidateRow[]>`

**Deliberately not here, and deferred to plan 4:** creating accounts and holders, and classifying a candidate into a deposit or withdrawal. Those are the review-queue and onboarding flows, and classification in particular needs the payout writer, which this plan does not build.

**A known gap to carry forward.** `compound_holder.status` is stored *and* derived — `fold()` computes a holder's status from the ledger. `getHolderSeeds` deliberately does not read the stored column, so nothing here can disagree with `fold`. But the stored column can still fall out of date once plan 4 writes exits, and **plan 4 must keep it in step or drop it.** A test asserting the two agree is not written here on purpose: with no payouts in any fixture this plan builds, both sides are `'active'` and the assertion could not fail.

- [ ] **Step 1: Create `lib/compound/db/compound.ts`**

```typescript
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
```

Note there is no `centsExpr` here: `amount_cents` and the three candidate columns are already `bigint`, so there is nothing to convert. Every cent value still goes through `toCents`, which is what refuses a `number` should a future edit change a column type underneath it.

- [ ] **Step 2: Write the tests**

The ledger fixture is built so that **id order, `occurred_on` order and `seq` order all disagree**. Without that, `order by seq` and `order by id` return the same list and the ordering assertion cannot fail.

Create `lib/compound/db/compound.db.test.ts`:

```typescript
import { fold } from "@/lib/compound/engine/replay";
import {
  getAccountById,
  getAccountByMt5,
  getHolderSeeds,
  getLedgerEntries,
  getReconcileCursor,
  listAccountsForManager,
  listCandidates,
} from "./compound";
import { closeTestPool, resetCompoundTables, seedUser, withTestClient } from "./testing/harness";

const MANAGER = "aaaaaaaa-0000-4000-8000-0000000007a1";
const OTHER_MANAGER = "bbbbbbbb-0000-4000-8000-0000000007b1";
const MT5 = 9_900_701;
const OTHER_MT5 = 9_900_702;

let accountId = 0;
let otherAccountId = 0;
let managerHolder = 0;
let activeHolder = 0;
let closedHolder = 0;

beforeEach(async () => {
  await withTestClient(async (c) => {
    await resetCompoundTables(c);
    await seedUser(c, MANAGER, "compound-mgr@example.test");
    await seedUser(c, OTHER_MANAGER, "compound-mgr-2@example.test");

    const accounts = await c.query<{ id: string }>(
      `insert into public.compound_account
         (mt5_account, label, broker, currency, default_split_bps,
          inception_date, manager_user_id)
       values ($1, 'Primary', 'Fictional Markets', 'USD', 4000, '2026-05-01', $3),
              ($2, 'Secondary', null, 'USD', 3500, '2026-06-01', $4)
       returning id`,
      [MT5, OTHER_MT5, MANAGER, OTHER_MANAGER],
    );
    accountId = Number(accounts.rows[0]!.id);
    otherAccountId = Number(accounts.rows[1]!.id);

    const holders = await c.query<{ id: string }>(
      `insert into public.compound_holder
         (account_id, name, is_manager, split_bps, joined_at, status)
       values ($1, 'Manager',  true,  4000, '2026-05-01', 'active'),
              ($1, 'Investor', false, 3500, '2026-05-10', 'active'),
              ($1, 'Departed', false, 4000, '2026-05-02', 'closed')
       returning id`,
      [accountId],
    );
    managerHolder = Number(holders.rows[0]!.id);
    activeHolder = Number(holders.rows[1]!.id);
    closedHolder = Number(holders.rows[2]!.id);

    // Inserted so that id order (3,1,2), occurred_on order (2,3,1) and seq
    // order (1,2,3) are three different orderings. `order by id` or
    // `order by occurred_on` both produce a wrong list, so the ordering
    // assertion below can actually fail.
    await c.query(
      `insert into public.compound_ledger_entry
         (account_id, holder_id, seq, occurred_on, type, amount_cents,
          fee_settlement, split_bps_applied)
       values ($1, null, 3, '2026-05-20', 'equity_reading', 1050000, null, null),
              ($1, null, 1, '2026-05-31', 'equity_reading', 1000000, null, null),
              ($1, $2,   2, '2026-05-25', 'deposit',         500000, null, null)`,
      [accountId, activeHolder],
    );

    await c.query(
      `insert into public.compound_capital_event_candidate
         (account_id, trade_date, balance_delta_cents, explained_cents,
          unexplained_cents, status)
       values ($1, '2026-06-25', 3100000, 0, 3100000, 'pending'),
              ($1, '2026-06-10',  120000, 120000,  0, 'ignored')`,
      [accountId],
    );
  });
});

afterAll(async () => {
  await withTestClient((c) => resetCompoundTables(c));
  await closeTestPool();
});

describe("account lookups", () => {
  it("reads an account by id, with the date as a key and the split as an int", async () => {
    const account = await withTestClient((c) => getAccountById(c, accountId));
    expect(account).toEqual({
      id: accountId,
      mt5Account: MT5,
      label: "Primary",
      broker: "Fictional Markets",
      currency: "USD",
      defaultSplitBps: 4000,
      inceptionDate: "2026-05-01",
      managerUserId: MANAGER,
    });
  });

  it("reads the same account by MT5 login", async () => {
    const account = await withTestClient((c) => getAccountByMt5(c, MT5));
    expect(account?.id).toBe(accountId);
  });

  it("returns null for an account that does not exist", async () => {
    expect(await withTestClient((c) => getAccountById(c, 999_999))).toBeNull();
    expect(await withTestClient((c) => getAccountByMt5(c, 999_999))).toBeNull();
  });

  it("lists only the accounts a given manager owns", async () => {
    const mine = await withTestClient((c) => listAccountsForManager(c, MANAGER));
    const theirs = await withTestClient((c) => listAccountsForManager(c, OTHER_MANAGER));
    expect(mine.map((a) => a.label)).toEqual(["Primary"]);
    expect(theirs.map((a) => a.label)).toEqual(["Secondary"]);
  });

  it("carries a null broker through as null, not as an empty string", async () => {
    const account = await withTestClient((c) => getAccountById(c, otherAccountId));
    expect(account?.broker).toBeNull();
  });
});

describe("getHolderSeeds", () => {
  it("returns every holder including the closed one", async () => {
    const seeds = await withTestClient((c) => getHolderSeeds(c, accountId));
    expect(seeds.map((s) => s.holderId)).toEqual([managerHolder, activeHolder, closedHolder]);
  });

  it("carries is_manager and the holder's own split", async () => {
    const seeds = await withTestClient((c) => getHolderSeeds(c, accountId));
    expect(seeds).toEqual([
      { holderId: managerHolder, isManager: true, splitBps: 4000 },
      { holderId: activeHolder, isManager: false, splitBps: 3500 },
      { holderId: closedHolder, isManager: false, splitBps: 4000 },
    ]);
  });

  it("returns nothing for an account with no holders", async () => {
    expect(await withTestClient((c) => getHolderSeeds(c, otherAccountId))).toEqual([]);
  });
});

describe("getLedgerEntries", () => {
  it("orders by seq, not by id and not by occurred_on", async () => {
    const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    // The three orderings really are different, so the assertion above is
    // testing something. If these ever coincide, rebuild the fixture.
    expect(entries.map((e) => e.id)).not.toEqual([...entries.map((e) => e.id)].sort((a, b) => a - b));
    expect(entries.map((e) => e.occurredOn)).toEqual([
      "2026-05-31",
      "2026-05-25",
      "2026-05-20",
    ]);
  });

  it("maps every field replay.ts reads", async () => {
    const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
    expect(entries[1]).toEqual({
      id: expect.any(Number),
      seq: 2,
      holderId: activeHolder,
      occurredOn: "2026-05-25",
      type: "deposit",
      amountCents: 500000n,
      feeSettlement: null,
      splitBpsApplied: null,
      reversesId: null,
    });
  });

  it("leaves holderId null on a reading", async () => {
    const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
    expect(entries[0]!.holderId).toBeNull();
    expect(entries[0]!.type).toBe("equity_reading");
  });

  it("returns amounts as bigints", async () => {
    const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
    expect(typeof entries[0]!.amountCents).toBe("bigint");
  });

  it("carries fee_settlement, split_bps_applied and reverses_id when present", async () => {
    const entries = await withTestClient(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `select id from public.compound_ledger_entry where account_id = $1 and seq = 1`,
        [accountId],
      );
      await c.query(
        `insert into public.compound_ledger_entry
           (account_id, holder_id, seq, occurred_on, type, amount_cents,
            fee_settlement, split_bps_applied, reverses_id)
         values ($1, $2, 4, '2026-06-01', 'exit', 250000, 'units', 3500, $3)`,
        [accountId, activeHolder, Number(rows[0]!.id)],
      );
      return getLedgerEntries(c, accountId);
    });
    const exit = entries.find((e) => e.seq === 4)!;
    expect(exit.feeSettlement).toBe("units");
    expect(exit.splitBpsApplied).toBe(3500);
    expect(exit.reversesId).toBeGreaterThan(0);
  });

  it("does not leak another account's entries", async () => {
    await withTestClient((c) =>
      c.query(
        `insert into public.compound_ledger_entry
           (account_id, seq, occurred_on, type, amount_cents)
         values ($1, 1, '2026-06-01', 'equity_reading', 999999)`,
        [otherAccountId],
      ),
    );
    const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
    expect(entries.map((e) => e.amountCents)).not.toContain(999999n);
  });

  it("feeds fold() without any adaptation", async () => {
    const state = await withTestClient(async (c) => {
      const entries = await getLedgerEntries(c, accountId);
      const seeds = await getHolderSeeds(c, accountId);
      return fold(entries, seeds);
    });
    // seq 1 sets equity to 1,000,000c at genesis (no units yet).
    // seq 2 deposits 500,000c: units issue at NAV 1.00 because units are 0.
    // seq 3 sets equity to 1,050,000c.
    expect(state.equityCents).toBe(1050000n);
    expect(state.lastReadingOn).toBe("2026-05-20");
    expect(state.seq).toBe(3);
    const investor = state.holders.find((h) => h.holderId === activeHolder)!;
    expect(investor.basisCents).toBe(500000n);
    expect(investor.units).toBeGreaterThan(0n);
  });
});

describe("getReconcileCursor", () => {
  it("reports a null date when no cursor row exists", async () => {
    expect(await withTestClient((c) => getReconcileCursor(c, accountId))).toEqual({
      lastReadingDate: null,
    });
  });

  it("reports the stored date as a key", async () => {
    const cursor = await withTestClient(async (c) => {
      await c.query(
        `insert into public.compound_reconcile_cursor (account_id, last_reading_date, last_run_at)
         values ($1, '2026-08-12', now())`,
        [accountId],
      );
      return getReconcileCursor(c, accountId);
    });
    expect(cursor).toEqual({ lastReadingDate: "2026-08-12" });
  });

  it("reports null when the row exists but the date is null", async () => {
    const cursor = await withTestClient(async (c) => {
      await c.query(
        `insert into public.compound_reconcile_cursor (account_id, last_reading_date, last_run_at)
         values ($1, null, now())`,
        [accountId],
      );
      return getReconcileCursor(c, accountId);
    });
    expect(cursor).toEqual({ lastReadingDate: null });
  });
});

describe("listCandidates", () => {
  it("returns every candidate in trade-date order", async () => {
    const rows = await withTestClient((c) => listCandidates(c, accountId));
    expect(rows.map((r) => r.tradeDate)).toEqual(["2026-06-10", "2026-06-25"]);
  });

  it("filters by status when asked", async () => {
    const rows = await withTestClient((c) => listCandidates(c, accountId, "pending"));
    expect(rows.map((r) => r.tradeDate)).toEqual(["2026-06-25"]);
  });

  it("maps the three cent figures as bigints", async () => {
    const rows = await withTestClient((c) => listCandidates(c, accountId, "pending"));
    expect(rows[0]!.balanceDeltaCents).toBe(3100000n);
    expect(rows[0]!.explainedCents).toBe(0n);
    expect(rows[0]!.unexplainedCents).toBe(3100000n);
  });

  it("renders detected_at as an ISO instant", async () => {
    const rows = await withTestClient((c) => listCandidates(c, accountId, "pending"));
    expect(rows[0]!.detectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("returns nothing for an account with no candidates", async () => {
    expect(await withTestClient((c) => listCandidates(c, otherAccountId))).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the gates**

```bash
pnpm typecheck && pnpm test:db
```

- [ ] **Step 4: Prove these tests bite**

1. **Order the ledger by `id`.** Change `order by seq asc` to `order by id asc`.
   Expected red: `"orders by seq, not by id and not by occurred_on"`, and `"feeds fold() without any adaptation"` — the second because replaying in the wrong order lands the deposit after the last reading and changes `equityCents`. Two independent tests, one change.
2. **Order the ledger by `occurred_on`.**
   Expected red: the same two. Confirm both, because a fixture whose `occurred_on` happened to agree with `seq` would leave this probe silent.
3. **Filter holders to active ones** — add `and status = 'active'` to `getHolderSeeds`.
   Expected red: `"returns every holder including the closed one"` and `"carries is_manager and the holder's own split"`. Note that `"feeds fold()"` stays green here, because no ledger entry references the closed holder; a fold with an exit in it would throw `unknown holderId`. Record that as the reason the seed query must not filter.
4. **Return `null` from `getReconcileCursor` when the row is missing** instead of `{ lastReadingDate: null }`.
   Expected red: `"reports a null date when no cursor row exists"`, and a type error from `tsc`.
5. **Drop the `account_id` filter** from `getLedgerEntries`.
   Expected red: `"does not leak another account's entries"`. That test exists only for this probe.
6. **Return the raw `inception_date`** instead of `dateKeyExpr`.
   Expected red: `"reads an account by id, with the date as a key"` — `toDateKey` throws on the `Date`.

- [ ] **Step 5: Commit**

```bash
git add lib/compound/db/compound.ts lib/compound/db/compound.db.test.ts
git commit -m "feat(db): read compound_* rows into engine and reconcile types"
```

---

### Task 8: The atomic writer

`planReadings()` returns a plan: some readings to post, sometimes a candidate, and a new cursor position. Persisting it must be **one transaction**, and the cursor must move **inside that transaction**. If readings land and the cursor does not, the next run re-posts them; if the cursor moves and the readings do not, NAV silently skips days. Spec §5.2's second distinction — a payout writes its equity reading and the payout entry together — is the same requirement in a different flow.

It also has to assign `seq`. Spec §6.2: monotonic per account, **assigned server-side**. That is why the writer is a `plpgsql` function rather than a sequence of client calls: a function body is one transaction by construction, and `max(seq) + 1` under a row lock is the only way two concurrent runs get disjoint numbers.

**Read this before writing the atomicity test.** The obvious version — call the writer so it fails, then assert nothing was persisted — is worthless if the failure fires before anything is written, because "nothing was persisted" is then true for the wrong reason. Two things prevent that:

- The final consistency check is deliberately the **last** statement in the function, after every insert. There is a comment in the SQL saying so; do not "tidy" it to the top.
- The test ratchets on `sequenceConsumed`. Sequences are exempt from rollback, so the test can assert **three ledger ids were handed out** even though no ledger row survives. That assertion goes red the moment the guard moves earlier.

**Files:**
- Create: `supabase/migrations/<generated>_compound_commit_reading_plan.sql`
- Create: `lib/compound/db/commit-plan.ts`
- Create: `lib/compound/db/commit-plan.db.test.ts`

**Interfaces:**
- Consumes: `ReadingPlan`, `PlannedReading`, `CapitalEventCandidate` from `@/lib/compound/reconcile/interlock`; `./client`; `./sql`
- Produces:
  - `public.compound_commit_reading_plan(p_account_id bigint, p_readings jsonb, p_candidate jsonb, p_cursor_date date, p_actor uuid) returns jsonb`
  - `interface CommitResult { readingsInserted: number; seqs: number[]; candidateId: number | null; cursorDate: string | null }`
  - `commitReadingPlan(c: Queryable, input: { accountId: number; plan: ReadingPlan; actorUserId: string | null }): Promise<CommitResult>`

> **One integration question for the reconciler author, to settle when `interlock.ts` lands.** `ReadingPlan`'s `halt` variant carries `newCursorDate: string | null`. When a re-run halts on a candidate that is already recorded, `readings` is empty — and it is not clear from the type whether `newCursorDate` is then `null` ("nothing new posted") or the existing cursor date. The writer treats **empty readings plus a null cursor date as "leave the cursor where it is"**, so both readings are safe and a repeat run is a clean no-op. Verify against the real `interlock.ts` and delete this note once confirmed.

- [ ] **Step 1: Generate the migration file**

```bash
supabase migration new compound_commit_reading_plan
```

Write into the generated file:

```sql
-- ============================================================================
-- Commit a reading plan. One transaction, cursor included.
-- ============================================================================
--
-- reconcile/interlock.ts returns a plan: readings to post, sometimes a capital
-- event candidate, and where the cursor should end up. All three must land
-- together or none of them must. Readings without the cursor get re-posted on
-- the next run; the cursor without the readings makes NAV skip days silently.
--
-- SECURITY INVOKER, deliberately. A SECURITY DEFINER function owned by
-- postgres would run with the owner's implicit privileges and could therefore
-- UPDATE compound_ledger_entry, quietly undoing the append-only grant that
-- section 9 asks for. As invoker it can only do what service_role can do,
-- which is SELECT and INSERT.
--
-- seq is assigned here, server-side, per section 6.2. The row lock on
-- compound_account is what makes two concurrent runs get disjoint numbers
-- instead of colliding on the unique (account_id, seq) constraint.
--
-- Money crosses the boundary as JSON *strings*. JSON.stringify throws on a
-- BigInt, and a JSON number above 2^53 is not the number you sent.
--
-- Custom SQLSTATEs so callers and tests can tell the refusals apart:
--   CX001  no such account
--   CX002  a reading is dated on or after an unclassified capital event
--   CX003  a reading is dated on or before the current cursor
--   CX004  the cursor does not match what was posted
--   CX005  readings are not in ascending date order
-- ============================================================================

create or replace function public.compound_commit_reading_plan(
  p_account_id  bigint,
  p_readings    jsonb,
  p_candidate   jsonb,
  p_cursor_date date,
  p_actor       uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_locked          bigint;
  v_prev_cursor     date;
  v_next_seq        bigint;
  v_reading         jsonb;
  v_occurred_on     date;
  v_previous_on     date := null;
  v_last_reading_on date := null;
  v_seqs            bigint[] := '{}';
  v_candidate_id    bigint := null;
  v_candidate_date  date := null;
begin
  -- Serialise concurrent commits for this account. Without it, two callers
  -- both read the same max(seq) and race to insert it, and the unique
  -- constraint turns a queue into an error for one of them.
  select a.id into v_locked
    from public.compound_account a
   where a.id = p_account_id
     for update;

  if v_locked is null then
    raise exception 'compound: no account %', p_account_id using errcode = 'CX001';
  end if;

  select c.last_reading_date into v_prev_cursor
    from public.compound_reconcile_cursor c
   where c.account_id = p_account_id;

  if p_candidate is not null then
    v_candidate_date := (p_candidate ->> 'trade_date')::date;
  end if;

  select coalesce(max(l.seq), 0) + 1 into v_next_seq
    from public.compound_ledger_entry l
   where l.account_id = p_account_id;

  -- The candidate first. ON CONFLICT DO NOTHING makes a repeated run against
  -- an unresolved event a no-op rather than a pile of duplicate review items.
  if p_candidate is not null then
    insert into public.compound_capital_event_candidate
      (account_id, trade_date, balance_delta_cents, explained_cents, unexplained_cents)
    values (
      p_account_id,
      v_candidate_date,
      (p_candidate ->> 'balance_delta_cents')::bigint,
      (p_candidate ->> 'explained_cents')::bigint,
      (p_candidate ->> 'unexplained_cents')::bigint
    )
    on conflict (account_id, trade_date) do nothing
    returning id into v_candidate_id;

    if v_candidate_id is null then
      select k.id into v_candidate_id
        from public.compound_capital_event_candidate k
       where k.account_id = p_account_id
         and k.trade_date = v_candidate_date;
    end if;
  end if;

  for v_reading in
    select value from jsonb_array_elements(coalesce(p_readings, '[]'::jsonb))
  loop
    v_occurred_on := (v_reading ->> 'occurred_on')::date;

    if v_prev_cursor is not null and v_occurred_on <= v_prev_cursor then
      raise exception
        'compound: reading % is not after the cursor %', v_occurred_on, v_prev_cursor
        using errcode = 'CX003';
    end if;

    if v_previous_on is not null and v_occurred_on <= v_previous_on then
      raise exception
        'compound: readings must ascend, % follows %', v_occurred_on, v_previous_on
        using errcode = 'CX005';
    end if;

    -- The interlock, restated at the persistence boundary. planReadings
    -- already guarantees this; a second refusal here costs one comparison and
    -- means NAV cannot cross an unclassified capital event even if a caller
    -- hand-builds a plan.
    if v_candidate_date is not null and v_occurred_on >= v_candidate_date then
      raise exception
        'compound: reading % is on or after unclassified capital event %',
        v_occurred_on, v_candidate_date
        using errcode = 'CX002';
    end if;

    insert into public.compound_ledger_entry
      (account_id, holder_id, seq, occurred_on, type, amount_cents,
       fee_settlement, split_bps_applied, note, reverses_id, created_by)
    values (
      p_account_id, null, v_next_seq, v_occurred_on, 'equity_reading',
      (v_reading ->> 'equity_cents')::bigint, null, null, null, null, p_actor
    );

    v_seqs            := v_seqs || v_next_seq;
    v_next_seq        := v_next_seq + 1;
    v_previous_on     := v_occurred_on;
    v_last_reading_on := v_occurred_on;
  end loop;

  -- With no readings the cursor does not move; only last_run_at does. That
  -- makes a repeat run against an unresolved candidate a clean no-op whether
  -- the caller passes null or the existing date.
  insert into public.compound_reconcile_cursor (account_id, last_reading_date, last_run_at)
  values (p_account_id, coalesce(v_last_reading_on, v_prev_cursor), now())
  on conflict (account_id) do update
    set last_reading_date = excluded.last_reading_date,
        last_run_at       = excluded.last_run_at;

  -- DELIBERATELY THE LAST STATEMENT. A guard that fires before any write makes
  -- "nothing was persisted" true for the wrong reason, and an atomicity test
  -- built on it passes even when the caller has split this into three round
  -- trips. Placed here, the rollback has real rows to undo — and the test
  -- proves it by watching the id sequence, which rollback does not rewind.
  if v_last_reading_on is null then
    if p_cursor_date is not null and p_cursor_date is distinct from v_prev_cursor then
      raise exception
        'compound: cursor moved to % with no readings posted', p_cursor_date
        using errcode = 'CX004';
    end if;
  elsif p_cursor_date is distinct from v_last_reading_on then
    raise exception
      'compound: cursor % does not match the last reading %',
      p_cursor_date, v_last_reading_on
      using errcode = 'CX004';
  end if;

  return jsonb_build_object(
    'seqs',         to_jsonb(v_seqs::text[]),
    'candidate_id', v_candidate_id::text,
    'cursor_date',  to_char(coalesce(v_last_reading_on, v_prev_cursor), 'YYYY-MM-DD')
  );
end;
$$;

-- Functions are granted EXECUTE to PUBLIC by default.
revoke execute on function public.compound_commit_reading_plan(bigint, jsonb, jsonb, date, uuid)
  from public;
grant execute on function public.compound_commit_reading_plan(bigint, jsonb, jsonb, date, uuid)
  to authenticated, service_role;
```

- [ ] **Step 2: Apply and confirm**

```bash
supabase db reset
```

- [ ] **Step 3: Create `lib/compound/db/commit-plan.ts`**

```typescript
/**
 * The only writer in Compound v1.
 *
 * It hands the whole plan to one SQL function, which is one transaction by
 * construction. Three client calls in a row would not be: a crash between them
 * leaves readings with no cursor, and the next run re-posts them.
 *
 * Money is serialised as strings. JSON.stringify throws outright on a BigInt,
 * and a JSON number above 2^53 is not the number that was sent.
 */
import type { ReadingPlan } from "@/lib/compound/reconcile/interlock";
import type { Queryable } from "./types";
import { toId } from "./sql";

export interface CommitResult {
  readingsInserted: number;
  /** The seq assigned to each reading, in the order they were posted. */
  seqs: number[];
  /** The candidate row, whether newly created or already present. */
  candidateId: number | null;
  /** Where the cursor ended up. Null when nothing has ever been posted. */
  cursorDate: string | null;
}

const CALL = `select public.compound_commit_reading_plan($1, $2::jsonb, $3::jsonb, $4::date, $5)
                as result`;

interface RawResult {
  seqs: string[];
  candidate_id: string | null;
  cursor_date: string | null;
}

export async function commitReadingPlan(
  c: Queryable,
  input: { accountId: number; plan: ReadingPlan; actorUserId: string | null },
): Promise<CommitResult> {
  const { accountId, plan, actorUserId } = input;

  // An idle plan is the common case — the reconciler runs on a schedule and
  // most runs have nothing to do. Taking a row lock to write nothing is waste,
  // so idle does not touch the database at all.
  if (plan.kind === "idle") {
    return { readingsInserted: 0, seqs: [], candidateId: null, cursorDate: null };
  }

  const readings = plan.readings.map((r) => ({
    occurred_on: r.occurredOn,
    equity_cents: r.equityCents.toString(),
  }));

  const candidate =
    plan.kind === "halt"
      ? {
          trade_date: plan.candidate.tradeDate,
          balance_delta_cents: plan.candidate.balanceDeltaCents.toString(),
          explained_cents: plan.candidate.explainedCents.toString(),
          unexplained_cents: plan.candidate.unexplainedCents.toString(),
        }
      : null;

  const { rows } = await c.query<{ result: RawResult }>(CALL, [
    accountId,
    JSON.stringify(readings),
    candidate === null ? null : JSON.stringify(candidate),
    plan.newCursorDate,
    actorUserId,
  ]);

  const raw = rows[0]?.result;
  if (!raw) throw new Error("compound_commit_reading_plan returned no row");

  return {
    readingsInserted: raw.seqs.length,
    seqs: raw.seqs.map((s, i) => toId(s, `commit result seqs[${i}]`)),
    candidateId: raw.candidate_id === null ? null : toId(raw.candidate_id, "candidate_id"),
    cursorDate: raw.cursor_date,
  };
}
```

- [ ] **Step 4: Write the tests**

Create `lib/compound/db/commit-plan.db.test.ts`:

```typescript
import type { ReadingPlan } from "@/lib/compound/reconcile/interlock";
import { commitReadingPlan } from "./commit-plan";
import { getLedgerEntries, getReconcileCursor, listCandidates } from "./compound";
import {
  closeTestPool,
  expectPgError,
  resetCompoundTables,
  seedUser,
  sequenceConsumed,
  withSeparateSession,
  withTestClient,
} from "./testing/harness";
import { testDatabaseUrl } from "./testing/env";

const MANAGER = "aaaaaaaa-0000-4000-8000-0000000008a1";
const MT5_A = 9_900_801;
const MT5_B = 9_900_802;

let accountA = 0;
let accountB = 0;

const LEDGER = "public.compound_ledger_entry";
const CANDIDATES = "public.compound_capital_event_candidate";

function reading(occurredOn: string, equityCents: bigint) {
  return { occurredOn, equityCents };
}

function advance(readings: Array<{ occurredOn: string; equityCents: bigint }>): ReadingPlan {
  return {
    kind: "advance",
    readings,
    newCursorDate: readings[readings.length - 1]!.occurredOn,
  };
}

beforeEach(async () => {
  await withTestClient(async (c) => {
    await resetCompoundTables(c);
    await seedUser(c, MANAGER, "writer@example.test");
    const { rows } = await c.query<{ id: string }>(
      `insert into public.compound_account
         (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
       values ($1, 'Writer A', 'USD', 4000, '2026-08-01', $3),
              ($2, 'Writer B', 'USD', 4000, '2026-08-01', $3)
       returning id`,
      [MT5_A, MT5_B, MANAGER],
    );
    accountA = Number(rows[0]!.id);
    accountB = Number(rows[1]!.id);
  });
});

afterAll(async () => {
  await withTestClient((c) => resetCompoundTables(c));
  await closeTestPool();
});

describe("an idle plan", () => {
  it("writes nothing and reports nothing", async () => {
    const result = await withTestClient((c) =>
      commitReadingPlan(c, { accountId: accountA, plan: { kind: "idle" }, actorUserId: MANAGER }),
    );
    expect(result).toEqual({
      readingsInserted: 0,
      seqs: [],
      candidateId: null,
      cursorDate: null,
    });
  });

  it("does not open a database round trip at all", async () => {
    // The ratchet: an idle plan that reached the function would still write
    // nothing, so counting rows proves nothing. Counting queries does.
    const fake = { query: jest.fn() } as unknown as Parameters<typeof commitReadingPlan>[0];
    await commitReadingPlan(fake, {
      accountId: accountA,
      plan: { kind: "idle" },
      actorUserId: MANAGER,
    });
    expect((fake as unknown as { query: jest.Mock }).query).not.toHaveBeenCalled();
  });
});

describe("an advancing plan", () => {
  it("posts every reading as an equity_reading with no holder", async () => {
    const entries = await withTestClient(async (c) => {
      await commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([
          reading("2026-08-03", 5074500n),
          reading("2026-08-04", 5081300n),
          reading("2026-08-05", 5099200n),
        ]),
        actorUserId: MANAGER,
      });
      return getLedgerEntries(c, accountA);
    });

    expect(entries.map((e) => e.occurredOn)).toEqual(["2026-08-03", "2026-08-04", "2026-08-05"]);
    expect(entries.map((e) => e.amountCents)).toEqual([5074500n, 5081300n, 5099200n]);
    expect(entries.every((e) => e.type === "equity_reading")).toBe(true);
    expect(entries.every((e) => e.holderId === null)).toBe(true);
  });

  it("assigns seq 1..n and returns them", async () => {
    const result = await withTestClient((c) =>
      commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-03", 100n), reading("2026-08-04", 200n)]),
        actorUserId: MANAGER,
      }),
    );
    expect(result.seqs).toEqual([1, 2]);
    expect(result.readingsInserted).toBe(2);
  });

  it("moves the cursor to the last reading, in the same call", async () => {
    const cursor = await withTestClient(async (c) => {
      await commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-03", 100n), reading("2026-08-04", 200n)]),
        actorUserId: MANAGER,
      });
      return getReconcileCursor(c, accountA);
    });
    expect(cursor).toEqual({ lastReadingDate: "2026-08-04" });
  });

  it("continues seq from where the previous run stopped", async () => {
    const seqs = await withTestClient(async (c) => {
      await commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-03", 100n), reading("2026-08-04", 200n)]),
        actorUserId: MANAGER,
      });
      const second = await commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-05", 300n)]),
        actorUserId: MANAGER,
      });
      return second.seqs;
    });
    expect(seqs).toEqual([3]);
  });

  it("numbers seq per account, not globally — section 6.2", async () => {
    const { a, b } = await withTestClient(async (c) => {
      const first = await commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-03", 100n), reading("2026-08-04", 200n)]),
        actorUserId: MANAGER,
      });
      const second = await commitReadingPlan(c, {
        accountId: accountB,
        plan: advance([reading("2026-08-03", 900n)]),
        actorUserId: MANAGER,
      });
      return { a: first.seqs, b: second.seqs };
    });
    expect(a).toEqual([1, 2]);
    // 1, not 3. A global sequence would give 3 here.
    expect(b).toEqual([1]);
  });

  it("keeps an equity value above 2^53 exact through the JSON boundary", async () => {
    const entries = await withTestClient(async (c) => {
      await commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-03", 9007199254740993n)]),
        actorUserId: MANAGER,
      });
      return getLedgerEntries(c, accountA);
    });
    expect(entries[0]!.amountCents).toBe(9007199254740993n);
  });

  it("stamps created_by with the actor", async () => {
    const actor = await withTestClient(async (c) => {
      await commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-03", 100n)]),
        actorUserId: MANAGER,
      });
      const { rows } = await c.query<{ created_by: string | null }>(
        `select created_by from ${LEDGER} where account_id = $1`,
        [accountA],
      );
      return rows[0]?.created_by ?? null;
    });
    expect(actor).toBe(MANAGER);
  });

  it("refuses to re-post a day the cursor has already passed", async () => {
    await withTestClient(async (c) => {
      await commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-03", 100n), reading("2026-08-04", 200n)]),
        actorUserId: MANAGER,
      });
      await expectPgError(
        commitReadingPlan(c, {
          accountId: accountA,
          plan: advance([reading("2026-08-04", 999n)]),
          actorUserId: MANAGER,
        }),
        "CX003",
        /reading 2026-08-04 is not after the cursor 2026-08-04/,
      );
    });
  });

  it("refuses readings that do not ascend", async () => {
    await withTestClient((c) =>
      expectPgError(
        commitReadingPlan(c, {
          accountId: accountA,
          plan: {
            kind: "advance",
            readings: [reading("2026-08-05", 100n), reading("2026-08-03", 200n)],
            newCursorDate: "2026-08-03",
          },
          actorUserId: MANAGER,
        }),
        "CX005",
        /readings must ascend, 2026-08-03 follows 2026-08-05/,
      ),
    );
  });

  it("refuses an account that does not exist", async () => {
    await withTestClient((c) =>
      expectPgError(
        commitReadingPlan(c, {
          accountId: 999_999,
          plan: advance([reading("2026-08-03", 100n)]),
          actorUserId: MANAGER,
        }),
        "CX001",
        /no account 999999/,
      ),
    );
  });
});

describe("a halting plan", () => {
  const halt = (
    readings: Array<{ occurredOn: string; equityCents: bigint }>,
    newCursorDate: string | null,
  ): ReadingPlan => ({
    kind: "halt",
    readings,
    newCursorDate,
    candidate: {
      tradeDate: "2026-08-12",
      previousDate: "2026-08-11",
      balanceDeltaCents: 500000n,
      explainedCents: 0n,
      unexplainedCents: 500000n,
    },
  });

  it("records the candidate and the readings together", async () => {
    const { entries, candidates, cursor } = await withTestClient(async (c) => {
      await commitReadingPlan(c, {
        accountId: accountA,
        plan: halt([reading("2026-08-10", 100n), reading("2026-08-11", 200n)], "2026-08-11"),
        actorUserId: MANAGER,
      });
      return {
        entries: await getLedgerEntries(c, accountA),
        candidates: await listCandidates(c, accountA),
        cursor: await getReconcileCursor(c, accountA),
      };
    });

    expect(entries.map((e) => e.occurredOn)).toEqual(["2026-08-10", "2026-08-11"]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.tradeDate).toBe("2026-08-12");
    expect(candidates[0]!.unexplainedCents).toBe(500000n);
    expect(candidates[0]!.status).toBe("pending");
    expect(cursor).toEqual({ lastReadingDate: "2026-08-11" });
  });

  it("refuses a reading dated on the unclassified event — the interlock", async () => {
    await withTestClient((c) =>
      expectPgError(
        commitReadingPlan(c, {
          accountId: accountA,
          plan: halt([reading("2026-08-11", 100n), reading("2026-08-12", 200n)], "2026-08-12"),
          actorUserId: MANAGER,
        }),
        "CX002",
        /reading 2026-08-12 is on or after unclassified capital event 2026-08-12/,
      ),
    );
  });

  it("is a clean no-op when re-run against an existing candidate", async () => {
    const { second, candidates, cursor } = await withTestClient(async (c) => {
      const first = await commitReadingPlan(c, {
        accountId: accountA,
        plan: halt([reading("2026-08-10", 100n), reading("2026-08-11", 200n)], "2026-08-11"),
        actorUserId: MANAGER,
      });
      const again = await commitReadingPlan(c, {
        accountId: accountA,
        plan: halt([], null),
        actorUserId: MANAGER,
      });
      return {
        first,
        second: again,
        candidates: await listCandidates(c, accountA),
        cursor: await getReconcileCursor(c, accountA),
      };
    });

    expect(second.readingsInserted).toBe(0);
    // The same candidate row, not a second one.
    expect(candidates).toHaveLength(1);
    expect(second.candidateId).toBe(candidates[0]!.id);
    // And the cursor did not slide backwards to null.
    expect(cursor).toEqual({ lastReadingDate: "2026-08-11" });
  });
});

describe("ATOMICITY — the whole point of this task", () => {
  /**
   * Force a failure that lands AFTER the writes: three valid readings, a valid
   * candidate, and a cursor date that matches neither. The function's final
   * consistency check is the last statement in the body, so by the time it
   * raises, three ledger rows, one candidate and one cursor row have all been
   * written.
   *
   * The row-count assertions alone would pass even if the guard had fired
   * first. The sequence assertions are what prove the writes happened, because
   * a sequence is not rolled back with the transaction.
   */
  const badPlan: ReadingPlan = {
    kind: "halt",
    readings: [
      reading("2026-08-08", 100n),
      reading("2026-08-09", 200n),
      reading("2026-08-10", 300n),
    ],
    // Deliberately wrong: the last reading is 2026-08-10.
    newCursorDate: "2026-08-30",
    candidate: {
      tradeDate: "2026-08-12",
      previousDate: "2026-08-11",
      balanceDeltaCents: 500000n,
      explainedCents: 0n,
      unexplainedCents: 500000n,
    },
  };

  it("raises CX004 and names both dates", async () => {
    await withTestClient((c) =>
      expectPgError(
        commitReadingPlan(c, { accountId: accountA, plan: badPlan, actorUserId: MANAGER }),
        "CX004",
        /cursor 2026-08-30 does not match the last reading 2026-08-10/,
      ),
    );
  });

  it("leaves no ledger row, no candidate and no cursor behind", async () => {
    await withTestClient(async (c) => {
      await expect(
        commitReadingPlan(c, { accountId: accountA, plan: badPlan, actorUserId: MANAGER }),
      ).rejects.toThrow();
    });

    const counts = await withTestClient(async (c) => {
      const { rows } = await c.query<{ l: string; k: string; u: string }>(
        `select (select count(*) from ${LEDGER}     where account_id = $1)::text as l,
                (select count(*) from ${CANDIDATES} where account_id = $1)::text as k,
                (select count(*) from public.compound_reconcile_cursor
                  where account_id = $1)::text as u`,
        [accountA],
      );
      return rows[0]!;
    });
    expect(counts).toEqual({ l: "0", k: "0", u: "0" });
  });

  it("consumed three ledger ids and one candidate id before rolling back", async () => {
    // This is the assertion that makes the one above mean something. Without
    // it, moving the guard to the top of the function leaves this suite green.
    const before = await withTestClient(async (c) => ({
      ledger: await sequenceConsumed(c, LEDGER, "id"),
      candidate: await sequenceConsumed(c, CANDIDATES, "id"),
    }));

    await withTestClient(async (c) => {
      await expect(
        commitReadingPlan(c, { accountId: accountA, plan: badPlan, actorUserId: MANAGER }),
      ).rejects.toThrow();
    });

    const after = await withTestClient(async (c) => ({
      ledger: await sequenceConsumed(c, LEDGER, "id"),
      candidate: await sequenceConsumed(c, CANDIDATES, "id"),
    }));

    expect(after.ledger - before.ledger).toBe(3);
    expect(after.candidate - before.candidate).toBe(1);
  });

  it("leaves the next successful run starting at seq 1", async () => {
    await withTestClient(async (c) => {
      await expect(
        commitReadingPlan(c, { accountId: accountA, plan: badPlan, actorUserId: MANAGER }),
      ).rejects.toThrow();
    });
    const result = await withTestClient((c) =>
      commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-08", 100n)]),
        actorUserId: MANAGER,
      }),
    );
    // seq is max(seq)+1 over surviving rows, so a rolled-back run must not
    // have consumed a seq. Note that the bigserial *id* did advance — ids and
    // seq are different things, and this is where that shows.
    expect(result.seqs).toEqual([1]);
  });
});

describe("CONCURRENCY — the row lock", () => {
  it("makes a second run wait rather than collide on seq", async () => {
    const call =
      `select public.compound_commit_reading_plan($1, $2::jsonb, null, $3::date, $4) as result`;

    const first = JSON.stringify([
      { occurred_on: "2026-08-03", equity_cents: "100" },
      { occurred_on: "2026-08-04", equity_cents: "200" },
      { occurred_on: "2026-08-05", equity_cents: "300" },
    ]);
    const second = JSON.stringify([
      { occurred_on: "2026-08-06", equity_cents: "400" },
      { occurred_on: "2026-08-07", equity_cents: "500" },
    ]);

    await withSeparateSession(async (a) => {
      await withSeparateSession(async (b) => {
        await a.query("begin");
        await a.query(call, [accountA, first, "2026-08-05", MANAGER]);

        let bSettled = false;
        const bPromise = b
          .query<{ result: { seqs: string[] } }>(call, [accountA, second, "2026-08-07", MANAGER])
          .then((r) => {
            bSettled = true;
            return r;
          });

        // Long enough for B to reach the lock and stop there. The assertion is
        // on bSettled, not on the delay: without the lock B completes
        // immediately and this goes red.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(bSettled).toBe(false);

        await a.query("commit");
        const bResult = await bPromise;

        expect(bResult.rows[0]!.result.seqs).toEqual(["4", "5"]);
      });
    });

    const allSeqs = await withTestClient(async (c) => {
      const entries = await getLedgerEntries(c, accountA);
      return entries.map((e) => e.seq);
    });
    expect(allSeqs).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("the writer respects the append-only ledger", () => {
  it("runs as service_role through withDb and still cannot rewrite what it wrote", async () => {
    const { withDb, closePool } = await import("./client");
    const saved = process.env.COMPOUND_DATABASE_URL;
    process.env.COMPOUND_DATABASE_URL = testDatabaseUrl();
    try {
      await withDb((c) =>
        commitReadingPlan(c, {
          accountId: accountA,
          plan: advance([reading("2026-08-03", 100n)]),
          actorUserId: MANAGER,
        }),
      );
      await withDb((c) =>
        expectPgError(
          c.query(`update ${LEDGER} set amount_cents = 1 where account_id = $1`, [accountA]),
          "42501",
          /permission denied for table compound_ledger_entry/,
        ),
      );
    } finally {
      await closePool();
      process.env.COMPOUND_DATABASE_URL = saved;
    }
  });
});
```

- [ ] **Step 5: Run the gates**

```bash
pnpm typecheck && pnpm test:db
```

- [ ] **Step 6: Prove these tests bite**

1. **Split the writer into three round trips.** Rewrite `commitReadingPlan` to run three separate `c.query` calls — insert candidate, insert readings, upsert cursor — with no transaction.
   Expected red: `"leaves no ledger row, no candidate and no cursor behind"`. This is the failure the whole task exists to prevent. Restore.
2. **Move the CX004 guard to the top** of the function, just after the cursor is read.
   Expected red: `"consumed three ledger ids and one candidate id before rolling back"` — the deltas become `0` and `0`. Expected **still green**: `"raises CX004 and names both dates"` and `"leaves no ledger row…"`, because with the guard first nothing was ever written. Record that. It is the demonstration that the row-count test alone was not enough, and the reason the SQL carries a comment pinning the guard's position.
3. **Remove `for update`** from the account lock.
   Expected red: `"makes a second run wait rather than collide on seq"` on `expect(bSettled).toBe(false)` — B no longer blocks. Restore.
4. **Drop the `where l.account_id` filter** from the `max(seq)` query, making seq global.
   Expected red: `"numbers seq per account, not globally"` — account B's first reading gets seq 3.
5. **Send equity as a JSON number** — change `equity_cents: r.equityCents.toString()` to `Number(r.equityCents)`.
   Expected red: `"keeps an equity value above 2^53 exact through the JSON boundary"` returns `9007199254740992n`. Every other test stays green, which is the point: at ordinary magnitudes the two paths agree exactly.
6. **Make the idle branch call the function** instead of returning early.
   Expected red: `"does not open a database round trip at all"`. Expected **still green**: `"writes nothing and reports nothing"`, because an idle plan posted through the function writes nothing anyway — which is why the query-count ratchet is there.
7. **Change `on conflict do nothing` to a plain insert** on the candidate.
   Expected red: `"is a clean no-op when re-run against an existing candidate"`, with a 23505 on `compound_capital_event_candidate_account_date_key`.
8. **Delete the CX002 interlock check.**
   Expected red: `"refuses a reading dated on the unclassified event"`. Nothing else — the interlock is otherwise `planReadings`' job, and this is the belt to its braces.

- [ ] **Step 7: Raise the purity ratchet**

`db/` now holds six source files: `types.ts`, `client.ts`, `sql.ts`, `copytraderx.ts`, `compound.ts`, `commit-plan.ts`. Raise the floor in `lib/compound/db/purity.test.ts` from `3` to `6` so a file silently dropping out of the scan is a failure rather than a quieter pass.

```typescript
  it("scans every source file in db/", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });
```

Confirm it bites: temporarily rename `sql.ts` to `sql.txt` and check the test goes red, then rename it back.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations lib/compound/db/commit-plan.ts lib/compound/db/commit-plan.db.test.ts lib/compound/db/purity.test.ts
git commit -m "feat(db): commit a reading plan and its cursor in one transaction"
```

---

### Task 9: The round trip, and the STOP

Everything joined up: read the CopyTraderX tables, dedupe, plan, commit, read back, fold, assert the invariants. Two suites, because they prove different things and one fixture cannot do both well.

- **Part A runs against the shipped seed**, which was built for exactly this: a duplicate deal pair, a weekend gap with a Saturday close, and one unexplained balance jump. It proves the interlock end to end and proves the dedupe guard earns its place.
- **Part B runs against a fixture this suite owns**, with `equity_close` deliberately different from `balance_close` on every day. That divergence is what makes "readings post equity, not balance" a falsifiable claim. The seed's daily rows may or may not diverge, and a test that cannot tell the two apart is worse than no test.

**Files:**
- Create: `lib/compound/db/round-trip.db.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–8; `dedupeDeals` from `@/lib/compound/reconcile/dedupe`; `planReadings` from `@/lib/compound/reconcile/interlock`; `fold` from `@/lib/compound/engine/replay`; `assertInvariants` from `@/lib/compound/engine/invariants`
- Produces: no exports

- [ ] **Step 1: Write the round-trip suite**

Create `lib/compound/db/round-trip.db.test.ts`:

```typescript
import { assertInvariants } from "@/lib/compound/engine/invariants";
import { fold } from "@/lib/compound/engine/replay";
import { dedupeDeals } from "@/lib/compound/reconcile/dedupe";
import { planReadings } from "@/lib/compound/reconcile/interlock";
import { commitReadingPlan } from "./commit-plan";
import {
  getHolderSeeds,
  getLedgerEntries,
  getReconcileCursor,
  listCandidates,
} from "./compound";
import { getClosedDeals, getDailySnapshots } from "./copytraderx";
import { closeTestPool, resetCompoundTables, seedUser, withTestClient } from "./testing/harness";

/** Seeded by the local-supabase fixture. Fictional. */
const SEED_MT5 = 90_000_001;
const SEED_MANAGER = "00000000-0000-0000-0000-000000000001";
const BROKER_OFFSET_HOURS = 3;

afterAll(async () => {
  await withTestClient((c) => resetCompoundTables(c));
  await closeTestPool();
});

// ---------------------------------------------------------------------------
// Part A — the shipped seed
// ---------------------------------------------------------------------------

describe("Part A: the seeded account, end to end", () => {
  let accountId = 0;

  beforeEach(async () => {
    await withTestClient(async (c) => {
      await resetCompoundTables(c);
      await seedUser(c, SEED_MANAGER, "manager@example.com");
      const { rows } = await c.query<{ id: string }>(
        `insert into public.compound_account
           (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
         values ($1, 'Seeded Desk', 'USD', 4000, '2026-08-03', $2)
         returning id`,
        [SEED_MT5, SEED_MANAGER],
      );
      accountId = Number(rows[0]!.id);
      await c.query(
        `insert into public.compound_holder
           (account_id, name, is_manager, split_bps, joined_at, status)
         values ($1, 'Manager', true, 4000, '2026-08-03', 'active')`,
        [accountId],
      );
    });
  });

  describe("the seed is really there", () => {
    // Ratchet. Every assertion below is vacuous against an empty database, and
    // an empty database is exactly what a stale `supabase db reset` produces.
    it("has ten daily snapshots across the expected window", async () => {
      const snaps = await withTestClient((c) => getDailySnapshots(c, SEED_MT5));
      expect(snaps).toHaveLength(10);
      expect(snaps[0]!.tradeDate).toBe("2026-08-03");
      expect(snaps[snaps.length - 1]!.tradeDate).toBe("2026-08-14");
    });

    it("has the duplicate pair and the weekend close", async () => {
      const deals = await withTestClient((c) => getClosedDeals(c, SEED_MT5));
      const tickets = deals.map((d) => d.ticket);
      expect(tickets).toContain(90010004);
      expect(tickets).toContain(90019999);
      expect(tickets).toContain(90010006);
    });

    it("shows the unexplained jump as a +5000.00 balance move on 2026-08-12", async () => {
      const snaps = await withTestClient((c) => getDailySnapshots(c, SEED_MT5));
      const before = snaps.find((s) => s.tradeDate === "2026-08-11")!;
      const after = snaps.find((s) => s.tradeDate === "2026-08-12")!;
      expect(after.balanceCloseCents - before.balanceCloseCents).toBe(500000n);
    });
  });

  describe("dedupe", () => {
    it("drops the +3h twin and keeps the lower ticket", async () => {
      const deals = await withTestClient((c) => getClosedDeals(c, SEED_MT5));
      const { kept, dropped } = dedupeDeals(deals, BROKER_OFFSET_HOURS);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]!.deal.ticket).toBe(90019999);
      expect(dropped[0]!.duplicateOfTicket).toBe(90010004);
      expect(kept.map((d) => d.ticket)).not.toContain(90019999);
    });
  });

  describe("the interlock, from database to database", () => {
    async function runOnce(useDedupe = true) {
      return withTestClient(async (c) => {
        const snapshots = await getDailySnapshots(c, SEED_MT5);
        const raw = await getClosedDeals(c, SEED_MT5);
        const deals = useDedupe ? dedupeDeals(raw, BROKER_OFFSET_HOURS).kept : raw;
        const cursor = await getReconcileCursor(c, accountId);
        const plan = planReadings({
          snapshots,
          deals,
          cursor,
          brokerOffsetHours: BROKER_OFFSET_HOURS,
          toleranceCents: 0n,
        });
        return plan;
      });
    }

    it("halts on the unexplained day, not before and not after", async () => {
      const plan = await runOnce();
      expect(plan.kind).toBe("halt");
      if (plan.kind !== "halt") throw new Error("expected halt");
      expect(plan.candidate.tradeDate).toBe("2026-08-12");
      expect(plan.candidate.unexplainedCents).toBe(500000n);
    });

    it("plans a reading for every explained day up to the one before", async () => {
      const plan = await runOnce();
      if (plan.kind !== "halt") throw new Error("expected halt");
      expect(plan.readings.map((r) => r.occurredOn)).toEqual([
        "2026-08-03",
        "2026-08-04",
        "2026-08-05",
        "2026-08-06",
        "2026-08-07",
        "2026-08-10",
        "2026-08-11",
      ]);
    });

    it("halts EARLIER without dedupe — spec 6.3's claim, made falsifiable", async () => {
      const withGuard = await runOnce(true);
      const without = await runOnce(false);
      if (withGuard.kind !== "halt") throw new Error("expected halt");
      if (without.kind !== "halt") throw new Error("expected halt");

      // The duplicate inflates 2026-08-06's closed-trade P/L, so the day stops
      // reconciling and the reconciler stops six days too early.
      expect(without.candidate.tradeDate).toBe("2026-08-06");
      // Stated separately, because it survives any change to the seed's dates:
      // the raw run must halt strictly before the real event.
      expect(
        without.candidate.tradeDate < withGuard.candidate.tradeDate,
      ).toBe(true);
    });

    it("commits the plan, and posts NOT ONE READING on or after the event", async () => {
      const plan = await runOnce();
      const result = await withTestClient((c) =>
        commitReadingPlan(c, { accountId, plan, actorUserId: SEED_MANAGER }),
      );
      expect(result.readingsInserted).toBe(7);
      expect(result.seqs).toEqual([1, 2, 3, 4, 5, 6, 7]);

      const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
      for (const e of entries) {
        expect(e.occurredOn < "2026-08-12").toBe(true);
      }

      const cursor = await withTestClient((c) => getReconcileCursor(c, accountId));
      expect(cursor).toEqual({ lastReadingDate: "2026-08-11" });

      const candidates = await withTestClient((c) => listCandidates(c, accountId, "pending"));
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.tradeDate).toBe("2026-08-12");
      expect(candidates[0]!.unexplainedCents).toBe(500000n);
    });

    it("is idempotent — a second full run changes nothing", async () => {
      const first = await runOnce();
      await withTestClient((c) =>
        commitReadingPlan(c, { accountId, plan: first, actorUserId: SEED_MANAGER }),
      );

      const second = await runOnce();
      const result = await withTestClient((c) =>
        commitReadingPlan(c, { accountId, plan: second, actorUserId: SEED_MANAGER }),
      );

      expect(result.readingsInserted).toBe(0);

      const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
      expect(entries).toHaveLength(7);
      const candidates = await withTestClient((c) => listCandidates(c, accountId));
      expect(candidates).toHaveLength(1);
      const cursor = await withTestClient((c) => getReconcileCursor(c, accountId));
      expect(cursor).toEqual({ lastReadingDate: "2026-08-11" });
    });
  });
});

// ---------------------------------------------------------------------------
// Part B — a fixture where equity and balance disagree on every day
// ---------------------------------------------------------------------------

describe("Part B: readings carry equity, and the fold reproduces it", () => {
  const MT5 = 9_900_901;
  const MANAGER = "aaaaaaaa-0000-4000-8000-0000000009a1";
  let accountId = 0;
  let holderId = 0;

  beforeAll(async () => {
    await withTestClient(async (c) => {
      await c.query("delete from public.deals where mt5_account = $1", [MT5]);
      await c.query("delete from public.account_snapshots_daily where mt5_account = $1", [MT5]);
      // Balance and equity differ on every day, by design. Without that,
      // "posts equity" and "posts balance" produce identical ledgers and the
      // assertion below could not fail.
      await c.query(
        `insert into public.account_snapshots_daily
           (mt5_account, trade_date, balance_close, equity_close, daily_pnl)
         values ($1, '2026-09-01', 10000.05, 10000.05,   0.00),
                ($1, '2026-09-02', 10123.45, 10150.29, 123.40),
                ($1, '2026-09-03', 10250.13, 10199.87, 126.68)`,
        [MT5],
      );
      await c.query(
        `insert into public.deals
           (mt5_account, ticket, ea_source, symbol, side, volume,
            open_price, close_price, open_time, close_time, profit, swap, commission)
         values ($1, 9909001, 'impulse', 'EURUSD', 'buy', 0.10, 1.0, 1.0,
                 '2026-09-02T07:00:00+00', '2026-09-02T15:00:00+00', 123.40, 0.00, 0.00),
                ($1, 9909002, 'impulse', 'EURUSD', 'buy', 0.10, 1.0, 1.0,
                 '2026-09-03T07:00:00+00', '2026-09-03T15:00:00+00', 126.68, 0.00, 0.00)`,
        [MT5],
      );
    });
  });

  afterAll(async () => {
    await withTestClient(async (c) => {
      await c.query("delete from public.deals where mt5_account = $1", [MT5]);
      await c.query("delete from public.account_snapshots_daily where mt5_account = $1", [MT5]);
    });
  });

  beforeEach(async () => {
    await withTestClient(async (c) => {
      await resetCompoundTables(c);
      await seedUser(c, MANAGER, "roundtrip-b@example.test");
      const acc = await c.query<{ id: string }>(
        `insert into public.compound_account
           (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
         values ($1, 'Divergent Desk', 'USD', 4000, '2026-09-01', $2)
         returning id`,
        [MT5, MANAGER],
      );
      accountId = Number(acc.rows[0]!.id);
      const h = await c.query<{ id: string }>(
        `insert into public.compound_holder
           (account_id, name, is_manager, split_bps, joined_at, status)
         values ($1, 'Manager', true, 4000, '2026-09-01', 'active')
         returning id`,
        [accountId],
      );
      holderId = Number(h.rows[0]!.id);

      // The genesis deposit. Posting deposits is plan 4's writer; here it is
      // inserted directly so the pool has units and the invariants have
      // something to be true about. seq 1, so the reader's readings start at 2.
      await c.query(
        `insert into public.compound_ledger_entry
           (account_id, holder_id, seq, occurred_on, type, amount_cents)
         values ($1, $2, 1, '2026-09-01', 'deposit', 1000005)`,
        [accountId, holderId],
      );
    });
  });

  it("has a fixture where equity and balance really do differ", async () => {
    // Ratchet on the discriminating property itself. If the fixture is ever
    // flattened, the assertion below stops testing anything and this says so.
    const snaps = await withTestClient((c) => getDailySnapshots(c, MT5));
    const divergent = snaps.filter((s) => s.equityCloseCents !== s.balanceCloseCents);
    expect(divergent.length).toBeGreaterThanOrEqual(2);
  });

  it("advances cleanly through every explained day", async () => {
    const plan = await withTestClient(async (c) => {
      const snapshots = await getDailySnapshots(c, MT5);
      const deals = dedupeDeals(await getClosedDeals(c, MT5), BROKER_OFFSET_HOURS).kept;
      const cursor = await getReconcileCursor(c, accountId);
      return planReadings({
        snapshots,
        deals,
        cursor,
        brokerOffsetHours: BROKER_OFFSET_HOURS,
        toleranceCents: 0n,
      });
    });
    expect(plan.kind).toBe("advance");
  });

  it("posts equity_close, not balance_close", async () => {
    const entries = await withTestClient(async (c) => {
      const snapshots = await getDailySnapshots(c, MT5);
      const deals = dedupeDeals(await getClosedDeals(c, MT5), BROKER_OFFSET_HOURS).kept;
      const cursor = await getReconcileCursor(c, accountId);
      const plan = planReadings({
        snapshots,
        deals,
        cursor,
        brokerOffsetHours: BROKER_OFFSET_HOURS,
        toleranceCents: 0n,
      });
      await commitReadingPlan(c, { accountId, plan, actorUserId: MANAGER });
      return getLedgerEntries(c, accountId);
    });

    const readings = entries.filter((e) => e.type === "equity_reading");
    expect(readings.map((e) => e.amountCents)).toEqual([1000005n, 1015029n, 1019987n]);
    // The balance series, for contrast: 1000005, 1012345, 1025013.
    expect(readings.map((e) => e.amountCents)).not.toContain(1012345n);
    expect(readings.map((e) => e.amountCents)).not.toContain(1025013n);
  });

  it("folds to a PoolState that satisfies every invariant", async () => {
    const state = await withTestClient(async (c) => {
      const snapshots = await getDailySnapshots(c, MT5);
      const deals = dedupeDeals(await getClosedDeals(c, MT5), BROKER_OFFSET_HOURS).kept;
      const cursor = await getReconcileCursor(c, accountId);
      const plan = planReadings({
        snapshots,
        deals,
        cursor,
        brokerOffsetHours: BROKER_OFFSET_HOURS,
        toleranceCents: 0n,
      });
      await commitReadingPlan(c, { accountId, plan, actorUserId: MANAGER });
      const entries = await getLedgerEntries(c, accountId);
      const seeds = await getHolderSeeds(c, accountId);
      return fold(entries, seeds);
    });

    expect(() => assertInvariants(state)).not.toThrow();
    expect(state.equityCents).toBe(1019987n);
    expect(state.lastReadingOn).toBe("2026-09-03");
    expect(state.seq).toBe(4);

    const manager = state.holders.find((h) => h.holderId === holderId)!;
    expect(manager.basisCents).toBe(1000005n);
    expect(manager.units).toBeGreaterThan(0n);
    // Invariant 1, stated directly rather than trusted to assertInvariants.
    expect(state.holders.reduce((sum, h) => sum + h.units, 0n)).toBe(state.units);
  });
});
```

- [ ] **Step 2: Run every gate**

```bash
supabase db reset
pnpm typecheck && pnpm test && pnpm test:db
```

- [ ] **Step 3: Prove the round trip bites**

1. **Skip dedupe** — change `runOnce()`'s default to `false`.
   Expected red: `"halts on the unexplained day, not before and not after"`, `"plans a reading for every explained day up to the one before"`, `"commits the plan, and posts NOT ONE READING on or after the event"`. This is spec §6.3's whole argument, reproduced against real-shaped data.
2. **Post `balanceCloseCents` instead of `equityCloseCents`** — the change would be inside `interlock.ts`, so make it locally in `planReadings` or, if that is on another branch, in a temporary copy.
   Expected red: `"posts equity_close, not balance_close"` and `"folds to a PoolState that satisfies every invariant"` on `state.equityCents`. Part A stays green if the seed's daily equity equals its balance — record whether it does, because that tells you whether Part B is load-bearing or merely belt-and-braces.
3. **Flatten Part B's fixture** — set every `equity_close` equal to its `balance_close`.
   Expected red: `"has a fixture where equity and balance really do differ"`, and only that. Confirm `"posts equity_close, not balance_close"` goes **green** with the flattened fixture — that is the ratchet earning its place, and the reason it is written as a separate test.
4. **Let the interlock advance past the event** — remove the halt from `runOnce`'s plan by passing a huge `toleranceCents` such as `10_000_000n`.
   Expected red: `"halts on the unexplained day"`, `"commits the plan, and posts NOT ONE READING on or after the event"`. The second is the safety property: readings would reach 2026-08-14.
5. **Break idempotence** — remove the `on conflict do nothing` from the candidate insert in the writer.
   Expected red: `"is idempotent — a second full run changes nothing"`.

- [ ] **Step 4: Update `README.md` with how to run the database tests**

Add a short section. Do not add a project ref, a key or a hosted URL.

````markdown
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
````

- [ ] **Step 5: STOP — the gate this plan ends at**

The migrations are proven locally. **They are not applied to CopyTraderX, and no step in this plan applies them.** Write the handover, commit it, and stop.

Add to the pull request description, not to a new file:

```markdown
### Ready for a human-approved apply

Four migrations are proven against a local Supabase:

1. `*_compound_core_tables.sql` — the six compound_* tables
2. `*_compound_rls.sql` — RLS, admin gate AND manager_user_id key
3. `*_compound_ledger_append_only.sql` — grants and triggers
4. `*_compound_commit_reading_plan.sql` — the atomic writer

Before anyone applies these to the CopyTraderX project, a human should confirm:

- `public.users` exists there with the columns these FKs assume, and the
  `auth.users` mirroring trigger is live.
- That project's `ALTER DEFAULT PRIVILEGES` are known. If they grant ALL to
  `anon`/`authenticated`/`service_role`, the `revoke` in migration 3 stops
  being a no-op and starts being the thing that matters.
- No `compound_*` table already exists there.
- The apply runs through the project's own review process, not from this
  repository. `supabase link` and `supabase db push` are not to be run here
  — the CLI on this machine holds an ambient session for an unrelated
  organisation.

Nothing in this branch reaches a hosted project.
```

- [ ] **Step 6: Commit**

```bash
git add lib/compound/db/round-trip.db.test.ts README.md
git commit -m "test(db): full round trip — seed to PoolState, with the interlock holding"
```

---

## Plan self-review

### Spec coverage

| Spec | Task |
|---|---|
| §5.2 reconcile on balance, post readings on **equity** | 6, 9 Part B |
| §5.2 committed versus live NAV (`account_snapshots_current`) | 6 — `getLiveSnapshot` |
| §5.3 the safety interlock, restated at the persistence boundary | 8 (CX002), 9 Part A |
| §6 the six `compound_*` tables | 2 |
| §6 ledger type set, candidate status set, holder status set | 2 |
| §6.1 the ledger stores inputs — no `units_delta`, no `nav_at_entry` | 2 (schema + a test that no such column exists anywhere) |
| §6.1 `split_bps_applied` is the one exception | 2 (check constraint), 7 (mapped through) |
| §6.2 `seq` monotonic per account, assigned server-side | 2 (`unique (account_id, seq)`), 7 (`order by seq`), 8 (`max+1` under a row lock) |
| §9 RLS on every `compound_*` table, keyed on `manager_user_id` | 3 |
| §9 the `admin` role gate, in the project's own JWT idiom | 3 |
| §9 `compound_ledger_entry` grants INSERT and SELECT only | 3 (grants), 4 (grants + triggers) |
| §3.5 invariant 5 — append-only, corrections are reversing entries | 4 |
| §3.5 invariants 1–4 | 9 Part B — `assertInvariants` over a state folded from real rows |
| §4 money as integer minor units, never float | 5 (SQL conversion, parsers, purity guard), 6 (values chosen so a float path is wrong) |
| §4 splits as integer basis points, `0..10000` | 2 |
| §4 NAV never stored | 2 — a test asserts no column matching `%nav%` exists |
| §4 `occurred_on` broker-server date, `recorded_at` UTC | 2 |
| §10 no project ref, no key, no real identifier in tracked files | throughout; every fixture is fictional |
| §11 `db/` integration tests, append-only enforcement | 1–9 |

**Not covered here, by design.** Surfaces and routes (§7), the design system (§8), the deposit / payout / exit writers and candidate classification (all of which need the payout flow, plan 4), the investor portal (§12, v2), deployment (§10), and §10's pre-commit secret-scanning check — that one belongs with the CI setup and is worth raising separately, because nothing in this plan or the two before it creates it.

**One spec clause with no implementation, deliberately.** §4 specifies units as `numeric(28,10)` in Postgres. Under D7 and §6.1 no table stores units, so no column implements it. Delete the clause from the spec rather than leaving it as a trap.

### Type consistency

**Imported, never redefined.** `Cents` (`engine/money`); `LedgerEntry`, `LedgerEntryType`, `HolderSeed`, `PoolState`, `fold` (`engine/replay`); `assertInvariants` (`engine/invariants`); `DailySnapshot`, `ClosedDeal`, `dealNetCents` (`reconcile/types`); `utcDateKey` (`reconcile/date-key`); `dedupeDeals` (`reconcile/dedupe`); `ReadingPlan`, `PlannedReading`, `CapitalEventCandidate`, `ReconcileCursor`, `planReadings` (`reconcile/interlock`). Every one is used with the name and shape its own module gives it.

**Defined once here, and referenced by the same name afterwards.** `Queryable` (in `db/types.ts` — the one type that could plausibly have been redefined in four modules, and is not), `DbRole`, `AppRole`, `DateRange`, `LiveSnapshot`, `CompoundAccount`, `CapitalEventCandidateRow`, `CommitResult`.

**Functions defined in exactly one task and used consistently after it:** `testDatabaseUrl`, `testPool`, `withTestClient`, `withSeparateSession`, `asRole`, `resetCompoundTables`, `sequenceConsumed`, `seedUser`, `expectPgError` (Task 1); `databaseUrl`, `getPool`, `withDb`, `withDbTransaction`, `centsExpr`, `milliLotsExpr`, `dateKeyExpr`, `utcIsoExpr`, `toCents`, `toId`, `toDateKey`, `toSide` (Task 5); `getDailySnapshots`, `getClosedDeals`, `getLiveSnapshot`, `getAccountOwnerUserId` (Task 6); `getAccountById`, `getAccountByMt5`, `listAccountsForManager`, `getHolderSeeds`, `getLedgerEntries`, `getReconcileCursor`, `listCandidates` (Task 7); `commitReadingPlan` (Task 8).

**SQL objects defined once:** `compound_is_admin()`, `compound_manages_account(bigint)` (Task 3); `compound_ledger_entry_is_append_only()` and its three triggers (Task 4); `compound_commit_reading_plan(...)` (Task 8).

### Placeholder scan

`grep -nEi 'TBD|to be determined|FIXME|XXX|TODO|similar to task|appropriate error handling|write tests for the above'` over the whole file returns nothing. Every code step carries its code, every SQL step carries its SQL, and every probe names the tests it should turn red.

### The vacuity audit

The brief that produced this plan asked for one thing above all: no assertion that cannot fail. Here is every place a database test would normally be vacuous, and what stops it.

| Would-be vacuity | What makes it discriminate |
|---|---|
| RLS test run as `postgres` or `service_role` | Verified both carry `BYPASSRLS`. Every RLS assertion runs through `asRole(c, "authenticated", …)`, and Task 3 probe 7 *deliberately* switches to `service_role` to watch the whole suite fail |
| RLS test filtered by `account_id` | Every RLS read is unfiltered; `readAllAs` takes raw SQL with no predicate |
| RLS test with one account | Two managers, two accounts, and a fixture-reality test asserting there really are two of everything |
| "service_role cannot UPDATE the ledger" | Would pass with the revoke *and* the triggers deleted, because this Supabase grants no UPDATE by default. Task 4 grants UPDATE **back** and asserts the trigger still refuses |
| "the writer is atomic" | Would pass if the guard fired before any write. `sequenceConsumed` asserts three ledger ids and one candidate id were consumed inside the rolled-back transaction |
| "an idle plan writes nothing" | Trivially true. A `jest.fn()` client asserts zero round trips instead |
| "the ledger comes back in order" | Would pass under `order by id` or `order by occurred_on`. The fixture makes all three orderings different |
| "money converts correctly" | `1234.56` passes under every implementation. `10000.05`, `10000.29`, `0.29` and `-2.05` do not — `Math.trunc` is one cent short on each — and `90071992547409.93` is exactly `2^53 + 1` cents |
| "the round trip works" | Would pass against an empty database. `globalSetup` fails loudly rather than skipping, and Part A ratchets on ten snapshots and three named tickets |
| "readings post equity" | Vacuous if `equity_close = balance_close` in the fixture. Part B's fixture diverges on every day, **and** a separate test asserts the divergence exists |
| "dedupe matters" | Asserted by contrast: the same pipeline run with and without `dedupeDeals` halts on different days |
| `.rejects.toThrow()` | Never used bare. `expectPgError` matches SQLSTATE **and** message, and has its own tests proving it rejects a right-code/wrong-message pair |

### Known thin spots, stated rather than hidden

1. **RLS is defence in depth in v1, not a live control.** Every server path runs as `service_role`, which bypasses RLS. If the policies were wrong today, nothing in v1 would break. They are built now because §9 asks for them from day one and because v2's investor portal will depend on them — but do not mistake a green RLS suite for a control that is currently doing work. The append-only **grant** is the one that binds at runtime, which is why `withDb` sets `role service_role` at all.
2. **Deleting the `revoke` in Task 4 turns nothing red** on this Supabase version. Task 4 probe 2 says so explicitly. The grant-back test is the compensating control, and the line stays because the live project's default privileges may differ.
3. **`BEFORE` versus `AFTER` on the append-only triggers is untested.** Both abort the statement. `BEFORE` is chosen because it is cheaper and conventional, not because anything demands it.
4. **Dropping `round()` from `centsExpr` changes no result**, because `numeric::bigint` rounds anyway. It stays so the intent is legible.
5. **Task 8's concurrency test waits 300 ms** before asserting the second session is still blocked. The assertion is on `bSettled`, not on elapsed time, but a very heavily loaded machine could in principle produce a false red. If it flakes, raise the delay rather than weakening the assertion.
6. **`compound_holder.status` is stored and also derived.** `getHolderSeeds` never reads the stored column, so nothing here can disagree with `fold`. No test asserts the two agree, deliberately: with no payouts in any fixture this plan builds, both sides read `'active'` and the assertion could not fail. **Plan 4 must keep the column in step or drop it.**
7. **`ReadingPlan`'s `halt` variant with empty readings** may carry `newCursorDate: null` or the existing cursor date; the type does not say. The writer accepts both as "leave the cursor alone". Confirm against the real `interlock.ts` and simplify.
8. **The `deals` fixture has no open/closed discriminator** and every seeded row is a closed trade. If the real table ever carries open positions, `getClosedDeals` needs a filter and no fixture here would have caught its absence.
9. **`'investor'` is not a storable role.** `public.users.role` is CHECK-constrained to `('admin','user')` in the live schema. Consistent with D1 and §9's "unused until v2", but it means v2's investor access must come from `compound_holder.user_id` linkage, not from a role claim. Worth recording in the spec.
10. **Nothing here verifies the live CopyTraderX schema.** `public.users`, the mirroring triggers and the licence CHECK constraints were read from that project's migrations, not from its database. The STOP checklist in Task 9 Step 5 asks a human to confirm before applying.

### Deviations from the spec, for the record

The eight decisions in the table near the top of this plan (**P1**–**P8**) are all changes to what §6 and §9 sketch, not merely to how this plan implements them. Two are worth folding back into the spec before plan 4 starts, because later plans will read the spec rather than this document:

- **P1**, `public.users` rather than `auth.users` for every uuid foreign key. §6's sketch is wrong about the project's own convention.
- **P5**, the admin claim as an `AND` gate rather than an `OR` bypass. §9 currently reads both ways, and only one of them leaves RLS with anything to do.
