import { randomUUID } from "node:crypto";
import {
  asRole,
  closeTestPool,
  expectPgError,
  resetCompoundTables,
  seedLedger,
  seedTwoAccounts,
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
    const result = await withTestClient(async (c) => {
      await c.query("delete from public.users where id = $1", [uid2]);
      await c.query("delete from auth.users where id = $1", [uid2]);
      await seedUser(c, uid2, "harness-seed-2@example.test", "user");
      const { rows } = await c.query<{ role: string; rawRole: string | null }>(
        `select u.role,
                (a.raw_user_meta_data ->> 'role') as "rawRole"
           from public.users u
           join auth.users a on a.id = u.id
          where u.id = $1`,
        [uid2],
      );
      return rows[0];
    });
    // The projected public.users.role alone is not enough here: the trigger's
    // own coalesce fallback is 'user', so a seedUser that wrote the role to
    // the wrong jsonb column would still land role = 'user' by coincidence —
    // verified by running this test against exactly that mutation. Asserting
    // raw_user_meta_data directly checks the column seedUser actually wrote,
    // which the coincidence cannot paper over.
    expect(result).toEqual({ role: "user", rawRole: "user" });
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

// The two describe blocks below are the only ones in this file that touch
// the real compound_* tables rather than a disposable scratch table or the
// standing public.users/auth.users rows, so unlike their siblings above they
// reset those six tables between tests — the same call every *.db.test.ts
// file in this directory already makes in its own beforeEach.
describe("seedTwoAccounts gives two accounts that differ in a way a test can see", () => {
  beforeEach(async () => {
    await withTestClient((c) => resetCompoundTables(c));
  });

  it("returns two accounts under two distinct managers", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    expect(seed.accountA.accountId).not.toBe(seed.accountB.accountId);
    expect(seed.accountA.managerUserId).not.toBe(seed.accountB.managerUserId);
  });

  it("gives the two accounts different holder counts — the visible difference this helper promises", async () => {
    // Not "different apart from id": a policy or a query that quietly leaked
    // rows across accounts would still look correct against two accounts
    // shaped identically, since there would be nothing about the leaked rows
    // to tell them apart from the real ones. Different holder counts is what
    // makes a leak visible in the shape of a result, not only in an id.
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    expect(seed.accountA.holderIds.length).toBe(2);
    expect(seed.accountB.holderIds.length).toBe(1);
    expect(seed.accountA.holderIds.length).not.toBe(seed.accountB.holderIds.length);
  });

  it("really did insert every account and holder it claims to have, not just return ids", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const counts = await withTestClient(async (c) => {
      const accounts = await c.query<{ n: string }>(
        "select count(*)::text as n from public.compound_account",
      );
      const holders = await c.query<{ account_id: string; n: string }>(
        `select account_id::text, count(*)::text as n
           from public.compound_holder
          group by account_id
          order by account_id`,
      );
      return { accounts: Number(accounts.rows[0]!.n), holders: holders.rows };
    });
    expect(counts.accounts).toBe(2);
    expect(counts.holders).toEqual(
      [
        { account_id: String(seed.accountA.accountId), n: "2" },
        { account_id: String(seed.accountB.accountId), n: "1" },
      ].sort((a, b) => a.account_id.localeCompare(b.account_id)),
    );
  });

  it("each manager_user_id resolves to a real public.users row, not a dangling uuid", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const found = await withTestClient(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `select id from public.users where id = any($1::uuid[]) order by id`,
        [[seed.accountA.managerUserId, seed.accountB.managerUserId]],
      );
      return rows.map((r) => r.id);
    });
    expect(found).toEqual([seed.accountA.managerUserId, seed.accountB.managerUserId].sort());
  });
});

describe("seedLedger appends entries with caller-controlled, contiguous seq", () => {
  beforeEach(async () => {
    await withTestClient((c) => resetCompoundTables(c));
  });

  it("inserts entries in order, returns their ids in that order, and the seq a caller chose survives", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const ids = await withTestClient((c) =>
      seedLedger(c, seed.accountA.accountId, [
        { seq: 1, occurredOn: "2026-05-01", type: "equity_reading", amountCents: 500000n },
        {
          seq: 2,
          occurredOn: "2026-05-02",
          type: "deposit",
          amountCents: 100000n,
          holderId: seed.accountA.holderIds[0]!,
        },
        { seq: 3, occurredOn: "2026-05-03", type: "equity_reading", amountCents: 600000n },
      ]),
    );
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);

    const rows = await withTestClient(async (c) => {
      // seq is bigint in Postgres, same as amount_cents — node-pg returns it
      // as a string for the same reason (see "bigint never becomes a float"
      // above), so the expectation below compares strings, not numbers.
      const { rows } = await c.query<{ seq: string; amount_cents: string }>(
        `select seq, amount_cents from public.compound_ledger_entry
          where account_id = $1 order by seq`,
        [seed.accountA.accountId],
      );
      return rows;
    });
    expect(rows.map((r) => r.seq)).toEqual(["1", "2", "3"]);
    expect(rows.map((r) => r.amount_cents)).toEqual(["500000", "100000", "600000"]);
  });

  it("a reversing entry can point at an id this same call already returned", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const holderId = seed.accountA.holderIds[0]!;
    const [firstId] = await withTestClient((c) =>
      seedLedger(c, seed.accountA.accountId, [
        {
          seq: 1,
          occurredOn: "2026-05-01",
          type: "payout",
          amountCents: 25000n,
          holderId,
          feeSettlement: "units",
          splitBpsApplied: 4000,
        },
      ]),
    );
    const [reversalId] = await withTestClient((c) =>
      seedLedger(c, seed.accountA.accountId, [
        {
          seq: 2,
          occurredOn: "2026-05-02",
          type: "payout",
          amountCents: 25000n,
          holderId,
          feeSettlement: "units",
          splitBpsApplied: 4000,
          reversesId: firstId,
          note: "reversal",
        },
      ]),
    );
    const reverses = await withTestClient(async (c) => {
      const { rows } = await c.query<{ reverses_id: string }>(
        `select reverses_id from public.compound_ledger_entry where id = $1`,
        [reversalId],
      );
      return Number(rows[0]!.reverses_id);
    });
    expect(reverses).toBe(firstId);
  });

  it("keeps a cent value above 2^53 exact on the way through seedLedger, not just direct SQL", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    const [id] = await withTestClient((c) =>
      seedLedger(c, seed.accountB.accountId, [
        {
          seq: 1,
          occurredOn: "2026-05-01",
          type: "equity_reading",
          amountCents: 9007199254740993n,
        },
      ]),
    );
    const back = await withTestClient(async (c) => {
      const { rows } = await c.query<{ amount_cents: string }>(
        `select amount_cents from public.compound_ledger_entry where id = $1`,
        [id],
      );
      return rows[0]!.amount_cents;
    });
    expect(typeof back).toBe("string");
    expect(BigInt(back)).toBe(9007199254740993n);
  });

  it("adds no protection of its own — a duplicate seq within an account is still refused by the schema", async () => {
    const seed = await withTestClient((c) => seedTwoAccounts(c));
    await withTestClient((c) =>
      seedLedger(c, seed.accountA.accountId, [
        { seq: 1, occurredOn: "2026-05-01", type: "equity_reading", amountCents: 1n },
      ]),
    );
    await withTestClient((c) =>
      expectPgError(
        seedLedger(c, seed.accountA.accountId, [
          { seq: 1, occurredOn: "2026-05-02", type: "equity_reading", amountCents: 2n },
        ]),
        "23505",
        /compound_ledger_entry_account_seq_key/,
      ),
    );
  });
});
