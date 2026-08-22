/**
 * The probe the report for this task calls "the one that matters": seed two
 * accounts under two different managers, read as one of them, and prove the
 * other's account, holders and ledger are invisible — THROUGH THE APP'S OWN
 * DATA LAYER, not through a hand-written query the way rls.db.test.ts (which
 * this file does not duplicate) proves the policies themselves are correct.
 *
 * "The app's own data layer" means exactly this: db/client.ts's
 * withAuthenticatedDb (the same helper requireAccount, requireManager and
 * every loader in load/ledger.ts actually call), wrapping the same reader
 * functions from db/compound.ts and db/holders.ts those loaders call —
 * getAccountById, getLedgerEntries, getHolderSeeds, listHolders — not
 * `select * from compound_account` typed into this file. requireAccount and
 * requireManager themselves cannot run in Jest at all (see gate.db.test.ts's
 * module doc: they need next/headers and a live Supabase Auth session), so
 * this file goes as far as a Jest process can: everything below
 * requireAccount, on the real connection helper, is exercised exactly the
 * way it runs in production.
 *
 * Two describe blocks:
 *
 *   "with the ownership check in place"    mirrors what resolveOwnedAccount
 *                                           actually does today — RLS AND an
 *                                           application-level ownership
 *                                           comparison, both in place.
 *
 *   "with the ownership check deleted"     calls getAccountById and the other
 *                                           readers DIRECTLY, with no
 *                                           managerUserId comparison anywhere
 *                                           in this file's own code — the
 *                                           thought experiment the task asked
 *                                           for, made real: if requireAccount's
 *                                           `if (account.managerUserId !==
 *                                           managerUserId) return null` line
 *                                           were deleted outright, would
 *                                           anything still stop this read?
 *                                           What is left, if this block still
 *                                           passes, is RLS alone.
 */
import { closePool, withAuthenticatedDb } from "@/lib/compound/db/client";
import { getAccountById, getHolderSeeds, getLedgerEntries, listAccountsForManager } from "@/lib/compound/db/compound";
import { listHolders } from "@/lib/compound/db/holders";
import {
  closeTestPool,
  resetCompoundTables,
  seedLedger,
  seedTwoAccounts,
  withTestClient,
} from "@/lib/compound/db/testing/harness";
import { LOCAL_SUPABASE_DB_URL } from "@/lib/compound/db/testing/env";
import { resolveOwnedAccount } from "./account";

const ORIGINAL_DATABASE_URL = process.env.COMPOUND_DATABASE_URL;

beforeAll(() => {
  process.env.COMPOUND_DATABASE_URL =
    process.env.COMPOUND_TEST_DATABASE_URL || LOCAL_SUPABASE_DB_URL;
});

afterAll(async () => {
  await closePool();
  await closeTestPool();
  process.env.COMPOUND_DATABASE_URL = ORIGINAL_DATABASE_URL;
});

interface Fixture {
  accountAId: number;
  accountBId: number;
  managerA: string;
  managerB: string;
}

async function seed(): Promise<Fixture> {
  await withTestClient((c) => resetCompoundTables(c));
  const { accountA, accountB } = await withTestClient((c) => seedTwoAccounts(c));
  // 56 is the exact count the dispatching session verified by hand before
  // writing this task's brief ("1 account, 56 ledger entries") — not
  // reproduced here (a fixture this size buys nothing an assertion on one
  // or two rows does not), but a non-empty, multi-row ledger is what makes
  // "the ledger is invisible" a claim about real rows rather than an
  // already-empty table.
  await withTestClient((c) =>
    seedLedger(c, accountA.accountId, [
      { seq: 1, occurredOn: "2026-05-02", type: "equity_reading", amountCents: 1_000_000n },
      { seq: 2, occurredOn: "2026-05-10", type: "deposit", amountCents: 250_000n, holderId: accountA.holderIds[1] },
      { seq: 3, occurredOn: "2026-06-01", type: "equity_reading", amountCents: 1_250_000n },
    ]),
  );
  await withTestClient((c) =>
    seedLedger(c, accountB.accountId, [
      { seq: 1, occurredOn: "2026-05-02", type: "equity_reading", amountCents: 2_000_000n },
    ]),
  );
  return {
    accountAId: accountA.accountId,
    accountBId: accountB.accountId,
    managerA: accountA.managerUserId,
    managerB: accountB.managerUserId,
  };
}

describe("cross-manager isolation through the app's data layer — with the ownership check in place", () => {
  it("Bob's own connection sees his account, his holder and his ledger", async () => {
    const f = await seed();
    const account = await withAuthenticatedDb(f.managerB, (c) =>
      resolveOwnedAccount(c, f.managerB, String(f.accountBId)),
    );
    expect(account?.id).toBe(f.accountBId);

    const entries = await withAuthenticatedDb(f.managerB, (c) => getLedgerEntries(c, f.accountBId));
    expect(entries).toHaveLength(1);

    const holders = await withAuthenticatedDb(f.managerB, (c) => listHolders(c, f.accountBId));
    expect(holders).toHaveLength(1);
  });

  it("Bob's connection cannot resolve Alice's account by id, even though it exists", async () => {
    const f = await seed();
    // It really exists — read as Alice, so this line proves nothing about
    // the isolation being tested and everything about the fixture being
    // real.
    const asAlice = await withAuthenticatedDb(f.managerA, (c) => getAccountById(c, f.accountAId));
    expect(asAlice?.id).toBe(f.accountAId);

    const asBob = await withAuthenticatedDb(f.managerB, (c) =>
      resolveOwnedAccount(c, f.managerB, String(f.accountAId)),
    );
    expect(asBob).toBeNull();
  });

  it("Bob's connection cannot list Alice's account among his own", async () => {
    const f = await seed();
    const bobsAccounts = await withAuthenticatedDb(f.managerB, (c) =>
      listAccountsForManager(c, f.managerB),
    );
    expect(bobsAccounts.map((a) => a.id)).toEqual([f.accountBId]);
    expect(bobsAccounts.map((a) => a.id)).not.toContain(f.accountAId);
  });

  it("Bob's connection reads an empty ledger for Alice's account, not an error and not her rows", async () => {
    const f = await seed();
    const entries = await withAuthenticatedDb(f.managerB, (c) => getLedgerEntries(c, f.accountAId));
    expect(entries).toEqual([]);
  });

  it("Bob's connection reads no holders on Alice's account", async () => {
    const f = await seed();
    const holders = await withAuthenticatedDb(f.managerB, (c) => listHolders(c, f.accountAId));
    expect(holders).toEqual([]);
  });

  it("Bob's connection reads no holder seeds on Alice's account (the shape fold() consumes)", async () => {
    const f = await seed();
    const seeds = await withAuthenticatedDb(f.managerB, (c) => getHolderSeeds(c, f.accountAId));
    expect(seeds).toEqual([]);
  });

  it("the reverse holds too: Alice cannot see Bob's account, holders or ledger", async () => {
    const f = await seed();
    expect(
      await withAuthenticatedDb(f.managerA, (c) =>
        resolveOwnedAccount(c, f.managerA, String(f.accountBId)),
      ),
    ).toBeNull();
    expect(await withAuthenticatedDb(f.managerA, (c) => getLedgerEntries(c, f.accountBId))).toEqual(
      [],
    );
    expect(await withAuthenticatedDb(f.managerA, (c) => listHolders(c, f.accountBId))).toEqual([]);
  });
});

describe("cross-manager isolation with the ownership check DELETED — RLS alone", () => {
  // No line in this describe block compares managerUserId to anything. If
  // any test here failed, the only thing that could have stopped it is a
  // policy in compound_rls.sql evaluating against the claims
  // withAuthenticatedDb set — there is no requireAccount, no
  // resolveOwnedAccount, no `if (owner !== caller)` anywhere in this block to
  // fall back on.
  it("getAccountById refuses Alice's account to a connection opened as Bob", async () => {
    const f = await seed();
    const row = await withAuthenticatedDb(f.managerB, (c) => getAccountById(c, f.accountAId));
    expect(row).toBeNull();
  });

  it("getLedgerEntries refuses Alice's ledger to a connection opened as Bob", async () => {
    const f = await seed();
    const rows = await withAuthenticatedDb(f.managerB, (c) => getLedgerEntries(c, f.accountAId));
    expect(rows).toEqual([]);
  });

  it("getHolderSeeds refuses Alice's holders to a connection opened as Bob", async () => {
    const f = await seed();
    const rows = await withAuthenticatedDb(f.managerB, (c) => getHolderSeeds(c, f.accountAId));
    expect(rows).toEqual([]);
  });

  it("listHolders refuses Alice's holders to a connection opened as Bob", async () => {
    const f = await seed();
    const rows = await withAuthenticatedDb(f.managerB, (c) => listHolders(c, f.accountAId));
    expect(rows).toEqual([]);
  });

  it("listAccountsForManager, asked for Alice's id while connected as Bob, still returns nothing", async () => {
    // The sharpest version of this probe: the SQL parameter itself asks for
    // Alice's rows (managerUserId = f.managerA), and the connection is
    // Bob's. If RLS is doing nothing, this returns Alice's account, because
    // the WHERE clause asked for exactly that and service_role/postgres
    // would happily comply. Under authenticated with Bob's claims, the
    // policy's own `manager_user_id = auth.uid()` ANDs against the WHERE
    // clause, and auth.uid() is Bob — so this returns nothing regardless of
    // what the query text asked for.
    const f = await seed();
    const rows = await withAuthenticatedDb(f.managerB, (c) => listAccountsForManager(c, f.managerA));
    expect(rows).toEqual([]);
  });

  it("still shows Bob his own account, holder and ledger — this is isolation, not a blanket outage", async () => {
    const f = await seed();
    const account = await withAuthenticatedDb(f.managerB, (c) => getAccountById(c, f.accountBId));
    expect(account?.id).toBe(f.accountBId);
    const entries = await withAuthenticatedDb(f.managerB, (c) => getLedgerEntries(c, f.accountBId));
    expect(entries).toHaveLength(1);
  });
});
