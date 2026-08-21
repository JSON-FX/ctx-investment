# Applying Compound to a live CopyTraderX database

Prepared for review. **Nothing here has been run against any live database**, and
running it is a decision for the operator, not for the tooling.

Compound never writes to CopyTraderX's tables. It reads market truth and owns its
own accounting truth in a separate `compound_*` namespace. This document covers
adding that namespace to a database that already has CopyTraderX in it.

---

## 1. What applies, and what must not

The `supabase/migrations/` directory holds thirteen files. **Two of them must
never be applied to a live database.**

| # | Migration | Apply? |
|---|---|---|
| 1 | `20260821004302_copytraderx_fixture_tables` | **NO** |
| 2 | `20260821022245_compound_core_tables` | yes |
| 3 | `20260821050126_compound_rls` | yes |
| 4 | `20260821054530_compound_ledger_append_only` | yes |
| 5 | `20260821054531_compound_truncate_hardening` | yes — **see §3** |
| 6 | `20260821065944_compound_commit_reading_plan` | yes |
| 7 | `20260821090108_compound_account_broker_offset` | yes |
| 8 | `20260821102706_compound_create_account` | yes |
| 9 | `20260821120000_copytraderx_orders_positions` | **NO** |
| 10 | `20260821122529_compound_add_holder` | yes |
| 11 | `20260821122530_compound_commit_deposit` | yes |
| 12 | `20260821122547_compound_commit_payout` | yes |
| 13 | `20260821122858_compound_classify_candidate` | yes |

### Why those two are excluded

They create `users`, `deals`, `account_snapshots_daily`,
`account_snapshots_current`, `licenses`, `orders` and `positions` — **local
stand-ins for tables the live database already has.** They exist so the code can
be developed and tested against the right shapes without a live connection.

Applying them to live would at best fail on existing objects and at worst
redefine tables the EA writes to. They are development scaffolding, not part of
the product.

`supabase db push` applies the whole directory. **Do not use it here.** Apply the
eleven individually, in the order above.

---

## 2. What the eleven actually add

Six tables, all prefixed `compound_`:

- `compound_account`, `compound_holder`, `compound_ledger_entry`
- `compound_capital_event_candidate`, `compound_reconcile_cursor`, `compound_audit`

Nine functions, all prefixed `compound_`:

- `compound_is_admin`, `compound_manages_account`
- `compound_ledger_entry_is_append_only`
- `compound_commit_reading_plan`, `compound_create_account`, `compound_add_holder`
- `compound_commit_deposit`, `compound_commit_payout`, `compound_classify_candidate`

**No existing table is altered. No existing function is replaced. No role is
created, and `public.users.role` is not widened** — Compound reads the JWT's
`app_metadata->>role` and keys ownership on `compound_account.manager_user_id`,
so it needs no `investor` role and adds none.

Five foreign keys point at **`public.users(id)`**, not `auth.users` — matching how
`licenses` and `subscriptions` already reference it.

---

## 3. The one change that reaches beyond `compound_*`

Migration 5 ends with:

```sql
alter default privileges for role postgres in schema public
  revoke truncate, maintain on tables from anon, authenticated, service_role;
```

**This narrows the default for every future table `postgres` creates in the
`public` schema — including future CopyTraderX tables, not only `compound_*`.**

It exists because of something verified on the local stack, and worth verifying
on yours before deciding (pre-flight check 6):

```
TRUNCATE          as authenticated  -> refused (only because an FK referenced the table)
TRUNCATE CASCADE  as authenticated  -> SUCCEEDED
TRUNCATE CASCADE  as anon           -> SUCCEEDED
```

RLS does not apply to `TRUNCATE` at all, so no policy protects against this. The
grants come from a Supabase-wide default ACL, not from anything this project
wrote.

**The case for applying it:** the ledger is the sole accounting truth and its loss
is unrecoverable. Nothing in this project has ever used `TRUNCATE` or `MAINTAIN`
through those roles, and pre-flight check 8 tests that claim against your
database rather than assuming it.

**The case for hesitating:** it is a schema-wide default, and a future table that
genuinely needs `TRUNCATE` would have to grant it back explicitly.

**If you would rather not:** apply migrations 1–4 and 6–13, and skip 5. The ledger
is still protected — migration 4's trigger refuses `UPDATE`, `DELETE` and
`TRUNCATE` even for the table owner, which is the part that actually holds.
Migration 5 is defence in depth for the other five tables and for future ones.

---

## 4. Order of operations

**Do not begin until the pre-flight passes.**

1. **Back up.** A `compound_ledger_entry` cannot be corrected by `UPDATE` or
   `DELETE` afterwards — the trigger refuses both, by design.

2. **Run the pre-flight** against the target and read every verdict. It writes
   nothing — every statement in it is a `SELECT`.

   This machine has no `psql`, so use the runnable version, which uses the `pg`
   dependency this project already has:

   ```bash
   COMPOUND_LIVE_URL=... node docs/live-migration/preflight.mjs
   ```

   It exits non-zero if any check says STOP. `preflight.sql` holds the same
   checks for anyone who does have `psql`.

   Pass the connection string through the environment rather than on the
   command line, so it does not land in shell history.

   Two of its checks are worth reading even when everything passes. Check 6
   reports who currently holds `TRUNCATE` on `public.deals` — on the local
   stack that is `anon, authenticated, postgres, service_role`, which shows the
   hole §3 describes is not confined to `compound_*` tables. Check 8 tests
   whether anything in *your* database actually uses `TRUNCATE`, rather than
   assuming nothing does.

3. **Apply the eleven, in order, one at a time.** Read each result. They are
   independent enough to stop between any two.

4. **Verify the append-only guarantee actually holds** on the live database, as
   the table owner, not just as `service_role`:

   ```sql
   begin;
     truncate public.compound_ledger_entry cascade;  -- expect CX010
   rollback;
   ```

   If that succeeds, migration 4 did not take and you should stop.

5. **Create the account row** for the MT5 account you are administering, then its
   manager holder — in the same transaction. `compound_create_account` does both;
   use it rather than two inserts. No database constraint can enforce "an account
   has a manager holder", so the writer is what guarantees it (decision P9).

6. **Point the app at the database** — `COMPOUND_DATABASE_URL`, `SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`. The
   `NEXT_PUBLIC_*` pair is inlined at build time, so the image must be rebuilt,
   not just restarted.

---

## 5. What happens on the first refresh — read this before you run it

The ledger has to be **built** from history, and the interlock guarantees that
cannot happen silently.

The reconciler reads daily balances, subtracts closed-trade P/L, and **halts on
every move it cannot explain.** For a real account, every historical deposit and
withdrawal is such a move. So the first **Refresh readings** will stop at the
earliest one and refuse to advance past it.

That is the interlock working, not a failure. An unrecorded deposit is
indistinguishable from profit, and profit gets split — so NAV never crosses an
unclassified capital event.

Expect to work through the review queue candidate by candidate, oldest first,
classifying each as a deposit, a match to an entry you have already recorded, or
not a capital event. The queue is built for exactly this. Budget real time for
it: an account with a long history has one decision per capital event, and each
one moves money.

**Do this on a copy first if you can.** Restore a dump into a scratch database,
apply the eleven there, and run the whole classification through once. The
classification decisions are the part with no undo — a wrong one is corrected by
a reversing entry, which is visible in the ledger forever.

---

## 6. Rolling back

Migrations 2–13 are additive and confined to the `compound_` namespace, so
undoing them is dropping what they created — but **only before any real ledger
entry exists.** After that, a drop destroys accounting history that cannot be
reconstructed from anywhere else.

Migration 5's default-privileges change is separate and reversible on its own:

```sql
alter default privileges for role postgres in schema public
  grant truncate, maintain on tables to anon, authenticated, service_role;
```

That restores the Supabase default, hole included.
