/**
 * Integration. Runs under jest.db.config.mjs against the local stack.
 *
 * Disagreements between the plan's Task 12 draft and the real harness, each
 * checked against a real run rather than assumed — the same class of
 * mistake write-account.db.test.ts and holders.db.test.ts already document
 * for Tasks 4 and 6 of this same plan:
 *
 *   1. The plan's snippet imported seedTwoAccounts and MANAGER_USER_ID from
 *      "@/lib/compound/db/test-harness" and destructured { mine, theirs }
 *      with a single mine.managerHolderId. Neither the path nor the exports
 *      exist. The real harness (lib/compound/db/testing/harness.ts) returns
 *      { accountA, accountB }, each a { accountId, managerUserId, holderIds }
 *      — holderIds is an ARRAY (account A seeds a manager AND an investor),
 *      so "the manager's holder id" is looked up explicitly by is_manager
 *      below rather than assumed to be a fixed array index.
 *
 *   2. seedUser (called by seedTwoAccounts) inserts into auth.users, which
 *      only postgres/supabase_auth_admin can write — no role client.ts ever
 *      switches to can. Fixture seeding therefore runs on the harness's
 *      postgres-connected pool (withTestClient) and the writers under test
 *      run on client.ts's withAuthenticatedDb, connected as the account's own
 *      manager — exactly as write-account.db.test.ts and holders.db.test.ts
 *      settled — not the plan's single rolled-back withDbTransaction spanning
 *      both, which cannot work once seeding needs a different role than the
 *      write. Isolation is resetCompoundTables in beforeEach, to match.
 *
 *   3. "cannot be updated or deleted afterwards" asserts the EXACT refusal
 *      rather than the plan's loose /append-only|not permitted|permission
 *      denied/i: commitDeposit runs through withAuthenticatedDb, and neither
 *      authenticated nor service_role holds an UPDATE/DELETE grant at all on
 *      compound_ledger_entry (compound_ledger_append_only grants it only
 *      select+insert, to both) — so the statement never reaches the
 *      append-only TRIGGER (which only binds the table owner, postgres) and
 *      is refused by the GRANT system instead, with 42501 "permission denied
 *      for table compound_ledger_entry". Confirmed against
 *      commit-plan.db.test.ts's own precedent for the identical scenario
 *      ("the writer respects the append-only ledger").
 *
 *   4. "refuses to create a second manager" asserts the real duplicate-key
 *      text from compound_holder_one_manager_per_account (23505), not a
 *      loose /unique|already exists/i.
 */
import { closePool, withAuthenticatedDb } from "@/lib/compound/db/client";
import { getLedgerEntries } from "@/lib/compound/db/compound";
import { commitDeposit } from "@/lib/compound/db/write-deposit";
import { addHolder } from "@/lib/compound/db/write-holder";
import {
  closeTestPool,
  expectPgError,
  resetCompoundTables,
  seedTwoAccounts,
  sequenceConsumed,
  withTestClient,
  type TwoAccountSeed,
} from "@/lib/compound/db/testing/harness";
import { LOCAL_SUPABASE_DB_URL } from "@/lib/compound/db/testing/env";

const ORIGINAL_DATABASE_URL = process.env.COMPOUND_DATABASE_URL;

beforeAll(() => {
  process.env.COMPOUND_DATABASE_URL =
    process.env.COMPOUND_TEST_DATABASE_URL || LOCAL_SUPABASE_DB_URL;
});

beforeEach(async () => {
  await withTestClient((c) => resetCompoundTables(c));
});

afterAll(async () => {
  await closePool();
  await closeTestPool();
  process.env.COMPOUND_DATABASE_URL = ORIGINAL_DATABASE_URL;
});

/** The seeded manager's own holder id — looked up, never assumed to be a fixed index. */
async function managerHolderId(seed: TwoAccountSeed["accountA"]): Promise<number> {
  const { rows } = await withTestClient((c) =>
    c.query<{ id: string }>(
      `select id from public.compound_holder where account_id = $1 and is_manager`,
      [seed.accountId],
    ),
  );
  return Number(rows[0]!.id);
}

describe("commitDeposit", () => {
  it("assigns seq server-side, starting at 1 and rising", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const holderId = await managerHolderId(seed.accountA);

    const a = await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
      commitDeposit(c, {
        accountId: seed.accountA.accountId, holderId,
        occurredOn: "2026-03-02", amountCents: 2_500_000n, note: null,
        actorUserId: seed.accountA.managerUserId,
      }),
    );
    const b = await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
      commitDeposit(c, {
        accountId: seed.accountA.accountId, holderId,
        occurredOn: "2026-03-03", amountCents: 100n, note: null,
        actorUserId: seed.accountA.managerUserId,
      }),
    );
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(a.seq + 1);
  });

  it("keeps seq independent per account", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const holderA = await managerHolderId(seed.accountA);
    const holderB = await managerHolderId(seed.accountB);

    const a = await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
      commitDeposit(c, {
        accountId: seed.accountA.accountId, holderId: holderA,
        occurredOn: "2026-03-02", amountCents: 100n, note: null,
        actorUserId: seed.accountA.managerUserId,
      }),
    );
    const b = await withAuthenticatedDb(seed.accountB.managerUserId, (c) =>
      commitDeposit(c, {
        accountId: seed.accountB.accountId, holderId: holderB,
        occurredOn: "2026-03-02", amountCents: 100n, note: null,
        actorUserId: seed.accountB.managerUserId,
      }),
    );
    expect(a.seq).toBe(b.seq); // both are 1: seq is per account, not global
  });

  it("stores an amount past Number.MAX_SAFE_INTEGER exactly", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const holderId = await managerHolderId(seed.accountA);
    const big = 9_007_199_254_740_993n;

    await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
      commitDeposit(c, {
        accountId: seed.accountA.accountId, holderId,
        occurredOn: "2026-03-02", amountCents: big, note: null,
        actorUserId: seed.accountA.managerUserId,
      }),
    );
    const [entry] = await withAuthenticatedDb(seed.accountA.managerUserId, (c) => getLedgerEntries(c, seed.accountA.accountId));
    expect(entry!.amountCents).toBe(big);
    expect(entry!.amountCents).not.toBe(9_007_199_254_740_992n);
  });

  it("stores no units_delta and no nav_at_entry, because there are no such columns", async () => {
    const { rows } = await withTestClient((c) =>
      c.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'compound_ledger_entry'`,
      ),
    );
    const names = rows.map((r) => r.column_name);
    expect(names).not.toContain("units_delta");
    expect(names).not.toContain("nav_at_entry");
  });

  it("refuses a holder who belongs to another account, with CX205", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const theirHolder = await managerHolderId(seed.accountB);

    await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
      expectPgError(
        commitDeposit(c, {
          accountId: seed.accountA.accountId, holderId: theirHolder,
          occurredOn: "2026-03-02", amountCents: 100n, note: null,
          actorUserId: seed.accountA.managerUserId,
        }),
        "CX205",
        /holder .* is not on account/,
      ),
    );
  });

  it("refuses a deposit dated on or after an unclassified capital event, with CX002", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const holderId = await managerHolderId(seed.accountA);

    await withTestClient((c) =>
      c.query(
        `insert into public.compound_capital_event_candidate
           (account_id, trade_date, balance_delta_cents, explained_cents, unexplained_cents)
         values ($1, '2026-08-12', 500000, 0, 500000)`,
        [seed.accountA.accountId],
      ),
    );

    await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
      expectPgError(
        commitDeposit(c, {
          accountId: seed.accountA.accountId, holderId,
          occurredOn: "2026-08-12", amountCents: 100n, note: null,
          actorUserId: seed.accountA.managerUserId,
        }),
        "CX002",
        /on or after the unclassified capital event/,
      ),
    );

    // And permits one dated before it, or the guard is just "refuse everything".
    await expect(
      withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
        commitDeposit(c, {
          accountId: seed.accountA.accountId, holderId,
          occurredOn: "2026-08-11", amountCents: 100n, note: null,
          actorUserId: seed.accountA.managerUserId,
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("refuses a non-positive amount before it reaches SQL", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const holderId = await managerHolderId(seed.accountA);

    await expect(
      withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
        commitDeposit(c, {
          accountId: seed.accountA.accountId, holderId,
          occurredOn: "2026-03-02", amountCents: 0n, note: null,
          actorUserId: seed.accountA.managerUserId,
        }),
      ),
    ).rejects.toThrow(/a deposit must be positive/);

    // Nothing reached SQL: no ledger row exists for the account at all.
    const entries = await withAuthenticatedDb(seed.accountA.managerUserId, (c) => getLedgerEntries(c, seed.accountA.accountId));
    expect(entries).toHaveLength(0);
  });

  it("refuses a non-positive amount at the SQL boundary too, with CX206", async () => {
    // Belt and suspenders: a caller that bypasses commitDeposit's own
    // RangeError (any direct SQL caller) still meets the same refusal.
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const holderId = await managerHolderId(seed.accountA);

    await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
      expectPgError(
        c.query(
          `select public.compound_commit_deposit($1,$2,$3::date,$4::bigint,$5,$6::uuid) as result`,
          [seed.accountA.accountId, holderId, "2026-03-02", "0", "", seed.accountA.managerUserId],
        ),
        "CX206",
        /a deposit must be positive/,
      ),
    );
  });

  it("cannot be updated or deleted afterwards", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const holderId = await managerHolderId(seed.accountA);

    const { ledgerEntryId } = await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
      commitDeposit(c, {
        accountId: seed.accountA.accountId, holderId,
        occurredOn: "2026-03-02", amountCents: 100n, note: null,
        actorUserId: seed.accountA.managerUserId,
      }),
    );

    await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
      expectPgError(
        c.query(`update public.compound_ledger_entry set amount_cents = 1 where id = $1`,
          [ledgerEntryId]),
        "42501",
        /permission denied for table compound_ledger_entry/,
      ),
    );
    await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
      expectPgError(
        c.query(`delete from public.compound_ledger_entry where id = $1`, [ledgerEntryId]),
        "42501",
        /permission denied for table compound_ledger_entry/,
      ),
    );
  });

  // -------------------------------------------------------------------------
  // ATOMICITY — the ledger insert and the audit insert land together or not
  // at all. This project's own append-only trigger cannot help here: it
  // guards UPDATE/DELETE/TRUNCATE, not "a second statement in the same
  // transaction failed". compound_commit_deposit is one plpgsql invocation —
  // one implicit transaction — and Postgres unwinds the whole thing when any
  // statement inside it raises, INSERT included. The forcing mechanism is a
  // temporary revoke of INSERT on compound_audit (undone in a finally),
  // which makes the SECOND insert fail after the FIRST one has genuinely
  // run — proved by sequenceConsumed, which a rolled-back transaction cannot
  // fake because sequences are not transactional.
  // -------------------------------------------------------------------------
  describe("ATOMICITY — the ledger insert and its audit row", () => {
    it("leaves neither row behind when the audit insert fails, having first proved the ledger insert ran", async () => {
      const seed = await withTestClient((c) => seedTwoAccounts(c));
      const holderId = await managerHolderId(seed.accountA);

      const before = await withTestClient((c) =>
        sequenceConsumed(c, "public.compound_ledger_entry", "id"),
      );

      // Revoked from `authenticated`, not `service_role`: commitDeposit now
      // runs through withAuthenticatedDb, so authenticated is the grant the
      // write actually depends on. See write-classify.db.test.ts's identical
      // fix for the full reasoning.
      await withTestClient((c) => c.query(`revoke insert on public.compound_audit from authenticated`));
      try {
        await expect(
          withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
            commitDeposit(c, {
              accountId: seed.accountA.accountId, holderId,
              occurredOn: "2026-03-02", amountCents: 4200n, note: null,
              actorUserId: seed.accountA.managerUserId,
            }),
          ),
        ).rejects.toThrow(/permission denied for table compound_audit/);
      } finally {
        await withTestClient((c) => c.query(`grant insert on public.compound_audit to authenticated`));
      }

      // The sequence advanced — the ledger INSERT genuinely executed and
      // reached RETURNING id — even though the row it produced is gone. A
      // promise rejection alone cannot tell a real rollback apart from a
      // guard that fired before either insert ran; the sequence can, because
      // it is not rolled back with the transaction.
      const after = await withTestClient((c) =>
        sequenceConsumed(c, "public.compound_ledger_entry", "id"),
      );
      expect(after).toBeGreaterThan(before);

      // Neither row survives, not "an error surfaced": no ledger entry —
      const entries = await withAuthenticatedDb(seed.accountA.managerUserId, (c) => getLedgerEntries(c, seed.accountA.accountId));
      expect(entries).toHaveLength(0);
      // — and no audit row for this account's deposit attempt either.
      const audit = await withTestClient((c) =>
        c.query<{ n: string }>(
          `select count(*)::text as n from public.compound_audit
            where account_id = $1 and action = 'commit_deposit'`,
          [seed.accountA.accountId],
        ),
      );
      expect(audit.rows[0]!.n).toBe("0");

      // And the next call is unaffected — seq starts fresh at 1, matching
      // "no partial state was left for it to trip over".
      const next = await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
        commitDeposit(c, {
          accountId: seed.accountA.accountId, holderId,
          occurredOn: "2026-03-02", amountCents: 100n, note: null,
          actorUserId: seed.accountA.managerUserId,
        }),
      );
      expect(next.seq).toBe(1);
    });
  });
});

describe("addHolder", () => {
  it("refuses to create a second manager, with the database's own unique index", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    // addHolder cannot ask for is_manager, so the only route to two managers
    // is direct SQL — which the partial unique index refuses.
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_holder
             (account_id, name, is_manager, split_bps, status)
           values ($1, 'Impostor', true, 0, 'active')`,
          [seed.accountA.accountId],
        ),
        "23505",
        /compound_holder_one_manager_per_account/,
      ),
    );
  });

  it("refuses an empty name", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    await expect(
      withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
        addHolder(c, {
          accountId: seed.accountA.accountId, name: "   ", email: null, splitBps: 4000,
          joinedAt: "2026-07-06", actorUserId: seed.accountA.managerUserId,
        }),
      ),
    ).rejects.toThrow(/a holder needs a name/);
  });

  it("refuses an account that does not exist, with CX001", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
      expectPgError(
        addHolder(c, {
          accountId: seed.accountA.accountId + 999_000, name: "Nobody", email: null,
          splitBps: 4000, joinedAt: "2026-07-06", actorUserId: seed.accountA.managerUserId,
        }),
        "CX001",
        /no account/,
      ),
    );
  });

  it("stores the holder's own split, not the account default", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c)); // account default is 4000
    const id = await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
      addHolder(c, {
        accountId: seed.accountA.accountId, name: "Grace Hopper", email: null, splitBps: 3700,
        joinedAt: "2026-07-06", actorUserId: seed.accountA.managerUserId,
      }),
    );
    const { rows } = await withTestClient((c) =>
      c.query<{ split_bps: number }>(
        `select split_bps from public.compound_holder where id = $1`, [id],
      ),
    );
    expect(rows[0]!.split_bps).toBe(3700);
  });

  it("adds no ledger entry — a holder with no deposit holds no units, not a units column set to zero", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const id = await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
      addHolder(c, {
        accountId: seed.accountA.accountId, name: "Katherine Johnson", email: null,
        splitBps: 4000, joinedAt: "2026-08-18", actorUserId: seed.accountA.managerUserId,
      }),
    );
    const entries = await withAuthenticatedDb(seed.accountA.managerUserId, (c) => getLedgerEntries(c, seed.accountA.accountId));
    expect(entries.some((e) => e.holderId === id)).toBe(false);
  });

  it("writes an audit row naming the actor", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const id = await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
      addHolder(c, {
        accountId: seed.accountA.accountId, name: "Grace Hopper", email: null, splitBps: 3700,
        joinedAt: "2026-07-06", actorUserId: seed.accountA.managerUserId,
      }),
    );
    const { rows } = await withTestClient((c) =>
      c.query<{ actor: string; action: string }>(
        `select actor, action from public.compound_audit
          where entity = 'compound_holder' and entity_id = $1`,
        [id],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe(seed.accountA.managerUserId);
    expect(rows[0]!.action).toBe("add_holder");
  });
});
