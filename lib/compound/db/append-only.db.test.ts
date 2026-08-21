/**
 * The ledger refuses to be rewritten — by anyone, including its owner.
 *
 * Note which vantage points these run from and why. As anon, authenticated
 * and service_role, the GRANT is the first thing that refuses — anon holds
 * none at all; authenticated and service_role hold only SELECT and INSERT.
 * As postgres, the grant is irrelevant (owners hold implicit privileges) and
 * only the TRIGGER refuses. Testing all four is what turns "the app cannot"
 * into "nobody can".
 *
 * Three facts, verified directly against the running stack before this file
 * was written, that this suite exists to encode rather than assume:
 *
 * 1. RLS does not apply to TRUNCATE at all. Every `as authenticated` test
 *    below that uses TRUNCATE runs as MANAGER — the account's own manager,
 *    who RLS's `using` clause would grant full SELECT/INSERT access to on
 *    this very row set. TRUNCATE is refused anyway, and never by a policy:
 *    Postgres does not evaluate row-security for TRUNCATE, full stop. See
 *    "RLS has no opinion on TRUNCATE" below for the structural half of this.
 *
 * 2. A plain `TRUNCATE` (no CASCADE) on this table happens to be refused
 *    for a second, unrelated reason: `compound_capital_event_candidate.
 *    resolved_ledger_entry_id` still references it, and Postgres refuses to
 *    truncate a table something else points at unless CASCADE is given.
 *    That is an accident of schema shape, not a defence — `TRUNCATE ...
 *    CASCADE` walks straight around it and, before this task, succeeded
 *    outright for both `authenticated` and `anon`. Every TRUNCATE-refusal
 *    test below is paired: one for the plain form (documenting what it
 *    actually refuses for, which for `postgres` is the accidental FK check,
 *    SQLSTATE 0A000, not the trigger), and one for CASCADE (which only the
 *    real defence — grant or trigger — can stop).
 *
 * 3. The grants this suite narrows away did not come from this project's own
 *    migrations. `anon`, `authenticated` and `service_role` all held
 *    REFERENCES, TRIGGER and TRUNCATE on this table (and, less visibly,
 *    MAINTAIN — see the structural block) from `pg_default_acl`, a
 *    database-wide default that regrants the same thing on any table
 *    `postgres` creates in `public` from here on, unless the default itself
 *    is changed. `compound_truncate_hardening` does both: narrows today's
 *    six tables and narrows the default for tomorrow's.
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

const ANON_DENIED = /permission denied for table compound_ledger_entry/;

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

describe("as anon — no claim, no grant at all", () => {
  it("refuses SELECT", async () => {
    await withTestClient((c) =>
      asRole(c, "anon", {}, () =>
        expectPgError(
          c.query("select 1 from public.compound_ledger_entry"),
          "42501",
          ANON_DENIED,
        ),
      ),
    );
  });

  it("refuses INSERT", async () => {
    await withTestClient((c) =>
      asRole(c, "anon", {}, () =>
        expectPgError(
          c.query(
            `insert into public.compound_ledger_entry
               (account_id, seq, occurred_on, type, amount_cents)
             values ($1, 3, '2026-05-04', 'equity_reading', 1)`,
            [accountId],
          ),
          "42501",
          ANON_DENIED,
        ),
      ),
    );
  });

  it("refuses UPDATE", async () => {
    await withTestClient((c) =>
      asRole(c, "anon", {}, () =>
        expectPgError(
          c.query("update public.compound_ledger_entry set amount_cents = 1"),
          "42501",
          ANON_DENIED,
        ),
      ),
    );
    expect(await ledgerAmounts()).toEqual(["1000005", "1000029"]);
  });

  it("refuses DELETE", async () => {
    await withTestClient((c) =>
      asRole(c, "anon", {}, () =>
        expectPgError(c.query("delete from public.compound_ledger_entry"), "42501", ANON_DENIED),
      ),
    );
    expect(await ledgerAmounts()).toEqual(["1000005", "1000029"]);
  });

  it("refuses plain TRUNCATE", async () => {
    await withTestClient((c) =>
      asRole(c, "anon", {}, () =>
        expectPgError(
          c.query("truncate public.compound_ledger_entry"),
          "42501",
          ANON_DENIED,
        ),
      ),
    );
    expect(await ledgerAmounts()).toEqual(["1000005", "1000029"]);
  });

  it("refuses TRUNCATE CASCADE — this is what succeeded outright before this task", async () => {
    await withTestClient((c) =>
      asRole(c, "anon", {}, () =>
        expectPgError(
          c.query("truncate public.compound_ledger_entry cascade"),
          "42501",
          ANON_DENIED,
        ),
      ),
    );
    expect(await ledgerAmounts()).toEqual(["1000005", "1000029"]);
  });
});

describe("as authenticated — running as MANAGER, the account's own owner under RLS", () => {
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

  it("refuses plain TRUNCATE — by grant now, not by the FK accident", async () => {
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

  it("refuses TRUNCATE CASCADE — this is what succeeded outright before this task, for the account's own manager", async () => {
    await withTestClient((c) =>
      asRole(c, "authenticated", { userId: MANAGER }, () =>
        expectPgError(
          c.query("truncate public.compound_ledger_entry cascade"),
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

  it("refuses plain TRUNCATE", async () => {
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

  it("refuses TRUNCATE CASCADE — this is what succeeded outright before this task", async () => {
    await withTestClient((c) =>
      asRole(c, "service_role", {}, () =>
        expectPgError(
          c.query("truncate public.compound_ledger_entry cascade"),
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

  it("refuses an UPDATE that matches no rows, so the guard is not row-count dependent", async () => {
    // This is the reason the triggers are FOR EACH STATEMENT and not FOR EACH
    // ROW. A FOR EACH ROW trigger fires once per row the statement actually
    // touches — with a WHERE clause matching none of the two seeded rows, it
    // would fire zero times and this UPDATE would silently succeed with
    // rowCount 0, never reaching the guard. Verified directly against a
    // FOR EACH ROW version of this trigger before writing this test: it does
    // exactly that. FOR EACH STATEMENT fires once before any row is scanned,
    // regardless of how many would have matched, including zero.
    await withTestClient((c) =>
      expectPgError(
        c.query("update public.compound_ledger_entry set amount_cents = 1 where seq = 9999"),
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

  it("refuses a DELETE that matches no rows, for the same reason", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query("delete from public.compound_ledger_entry where seq = 9999"),
        "CX010",
        /append-only: DELETE refused/,
      ),
    );
    expect(await ledgerAmounts()).toEqual(["1000005", "1000029"]);
  });

  it("refuses a plain TRUNCATE — but only by accident, a foreign key, not the trigger", async () => {
    // compound_capital_event_candidate.resolved_ledger_entry_id references
    // this table, and a plain TRUNCATE refuses to leave a dangling reference
    // unless CASCADE says otherwise. Postgres raises this BEFORE any BEFORE
    // TRUNCATE trigger gets a chance to fire — verified directly: the owner's
    // own trigger (CX010) never runs for this exact statement. If that FK
    // were ever dropped, this specific refusal would vanish with it. The next
    // test is the one that does not depend on that FK existing.
    await withTestClient((c) =>
      expectPgError(
        c.query("truncate public.compound_ledger_entry"),
        "0A000",
        /cannot truncate a table referenced in a foreign key constraint/,
      ),
    );
    expect(await ledgerAmounts()).toEqual(["1000005", "1000029"]);
  });

  it("refuses TRUNCATE CASCADE — this is the real guard, the FK accident cannot stop this one", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query("truncate public.compound_ledger_entry cascade"),
        "CX010",
        /append-only: TRUNCATE refused/,
      ),
    );
    expect(await ledgerAmounts()).toEqual(["1000005", "1000029"]);
  });
});

describe("RLS has no opinion on any of this", () => {
  /**
   * Every TRUNCATE test in the `authenticated` block above already ran as
   * MANAGER — the account's own manager, the one identity RLS's `using`
   * clause on this table is written to let all the way in for SELECT and
   * INSERT. TRUNCATE was refused anyway, every time, and never by a policy.
   * This test makes that explicit rather than leaving it implicit in a role
   * name: RLS is switched on for this table, and TRUNCATE is refused for a
   * reason that has nothing to do with any policy on it.
   */
  it("compound_ledger_entry has row level security enabled, and TRUNCATE is refused for reasons no policy states", async () => {
    const rls = await withTestClient(async (c) => {
      const { rows } = await c.query<{ relrowsecurity: boolean; policy_count: string }>(
        `select c.relrowsecurity,
                (select count(*)::text from pg_policies
                  where schemaname = 'public' and tablename = 'compound_ledger_entry') as policy_count
           from pg_class c
          where c.oid = 'public.compound_ledger_entry'::regclass`,
      );
      return rows[0]!;
    });
    expect(rls.relrowsecurity).toBe(true);
    // select + insert only, per compound_rls — neither one is a TRUNCATE
    // policy, because there is no such thing: CREATE POLICY has no TRUNCATE
    // command to attach to. This count is what "no policy governs TRUNCATE"
    // looks like structurally, not just asserted in a comment.
    expect(Number(rls.policy_count)).toBe(2);

    await withTestClient((c) =>
      asRole(c, "authenticated", { userId: MANAGER }, () =>
        expectPgError(
          c.query("truncate public.compound_ledger_entry cascade"),
          "42501",
          /permission denied for table compound_ledger_entry/,
        ),
      ),
    );
  });
});

describe("the trigger, not the grant, is what holds locally", () => {
  /**
   * This is the important one. It simulates a project whose default
   * privileges DO hand UPDATE, DELETE and TRUNCATE to service_role/
   * authenticated — which is exactly what this stack's default ACL did, for
   * every one of the six compound_* tables, before this task — by granting
   * them all back explicitly, and shows the ledger is still not writable.
   *
   * Without it, every "refuses UPDATE/DELETE/TRUNCATE" test above would pass
   * with the revoke deleted AND with the triggers deleted, purely because the
   * revoke was standing in the way. Those tests prove the grant set; this one
   * proves the guarantee — the part that survives even if a future default
   * ACL, or a careless `grant all`, hands every privilege back.
   */
  it("refuses UPDATE and DELETE as service_role even when granted back", async () => {
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

  it("refuses TRUNCATE CASCADE as authenticated even when TRUNCATE is granted back everywhere CASCADE would reach", async () => {
    // Granting TRUNCATE on only compound_ledger_entry is not enough to
    // reproduce the pre-fix hole here: CASCADE also needs TRUNCATE on
    // compound_capital_event_candidate (the table the FK pulls in), and
    // compound_truncate_hardening revoked that one too. Grant both back, so
    // this test is not accidentally proving a DIFFERENT table's grant — it
    // has to reach compound_ledger_entry's own trigger to be refused at all.
    await withTestClient((c) =>
      c.query(
        `grant truncate on public.compound_ledger_entry,
                              public.compound_capital_event_candidate
           to authenticated`,
      ),
    );
    try {
      await withTestClient((c) =>
        asRole(c, "authenticated", { userId: MANAGER }, () =>
          expectPgError(
            c.query("truncate public.compound_ledger_entry cascade"),
            "CX010",
            /append-only: TRUNCATE refused/,
          ),
        ),
      );
      expect(await ledgerAmounts()).toEqual(["1000005", "1000029"]);
    } finally {
      await withTestClient((c) =>
        c.query(
          `revoke truncate on public.compound_ledger_entry,
                                public.compound_capital_event_candidate
             from authenticated`,
        ),
      );
    }
  });
});

describe("the guarantee is structurally in place", () => {
  it("has all three triggers, each BEFORE and FOR EACH STATEMENT", async () => {
    // pg_trigger, not information_schema.triggers: the standard view has no
    // concept of a TRUNCATE trigger at all (TRUNCATE triggers are a
    // PostgreSQL extension) and silently omits it — checked directly, this
    // table's three triggers show up as two rows there. pg_get_triggerdef
    // reconstructs the exact CREATE TRIGGER text, which is what lets one
    // query check the timing and the per-row/per-statement choice as well as
    // which events exist, instead of decoding tgtype by hand.
    const triggers = await withTestClient(async (c) => {
      const { rows } = await c.query<{ tgname: string; def: string }>(
        `select tgname, pg_get_triggerdef(oid) as def
           from pg_trigger
          where tgrelid = 'public.compound_ledger_entry'::regclass
            and not tgisinternal
          order by tgname`,
      );
      return rows;
    });
    expect(triggers.map((t) => t.tgname)).toEqual([
      "compound_ledger_entry_no_delete",
      "compound_ledger_entry_no_truncate",
      "compound_ledger_entry_no_update",
    ]);
    for (const t of triggers) {
      expect(t.def).toContain("BEFORE");
      expect(t.def).toContain("FOR EACH STATEMENT");
    }
    expect(triggers.find((t) => t.tgname.endsWith("no_update"))?.def).toContain("UPDATE");
    expect(triggers.find((t) => t.tgname.endsWith("no_delete"))?.def).toContain("DELETE");
    expect(triggers.find((t) => t.tgname.endsWith("no_truncate"))?.def).toContain("TRUNCATE");
  });

  it("grants exactly SELECT and INSERT, to exactly two roles — checked against the raw ACL, not just information_schema", async () => {
    // information_schema.role_table_grants has its own blind spot, the mirror
    // image of the trigger one above: it does not surface MAINTAIN
    // (PostgreSQL 17) at all, on any table, checked directly against its
    // view definition. A privilege that default-ACL still hands out would
    // pass a test written only against this view. Assert both: the readable
    // view, for the four rows a human expects, and has_table_privilege,
    // which cannot have the same blind spot because it asks Postgres
    // directly rather than reconstructing an SQL-standard list.
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

    const leaks = await withTestClient(async (c) => {
      const { rows } = await c.query<{ role: string; priv: string; has: boolean }>(
        `select role, priv, has_table_privilege(role, 'public.compound_ledger_entry', priv) as has
           from (values ('anon'), ('authenticated'), ('service_role')) as r(role),
                (values ('TRUNCATE'), ('MAINTAIN'), ('REFERENCES'), ('TRIGGER'),
                        ('UPDATE'), ('DELETE')) as p(priv)
          order by role, priv`,
      );
      return rows.filter((r) => r.has).map((r) => `${r.role}:${r.priv}`);
    });
    expect(leaks).toEqual([]);

    // anon holds nothing on this table at all, not even under a privilege
    // information_schema would show — the strongest single statement of
    // "no access", checked the same way.
    const anonAny = await withTestClient(async (c) => {
      const { rows } = await c.query<{ has: boolean }>(
        `select has_table_privilege('anon', 'public.compound_ledger_entry', priv) as has
           from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE',
                              'REFERENCES','TRIGGER','MAINTAIN']) as priv
          where has_table_privilege('anon', 'public.compound_ledger_entry', priv)`,
      );
      return rows;
    });
    expect(anonAny).toEqual([]);
  });
});
