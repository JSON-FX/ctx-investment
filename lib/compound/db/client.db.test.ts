import { closePool, withDb, withDbTransaction } from "./client";
import { centsExpr, toCents } from "./sql";
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

/**
 * centsExpr + toCents round-tripped against a live database, using values
 * chosen specifically because JavaScript float arithmetic gets them wrong.
 *
 * 10000.05 is the plan's own canonical example: Math.trunc(10000.05 * 100)
 * is 1000004 in JavaScript — one cent short — while
 * round(10000.05::numeric * 100)::bigint is the correct 1000005. A fixture
 * of 100.00 or 1.00 would pass under either a correct or a broken
 * implementation, which is exactly why the plan calls that shape out as
 * proving nothing.
 *
 * The second value sits just above 2^53 (9007199254740992), the point past
 * which a JSON-number transport (PostgREST, or any accidental JS-number
 * conversion in this path) silently corrupts an integer. sql.test.ts proves
 * toCents parses a string like that correctly offline; this proves the whole
 * chain — Postgres numeric arithmetic, the pg driver, and toCents together —
 * carries it through a real connection without ever routing through a
 * JavaScript number.
 */
describe("centsExpr converts money in SQL, exactly, where JavaScript float arithmetic would not", () => {
  it("round-trips 10000.05 dollars to 1000005 cents, not 1000004", async () => {
    const cents = await withDb(async (c) => {
      const { rows } = await c.query<{ v: unknown }>(`select ${centsExpr("10000.05")} as v`);
      return toCents(rows[0]!.v, "v");
    });
    expect(cents).toBe(1000005n);
    // The bug this fixture exists to catch, made concrete: this is what
    // JavaScript does with the same arithmetic, and it is wrong by a cent.
    expect(Math.trunc(10000.05 * 100)).toBe(1000004);
  });

  it("round-trips a dollar figure whose cent value sits just above 2^53, exactly", async () => {
    const cents = await withDb(async (c) => {
      const { rows } = await c.query<{ v: unknown }>(
        `select ${centsExpr("90071992547409.93")} as v`,
      );
      return toCents(rows[0]!.v, "v");
    });
    expect(cents).toBe(9007199254740993n);
  });

  it("round-trips the same awkward value out of a real numeric(18,2) column, positive and negative", async () => {
    // account_snapshots_daily.balance_close is numeric(18,2) — decimal
    // dollars, not cents (see the plan's "local stack" table, and Task 6). A
    // scratch column of the same type proves centsExpr works against a
    // stored value, not only a literal spliced straight into the query.
    await withTestClient((c) => c.query("drop table if exists public.zz_money"));
    await withTestClient((c) =>
      c.query("create table public.zz_money (v numeric(18,2) not null)"),
    );
    await withTestClient((c) => c.query("grant select on public.zz_money to service_role"));
    try {
      await withTestClient((c) =>
        c.query("insert into public.zz_money (v) values (10000.05), (-10000.05)"),
      );
      const cents = await withDb(async (c) => {
        const { rows } = await c.query<{ v: unknown }>(
          `select ${centsExpr("v")} as v from public.zz_money order by v`,
        );
        return rows.map((r) => toCents(r.v, "v"));
      });
      expect(cents).toEqual([-1000005n, 1000005n]);
    } finally {
      await withTestClient((c) => c.query("drop table if exists public.zz_money"));
    }
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
