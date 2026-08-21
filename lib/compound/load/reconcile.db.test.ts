/**
 * planFor's wiring: real cursor/snapshot/deal reads feeding planReadings,
 * and — the point of this file — the three-way branch a caller must get
 * right. planReadings itself (idle/advance/halt, and the two RangeError
 * data defects) is already covered pure, without a database, by
 * reconcile/interlock.test.ts. This file does not re-prove that logic; it
 * proves planFor does not lose or reshape it on the way through a real
 * connection.
 *
 * The "duplicate snapshot" RangeError is not constructible here:
 * account_snapshots_daily's primary key is (mt5_account, trade_date), so two
 * rows sharing a trade date cannot exist in this schema at all. Only the
 * other RangeError — a window starting after the cursor — is a real,
 * reachable state over this table, and it is what "swallow a RangeError into
 * the halt path" is probed against below.
 */
import { closePool, withDb, withDbTransaction } from "@/lib/compound/db/client";
import { commitReadingPlan } from "@/lib/compound/db/commit-plan";
import type { ResolvedAccount } from "@/lib/compound/load/account";
import { decodeDroppedDeals, encodeDroppedDeals, planFor } from "./reconcile";
import {
  closeTestPool,
  resetCompoundTables,
  seedTwoAccounts,
  withTestClient,
} from "@/lib/compound/db/testing/harness";
import { LOCAL_SUPABASE_DB_URL } from "@/lib/compound/db/testing/env";

const ORIGINAL_DATABASE_URL = process.env.COMPOUND_DATABASE_URL;
const MT5 = 9_921_601;

beforeAll(() => {
  process.env.COMPOUND_DATABASE_URL =
    process.env.COMPOUND_TEST_DATABASE_URL || LOCAL_SUPABASE_DB_URL;
});

beforeEach(async () => {
  await withTestClient(async (c) => {
    await resetCompoundTables(c);
    await c.query("delete from public.account_snapshots_daily where mt5_account = $1", [MT5]);
    await c.query("delete from public.deals where mt5_account = $1", [MT5]);
  });
});

afterAll(async () => {
  await closePool();
  await closeTestPool();
  process.env.COMPOUND_DATABASE_URL = ORIGINAL_DATABASE_URL;
});

async function seedAccount(brokerOffsetHours: number | null): Promise<ResolvedAccount> {
  const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
  await withTestClient((c) =>
    c.query("update public.compound_account set broker_offset_hours = $1 where id = $2", [
      brokerOffsetHours,
      accountA.accountId,
    ]),
  );
  return {
    id: accountA.accountId,
    mt5Account: MT5,
    label: "Seed Account A",
    broker: null,
    currency: "USD",
    defaultSplitBps: 4000,
    inceptionDate: "2026-05-01",
    managerUserId: accountA.managerUserId,
    brokerOffsetHours,
  };
}

describe("planFor — not-configured", () => {
  it("refuses before touching CopyTraderX data at all, when the broker offset is null", async () => {
    const account = await seedAccount(null);
    const outcome = await withDb(() => planFor(account));
    expect(outcome).toEqual({ kind: "not-configured" });
  });
});

describe("planFor — plan", () => {
  it("reports idle when CopyTraderX has nothing for this account yet", async () => {
    const account = await seedAccount(2);
    const outcome = await withDb(() => planFor(account));
    expect(outcome.kind).toBe("plan");
    if (outcome.kind === "plan") {
      expect(outcome.plan).toEqual({ kind: "idle", droppedDeals: [] });
      expect(outcome.lastSnapshotDate).toBeNull();
    }
  });

  it("advances through days a manager has never posted, in trade-date order", async () => {
    const account = await seedAccount(2);
    await withTestClient((c) =>
      c.query(
        `insert into public.account_snapshots_daily
           (mt5_account, trade_date, balance_close, equity_close, daily_pnl)
         values ($1, '2026-08-10', 10000.00, 10000.00, 0.00),
                ($1, '2026-08-11', 10000.00, 10000.00, 0.00)`,
        [MT5],
      ),
    );
    const outcome = await withDb(() => planFor(account));
    expect(outcome.kind).toBe("plan");
    if (outcome.kind === "plan") {
      expect(outcome.plan.kind).toBe("advance");
      expect(outcome.lastSnapshotDate).toBe("2026-08-11");
      if (outcome.plan.kind === "advance") {
        expect(outcome.plan.readings.map((r) => r.occurredOn)).toEqual([
          "2026-08-10", "2026-08-11",
        ]);
        expect(outcome.plan.droppedDeals).toEqual([]);
      }
    }
  });

  it("halts on a balance move closed trades do not explain, and carries the candidate", async () => {
    const account = await seedAccount(2);
    await withTestClient((c) =>
      c.query(
        `insert into public.account_snapshots_daily
           (mt5_account, trade_date, balance_close, equity_close, daily_pnl)
         values ($1, '2026-08-10', 10000.00, 10000.00, 0.00),
                ($1, '2026-08-11', 10500.00, 10500.00, 500.00)`,
        [MT5],
      ),
    );
    // No deals at all: the 500.00 move on 08-11 is entirely unexplained.
    const outcome = await withDb(() => planFor(account));
    expect(outcome.kind).toBe("plan");
    if (outcome.kind === "plan" && outcome.plan.kind === "halt") {
      expect(outcome.plan.candidate.tradeDate).toBe("2026-08-11");
      expect(outcome.plan.candidate.unexplainedCents).toBe(50_000n);
      // The baseline day still gets a reading; only the unexplained day halts.
      expect(outcome.plan.readings.map((r) => r.occurredOn)).toEqual(["2026-08-10"]);
    } else {
      throw new Error(`expected a halt, got ${JSON.stringify(outcome)}`);
    }
  });

  it("carries droppedDeals through, with the ticket each was judged a duplicate of", async () => {
    const account = await seedAccount(2); // offset 2h
    await withTestClient(async (c) => {
      await c.query(
        `insert into public.account_snapshots_daily
           (mt5_account, trade_date, balance_close, equity_close, daily_pnl)
         values ($1, '2026-08-10', 10100.00, 10100.00, 100.00)`,
        [MT5],
      );
      // A genuine deal, plus its broker-double-push duplicate: identical
      // values, both timestamps shifted by exactly the 2h offset, ticket out
      // of sequence — dedupeDeals' own narrow rule (dedupe.ts).
      await c.query(
        `insert into public.deals
           (mt5_account, ticket, ea_source, symbol, side, volume,
            open_price, close_price, open_time, close_time, profit, swap, commission)
         values
           ($1, 5001, 'impulse', 'EURUSD', 'buy', 0.10, 1.0, 1.0,
            '2026-08-10T05:00:00+00', '2026-08-10T06:00:00+00', 100.00, 0.00, 0.00),
           ($1, 5000, 'impulse', 'EURUSD', 'buy', 0.10, 1.0, 1.0,
            '2026-08-10T07:00:00+00', '2026-08-10T08:00:00+00', 100.00, 0.00, 0.00)`,
        [MT5],
      );
    });
    const outcome = await withDb(() => planFor(account));
    expect(outcome.kind).toBe("plan");
    if (outcome.kind === "plan") {
      expect(outcome.plan.droppedDeals).toHaveLength(1);
      const encoded = encodeDroppedDeals(outcome.plan.droppedDeals);
      // dedupeDeals keeps 5000 and drops 5001 as its duplicate — confirmed by
      // running it, not assumed from ticket order. See dedupe.ts for the tie
      // break; this test only needs droppedDeals to carry the real verdict
      // through planFor unchanged, whichever way that verdict goes.
      expect(decodeDroppedDeals(encoded)).toEqual([{ ticket: 5001, duplicateOfTicket: 5000 }]);
    }
  });
});

describe("planFor — error (the RangeError data defect, kept apart from a halt)", () => {
  it("returns kind:'error', not a throw and not a halt, when the window starts after the cursor", async () => {
    const account = await seedAccount(2);
    // The cursor claims readings are posted through 08-20. CopyTraderX's
    // earliest available snapshot for this window is 08-22 — a two-day gap
    // with no row at or before the cursor date, so the first day's balance
    // move cannot be reconciled against anything. This is the shape
    // planReadings' own module doc names as unreachable via the natural
    // `WHERE trade_date > $cursor` query and refuses loudly rather than
    // silently skipping the gap.
    await withTestClient((c) =>
      c.query(
        `insert into public.compound_reconcile_cursor (account_id, last_reading_date)
         values ($1, '2026-08-20')`,
        [account.id],
      ),
    );
    await withTestClient((c) =>
      c.query(
        `insert into public.account_snapshots_daily
           (mt5_account, trade_date, balance_close, equity_close, daily_pnl)
         values ($1, '2026-08-22', 10000.00, 10000.00, 0.00)`,
        [MT5],
      ),
    );

    const outcome = await withDb(() => planFor(account));

    // The defining assertion: this is an ERROR outcome, never a halt. A halt
    // carries a `candidate` a manager would go to Review and look for; here
    // there is no such candidate, because nothing was ever explained or
    // unexplained — the run never got far enough to ask that question.
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toContain("2026-08-22");
      expect(outcome.message).toContain("2026-08-20");
    }
    expect(outcome).not.toHaveProperty("plan");
  });
});

describe("the fence a hand-posted reading needs, that compound_commit_reading_plan does not provide on its own", () => {
  // postReading (app/a/[id]/actions/actions.ts) builds a plain
  // {kind:"advance", ...} plan directly — it does not go through
  // planReadings, so it never carries a `candidate`. commit-plan.ts only
  // forwards p_candidate to the SQL function when plan.kind === "halt", and
  // the SQL function's own CX002 guard only fires when p_candidate is
  // non-null (see compound_commit_reading_plan.sql: v_candidate_date stays
  // null otherwise). So a hand-built advance plan reaches the writer with
  // NOTHING checking it against a pending candidate that already exists —
  // proved here by calling commitReadingPlan exactly the way postReading
  // does, with a genuinely pending candidate already in the database, and
  // watching it succeed. That is not a defect in commitReadingPlan (it is
  // faithfully doing what its caller asked); it is why postReading has its
  // own independent planFor(...).plan.kind !== "idle" check before it ever
  // gets here — the one place this plan can put a guard, since
  // lib/compound/db/ is finished and not this task's to change.
  it("a hand-built advance plan posts straight through an existing pending candidate, unguarded", async () => {
    const account = await seedAccount(2);
    await withTestClient((c) =>
      c.query(
        `insert into public.account_snapshots_daily
           (mt5_account, trade_date, balance_close, equity_close, daily_pnl)
         values ($1, '2026-08-10', 10000.00, 10000.00, 0.00),
                ($1, '2026-08-11', 10500.00, 10500.00, 500.00)`,
        [MT5],
      ),
    );
    const halted = await withDb(() => planFor(account));
    if (halted.kind !== "plan" || halted.plan.kind !== "halt") {
      throw new Error(`fixture setup failed to produce a halt: ${JSON.stringify(halted)}`);
    }
    await withDbTransaction((c) =>
      commitReadingPlan(c, { accountId: account.id, plan: halted.plan, actorUserId: null }),
    );

    // The candidate is now pending in the database — exactly the state
    // postReading's fence exists to catch before it ever reaches here.
    const stillPending = await withDb(() => planFor(account));
    expect(stillPending.kind).toBe("plan");
    if (stillPending.kind === "plan") expect(stillPending.plan.kind).toBe("halt");

    // A manager hand-posts a reading dated after the frozen candidate — the
    // exact shape postReading builds, bypassing planReadings entirely.
    const handBuilt = await withDbTransaction((c) =>
      commitReadingPlan(c, {
        accountId: account.id,
        plan: {
          kind: "advance",
          readings: [{ occurredOn: "2026-08-12", equityCents: 1_100_000n }],
          newCursorDate: "2026-08-12",
          droppedDeals: [],
        },
        actorUserId: null,
      }),
    );

    // No CX002. It posted. This is the vulnerability postReading's fence
    // closes — if that fence is ever weakened or removed, this assertion
    // does not change (it tests commitReadingPlan directly, not postReading),
    // but the fact that it stays green is exactly why the fence has to live
    // in application code: nothing below it will ever refuse this.
    expect(handBuilt.readingsInserted).toBe(1);
    expect(handBuilt.cursorDate).toBe("2026-08-12");
  });

  // The other half of "commit readings without the cursor": postReading
  // itself is not exercised by any test in this suite (server actions need
  // a live Supabase session — next/headers cookies, the Auth server — that
  // does not exist in Jest; no test anywhere in this codebase mocks that
  // boundary). So a bug that sent the wrong newCursorDate from postReading
  // would not be caught here or in any offline test. This is the fallback
  // that WOULD catch it in production: compound_commit_reading_plan itself
  // refuses when the cursor it is asked to move to does not match the last
  // reading actually posted in the same call, unconditionally, regardless of
  // which caller built the plan.
  it("refuses — CX004 — when the cursor a caller asks for does not match the reading it just posted", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    await expect(withDbTransaction((c) =>
      commitReadingPlan(c, {
        accountId: accountA.accountId,
        plan: {
          kind: "advance",
          readings: [{ occurredOn: "2026-08-10", equityCents: 100_000n }],
          newCursorDate: null as unknown as string,
          droppedDeals: [],
        },
        actorUserId: null,
      }),
    )).rejects.toMatchObject({ code: "CX004" });
  });
});
