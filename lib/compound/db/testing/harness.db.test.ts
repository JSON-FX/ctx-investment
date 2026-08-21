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
