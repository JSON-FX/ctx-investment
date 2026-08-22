/**
 * Integration. Runs under jest.db.config.mjs against the local stack.
 *
 * Three disagreements between the plan's Step 6 draft and the real harness,
 * each checked against a real run rather than assumed:
 *
 *   1. The plan's snippet imported MANAGER_USER_ID and OTHER_MANAGER_USER_ID
 *      from "@/lib/compound/db/test-harness" and used them as pre-seeded
 *      constants. Neither the path nor the exports exist — the real harness
 *      lives at lib/compound/db/testing/harness.ts and has no such constants,
 *      only seedUser/seedTwoAccounts. holders.db.test.ts's header documents
 *      the identical mistake for the same plan's Task 4 draft; this file
 *      hits it independently for Task 6.
 *
 *   2. seedUser (and seedTwoAccounts, which calls it) inserts into
 *      auth.users, which only postgres/supabase_auth_admin can write — no
 *      role client.ts ever switches to can (confirmed exactly as
 *      holders.db.test.ts's header describes). createAccount itself has to
 *      run through client.ts's withAuthenticatedDb, connected as the
 *      manager the row belongs to, since that is the helper — and the
 *      identity — it actually runs under in production. So fixture seeding
 *      (withTestClient, the postgres-connected harness pool) and the writer
 *      under test (withAuthenticatedDb, authenticated) are necessarily two
 *      different connections/roles, not one rolled-back transaction spanning
 *      both, which is what the plan's draft assumed.
 *
 *   3. The plan's fourth case forces the manager-holder insert to fail with
 *      a 100,000-character managerName, reasoning that compound_holder.name
 *      would reject it. Checked against the real DDL (compound_core_tables
 *      migration) and against a live insert: name is bare `text`, no length
 *      constraint, and the 100,000-character value lands without error. This
 *      file uses the plan's own documented fallback instead — a null name
 *      against NOT NULL — and says so at the point it matters, per that same
 *      instruction.
 *
 * Isolation is resetCompoundTables in beforeEach, matching holders.db.test.ts
 * and commit-plan.db.test.ts, rather than transaction rollback — see point 2.
 */
import { closePool, withAuthenticatedDb } from "@/lib/compound/db/client";
import { getAccountById, getAccountByMt5, listAccountsForManager } from "@/lib/compound/db/compound";
import { listHolders } from "@/lib/compound/db/holders";
import { createAccount, type CreateAccountInput } from "@/lib/compound/db/write-account";
import {
  closeTestPool,
  expectPgError,
  resetCompoundTables,
  seedTwoAccounts,
  seedUser,
  sequenceConsumed,
  withTestClient,
} from "@/lib/compound/db/testing/harness";
import { LOCAL_SUPABASE_DB_URL } from "@/lib/compound/db/testing/env";

// withAuthenticatedDb (client.ts) reads COMPOUND_DATABASE_URL, not
// COMPOUND_TEST_DATABASE_URL, and throws if it is unset. Nothing sets it
// globally; client.db.test.ts is the precedent for doing this locally so
// this file does not depend on run order.
const ORIGINAL_DATABASE_URL = process.env.COMPOUND_DATABASE_URL;

const MANAGER = "aaaaaaaa-0000-4000-8000-0000000006a1";
const OTHER_MANAGER = "bbbbbbbb-0000-4000-8000-0000000006b1";

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

function input(over: Partial<CreateAccountInput> = {}): CreateAccountInput {
  return {
    mt5Account: 90_000_777,
    label: "Test account",
    broker: "Fictional Markets",
    currency: "USD",
    defaultSplitBps: 4000,
    inceptionDate: "2026-03-02",
    managerUserId: MANAGER,
    managerName: "J. Marsh",
    brokerOffsetHours: 3,
    ...over,
  };
}

describe("createAccount", () => {
  beforeEach(async () => {
    await withTestClient(async (c) => {
      await seedUser(c, MANAGER, "compound-writer-mgr@example.test");
      await seedUser(c, OTHER_MANAGER, "compound-writer-mgr-2@example.test");
    });
  });

  it("creates the account and its manager holder together", async () => {
    const { accountId, managerHolderId } = await withAuthenticatedDb(MANAGER, (c) =>
      createAccount(c, input()),
    );

    const account = await withAuthenticatedDb(MANAGER, (c) => getAccountById(c, accountId));
    expect(account!.mt5Account).toBe(90_000_777);
    expect(account!.brokerOffsetHours).toBe(3);

    const holders = await withAuthenticatedDb(MANAGER, (c) => listHolders(c, accountId));
    expect(holders).toHaveLength(1);
    expect(holders[0]!.id).toBe(managerHolderId);
    expect(holders[0]!.isManager).toBe(true);
    expect(holders[0]!.splitBps).toBe(0);
  });

  it("stores a null offset when none is given, rather than zero", async () => {
    const { accountId } = await withAuthenticatedDb(MANAGER, (c) =>
      createAccount(c, input({ mt5Account: 90_001_777, brokerOffsetHours: null })),
    );
    expect(
      (await withAuthenticatedDb(MANAGER, (c) => getAccountById(c, accountId)))!.brokerOffsetHours,
    ).toBeNull();
  });

  it("refuses the SAME manager a second account on an MT5 number they already registered, with CX101", async () => {
    await withAuthenticatedDb(MANAGER, (c) => createAccount(c, input()));
    await expectPgError(
      withAuthenticatedDb(MANAGER, (c) => createAccount(c, input({ label: "Second attempt" }))),
      "CX101",
      /already has a Compound account/,
    );
  });

  // Not the same case as above, and not interchangeable with it —
  // 20260822130000_compound_create_account_visible_duplicate_check.sql's own
  // header explains why: compound_create_account is SECURITY INVOKER, and
  // CX101's guard now runs as `authenticated`. Read by the SAME manager who
  // owns the existing row, compound_account_select's policy lets the guard
  // see it, and CX101 fires — that is the case immediately above. Read by a
  // DIFFERENT manager, the same unqualified `select … from compound_account`
  // would have found nothing before this migration's fix (RLS scoping the
  // guard to the caller's own rows), and CX101 would never have fired at
  // all — the INSERT would have reached compound_account_mt5_account_key's
  // raw UNIQUE constraint instead, a 23505 with no friendly message. This
  // case is what compound_mt5_account_taken exists to keep working: CX101
  // regardless of which manager is asking, because an MT5 account number is
  // one broker account and must resolve to at most one Compound account,
  // full stop.
  it("refuses a DIFFERENT manager the same MT5 number too, with the same CX101 — not the raw unique-constraint error", async () => {
    await withAuthenticatedDb(MANAGER, (c) => createAccount(c, input()));
    await expectPgError(
      withAuthenticatedDb(OTHER_MANAGER, (c) =>
        createAccount(c, input({ managerUserId: OTHER_MANAGER, managerName: "Other Marsh" })),
      ),
      "CX101",
      /already has a Compound account/,
    );
  });

  it("leaves no orphan account behind when the manager-holder insert fails", async () => {
    // See the module doc, point 3: `managerName: null` is cast through
    // `unknown` because CreateAccountInput's own type correctly disallows
    // it — no valid TypeScript caller can reach this path. Only a test that
    // wants to hit compound_holder.name's NOT NULL directly needs to.
    const before = await withAuthenticatedDb(MANAGER, (c) =>
      sequenceConsumed(c, "public.compound_account", "id"),
    );

    await expectPgError(
      withAuthenticatedDb(MANAGER, (c) =>
        createAccount(c, input({ mt5Account: 90_000_778, managerName: null as unknown as string })),
      ),
      "23502",
      /null value in column "name" of relation "compound_holder"/,
    );

    // The sequence advanced — the account INSERT genuinely executed and
    // reached RETURNING id — even though the row it produced is gone. This
    // is what tells a real rollback apart from a guard that fired before
    // either insert ran; a promise rejection alone cannot.
    const after = await withAuthenticatedDb(MANAGER, (c) =>
      sequenceConsumed(c, "public.compound_account", "id"),
    );
    expect(after).toBeGreaterThan(before);

    // Neither row survives, not "an error surfaced": the account itself —
    const account = await withAuthenticatedDb(MANAGER, (c) => getAccountByMt5(c, 90_000_778));
    expect(account).toBeNull();
    // — and, since compound_holder.account_id can only reference a row that
    // exists, no holder anywhere in the (freshly reset) table either.
    const holderCount = await withAuthenticatedDb(MANAGER, async (c) => {
      const { rows } = await c.query<{ n: string }>(`select count(*)::text as n from public.compound_holder`);
      return Number(rows[0]!.n);
    });
    expect(holderCount).toBe(0);
  });

  it("refuses a split outside 0..10000 before it reaches SQL", async () => {
    await expect(
      withAuthenticatedDb(MANAGER, (c) => createAccount(c, input({ defaultSplitBps: 10_001 }))),
    ).rejects.toThrow(/defaultSplitBps must be an integer/);
  });

  it("writes an audit row naming the actor", async () => {
    const { accountId } = await withAuthenticatedDb(MANAGER, (c) => createAccount(c, input()));
    const { rows } = await withAuthenticatedDb(MANAGER, (c) =>
      c.query<{ actor: string; action: string; entity_id: string }>(
        `select actor, action, entity_id from public.compound_audit
          where entity = 'compound_account' and entity_id = $1`,
        [accountId],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe(MANAGER);
    expect(rows[0]!.action).toBe("create_account");
  });
});

// ---------------------------------------------------------------------------
// Beyond the plan's own six cases. The dispatch for this task calls the
// account list "the first place that matters" for the ownership half of
// spec section 9's AND gate, and asks for a fixture that puts two managers
// in the same table, not one — plan 3's own seedTwoAccounts gives exactly
// that, and it is unused by the plan's Step 6 draft.
// ---------------------------------------------------------------------------

describe("createAccount + listAccountsForManager — ownership scoping", () => {
  it("shows a manager only the accounts they own, including one just created — never another manager's", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));

    const { accountId: newId } = await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
      createAccount(c, input({
        mt5Account: 90_000_779,
        label: "New for A",
        managerUserId: seed.accountA.managerUserId,
        managerName: "New Manager Holder",
      })),
    );

    const listA = await withAuthenticatedDb(seed.accountA.managerUserId, (c) =>
      listAccountsForManager(c, seed.accountA.managerUserId),
    );
    const listB = await withAuthenticatedDb(seed.accountB.managerUserId, (c) =>
      listAccountsForManager(c, seed.accountB.managerUserId),
    );

    // "These": A's list has both of A's accounts.
    expect(listA.map((a) => a.id)).toEqual([seed.accountA.accountId, newId]);
    expect(listA.map((a) => a.label)).toEqual(["Seed Account A", "New for A"]);
    expect(listA.every((a) => a.managerUserId === seed.accountA.managerUserId)).toBe(true);
    // "...and not those": B's seeded account appears nowhere in A's list.
    expect(listA.some((a) => a.id === seed.accountB.accountId)).toBe(false);

    // And the reverse direction: B sees only B, never A's freshly created account.
    expect(listB.map((a) => a.id)).toEqual([seed.accountB.accountId]);
    expect(listB.some((a) => a.id === newId)).toBe(false);
    expect(listB.some((a) => a.id === seed.accountA.accountId)).toBe(false);
  });
});

describe("createAccount + listAccountsForManager — order", () => {
  // account-list.tsx renders listAccountsForManager's rows in the order the
  // reader hands them back — it sorts nothing itself (see that file's
  // module doc). The reader orders `by id asc`. A fixture where every
  // account happens to be created in ascending-id order cannot tell "sorted
  // by id" apart from "no ORDER BY, and the rows came back in the order
  // they were written" — on a freshly reset table the two look identical.
  //
  // This fixture breaks that coincidence on purpose: it reserves two id
  // values from the account table's own sequence and, in a SINGLE insert
  // statement, writes the row with the HIGHER id first and the row with the
  // LOWER id second. Checked against a real run of this exact fixture
  // before relying on it: with `order by id asc` in place the query
  // returns [low, high]; with the clause removed it returns [high, low] —
  // Postgres's bitmap-heap-scan plan for this filter visits matching rows
  // in the order they were written, not id order, once there is nothing
  // telling it to sort. `order by id asc` therefore has to do real work to
  // pass this test.
  it("lists a manager's own accounts in ascending id order, not the order rows happen to be stored physically", async () => {
    await withTestClient((c) => seedUser(c, MANAGER, "compound-writer-mgr@example.test"));

    const [low, high] = await withTestClient(async (c) => {
      const { rows: seqRows } = await c.query<{ seq: string }>(
        `select pg_get_serial_sequence('public.compound_account', 'id') as seq`,
      );
      const seqName = seqRows[0]!.seq!;
      const a = await c.query<{ n: string }>(`select nextval('${seqName}') as n`);
      const b = await c.query<{ n: string }>(`select nextval('${seqName}') as n`);
      return [Number(a.rows[0]!.n), Number(b.rows[0]!.n)];
    });

    await withTestClient((c) =>
      c.query(
        `insert into public.compound_account
           (id, mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
         values ($1, 90000780, 'Zeta, physically first',  'USD', 4000, '2026-01-01', $3),
                ($2, 90000781, 'Alpha, physically second', 'USD', 4000, '2026-01-02', $3)`,
        [high, low, MANAGER],
      ),
    );

    const rows = await withAuthenticatedDb(MANAGER, (c) => listAccountsForManager(c, MANAGER));
    expect(rows.map((a) => a.id)).toEqual([low, high]);
    expect(rows.map((a) => a.label)).toEqual(["Alpha, physically second", "Zeta, physically first"]);
  });
});
