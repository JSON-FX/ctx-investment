/**
 * The full round trip. Read the CopyTraderX tables, dedupe, plan, commit,
 * read back, fold, assert the invariants — everything joined up, against a
 * real local Postgres.
 *
 * The bar is not "the pipeline ran". It is that a figure computed through the
 * full stack (write to Postgres, read back through db/, fold through the
 * engine) equals the SAME figure computed directly (fold the same logical
 * ledger in memory, no database involved) — exactly, not approximately.
 * Integer cents make that an equality; every comparison below is exact.
 *
 * Three parts, because one fixture cannot prove all of this well:
 *
 * - Part A runs against the shipped seed (account_snapshots_daily,
 *   deals) — a duplicate deal pair, a weekend gap, one unexplained balance
 *   jump. It proves the interlock halts exactly where it must, and that the
 *   dedupe guard is load-bearing, not decorative.
 * - Part B runs against a fixture this suite owns, with equity_close
 *   deliberately different from balance_close on every day. That divergence
 *   is what makes "readings post equity, not balance" falsifiable.
 * - Part C never touches the CopyTraderX tables. It is the compound_ledger_entry
 *   round trip on its own: several holders, a non-genesis deposit priced at a
 *   real prevailing NAV, a payout whose settlement reading commits with it in
 *   one transaction, and a cents value one past 2^53 — the first integer a
 *   JavaScript number cannot hold exactly. checkInvariants runs after every
 *   committed step, not only at the end. A concurrent second account proves
 *   the readers stay scoped to the one being asked about.
 */
import { assertInvariants, checkInvariants } from "@/lib/compound/engine/invariants";
import { fold, totalsOf } from "@/lib/compound/engine/replay";
import type { HolderSeed, LedgerEntry } from "@/lib/compound/engine/replay";
import { quote } from "@/lib/compound/engine/quote";
import { dedupeDeals } from "@/lib/compound/reconcile/dedupe";
import { reconcileDays } from "@/lib/compound/reconcile/detect";
import { planReadings } from "@/lib/compound/reconcile/interlock";
import { commitReadingPlan } from "./commit-plan";
import {
  getHolderSeeds,
  getLedgerEntries,
  getReconcileCursor,
  listCandidates,
} from "./compound";
import { getClosedDeals, getDailySnapshots } from "./copytraderx";
import type { Queryable } from "./types";
import {
  closeTestPool,
  expectPgError,
  resetCompoundTables,
  seedLedger,
  seedUser,
  sequenceConsumed,
  withTestClient,
} from "./testing/harness";

/** Seeded by the local-supabase fixture. Fictional. */
const SEED_MT5 = 90_000_001;
const SEED_MANAGER = "00000000-0000-0000-0000-000000000001";
const BROKER_OFFSET_HOURS = 3;

afterAll(async () => {
  await withTestClient((c) => resetCompoundTables(c));
  await closeTestPool();
});

// ---------------------------------------------------------------------------
// Part A — the shipped seed
// ---------------------------------------------------------------------------

describe("Part A: the seeded account, end to end", () => {
  let accountId = 0;
  let holderId = 0;

  beforeEach(async () => {
    await withTestClient(async (c) => {
      await resetCompoundTables(c);
      await seedUser(c, SEED_MANAGER, "manager@example.com");
      const { rows } = await c.query<{ id: string }>(
        `insert into public.compound_account
           (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
         values ($1, 'Seeded Desk', 'USD', 4000, '2026-08-03', $2)
         returning id`,
        [SEED_MT5, SEED_MANAGER],
      );
      accountId = Number(rows[0]!.id);
      const h = await c.query<{ id: string }>(
        `insert into public.compound_holder
           (account_id, name, is_manager, split_bps, joined_at, status)
         values ($1, 'Manager', true, 4000, '2026-08-03', 'active')
         returning id`,
        [accountId],
      );
      holderId = Number(h.rows[0]!.id);
    });
  });

  describe("the seed is really there", () => {
    // Ratchet. Every assertion below is vacuous against an empty database, and
    // an empty database is exactly what a stale `supabase db reset` produces.
    it("has ten daily snapshots across the expected window", async () => {
      const snaps = await withTestClient((c) => getDailySnapshots(c, SEED_MT5));
      expect(snaps).toHaveLength(10);
      expect(snaps[0]!.tradeDate).toBe("2026-08-03");
      expect(snaps[snaps.length - 1]!.tradeDate).toBe("2026-08-14");
    });

    it("has the duplicate pair and the weekend close", async () => {
      const deals = await withTestClient((c) => getClosedDeals(c, SEED_MT5));
      const tickets = deals.map((d) => d.ticket);
      expect(tickets).toContain(90010004);
      expect(tickets).toContain(90019999);
      expect(tickets).toContain(90010006);
    });

    it("shows the unexplained jump as a +5000.00 balance move on 2026-08-12", async () => {
      const snaps = await withTestClient((c) => getDailySnapshots(c, SEED_MT5));
      const before = snaps.find((s) => s.tradeDate === "2026-08-11")!;
      const after = snaps.find((s) => s.tradeDate === "2026-08-12")!;
      expect(after.balanceCloseCents - before.balanceCloseCents).toBe(500000n);
    });
  });

  describe("dedupe", () => {
    it("drops the +3h twin and keeps the lower ticket", async () => {
      const deals = await withTestClient((c) => getClosedDeals(c, SEED_MT5));
      const { kept, dropped } = dedupeDeals(deals, BROKER_OFFSET_HOURS);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]!.deal.ticket).toBe(90019999);
      expect(dropped[0]!.duplicateOfTicket).toBe(90010004);
      expect(kept.map((d) => d.ticket)).not.toContain(90019999);
    });
  });

  describe("the interlock, from database to database", () => {
    async function runOnce(useDedupe = true) {
      return withTestClient(async (c) => {
        const snapshots = await getDailySnapshots(c, SEED_MT5);
        const raw = await getClosedDeals(c, SEED_MT5);
        const deals = useDedupe ? dedupeDeals(raw, BROKER_OFFSET_HOURS).kept : raw;
        const cursor = await getReconcileCursor(c, accountId);
        const plan = planReadings({
          snapshots,
          deals,
          cursor,
          brokerOffsetHours: BROKER_OFFSET_HOURS,
          toleranceCents: 0n,
        });
        return plan;
      });
    }

    it("halts on the unexplained day, not before and not after", async () => {
      const plan = await runOnce();
      expect(plan.kind).toBe("halt");
      if (plan.kind !== "halt") throw new Error("expected halt");
      expect(plan.candidate.tradeDate).toBe("2026-08-12");
      expect(plan.candidate.unexplainedCents).toBe(500000n);
    });

    it("plans a reading for every explained day up to the one before", async () => {
      const plan = await runOnce();
      if (plan.kind !== "halt") throw new Error("expected halt");
      expect(plan.readings.map((r) => r.occurredOn)).toEqual([
        "2026-08-03",
        "2026-08-04",
        "2026-08-05",
        "2026-08-06",
        "2026-08-07",
        "2026-08-10",
        "2026-08-11",
      ]);
    });

    // NOTE on a finding: the plan's own Task 9 sample proposed toggling
    // dedupe through runOnce()'s `deals` argument and expecting planReadings
    // to halt six days earlier without it. That does not hold against the
    // actual interlock.ts: planReadings composes dedupeDeals INTERNALLY and
    // UNCONDITIONALLY (see its own doc comment — "This module composes
    // dedupe and detect... reconciling without deduplicating first inflates
    // the explained figure"), so runOnce(false) re-dedupes anyway and is
    // observably identical to runOnce(true). Verified: both produce a halt
    // on 2026-08-12, not 2026-08-06. detect.ts's reconcileDays, by contrast,
    // is documented to NOT dedupe on its own ("callers... must run them
    // through dedupeDeals first") — that is the actual layer where spec
    // 6.3's claim is falsifiable, and the two tests below use it there.
    it("halts EARLIER when reconciled directly without dedupe — spec 6.3's claim, made falsifiable", async () => {
      const { snapshots, raw, kept } = await withTestClient(async (c) => {
        const snapshots = await getDailySnapshots(c, SEED_MT5);
        const raw = await getClosedDeals(c, SEED_MT5);
        const kept = dedupeDeals(raw, BROKER_OFFSET_HOURS).kept;
        return { snapshots, raw, kept };
      });

      const withGuard = reconcileDays(snapshots, kept, 0n).find((d) => !d.isExplained);
      const without = reconcileDays(snapshots, raw, 0n).find((d) => !d.isExplained);
      if (!withGuard) throw new Error("expected an unexplained day with dedupe applied");
      if (!without) throw new Error("expected an unexplained day without dedupe");

      // The duplicate double-counts 2026-08-06's closed-trade P/L, so THAT
      // day stops reconciling the moment dedupe is skipped — six days before
      // the real capital event on 2026-08-12.
      expect(without.tradeDate).toBe("2026-08-06");
      expect(withGuard.tradeDate).toBe("2026-08-12");
      // Stated separately, because it survives any change to the seed's dates:
      // the raw run must find its first unexplained day strictly before the
      // guarded run's.
      expect(without.tradeDate < withGuard.tradeDate).toBe(true);
    });

    it("planReadings protects the interlock even when a caller forgets to dedupe first", async () => {
      // The composition guarantee stated directly: unlike reconcileDays alone
      // (proven vulnerable above), planReadings is safe against exactly the
      // mistake a caller could make by passing it raw, undeduped deals.
      const withRaw = await runOnce(false);
      const withKept = await runOnce(true);

      // The DECISION must be identical either way — same kind, same readings,
      // same cursor, same candidate. droppedDeals is deliberately excluded
      // from that comparison: it reports what planReadings itself removed, so
      // it is empty when the caller already deduped and non-empty when it did
      // not. Asserting the two agree on it would assert the opposite of the
      // property under test.
      const { droppedDeals: rawDropped, ...rawDecision } = withRaw;
      const { droppedDeals: keptDropped, ...keptDecision } = withKept;
      expect(rawDecision).toEqual(keptDecision);

      // And prove the dedupe actually ran inside planReadings, rather than the
      // two runs agreeing because neither dropped anything. Without this pair
      // the test above passes with dedupe removed entirely.
      expect(rawDropped.length).toBeGreaterThan(0);
      expect(keptDropped).toEqual([]);

      if (withRaw.kind !== "halt") throw new Error("expected halt");
      expect(withRaw.candidate.tradeDate).toBe("2026-08-12");
    });

    it("commits the plan, and posts NOT ONE READING on or after the event", async () => {
      const plan = await runOnce();
      const result = await withTestClient((c) =>
        commitReadingPlan(c, { accountId, plan, actorUserId: SEED_MANAGER }),
      );
      expect(result.readingsInserted).toBe(7);
      expect(result.seqs).toEqual([1, 2, 3, 4, 5, 6, 7]);

      const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
      for (const e of entries) {
        expect(e.occurredOn < "2026-08-12").toBe(true);
      }

      const cursor = await withTestClient((c) => getReconcileCursor(c, accountId));
      expect(cursor).toEqual({ lastReadingDate: "2026-08-11" });

      const candidates = await withTestClient((c) => listCandidates(c, accountId, "pending"));
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.tradeDate).toBe("2026-08-12");
      expect(candidates[0]!.unexplainedCents).toBe(500000n);
    });

    it("is idempotent — a second full run changes nothing", async () => {
      const first = await runOnce();
      await withTestClient((c) =>
        commitReadingPlan(c, { accountId, plan: first, actorUserId: SEED_MANAGER }),
      );

      const second = await runOnce();
      const result = await withTestClient((c) =>
        commitReadingPlan(c, { accountId, plan: second, actorUserId: SEED_MANAGER }),
      );

      expect(result.readingsInserted).toBe(0);

      const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
      expect(entries).toHaveLength(7);
      const candidates = await withTestClient((c) => listCandidates(c, accountId));
      expect(candidates).toHaveLength(1);
      const cursor = await withTestClient((c) => getReconcileCursor(c, accountId));
      expect(cursor).toEqual({ lastReadingDate: "2026-08-11" });
    });

    // Section 6.1: no compound_* table stores units, and no writer for a
    // genesis deposit exists in this plan — that lands in plan 4. Folding this
    // account's real ledger is therefore folding SEVEN equity readings and no
    // deposit, which is exactly the state checkInvariants exists to name
    // honestly rather than let assertInvariants throw an unexplained error.
    // This is not "the pipeline is broken" — it is "nobody has funded the pool
    // yet", and it is the one invariant check in this suite that is SUPPOSED
    // to report a violation. Every other code stays absent; that is the part
    // that must not regress.
    it("folds to an orphan-equity state — no deposit, no units, and checkInvariants says exactly that", async () => {
      const plan = await runOnce();
      await withTestClient((c) =>
        commitReadingPlan(c, { accountId, plan, actorUserId: SEED_MANAGER }),
      );

      const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
      const seeds = await withTestClient((c) => getHolderSeeds(c, accountId));
      const state = fold(entries, seeds);

      expect(state.units).toBe(0n);
      expect(state.equityCents).toBe(5_074_500n); // 2026-08-11's equity_close, in cents

      const violations = checkInvariants(state);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.code).toBe("I2_ORPHAN_EQUITY");
    });

    it("keeps a genesis deposit's units untouched by every reading that follows — checkInvariants clean at each one", async () => {
      // Same account, but with the manager's genesis deposit recorded directly
      // (seedLedger, the way this plan's own harness stands in for the
      // deposit writer plan 4 has not built yet — see the file banner).
      // seq 1 is the deposit; the reader's seq therefore starts at 2, which
      // commitReadingPlan computes for itself from max(seq)+1.
      await withTestClient((c) =>
        seedLedger(c, accountId, [
          {
            seq: 1,
            occurredOn: "2026-08-03",
            type: "deposit",
            amountCents: 5_000_000n,
            holderId,
          },
        ]),
      );

      const plan = await runOnce();
      await withTestClient((c) =>
        commitReadingPlan(c, { accountId, plan, actorUserId: SEED_MANAGER }),
      );

      const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
      const seeds = await withTestClient((c) => getHolderSeeds(c, accountId));

      // checkInvariants after EVERY prefix of the replayed ledger, not just at
      // the end — a units-issuing bug hiding behind one of the seven readings
      // would otherwise be invisible until the final fold.
      const unitsAtEachStep: bigint[] = [];
      for (let i = 1; i <= entries.length; i += 1) {
        const prefixState = fold(entries.slice(0, i), seeds);
        expect(checkInvariants(prefixState)).toEqual([]);
        unitsAtEachStep.push(prefixState.units);
      }

      // The deposit is entries[0] (seq 1); every entry after it is a reading.
      // Units must be identical across all of them — a reading moves equity,
      // never units.
      expect(new Set(unitsAtEachStep)).toEqual(new Set([unitsAtEachStep[0]]));
      expect(unitsAtEachStep[0]).toBeGreaterThan(0n);

      const finalState = fold(entries, seeds);
      expect(finalState.equityCents).toBe(5_074_500n);
      expect(() => assertInvariants(finalState)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Part B — a fixture where equity and balance disagree on every day
// ---------------------------------------------------------------------------

describe("Part B: readings carry equity, and the fold reproduces it", () => {
  const MT5 = 9_900_901;
  const MANAGER = "aaaaaaaa-0000-4000-8000-0000000009a1";
  let accountId = 0;
  let holderId = 0;

  beforeAll(async () => {
    await withTestClient(async (c) => {
      await c.query("delete from public.deals where mt5_account = $1", [MT5]);
      await c.query("delete from public.account_snapshots_daily where mt5_account = $1", [MT5]);
      // Balance and equity differ on every day, by design. Without that,
      // "posts equity" and "posts balance" produce identical ledgers and the
      // assertion below could not fail.
      await c.query(
        `insert into public.account_snapshots_daily
           (mt5_account, trade_date, balance_close, equity_close, daily_pnl)
         values ($1, '2026-09-01', 10000.05, 10000.05,   0.00),
                ($1, '2026-09-02', 10123.45, 10150.29, 123.40),
                ($1, '2026-09-03', 10250.13, 10199.87, 126.68)`,
        [MT5],
      );
      await c.query(
        `insert into public.deals
           (mt5_account, ticket, ea_source, symbol, side, volume,
            open_price, close_price, open_time, close_time, profit, swap, commission)
         values ($1, 9909001, 'impulse', 'EURUSD', 'buy', 0.10, 1.0, 1.0,
                 '2026-09-02T07:00:00+00', '2026-09-02T15:00:00+00', 123.40, 0.00, 0.00),
                ($1, 9909002, 'impulse', 'EURUSD', 'buy', 0.10, 1.0, 1.0,
                 '2026-09-03T07:00:00+00', '2026-09-03T15:00:00+00', 126.68, 0.00, 0.00)`,
        [MT5],
      );
    });
  });

  afterAll(async () => {
    await withTestClient(async (c) => {
      await c.query("delete from public.deals where mt5_account = $1", [MT5]);
      await c.query("delete from public.account_snapshots_daily where mt5_account = $1", [MT5]);
    });
  });

  beforeEach(async () => {
    await withTestClient(async (c) => {
      await resetCompoundTables(c);
      await seedUser(c, MANAGER, "roundtrip-b@example.test");
      const acc = await c.query<{ id: string }>(
        `insert into public.compound_account
           (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
         values ($1, 'Divergent Desk', 'USD', 4000, '2026-09-01', $2)
         returning id`,
        [MT5, MANAGER],
      );
      accountId = Number(acc.rows[0]!.id);
      const h = await c.query<{ id: string }>(
        `insert into public.compound_holder
           (account_id, name, is_manager, split_bps, joined_at, status)
         values ($1, 'Manager', true, 4000, '2026-09-01', 'active')
         returning id`,
        [accountId],
      );
      holderId = Number(h.rows[0]!.id);

      // The genesis deposit. Posting deposits is plan 4's writer; here it is
      // inserted directly so the pool has units and the invariants have
      // something to be true about. seq 1, so the reader's readings start at 2.
      await c.query(
        `insert into public.compound_ledger_entry
           (account_id, holder_id, seq, occurred_on, type, amount_cents)
         values ($1, $2, 1, '2026-09-01', 'deposit', 1000005)`,
        [accountId, holderId],
      );
    });
  });

  it("has a fixture where equity and balance really do differ", async () => {
    // Ratchet on the discriminating property itself. If the fixture is ever
    // flattened, the assertion below stops testing anything and this says so.
    const snaps = await withTestClient((c) => getDailySnapshots(c, MT5));
    const divergent = snaps.filter((s) => s.equityCloseCents !== s.balanceCloseCents);
    expect(divergent.length).toBeGreaterThanOrEqual(2);
  });

  it("advances cleanly through every explained day", async () => {
    const plan = await withTestClient(async (c) => {
      const snapshots = await getDailySnapshots(c, MT5);
      const deals = dedupeDeals(await getClosedDeals(c, MT5), BROKER_OFFSET_HOURS).kept;
      const cursor = await getReconcileCursor(c, accountId);
      return planReadings({
        snapshots,
        deals,
        cursor,
        brokerOffsetHours: BROKER_OFFSET_HOURS,
        toleranceCents: 0n,
      });
    });
    expect(plan.kind).toBe("advance");
  });

  it("posts equity_close, not balance_close", async () => {
    const entries = await withTestClient(async (c) => {
      const snapshots = await getDailySnapshots(c, MT5);
      const deals = dedupeDeals(await getClosedDeals(c, MT5), BROKER_OFFSET_HOURS).kept;
      const cursor = await getReconcileCursor(c, accountId);
      const plan = planReadings({
        snapshots,
        deals,
        cursor,
        brokerOffsetHours: BROKER_OFFSET_HOURS,
        toleranceCents: 0n,
      });
      await commitReadingPlan(c, { accountId, plan, actorUserId: MANAGER });
      return getLedgerEntries(c, accountId);
    });

    const readings = entries.filter((e) => e.type === "equity_reading");
    expect(readings.map((e) => e.amountCents)).toEqual([1000005n, 1015029n, 1019987n]);
    // The balance series, for contrast: 1000005, 1012345, 1025013.
    expect(readings.map((e) => e.amountCents)).not.toContain(1012345n);
    expect(readings.map((e) => e.amountCents)).not.toContain(1025013n);
  });

  it("posts exactly the fixture's own equity_close, independent of its literal values", async () => {
    // The test above pins the shipped fixture's specific numbers — good
    // evidence, but it can only stay green for THIS fixture. This one derives
    // its expectation from account_snapshots_daily directly (a second,
    // independent read, not the one the interlock itself used), so it keeps
    // discriminating even if the fixture's numbers ever change — including
    // under the "flatten equity_close to balance_close" probe in this task's
    // report, where the test above necessarily goes red because its literals
    // no longer match, and this one is the one that is SUPPOSED to survive.
    const { entries, snapshots } = await withTestClient(async (c) => {
      const snapshots = await getDailySnapshots(c, MT5);
      const deals = dedupeDeals(await getClosedDeals(c, MT5), BROKER_OFFSET_HOURS).kept;
      const cursor = await getReconcileCursor(c, accountId);
      const plan = planReadings({
        snapshots,
        deals,
        cursor,
        brokerOffsetHours: BROKER_OFFSET_HOURS,
        toleranceCents: 0n,
      });
      await commitReadingPlan(c, { accountId, plan, actorUserId: MANAGER });
      return { entries: await getLedgerEntries(c, accountId), snapshots };
    });

    const byDate = new Map(snapshots.map((s) => [s.tradeDate, s]));
    const readings = entries.filter((e) => e.type === "equity_reading");
    expect(readings.length).toBeGreaterThan(0);
    expect(readings.map((e) => e.amountCents)).toEqual(
      readings.map((e) => byDate.get(e.occurredOn)!.equityCloseCents),
    );
  });

  it("folds to a PoolState that satisfies every invariant", async () => {
    const state = await withTestClient(async (c) => {
      const snapshots = await getDailySnapshots(c, MT5);
      const deals = dedupeDeals(await getClosedDeals(c, MT5), BROKER_OFFSET_HOURS).kept;
      const cursor = await getReconcileCursor(c, accountId);
      const plan = planReadings({
        snapshots,
        deals,
        cursor,
        brokerOffsetHours: BROKER_OFFSET_HOURS,
        toleranceCents: 0n,
      });
      await commitReadingPlan(c, { accountId, plan, actorUserId: MANAGER });
      const entries = await getLedgerEntries(c, accountId);
      const seeds = await getHolderSeeds(c, accountId);
      return fold(entries, seeds);
    });

    expect(() => assertInvariants(state)).not.toThrow();
    expect(state.equityCents).toBe(1019987n);
    expect(state.lastReadingOn).toBe("2026-09-03");
    expect(state.seq).toBe(4);

    const manager = state.holders.find((h) => h.holderId === holderId)!;
    expect(manager.basisCents).toBe(1000005n);
    expect(manager.units).toBeGreaterThan(0n);
    // Invariant 1, stated directly rather than trusted to assertInvariants.
    expect(state.holders.reduce((sum, h) => sum + h.units, 0n)).toBe(state.units);
  });
});

// ---------------------------------------------------------------------------
// Part C — several holders, a payout, and a value past 2^53. No CopyTraderX
// tables: this part is the compound_ledger_entry <-> engine round trip on its
// own, which is a different claim from Parts A and B (they prove the
// reconciler composes with the writer; this proves the writer's OWN data
// composes with the reader and the engine, for the shapes the reconciler
// never produces — a multi-holder payout).
// ---------------------------------------------------------------------------

describe("Part C: several holders, a payout, and a value past 2^53", () => {
  const FUND_MT5 = 9_900_920;
  const FUND_MANAGER = "c0ffee00-0000-4000-8000-0000000009c1";
  const DECOY_MT5 = 9_900_921;
  const DECOY_MANAGER = "c0ffee00-0000-4000-8000-0000000009c2";

  // 2^53 + 1 — the first integer a JavaScript number cannot hold exactly.
  // The same value client.db.test.ts, schema.db.test.ts and
  // commit-plan.db.test.ts already use to prove the WRITE layer round-trips
  // it. Nothing before this task has taken it through fold() — that is the
  // new ground here.
  const PAST_2_53 = 9_007_199_254_740_993n;

  let fundAccountId = 0;
  let decoyAccountId = 0;
  let managerId = 0;
  let investorXId = 0; // split_bps 3500
  let investorYId = 0; // split_bps 2000

  /** The in-memory ledger, built in lock-step with what gets written below. */
  const entries: LedgerEntry[] = [];
  let seeds: HolderSeed[] = [];
  let nextEntryId = 1;

  /** invariant checkpoints captured DURING construction, one per committed step. */
  const checkpoints: Array<{ label: string; violations: ReturnType<typeof checkInvariants> }> = [];

  /**
   * Push one entry onto the in-memory ledger AND insert the identical row
   * into Postgres, inside the given connection. The two are built from the
   * same object on purpose — see the file banner on why this suite compares
   * "folded directly" against "folded after a database round trip" rather
   * than typing two independently-hand-computed numbers that could drift.
   */
  async function commitStep(
    c: Queryable,
    accountId: number,
    e: Omit<LedgerEntry, "id" | "reversesId">,
    label: string,
  ): Promise<LedgerEntry> {
    const full: LedgerEntry = { id: nextEntryId, reversesId: null, ...e };
    nextEntryId += 1;
    entries.push(full);
    await seedLedger(c, accountId, [
      {
        seq: full.seq,
        occurredOn: full.occurredOn,
        type: full.type,
        amountCents: full.amountCents,
        holderId: full.holderId,
        feeSettlement: full.feeSettlement,
        splitBpsApplied: full.splitBpsApplied,
      },
    ]);
    const state = fold(entries, seeds);
    checkpoints.push({ label, violations: checkInvariants(state) });
    return full;
  }

  /**
   * NAV = equity / units. Comparing two fractions without ever dividing:
   *   after.equity/after.units >= before.equity/before.units
   *     <=>  after.equity * before.units >= before.equity * after.units
   * Safe here because every operand in this fixture is positive. This is
   * invariant 3 (spec 3.5) asked directly of the round-tripped figures,
   * independent of anything fold() itself asserts.
   */
  function navDidNotDecrease(
    before: { equityCents: bigint; units: bigint },
    after: { equityCents: bigint; units: bigint },
  ): boolean {
    return after.equityCents * before.units >= before.equityCents * after.units;
  }

  beforeAll(async () => {
    await withTestClient(async (c) => {
      await resetCompoundTables(c);

      // The decoy account, seeded FIRST so its ids are the SMALLEST in the
      // shared compound_holder / compound_ledger_entry tables. That matters:
      // replay.ts resolves the fee-receiving manager with
      // holders.find(h => h.isManager), so if a reader ever forgot its
      // account_id filter, the decoy's manager — not the fund's — would be
      // the one `find` returns, and a fee would land on the wrong account's
      // holder instead of merely adding a harmless extra zero-unit row.
      await seedUser(c, DECOY_MANAGER, "roundtrip-c-decoy@example.test");
      const decoyAcc = await c.query<{ id: string }>(
        `insert into public.compound_account
           (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
         values ($1, 'Decoy Desk', 'USD', 4000, '2026-09-15', $2)
         returning id`,
        [DECOY_MT5, DECOY_MANAGER],
      );
      decoyAccountId = Number(decoyAcc.rows[0]!.id);
      const decoyHolder = await c.query<{ id: string }>(
        `insert into public.compound_holder
           (account_id, name, is_manager, split_bps, joined_at, status)
         values ($1, 'Decoy Manager', true, 4000, '2026-09-15', 'active')
         returning id`,
        [decoyAccountId],
      );
      const decoyHolderId = Number(decoyHolder.rows[0]!.id);
      await seedLedger(c, decoyAccountId, [
        {
          seq: 1,
          occurredOn: "2026-09-15",
          type: "deposit",
          amountCents: 250_037n,
          holderId: decoyHolderId,
        },
      ]);

      // The fund account. Three holders: the manager, and two investors with
      // DIFFERENT splits, so a fee computed against the wrong holder's split
      // would show up as a wrong number rather than an accidentally-correct
      // one.
      await seedUser(c, FUND_MANAGER, "roundtrip-c-fund@example.test");
      const fundAcc = await c.query<{ id: string }>(
        `insert into public.compound_account
           (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
         values ($1, 'Fund Desk', 'USD', 4000, '2026-10-01', $2)
         returning id`,
        [FUND_MT5, FUND_MANAGER],
      );
      fundAccountId = Number(fundAcc.rows[0]!.id);

      const mRow = await c.query<{ id: string }>(
        `insert into public.compound_holder
           (account_id, name, is_manager, split_bps, joined_at, status)
         values ($1, 'Manager', true, 4000, '2026-10-01', 'active')
         returning id`,
        [fundAccountId],
      );
      managerId = Number(mRow.rows[0]!.id);
      const xRow = await c.query<{ id: string }>(
        `insert into public.compound_holder
           (account_id, name, is_manager, split_bps, joined_at, status)
         values ($1, 'Investor X', false, 3500, '2026-10-06', 'active')
         returning id`,
        [fundAccountId],
      );
      investorXId = Number(xRow.rows[0]!.id);
      const yRow = await c.query<{ id: string }>(
        `insert into public.compound_holder
           (account_id, name, is_manager, split_bps, joined_at, status)
         values ($1, 'Investor Y', false, 2000, '2026-10-07', 'active')
         returning id`,
        [fundAccountId],
      );
      investorYId = Number(yRow.rows[0]!.id);

      seeds = [
        { holderId: managerId, isManager: true, splitBps: 4000 },
        { holderId: investorXId, isManager: false, splitBps: 3500 },
        { holderId: investorYId, isManager: false, splitBps: 2000 },
      ];

      // seq 1 — the manager's genesis deposit. Awkward amount: not a round
      // number, so every division downstream is a real one.
      await commitStep(
        c,
        fundAccountId,
        {
          seq: 1,
          occurredOn: "2026-10-01",
          holderId: managerId,
          type: "deposit",
          amountCents: 50_030_071n,
          feeSettlement: null,
          splitBpsApplied: null,
        },
        "after the genesis deposit",
      );

      // seq 2 — a plain equity reading. Proof point: moves equity, not units.
      const beforeReading = totalsOf(fold(entries, seeds));
      await commitStep(
        c,
        fundAccountId,
        {
          seq: 2,
          occurredOn: "2026-10-05",
          holderId: null,
          type: "equity_reading",
          amountCents: 50_130_222n,
          feeSettlement: null,
          splitBpsApplied: null,
        },
        "after the first equity reading",
      );
      const afterReading = totalsOf(fold(entries, seeds));
      expect(afterReading.units).toBe(beforeReading.units);
      expect(afterReading.equityCents).not.toBe(beforeReading.equityCents);

      // seq 3 — Investor X deposits at a real, already-established NAV. Unlike
      // the manager's genesis deposit (NAV defined as 1.00; nothing to
      // compare against), this one prices against equity/units from seq 2.
      const beforeX = totalsOf(fold(entries, seeds));
      await commitStep(
        c,
        fundAccountId,
        {
          seq: 3,
          occurredOn: "2026-10-06",
          holderId: investorXId,
          type: "deposit",
          amountCents: 12_345_678n,
          feeSettlement: null,
          splitBpsApplied: null,
        },
        "after Investor X's non-genesis deposit",
      );
      const afterX = totalsOf(fold(entries, seeds));
      expect(navDidNotDecrease(beforeX, afterX)).toBe(true);

      // seq 4 — Investor Y deposits at the (now different) prevailing NAV.
      const beforeY = totalsOf(fold(entries, seeds));
      await commitStep(
        c,
        fundAccountId,
        {
          seq: 4,
          occurredOn: "2026-10-07",
          holderId: investorYId,
          type: "deposit",
          amountCents: 3_210_987n,
          feeSettlement: null,
          splitBpsApplied: null,
        },
        "after Investor Y's non-genesis deposit",
      );
      const afterY = totalsOf(fold(entries, seeds));
      expect(navDidNotDecrease(beforeY, afterY)).toBe(true);

      // seq 5 — a second plain reading, with real trading profit behind it
      // (roughly +12% of pool equity), so the payout below has a real,
      // comfortably-above-rounding-noise profit to crystallise a fee against.
      const beforeReading2 = totalsOf(fold(entries, seeds));
      await commitStep(
        c,
        fundAccountId,
        {
          seq: 5,
          occurredOn: "2026-10-08",
          holderId: null,
          type: "equity_reading",
          amountCents: beforeReading2.equityCents + 8_040_506n,
          feeSettlement: null,
          splitBpsApplied: null,
        },
        "after the second equity reading",
      );
      const afterReading2 = totalsOf(fold(entries, seeds));
      expect(afterReading2.units).toBe(beforeReading2.units);

      // seq 6 + seq 7 — the payout, atomically. Spec 5.2: "it writes an
      // equity reading capturing the exact equity used, then the payout
      // entry, in one transaction." Both rows are built from the SAME
      // pre-payout state below, and both land in one begin/commit — see the
      // separate describe block for the proof that a failure between them
      // rolls back both.
      const preSettlement = totalsOf(fold(entries, seeds));
      const settlementEquity = preSettlement.equityCents + 654_321n; // a little further live drift

      await c.query("begin");
      try {
        await commitStep(
          c,
          fundAccountId,
          {
            seq: 6,
            occurredOn: "2026-10-09",
            holderId: null,
            type: "equity_reading",
            amountCents: settlementEquity,
            feeSettlement: null,
            splitBpsApplied: null,
          },
          "after the settlement reading (pre-commit)",
        );

        const prePayout = fold(entries, seeds);
        const investorX = prePayout.holders.find((h) => h.holderId === investorXId)!;
        const q = quote({
          totals: totalsOf(prePayout),
          holderUnits: investorX.units,
          basisCents: investorX.basisCents,
          splitBps: 3500,
          isManager: false,
          mode: "profit",
        });
        expect(q.profitCents).toBeGreaterThan(0n);
        expect(q.feeCents).toBeGreaterThan(0n);

        await commitStep(
          c,
          fundAccountId,
          {
            seq: 7,
            occurredOn: "2026-10-09",
            holderId: investorXId,
            type: "payout",
            amountCents: q.toHolderCents,
            feeSettlement: "units",
            splitBpsApplied: 3500,
          },
          "after the atomic payout",
        );
        await c.query("commit");
      } catch (err) {
        await c.query("rollback");
        throw err;
      }

      // seq 8 — one more plain reading, this time jumping straight to a cents
      // value one past 2^53. Placed after the payout on purpose: it touches
      // no per-holder division, so it cannot degrade any holder's units to
      // zero the way an astronomical NAV early in the timeline could.
      const beforeHuge = totalsOf(fold(entries, seeds));
      await commitStep(
        c,
        fundAccountId,
        {
          seq: 8,
          occurredOn: "2026-10-10",
          holderId: null,
          type: "equity_reading",
          amountCents: PAST_2_53,
          feeSettlement: null,
          splitBpsApplied: null,
        },
        "after the reading past 2^53",
      );
      const afterHuge = totalsOf(fold(entries, seeds));
      expect(afterHuge.units).toBe(beforeHuge.units);
      expect(afterHuge.equityCents).toBe(PAST_2_53);
    });
  });

  it("built a fixture with three holders and a real, non-genesis deposit each time", () => {
    // Ratchet on the fixture's own shape, per this project's own lesson about
    // "one account, one manager" fixtures that pass whether or not a filter
    // is doing anything.
    expect(seeds).toHaveLength(3);
    expect(entries).toHaveLength(8);
    expect(entries.filter((e) => e.type === "deposit")).toHaveLength(3);
    expect(entries.filter((e) => e.type === "payout")).toHaveLength(1);
  });

  it("checkInvariants is clean after every one of the eight committed steps, not just the last", () => {
    expect(checkpoints).toHaveLength(8);
    for (const { label, violations } of checkpoints) {
      expect({ label, violations }).toEqual({ label, violations: [] });
    }
  });

  it("carries a cents value one past 2^53 through fold() exactly, not rounded to 2^53", () => {
    const state = fold(entries, seeds);
    expect(state.equityCents).toBe(9_007_199_254_740_993n);
    // For contrast: what a JS number would have silently done to it.
    expect(Number(state.equityCents)).toBe(9_007_199_254_740_992);
    expect(state.equityCents).not.toBe(BigInt(Number(state.equityCents)));
  });

  it("matches a direct fold exactly — the database round trip loses nothing", async () => {
    const expectedState = fold(entries, seeds);
    expect(() => assertInvariants(expectedState)).not.toThrow();

    const actualState = await withTestClient(async (c) => {
      const dbEntries = await getLedgerEntries(c, fundAccountId);
      const dbSeeds = await getHolderSeeds(c, fundAccountId);
      return fold(dbEntries, dbSeeds);
    });

    // The headline claim: folding what came back from Postgres reproduces
    // EXACTLY the state folding the in-memory ledger produces. Not close —
    // equal, field for field, holder for holder.
    expect(actualState).toEqual(expectedState);
    expect(() => assertInvariants(actualState)).not.toThrow();

    // A few figures called out by name, so a failure here reads as "the fee
    // is wrong" rather than only "the objects differ somewhere".
    expect(actualState.equityCents).toBe(9_007_199_254_740_993n);
    expect(actualState.holders).toHaveLength(3);
    const manager = actualState.holders.find((h) => h.holderId === managerId)!;
    const investorX = actualState.holders.find((h) => h.holderId === investorXId)!;
    expect(manager.basisCents).toBeGreaterThan(50_030_071n); // grew: retained the fee as units
    expect(investorX.basisCents).toBe(12_345_678n); // profit taken, principal basis unchanged
    expect(investorX.status).toBe("active"); // a "profit" payout, not an exit — still in the pool
  });

  it("does not leak the decoy account's rows into the fund's fold", async () => {
    // The decoy is real and non-empty — this is not a two-account fixture
    // where the "other" account happens to be empty, which would pass whether
    // or not a reader's account_id filter was doing anything. Both counts
    // matter: the decoy's presence is what makes the fund-side counts below
    // an actual isolation proof rather than an assertion that would hold in
    // an empty database too.
    const decoyEntries = await withTestClient((c) => getLedgerEntries(c, decoyAccountId));
    const decoySeeds = await withTestClient((c) => getHolderSeeds(c, decoyAccountId));
    expect(decoyEntries).toHaveLength(1);
    expect(decoySeeds).toHaveLength(1);

    const dbEntries = await withTestClient((c) => getLedgerEntries(c, fundAccountId));
    const dbSeeds = await withTestClient((c) => getHolderSeeds(c, fundAccountId));
    expect(dbEntries).toHaveLength(8);
    expect(dbSeeds).toHaveLength(3);
    expect(dbSeeds.map((s) => s.holderId)).not.toContain(decoySeeds[0]!.holderId);
  });
});

// ---------------------------------------------------------------------------
// Part C, continued — the payout's settlement reading commits atomically.
// A separate, smaller fixture: this is a schema/transaction-mechanics claim
// ("both rows land together, or neither does"), not an arithmetic one — the
// payout figures above already prove the arithmetic. Using a simple,
// schema-valid number here keeps the two concerns apart.
// ---------------------------------------------------------------------------

describe("Part C: the payout's settlement reading, committed atomically", () => {
  const MT5 = 9_900_922;
  const MANAGER = "c0ffee00-0000-4000-8000-0000000009c3";
  let accountId = 0;
  let holderId = 0;

  beforeEach(async () => {
    await withTestClient(async (c) => {
      await resetCompoundTables(c);
      await seedUser(c, MANAGER, "roundtrip-c-atomic@example.test");
      const acc = await c.query<{ id: string }>(
        `insert into public.compound_account
           (mt5_account, label, currency, default_split_bps, inception_date, manager_user_id)
         values ($1, 'Atomicity Probe', 'USD', 4000, '2026-10-01', $2)
         returning id`,
        [MT5, MANAGER],
      );
      accountId = Number(acc.rows[0]!.id);
      const h = await c.query<{ id: string }>(
        `insert into public.compound_holder
           (account_id, name, is_manager, split_bps, joined_at, status)
         values ($1, 'Manager', true, 4000, '2026-10-01', 'active')
         returning id`,
        [accountId],
      );
      holderId = Number(h.rows[0]!.id);
      await seedLedger(c, accountId, [
        { seq: 1, occurredOn: "2026-10-01", type: "deposit", amountCents: 1_000_000n, holderId },
      ]);
    });
  });

  it("both rows land together, inside one transaction", async () => {
    await withTestClient(async (c) => {
      await c.query("begin");
      try {
        await seedLedger(c, accountId, [
          { seq: 2, occurredOn: "2026-10-05", type: "equity_reading", amountCents: 1_050_000n },
          {
            seq: 3,
            occurredOn: "2026-10-05",
            type: "payout",
            amountCents: 32_500n,
            holderId,
            feeSettlement: "units",
            splitBpsApplied: 0,
          },
        ]);
        await c.query("commit");
      } catch (err) {
        await c.query("rollback");
        throw err;
      }
    });

    const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
    expect(entries.map((e) => e.type)).toEqual(["deposit", "equity_reading", "payout"]);
  });

  it("rolls back BOTH rows when the second insert fails inside the same transaction", async () => {
    const before = await withTestClient((c) =>
      sequenceConsumed(c, "public.compound_ledger_entry", "id"),
    );

    // The settlement reading would succeed on its own; the payout that
    // follows it collides on (account_id, seq) with the deposit seeded in
    // beforeEach (seq 1), which must abort the WHOLE transaction — reading
    // included — not just the row that violated the constraint.
    await expectPgError(
      withTestClient(async (c) => {
        await c.query("begin");
        try {
          await seedLedger(c, accountId, [
            { seq: 2, occurredOn: "2026-10-05", type: "equity_reading", amountCents: 1_050_000n },
          ]);
          await seedLedger(c, accountId, [
            {
              seq: 1, // collides with the beforeEach deposit
              occurredOn: "2026-10-05",
              type: "payout",
              amountCents: 10_000n,
              holderId,
              feeSettlement: "units",
              splitBpsApplied: 0,
            },
          ]);
          await c.query("commit");
        } catch (err) {
          await c.query("rollback");
          throw err;
        }
      }),
      "23505",
      /compound_ledger_entry_account_seq_key/,
    );

    // The sequence advanced — the reading's INSERT really executed — even
    // though the row it produced is gone. The same technique Task 8 uses to
    // prove a rollback undid real writes, not writes that never happened.
    const after = await withTestClient((c) =>
      sequenceConsumed(c, "public.compound_ledger_entry", "id"),
    );
    expect(after).toBeGreaterThan(before);

    const entries = await withTestClient((c) => getLedgerEntries(c, accountId));
    expect(entries).toHaveLength(1); // only the beforeEach deposit; the reading did not survive
    expect(entries[0]!.type).toBe("deposit");
  });
});
