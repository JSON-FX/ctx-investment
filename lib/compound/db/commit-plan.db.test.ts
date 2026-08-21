import type { ReadingPlan } from "@/lib/compound/reconcile/interlock";
import { commitReadingPlan } from "./commit-plan";
import { getLedgerEntries, getReconcileCursor, listCandidates } from "./compound";
import {
  closeTestPool,
  expectPgError,
  resetCompoundTables,
  seedUser,
  sequenceConsumed,
  withSeparateSession,
  withTestClient,
} from "./testing/harness";
import { testDatabaseUrl } from "./testing/env";

const MANAGER = "aaaaaaaa-0000-4000-8000-0000000008a1";
const MT5_A = 9_900_801;
const MT5_B = 9_900_802;

let accountA = 0;
let accountB = 0;

const LEDGER = "public.compound_ledger_entry";
const CANDIDATES = "public.compound_capital_event_candidate";

function reading(occurredOn: string, equityCents: bigint) {
  return { occurredOn, equityCents };
}

function advance(readings: Array<{ occurredOn: string; equityCents: bigint }>): ReadingPlan {
  return {
    kind: "advance",
    readings,
    newCursorDate: readings[readings.length - 1]!.occurredOn,
  };
}

beforeEach(async () => {
  await withTestClient(async (c) => {
    await resetCompoundTables(c);
    await seedUser(c, MANAGER, "writer@example.test");
    const { rows } = await c.query<{ id: string }>(
      `insert into public.compound_account
         (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
       values ($1, 'Writer A', 'USD', 4000, '2026-08-01', $3),
              ($2, 'Writer B', 'USD', 4000, '2026-08-01', $3)
       returning id`,
      [MT5_A, MT5_B, MANAGER],
    );
    accountA = Number(rows[0]!.id);
    accountB = Number(rows[1]!.id);
  });
});

afterAll(async () => {
  await withTestClient((c) => resetCompoundTables(c));
  await closeTestPool();
});

describe("an idle plan", () => {
  it("writes nothing and reports nothing", async () => {
    const result = await withTestClient((c) =>
      commitReadingPlan(c, { accountId: accountA, plan: { kind: "idle" }, actorUserId: MANAGER }),
    );
    expect(result).toEqual({
      readingsInserted: 0,
      seqs: [],
      candidateId: null,
      cursorDate: null,
    });
  });

  it("does not open a database round trip at all", async () => {
    // The ratchet: an idle plan that reached the function would still write
    // nothing, so counting rows proves nothing. Counting queries does.
    const fake = { query: jest.fn() } as unknown as Parameters<typeof commitReadingPlan>[0];
    await commitReadingPlan(fake, {
      accountId: accountA,
      plan: { kind: "idle" },
      actorUserId: MANAGER,
    });
    expect((fake as unknown as { query: jest.Mock }).query).not.toHaveBeenCalled();
  });
});

describe("an advancing plan", () => {
  it("posts every reading as an equity_reading with no holder", async () => {
    const entries = await withTestClient(async (c) => {
      await commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([
          reading("2026-08-03", 5074500n),
          reading("2026-08-04", 5081300n),
          reading("2026-08-05", 5099200n),
        ]),
        actorUserId: MANAGER,
      });
      return getLedgerEntries(c, accountA);
    });

    expect(entries.map((e) => e.occurredOn)).toEqual(["2026-08-03", "2026-08-04", "2026-08-05"]);
    expect(entries.map((e) => e.amountCents)).toEqual([5074500n, 5081300n, 5099200n]);
    expect(entries.every((e) => e.type === "equity_reading")).toBe(true);
    expect(entries.every((e) => e.holderId === null)).toBe(true);
  });

  it("assigns seq 1..n and returns them", async () => {
    const result = await withTestClient((c) =>
      commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-03", 100n), reading("2026-08-04", 200n)]),
        actorUserId: MANAGER,
      }),
    );
    expect(result.seqs).toEqual([1, 2]);
    expect(result.readingsInserted).toBe(2);
  });

  it("moves the cursor to the last reading, in the same call", async () => {
    const cursor = await withTestClient(async (c) => {
      await commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-03", 100n), reading("2026-08-04", 200n)]),
        actorUserId: MANAGER,
      });
      return getReconcileCursor(c, accountA);
    });
    expect(cursor).toEqual({ lastReadingDate: "2026-08-04" });
  });

  it("continues seq from where the previous run stopped", async () => {
    const seqs = await withTestClient(async (c) => {
      await commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-03", 100n), reading("2026-08-04", 200n)]),
        actorUserId: MANAGER,
      });
      const second = await commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-05", 300n)]),
        actorUserId: MANAGER,
      });
      return second.seqs;
    });
    expect(seqs).toEqual([3]);
  });

  it("numbers seq per account, not globally — section 6.2", async () => {
    const { a, b } = await withTestClient(async (c) => {
      const first = await commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-03", 100n), reading("2026-08-04", 200n)]),
        actorUserId: MANAGER,
      });
      const second = await commitReadingPlan(c, {
        accountId: accountB,
        plan: advance([reading("2026-08-03", 900n)]),
        actorUserId: MANAGER,
      });
      return { a: first.seqs, b: second.seqs };
    });
    expect(a).toEqual([1, 2]);
    // 1, not 3. A global sequence would give 3 here.
    expect(b).toEqual([1]);
  });

  it("keeps an equity value above 2^53 exact through the JSON boundary", async () => {
    const entries = await withTestClient(async (c) => {
      await commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-03", 9007199254740993n)]),
        actorUserId: MANAGER,
      });
      return getLedgerEntries(c, accountA);
    });
    expect(entries[0]!.amountCents).toBe(9007199254740993n);
  });

  it("stamps created_by with the actor", async () => {
    const actor = await withTestClient(async (c) => {
      await commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-03", 100n)]),
        actorUserId: MANAGER,
      });
      const { rows } = await c.query<{ created_by: string | null }>(
        `select created_by from ${LEDGER} where account_id = $1`,
        [accountA],
      );
      return rows[0]?.created_by ?? null;
    });
    expect(actor).toBe(MANAGER);
  });

  it("refuses to re-post a day the cursor has already passed", async () => {
    await withTestClient(async (c) => {
      await commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-03", 100n), reading("2026-08-04", 200n)]),
        actorUserId: MANAGER,
      });
      await expectPgError(
        commitReadingPlan(c, {
          accountId: accountA,
          plan: advance([reading("2026-08-04", 999n)]),
          actorUserId: MANAGER,
        }),
        "CX003",
        /reading 2026-08-04 is not after the cursor 2026-08-04/,
      );
    });
  });

  it("refuses readings that do not ascend", async () => {
    await withTestClient((c) =>
      expectPgError(
        commitReadingPlan(c, {
          accountId: accountA,
          plan: {
            kind: "advance",
            readings: [reading("2026-08-05", 100n), reading("2026-08-03", 200n)],
            newCursorDate: "2026-08-03",
          },
          actorUserId: MANAGER,
        }),
        "CX005",
        /readings must ascend, 2026-08-03 follows 2026-08-05/,
      ),
    );
  });

  it("refuses an account that does not exist", async () => {
    await withTestClient((c) =>
      expectPgError(
        commitReadingPlan(c, {
          accountId: 999_999,
          plan: advance([reading("2026-08-03", 100n)]),
          actorUserId: MANAGER,
        }),
        "CX001",
        /no account 999999/,
      ),
    );
  });
});

describe("a halting plan", () => {
  const halt = (
    readings: Array<{ occurredOn: string; equityCents: bigint }>,
    newCursorDate: string | null,
  ): ReadingPlan => ({
    kind: "halt",
    readings,
    newCursorDate,
    candidate: {
      tradeDate: "2026-08-12",
      previousDate: "2026-08-11",
      balanceDeltaCents: 500000n,
      explainedCents: 0n,
      unexplainedCents: 500000n,
    },
  });

  it("records the candidate and the readings together", async () => {
    const { entries, candidates, cursor } = await withTestClient(async (c) => {
      await commitReadingPlan(c, {
        accountId: accountA,
        plan: halt([reading("2026-08-10", 100n), reading("2026-08-11", 200n)], "2026-08-11"),
        actorUserId: MANAGER,
      });
      return {
        entries: await getLedgerEntries(c, accountA),
        candidates: await listCandidates(c, accountA),
        cursor: await getReconcileCursor(c, accountA),
      };
    });

    expect(entries.map((e) => e.occurredOn)).toEqual(["2026-08-10", "2026-08-11"]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.tradeDate).toBe("2026-08-12");
    expect(candidates[0]!.unexplainedCents).toBe(500000n);
    expect(candidates[0]!.status).toBe("pending");
    expect(cursor).toEqual({ lastReadingDate: "2026-08-11" });
  });

  it("refuses a reading dated on the unclassified event — the interlock", async () => {
    await withTestClient((c) =>
      expectPgError(
        commitReadingPlan(c, {
          accountId: accountA,
          plan: halt([reading("2026-08-11", 100n), reading("2026-08-12", 200n)], "2026-08-12"),
          actorUserId: MANAGER,
        }),
        "CX002",
        /reading 2026-08-12 is on or after unclassified capital event 2026-08-12/,
      ),
    );
  });

  it("is a clean no-op when re-run against an existing candidate", async () => {
    const { second, candidates, cursor } = await withTestClient(async (c) => {
      const first = await commitReadingPlan(c, {
        accountId: accountA,
        plan: halt([reading("2026-08-10", 100n), reading("2026-08-11", 200n)], "2026-08-11"),
        actorUserId: MANAGER,
      });
      const again = await commitReadingPlan(c, {
        accountId: accountA,
        plan: halt([], null),
        actorUserId: MANAGER,
      });
      return {
        first,
        second: again,
        candidates: await listCandidates(c, accountA),
        cursor: await getReconcileCursor(c, accountA),
      };
    });

    expect(second.readingsInserted).toBe(0);
    // The same candidate row, not a second one.
    expect(candidates).toHaveLength(1);
    expect(second.candidateId).toBe(candidates[0]!.id);
    // And the cursor did not slide backwards to null.
    expect(cursor).toEqual({ lastReadingDate: "2026-08-11" });
  });
});

describe("ATOMICITY — the whole point of this task", () => {
  /**
   * Force a failure that lands AFTER the writes: three valid readings, a valid
   * candidate, and a cursor date that matches neither. The function's final
   * consistency check is the last statement in the body, so by the time it
   * raises, three ledger rows, one candidate and one cursor row have all been
   * written.
   *
   * The row-count assertions alone would pass even if the guard had fired
   * first. The sequence assertions are what prove the writes happened, because
   * a sequence is not rolled back with the transaction.
   */
  const badPlan: ReadingPlan = {
    kind: "halt",
    readings: [
      reading("2026-08-08", 100n),
      reading("2026-08-09", 200n),
      reading("2026-08-10", 300n),
    ],
    // Deliberately wrong: the last reading is 2026-08-10.
    newCursorDate: "2026-08-30",
    candidate: {
      tradeDate: "2026-08-12",
      previousDate: "2026-08-11",
      balanceDeltaCents: 500000n,
      explainedCents: 0n,
      unexplainedCents: 500000n,
    },
  };

  it("raises CX004 and names both dates", async () => {
    await withTestClient((c) =>
      expectPgError(
        commitReadingPlan(c, { accountId: accountA, plan: badPlan, actorUserId: MANAGER }),
        "CX004",
        /cursor 2026-08-30 does not match the last reading 2026-08-10/,
      ),
    );
  });

  it("leaves no ledger row, no candidate and no cursor behind", async () => {
    await withTestClient(async (c) => {
      await expect(
        commitReadingPlan(c, { accountId: accountA, plan: badPlan, actorUserId: MANAGER }),
      ).rejects.toThrow();
    });

    const counts = await withTestClient(async (c) => {
      const { rows } = await c.query<{ l: string; k: string; u: string }>(
        `select (select count(*) from ${LEDGER}     where account_id = $1)::text as l,
                (select count(*) from ${CANDIDATES} where account_id = $1)::text as k,
                (select count(*) from public.compound_reconcile_cursor
                  where account_id = $1)::text as u`,
        [accountA],
      );
      return rows[0]!;
    });
    expect(counts).toEqual({ l: "0", k: "0", u: "0" });
  });

  it("consumed three ledger ids and one candidate id before rolling back", async () => {
    // This is the assertion that makes the one above mean something. Without
    // it, moving the guard to the top of the function leaves this suite green.
    const before = await withTestClient(async (c) => ({
      ledger: await sequenceConsumed(c, LEDGER, "id"),
      candidate: await sequenceConsumed(c, CANDIDATES, "id"),
    }));

    await withTestClient(async (c) => {
      await expect(
        commitReadingPlan(c, { accountId: accountA, plan: badPlan, actorUserId: MANAGER }),
      ).rejects.toThrow();
    });

    const after = await withTestClient(async (c) => ({
      ledger: await sequenceConsumed(c, LEDGER, "id"),
      candidate: await sequenceConsumed(c, CANDIDATES, "id"),
    }));

    expect(after.ledger - before.ledger).toBe(3);
    expect(after.candidate - before.candidate).toBe(1);
  });

  it("leaves the next successful run starting at seq 1", async () => {
    await withTestClient(async (c) => {
      await expect(
        commitReadingPlan(c, { accountId: accountA, plan: badPlan, actorUserId: MANAGER }),
      ).rejects.toThrow();
    });
    const result = await withTestClient((c) =>
      commitReadingPlan(c, {
        accountId: accountA,
        plan: advance([reading("2026-08-08", 100n)]),
        actorUserId: MANAGER,
      }),
    );
    // seq is max(seq)+1 over surviving rows, so a rolled-back run must not
    // have consumed a seq. Note that the bigserial *id* did advance — ids and
    // seq are different things, and this is where that shows.
    expect(result.seqs).toEqual([1]);
  });
});

describe("CONCURRENCY — the row lock", () => {
  it("makes a second run wait rather than collide on seq", async () => {
    const call =
      `select public.compound_commit_reading_plan($1, $2::jsonb, null, $3::date, $4) as result`;

    const first = JSON.stringify([
      { occurred_on: "2026-08-03", equity_cents: "100" },
      { occurred_on: "2026-08-04", equity_cents: "200" },
      { occurred_on: "2026-08-05", equity_cents: "300" },
    ]);
    const second = JSON.stringify([
      { occurred_on: "2026-08-06", equity_cents: "400" },
      { occurred_on: "2026-08-07", equity_cents: "500" },
    ]);

    await withSeparateSession(async (a) => {
      await withSeparateSession(async (b) => {
        await a.query("begin");
        await a.query(call, [accountA, first, "2026-08-05", MANAGER]);

        let bSettled = false;
        const bPromise = b
          .query<{ result: { seqs: string[] } }>(call, [accountA, second, "2026-08-07", MANAGER])
          .then((r) => {
            bSettled = true;
            return r;
          });

        // Long enough for B to reach the lock and stop there. The assertion is
        // on bSettled, not on the delay: without the lock B completes
        // immediately and this goes red.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(bSettled).toBe(false);

        await a.query("commit");
        const bResult = await bPromise;

        expect(bResult.rows[0]!.result.seqs).toEqual(["4", "5"]);
      });
    });

    const allSeqs = await withTestClient(async (c) => {
      const entries = await getLedgerEntries(c, accountA);
      return entries.map((e) => e.seq);
    });
    expect(allSeqs).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("the writer respects the append-only ledger", () => {
  it("runs as service_role through withDb and still cannot rewrite what it wrote", async () => {
    const { withDb, closePool } = await import("./client");
    const saved = process.env.COMPOUND_DATABASE_URL;
    process.env.COMPOUND_DATABASE_URL = testDatabaseUrl();
    try {
      await withDb((c) =>
        commitReadingPlan(c, {
          accountId: accountA,
          plan: advance([reading("2026-08-03", 100n)]),
          actorUserId: MANAGER,
        }),
      );
      await withDb((c) =>
        expectPgError(
          c.query(`update ${LEDGER} set amount_cents = 1 where account_id = $1`, [accountA]),
          "42501",
          /permission denied for table compound_ledger_entry/,
        ),
      );
    } finally {
      await closePool();
      process.env.COMPOUND_DATABASE_URL = saved;
    }
  });
});
