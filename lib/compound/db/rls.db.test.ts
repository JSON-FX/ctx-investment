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
    // An exact-match assertion over every grantee/privilege pair here would
    // also have to enumerate REFERENCES, TRIGGER and TRUNCATE for
    // anon/authenticated/service_role — verified directly against
    // pg_default_acl for the `postgres` role in the public schema, present
    // identically on compound_account and compound_holder too, so it is a
    // database-wide default and not something this migration granted. It is
    // real, and it is deliberately not this migration's problem: the SQL
    // comment above compound_ledger_entry's policies says the next migration
    // (Task 4) takes TRUNCATE away and backs it with a trigger that refuses
    // even the table owner, because REVOKE cannot bind the owner at all. This
    // assertion stays scoped to what Task 3 actually owns — no grant ever
    // hands out UPDATE or DELETE, the pair that would let a role rewrite or
    // erase a row outright.
    const disallowed = await withTestClient(async (c) => {
      const { rows } = await c.query<{ grantee: string; privilege_type: string }>(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'public' and table_name = 'compound_ledger_entry'
            and grantee <> 'postgres'
            and privilege_type in ('UPDATE', 'DELETE')
          order by grantee, privilege_type`,
      );
      return rows.map((r) => `${r.grantee}:${r.privilege_type}`);
    });
    expect(disallowed).toEqual([]);
  });

  it("grants exactly INSERT and SELECT to authenticated and service_role", async () => {
    // The narrower complement of the assertion above: not just "no UPDATE or
    // DELETE", but that the DML surface Task 3 itself grants is precisely
    // INSERT and SELECT, nothing more, nothing less. TRUNCATE/REFERENCES/
    // TRIGGER are excluded here on purpose — they are the database's default
    // ACL, not a DML grant, and Task 4 owns closing TRUNCATE.
    const dml = await withTestClient(async (c) => {
      const { rows } = await c.query<{ grantee: string; privilege_type: string }>(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'public' and table_name = 'compound_ledger_entry'
            and grantee <> 'postgres'
            and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
          order by grantee, privilege_type`,
      );
      return rows.map((r) => `${r.grantee}:${r.privilege_type}`);
    });
    expect(dml).toEqual([
      "authenticated:INSERT",
      "authenticated:SELECT",
      "service_role:INSERT",
      "service_role:SELECT",
    ]);
  });
});
