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

  // The four constraints below were dropped one at a time against the
  // running suite before this file had any test for them, and the suite
  // stayed fully green each time — a passing suite that would still pass
  // with the constraint gone. compound_ledger_entry_seq_check is the first;
  // compound_ledger_entry_holder_id_fkey (next describe down, holder_id) is
  // the one P8 credits with turning replay.ts's "unknown holderId" throw
  // into a row refusal — the plan's own accounting for that claim had
  // nothing testing it until now.
  it("refuses a seq of zero", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_ledger_entry
             (account_id, seq, occurred_on, type, amount_cents)
           values ($1, 0, '2026-05-02', 'equity_reading', 100)`,
          [accountId],
        ),
        "23514",
        /compound_ledger_entry_seq_check/,
      ),
    );
  });

  it("refuses a negative seq", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_ledger_entry
             (account_id, seq, occurred_on, type, amount_cents)
           values ($1, -1, '2026-05-02', 'equity_reading', 100)`,
          [accountId],
        ),
        "23514",
        /compound_ledger_entry_seq_check/,
      ),
    );
  });

  it("refuses a holder_id that belongs to no holder — this is what replay.ts's holderOf() throw becomes at write time", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_ledger_entry
             (account_id, holder_id, seq, occurred_on, type, amount_cents)
           values ($1, 999999999, 1, '2026-05-02', 'deposit', 500000)`,
          [accountId],
        ),
        "23503",
        /compound_ledger_entry_holder_id_fkey/,
      ),
    );
  });

  it("refuses an account_id that does not exist", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_ledger_entry
             (account_id, seq, occurred_on, type, amount_cents)
           values (999999999, 1, '2026-05-02', 'equity_reading', 100)`,
        ),
        "23503",
        /compound_ledger_entry_account_id_fkey/,
      ),
    );
  });

  it("refuses a created_by that is not a public.users row", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_ledger_entry
             (account_id, seq, occurred_on, type, amount_cents, created_by)
           values ($1, 1, '2026-05-02', 'equity_reading', 100,
                   'ffffffff-0000-4000-8000-ffffffffffff')`,
          [accountId],
        ),
        "23503",
        /compound_ledger_entry_created_by_fkey/,
      ),
    );
  });

  it("refuses a reverses_id that does not exist", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_ledger_entry
             (account_id, seq, occurred_on, type, amount_cents, reverses_id)
           values ($1, 1, '2026-05-02', 'equity_reading', 100, 999999999)`,
          [accountId],
        ),
        "23503",
        /compound_ledger_entry_reverses_id_fkey/,
      ),
    );
  });

  it("refuses a fee_settlement outside units and cash", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_ledger_entry
             (account_id, holder_id, seq, occurred_on, type, amount_cents,
              fee_settlement, split_bps_applied)
           values ($1, $2, 1, '2026-05-02', 'payout', 25000, 'crypto', 4000)`,
          [accountId, holderId],
        ),
        "23514",
        /compound_ledger_entry_fee_settlement_check/,
      ),
    );
  });

  it("refuses a split_bps_applied outside 0..10000", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_ledger_entry
             (account_id, holder_id, seq, occurred_on, type, amount_cents,
              fee_settlement, split_bps_applied)
           values ($1, $2, 1, '2026-05-02', 'payout', 25000, 'units', 10001)`,
          [accountId, holderId],
        ),
        "23514",
        /compound_ledger_entry_split_bps_applied_check/,
      ),
    );
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

  it("refuses an account_id that does not exist", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_holder
             (account_id, name, is_manager, split_bps, status)
           values (999999999, 'Orphan Holder', false, 4000, 'active')`,
        ),
        "23503",
        /compound_holder_account_id_fkey/,
      ),
    );
  });

  it("refuses a user_id that is not a public.users row", async () => {
    const accountId = await seedAccount();
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_holder
             (account_id, name, user_id, is_manager, split_bps, status)
           values ($1, 'Orphan Link', 'ffffffff-0000-4000-8000-ffffffffffff', false, 4000, 'active')`,
          [accountId],
        ),
        "23503",
        /compound_holder_user_id_fkey/,
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

  it("refuses an account_id that does not exist", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_capital_event_candidate
             (account_id, trade_date, balance_delta_cents, explained_cents, unexplained_cents)
           values (999999999, '2026-06-25', 3100000, 0, 3100000)`,
        ),
        "23503",
        /compound_capital_event_candidate_account_id_fkey/,
      ),
    );
  });

  it("refuses a resolved_by that is not a public.users row", async () => {
    const accountId = await seedAccount();
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_capital_event_candidate
             (account_id, trade_date, balance_delta_cents, explained_cents,
              unexplained_cents, resolved_by)
           values ($1, '2026-06-25', 3100000, 0, 3100000,
                   'ffffffff-0000-4000-8000-ffffffffffff')`,
          [accountId],
        ),
        "23503",
        /compound_capital_event_candidate_resolved_by_fkey/,
      ),
    );
  });

  it("refuses a resolved_ledger_entry_id that does not exist", async () => {
    const accountId = await seedAccount();
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_capital_event_candidate
             (account_id, trade_date, balance_delta_cents, explained_cents,
              unexplained_cents, resolved_ledger_entry_id)
           values ($1, '2026-06-25', 3100000, 0, 3100000, 999999999)`,
          [accountId],
        ),
        "23503",
        /compound_capital_event_candidate_resolved_ledger_entry_id_fkey/,
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

  it("refuses a default_split_bps outside 0..10000", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_account
             (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
           values ($1, 'Impossible Default', 'USD', 10001, '2026-05-01', $2)`,
          [MT5 + 98, MANAGER],
        ),
        "23514",
        /compound_account_default_split_bps_check/,
      ),
    );
  });
});

// Neither of these two tables had a describe block before this task — Task
// 2's own review found compound_reconcile_cursor and compound_audit had no
// test coverage at all, and dropping either one's account_id foreign key
// left the full suite green. compound_audit's is the sharper gap: P8 rests
// part of its "replay.ts's throws become row refusals" argument on the
// account_id foreign key existing, and nothing here tested that it does.
describe("compound_reconcile_cursor constraints", () => {
  it("accepts a cursor row for a real account", async () => {
    const accountId = await seedAccount();
    const n = await withTestClient(async (c) => {
      const { rowCount } = await c.query(
        `insert into public.compound_reconcile_cursor (account_id, last_reading_date, last_run_at)
         values ($1, '2026-06-01', now())`,
        [accountId],
      );
      return rowCount;
    });
    expect(n).toBe(1);
  });

  it("refuses an account_id that does not exist", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_reconcile_cursor (account_id, last_reading_date)
           values (999999999, '2026-06-01')`,
        ),
        "23503",
        /compound_reconcile_cursor_account_id_fkey/,
      ),
    );
  });

  it("refuses a second cursor row for the same account — account_id is its own primary key", async () => {
    const accountId = await seedAccount();
    await withTestClient(async (c) => {
      await c.query(
        `insert into public.compound_reconcile_cursor (account_id, last_reading_date)
         values ($1, '2026-06-01')`,
        [accountId],
      );
      await expectPgError(
        c.query(
          `insert into public.compound_reconcile_cursor (account_id, last_reading_date)
           values ($1, '2026-06-02')`,
          [accountId],
        ),
        "23505",
        /compound_reconcile_cursor_pkey/,
      );
    });
  });
});

describe("compound_audit constraints", () => {
  it("accepts an audit row tied to a real account and a real actor", async () => {
    const accountId = await seedAccount();
    const n = await withTestClient(async (c) => {
      const { rowCount } = await c.query(
        `insert into public.compound_audit (account_id, actor, action, entity, entity_id)
         values ($1, $2, 'create', 'compound_account', $1)`,
        [accountId, MANAGER],
      );
      return rowCount;
    });
    expect(n).toBe(1);
  });

  it("accepts a null account_id — an action can precede any account existing", async () => {
    const n = await withTestClient(async (c) => {
      await seedUser(c, MANAGER, "schema-manager@example.test");
      const { rowCount } = await c.query(
        `insert into public.compound_audit (account_id, actor, action, entity)
         values (null, $1, 'sign_in', 'auth')`,
        [MANAGER],
      );
      return rowCount;
    });
    expect(n).toBe(1);
  });

  it("refuses an account_id that does not exist — this is the FK P8 credits with covering replay.ts's account-scoped throws", async () => {
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_audit (account_id, action, entity)
           values (999999999, 'create', 'compound_account')`,
        ),
        "23503",
        /compound_audit_account_id_fkey/,
      ),
    );
  });

  it("refuses an actor that is not a public.users row", async () => {
    const accountId = await seedAccount();
    await withTestClient((c) =>
      expectPgError(
        c.query(
          `insert into public.compound_audit (account_id, actor, action, entity)
           values ($1, 'ffffffff-0000-4000-8000-ffffffffffff', 'create', 'compound_account')`,
          [accountId],
        ),
        "23503",
        /compound_audit_actor_fkey/,
      ),
    );
  });
});
