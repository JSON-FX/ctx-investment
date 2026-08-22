/**
 * Integration. Runs under jest.db.config.mjs against the local stack.
 *
 * Deviations from the plan's Task 14 Step 8 draft, each checked against real
 * code rather than assumed — the same discipline write-account.db.test.ts and
 * holders.db.test.ts already documented for this same plan's Task 4 and 6
 * drafts:
 *
 *   1. seedTwoAccounts/seedUser live at lib/compound/db/testing/harness.ts,
 *      not "@/lib/compound/db/test-harness", and return
 *      { accountA, accountB }, each { accountId, managerUserId, holderIds }
 *      — not { mine, theirs } with a bare managerHolderId. accountA seeds a
 *      manager plus one investor, in that insertion order, so
 *      accountA.holderIds[0] is the manager.
 *
 *   2. commitDeposit (write-deposit.ts, Task 12) does not exist in this
 *      worktree — Task 12 was still in progress in a sibling worktree at the
 *      time this file was written, on the same base commit, with nothing to
 *      import yet. The tests below that need an already-recorded ledger entry
 *      (the "match" case) seed one with a direct insert instead, matching how
 *      commit-plan.db.test.ts seeds its own fixtures directly rather than
 *      through another task's writer. The "unfreezes" and "does NOT let one
 *      candidate's classification skip another" tests use commitReadingPlan
 *      (lib/compound/db/commit-plan.ts, Task 5, already merged) to create
 *      genuine pending candidates through the same writer production uses,
 *      rather than a bare row insert — see the describe block below for why
 *      that distinction turned out to matter.
 *
 *   3. Isolation is resetCompoundTables in beforeEach (withTestClient), not
 *      per-test transaction rollback. seedTwoAccounts writes auth.users,
 *      which only postgres can do; classifyCandidate's real caller
 *      (app/a/[id]/actions/actions.ts's `classify`) runs it through
 *      withAuthenticatedDb, connected as the account's own manager — so the
 *      writer under test runs through withAuthenticatedDb here too,
 *      exercising the same helper, role and RLS policy the app actually
 *      uses, the same reasoning write-account.db.test.ts gives for the
 *      identical split.
 *
 *   4. CX208 IS used for the bad-outcome check, same as the plan's draft —
 *      but only after checking, not by trusting the draft. Task 13's
 *      compound_commit_payout also raises CX208 for two of its own checks
 *      ("mode must be payout or exit", "fee settlement must be units or
 *      cash"), which first looked like a real collision: explainCommitError
 *      maps a code to one message with no knowledge of which function
 *      raised it, so a third meaning on the same code seemed like it would
 *      surface the wrong sentence, and this file briefly used CX212
 *      instead. The seam's actual, merged errors.ts settled it: CX208's
 *      registered message is the deliberately generic "That is not a valid
 *      choice for this form. Nothing was committed.", reused across Tasks
 *      12-14 for exactly this class of refusal — confirmed directly by the
 *      seam owner. Back to CX208, matching the migration.
 */
import { closePool, withAuthenticatedDb } from "@/lib/compound/db/client";
import { commitReadingPlan } from "@/lib/compound/db/commit-plan";
import { getLedgerEntries, listCandidates } from "@/lib/compound/db/compound";
import { classifyCandidate, type ClassifyInput } from "@/lib/compound/db/write-classify";
import {
  closeTestPool,
  expectPgError,
  resetCompoundTables,
  seedTwoAccounts,
  sequenceConsumed,
  withTestClient,
} from "@/lib/compound/db/testing/harness";
import { LOCAL_SUPABASE_DB_URL } from "@/lib/compound/db/testing/env";
import type { ReadingPlan } from "@/lib/compound/reconcile/interlock";

const ORIGINAL_DATABASE_URL = process.env.COMPOUND_DATABASE_URL;

beforeAll(() => {
  process.env.COMPOUND_DATABASE_URL =
    process.env.COMPOUND_TEST_DATABASE_URL || LOCAL_SUPABASE_DB_URL;
});

beforeEach(async () => {
  await withTestClient((c) => resetCompoundTables(c));
});

afterAll(async () => {
  await closePool();
  await closeTestPool();
  process.env.COMPOUND_DATABASE_URL = ORIGINAL_DATABASE_URL;
});

/** A pending candidate, inserted directly — the schema's own shortcut, not
 * the reconciler's. Fine for tests that only care about classification's
 * effect on ONE candidate row; the "does not let one skip another" describe
 * block below deliberately seeds through commitReadingPlan instead, because
 * that is the writer that actually decides whether a reading can cross one. */
async function seedCandidate(
  accountId: number,
  tradeDate: string,
  unexplainedCents = 500_000n,
): Promise<number> {
  const { rows } = await withTestClient((c) =>
    c.query<{ id: string }>(
      `insert into public.compound_capital_event_candidate
         (account_id, trade_date, balance_delta_cents, explained_cents, unexplained_cents)
       values ($1, $2, $3, 0, $3) returning id`,
      [accountId, tradeDate, unexplainedCents.toString()],
    ),
  );
  return Number(rows[0]!.id);
}

/** A ledger entry recorded some other way (by hand, or by a writer this file
 * does not import), for the "match an existing entry" path to point at. */
async function seedManualDeposit(
  accountId: number,
  holderId: number,
  occurredOn: string,
  amountCents: bigint,
  actorUserId: string,
): Promise<number> {
  const { rows } = await withTestClient((c) =>
    c.query<{ id: string }>(
      `insert into public.compound_ledger_entry
         (account_id, holder_id, seq, occurred_on, type, amount_cents, created_by)
       values ($1, $2,
               (select coalesce(max(seq), 0) + 1 from public.compound_ledger_entry
                 where account_id = $1),
               $3, 'deposit', $4, $5)
       returning id`,
      [accountId, holderId, occurredOn, amountCents.toString(), actorUserId],
    ),
  );
  return Number(rows[0]!.id);
}

// Unused in this file today (kept for parity with reconcile.db.test.ts's
// own helper of the same name) — cheap to keep correct rather than delete.
async function currentSeq(managerUserId: string, accountId: number): Promise<number> {
  const entries = await withAuthenticatedDb(managerUserId, (c) => getLedgerEntries(c, accountId));
  return entries.reduce((m, e) => (e.seq > m ? e.seq : m), 0);
}

function classifyInput(over: Partial<ClassifyInput> & { accountId: number; candidateId: number; expectedSeq: number }): ClassifyInput {
  return {
    outcome: "ignore",
    holderId: null,
    amountCents: null,
    matchEntryId: null,
    note: "Broker rebate, confirmed by support ticket 4471",
    actorUserId: "aaaaaaaa-0000-4000-8000-0000000000a1",
    ...over,
  };
}

describe("classifyCandidate — as a deposit", () => {
  it("writes an entry dated on the event's own day, not today", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const managerId = accountA.holderIds[0]!;
    const candidateId = await seedCandidate(accountA.accountId, "2026-08-12");

    const { ledgerEntryId } = await withAuthenticatedDb(accountA.managerUserId, (c) =>
      classifyCandidate(c, classifyInput({
        accountId: accountA.accountId, candidateId, outcome: "deposit",
        holderId: managerId, amountCents: 500_000n, note: null,
        expectedSeq: 0, actorUserId: accountA.managerUserId,
      })),
    );

    const entry = (await withAuthenticatedDb(accountA.managerUserId, (c) => getLedgerEntries(c, accountA.accountId)))
      .find((e) => e.id === ledgerEntryId)!;
    expect(entry.type).toBe("deposit");
    expect(entry.occurredOn).toBe("2026-08-12");
    expect(entry.amountCents).toBe(500_000n);
    expect(entry.holderId).toBe(managerId);
  });

  it("resolves the candidate and points it at the entry it created", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const managerId = accountA.holderIds[0]!;
    const candidateId = await seedCandidate(accountA.accountId, "2026-08-12");

    const { ledgerEntryId } = await withAuthenticatedDb(accountA.managerUserId, (c) =>
      classifyCandidate(c, classifyInput({
        accountId: accountA.accountId, candidateId, outcome: "deposit",
        holderId: managerId, amountCents: 500_000n, note: null,
        expectedSeq: 0, actorUserId: accountA.managerUserId,
      })),
    );

    expect(await withAuthenticatedDb(accountA.managerUserId, (c) => listCandidates(c, accountA.accountId, "pending"))).toEqual([]);
    const { rows } = await withTestClient((c) =>
      c.query<{ status: string; resolved_ledger_entry_id: string | null }>(
        `select status, resolved_ledger_entry_id
           from public.compound_capital_event_candidate where id = $1`,
        [candidateId],
      ),
    );
    expect(rows[0]!.status).toBe("classified");
    expect(Number(rows[0]!.resolved_ledger_entry_id)).toBe(ledgerEntryId);
  });

  it("refuses a non-positive amount locally, with no round trip, CX211 shape", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const managerId = accountA.holderIds[0]!;
    const candidateId = await seedCandidate(accountA.accountId, "2026-08-12");
    await expect(withAuthenticatedDb(accountA.managerUserId, (c) =>
      classifyCandidate(c, classifyInput({
        accountId: accountA.accountId, candidateId, outcome: "deposit",
        holderId: managerId, amountCents: 0n, note: null, expectedSeq: 0,
      })),
    )).rejects.toThrow(/needs a positive amount/);
  });

  it("refuses a holder from another account, with CX205", async () => {
    const { accountA, accountB } = await withTestClient((c) => seedTwoAccounts(c));
    const otherManagerId = accountB.holderIds[0]!;
    const candidateId = await seedCandidate(accountA.accountId, "2026-08-12");
    await expectPgError(
      withAuthenticatedDb(accountA.managerUserId, (c) =>
        classifyCandidate(c, classifyInput({
          accountId: accountA.accountId, candidateId, outcome: "deposit",
          holderId: otherManagerId, amountCents: 500_000n, note: null, expectedSeq: 0,
        })),
      ),
      "CX205",
      /is not on account/,
    );
  });
});

describe("classifyCandidate — refuses to double-classify, CX203", () => {
  it("refuses the same candidate twice, and only one deposit exists for it", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const managerId = accountA.holderIds[0]!;
    const candidateId = await seedCandidate(accountA.accountId, "2026-08-12");

    await withAuthenticatedDb(accountA.managerUserId, (c) =>
      classifyCandidate(c, classifyInput({
        accountId: accountA.accountId, candidateId, outcome: "deposit",
        holderId: managerId, amountCents: 500_000n, note: null, expectedSeq: 0,
      })),
    );

    await expectPgError(
      withAuthenticatedDb(accountA.managerUserId, (c) =>
        classifyCandidate(c, classifyInput({
          accountId: accountA.accountId, candidateId, outcome: "deposit",
          holderId: managerId, amountCents: 500_000n, note: null, expectedSeq: 1,
        })),
      ),
      "CX203",
      /is already classified/,
    );

    const deposits = (await withAuthenticatedDb(accountA.managerUserId, (c) => getLedgerEntries(c, accountA.accountId)))
      .filter((e) => e.type === "deposit" && e.occurredOn === "2026-08-12");
    expect(deposits).toHaveLength(1);
  });

  it("refuses a candidate id that does not exist, also CX203", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    await expectPgError(
      withAuthenticatedDb(accountA.managerUserId, (c) =>
        classifyCandidate(c, classifyInput({
          accountId: accountA.accountId, candidateId: 999_999, expectedSeq: 0,
        })),
      ),
      "CX203",
      /no candidate/,
    );
  });
});

describe("classifyCandidate — as ignore", () => {
  it("requires a note locally, with no round trip", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const candidateId = await seedCandidate(accountA.accountId, "2026-08-12");
    await expect(withAuthenticatedDb(accountA.managerUserId, (c) =>
      classifyCandidate(c, classifyInput({
        accountId: accountA.accountId, candidateId, outcome: "ignore", note: "   ", expectedSeq: 0,
      })),
    )).rejects.toThrow(/requires a note/);
  });

  it("writes no ledger entry and sets status to ignored, not classified", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const candidateId = await seedCandidate(accountA.accountId, "2026-08-12");

    const { ledgerEntryId } = await withAuthenticatedDb(accountA.managerUserId, (c) =>
      classifyCandidate(c, classifyInput({
        accountId: accountA.accountId, candidateId, outcome: "ignore", expectedSeq: 0,
      })),
    );
    expect(ledgerEntryId).toBeNull();
    expect(await withAuthenticatedDb(accountA.managerUserId, (c) => getLedgerEntries(c, accountA.accountId))).toEqual([]);

    const { rows } = await withTestClient((c) =>
      c.query<{ status: string }>(
        `select status from public.compound_capital_event_candidate where id = $1`,
        [candidateId],
      ),
    );
    expect(rows[0]!.status).toBe("ignored");
  });
});

describe("classifyCandidate — matching an existing entry, without double-counting", () => {
  it("writes no new entry and points the candidate at the one already recorded", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const managerId = accountA.holderIds[0]!;
    const existingId = await seedManualDeposit(
      accountA.accountId, managerId, "2026-03-02", 2_500_000n, accountA.managerUserId,
    );
    const candidateId = await seedCandidate(accountA.accountId, "2026-08-12");
    const before = (await withAuthenticatedDb(accountA.managerUserId, (c) => getLedgerEntries(c, accountA.accountId))).length;

    const r = await withAuthenticatedDb(accountA.managerUserId, (c) =>
      classifyCandidate(c, classifyInput({
        accountId: accountA.accountId, candidateId, outcome: "match",
        matchEntryId: existingId, expectedSeq: 1,
      })),
    );

    expect(r.ledgerEntryId).toBe(existingId);
    // The count that actually proves no double-count: same number of rows
    // after matching as before it, not merely "a row exists".
    expect((await withAuthenticatedDb(accountA.managerUserId, (c) => getLedgerEntries(c, accountA.accountId))).length).toBe(before);
  });

  it("refuses an entry belonging to another account, with CX210", async () => {
    const { accountA, accountB } = await withTestClient((c) => seedTwoAccounts(c));
    const theirManagerId = accountB.holderIds[0]!;
    const theirEntry = await seedManualDeposit(
      accountB.accountId, theirManagerId, "2026-03-02", 100n, accountB.managerUserId,
    );
    const candidateId = await seedCandidate(accountA.accountId, "2026-08-12");

    await expectPgError(
      withAuthenticatedDb(accountA.managerUserId, (c) =>
        classifyCandidate(c, classifyInput({
          accountId: accountA.accountId, candidateId, outcome: "match",
          matchEntryId: theirEntry, expectedSeq: 0,
        })),
      ),
      "CX210",
      /is not on account/,
    );
  });
});

describe("classifyCandidate — input validation reaching the database", () => {
  it("refuses an outcome that is not deposit, match or ignore, with CX208", async () => {
    // CX208 is deliberately shared with compound_commit_payout's two enum
    // checks — errors.ts registers one generic "not a valid choice" message
    // for the code, not a per-function one. This is still the test that
    // would catch reusing the WRONG code here: expectPgError fails on the
    // CODE, not just on "it threw".
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const candidateId = await seedCandidate(accountA.accountId, "2026-08-12");
    await expectPgError(
      withAuthenticatedDb(accountA.managerUserId, (c) =>
        // Cast through unknown: ClassifyOutcome correctly disallows this at
        // the type level. Only a test that wants to hit the database's own
        // check directly needs to bypass it.
        classifyCandidate(c, classifyInput({
          accountId: accountA.accountId, candidateId,
          outcome: "typo" as unknown as ClassifyInput["outcome"], expectedSeq: 0,
        })),
      ),
      "CX208",
      /outcome must be deposit, match or ignore/,
    );
  });

  it("refuses when the account has moved since the receipt, with CX204", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const managerId = accountA.holderIds[0]!;
    // Move the account by one seq so expectedSeq: 0 is stale.
    await seedManualDeposit(accountA.accountId, managerId, "2026-01-01", 100n, accountA.managerUserId);
    const candidateId = await seedCandidate(accountA.accountId, "2026-08-12");

    await expectPgError(
      withAuthenticatedDb(accountA.managerUserId, (c) =>
        classifyCandidate(c, classifyInput({
          accountId: accountA.accountId, candidateId, outcome: "ignore", expectedSeq: 0,
        })),
      ),
      "CX204",
      /account is at entry 1 and the receipt was worked out at entry 0/,
    );
    // Nothing was written for the refused attempt: still pending, no second entry.
    expect(await withAuthenticatedDb(accountA.managerUserId, (c) => listCandidates(c, accountA.accountId, "pending"))).toHaveLength(1);
  });
});

describe("classifyCandidate — a forced failure mid-write rolls back everything, having actually written first", () => {
  const AUDIT = "public.compound_audit";
  const LEDGER = "public.compound_ledger_entry";

  it("leaves no ledger row and the candidate still pending, after proving the ledger insert really ran", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const managerId = accountA.holderIds[0]!;
    const candidateId = await seedCandidate(accountA.accountId, "2026-08-12");

    // Force compound_classify_candidate's LAST statement (the audit insert)
    // to fail, after its ledger insert and its candidate update have already
    // run inside the same function call. Revoking a grant mid-test is
    // restored in the finally block below, unconditionally — this touches a
    // database-level object that outlives this test file if left revoked.
    //
    // Revoked from `authenticated`, not `service_role`: classifyCandidate now
    // runs through withAuthenticatedDb, so authenticated is the grant that
    // actually has to bind for this revoke to reach the write at all. Revoking
    // service_role's grant (the pre-task target) would revoke a privilege
    // nothing in this call path uses any more, and the insert would succeed
    // right through it — the exact "test that could not fail" shape this
    // project's own lessons table warns about.
    await withTestClient((c) => c.query(`revoke insert on ${AUDIT} from authenticated`));

    const before = await withTestClient((c) => sequenceConsumed(c, LEDGER, "id"));

    try {
      await expect(withAuthenticatedDb(accountA.managerUserId, (c) =>
        classifyCandidate(c, classifyInput({
          accountId: accountA.accountId, candidateId, outcome: "deposit",
          holderId: managerId, amountCents: 500_000n, note: null, expectedSeq: 0,
        })),
      )).rejects.toThrow(/permission denied/);
    } finally {
      await withTestClient((c) => c.query(`grant insert on ${AUDIT} to authenticated`));
    }

    // The proof that the earlier statements actually executed before the
    // rollback: the id sequence advanced. Without revoking the audit grant,
    // this whole test would pass even if the guard fired before any write —
    // sequenceConsumed is what makes "leaves no row" mean atomicity rather
    // than "never tried".
    const after = await withTestClient((c) => sequenceConsumed(c, LEDGER, "id"));
    expect(after - before).toBe(1);

    // And yet, post-rollback, nothing is actually there.
    expect(await withAuthenticatedDb(accountA.managerUserId, (c) => getLedgerEntries(c, accountA.accountId))).toEqual([]);
    const { rows } = await withTestClient((c) =>
      c.query<{ status: string; resolved_ledger_entry_id: string | null }>(
        `select status, resolved_ledger_entry_id
           from public.compound_capital_event_candidate where id = $1`,
        [candidateId],
      ),
    );
    expect(rows[0]).toEqual({ status: "pending", resolved_ledger_entry_id: null });
  });
});

describe("classifyCandidate — several pending candidates, one whose classification does not touch another", () => {
  it("classifying the later of two adjacent-day candidates leaves the earlier one untouched", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const earlyId = await seedCandidate(accountA.accountId, "2026-08-10", 250_000n);
    const lateId = await seedCandidate(accountA.accountId, "2026-08-11", -157_836n);

    await withAuthenticatedDb(accountA.managerUserId, (c) =>
      classifyCandidate(c, classifyInput({
        accountId: accountA.accountId, candidateId: lateId, outcome: "ignore",
        note: "Broker correction, confirmed 2026-08-13", expectedSeq: 0,
      })),
    );

    const { rows } = await withTestClient((c) =>
      c.query<{ id: string; status: string; resolved_ledger_entry_id: string | null }>(
        `select id, status, resolved_ledger_entry_id
           from public.compound_capital_event_candidate
          where account_id = $1 order by trade_date`,
        [accountA.accountId],
      ),
    );
    expect(rows).toEqual([
      { id: String(earlyId), status: "pending", resolved_ledger_entry_id: null },
      { id: String(lateId), status: "ignored", resolved_ledger_entry_id: null },
    ]);

    const pending = await withAuthenticatedDb(accountA.managerUserId, (c) => listCandidates(c, accountA.accountId, "pending"));
    expect(pending.map((k) => k.id)).toEqual([earlyId]);
  });

  it("classifying one candidate three times over does not change a third, unrelated one's status", async () => {
    // Same property, restated with a candidate that is never touched at all
    // (not classified, not attempted) — the strongest version of "did not
    // reach it": there is no call anywhere in this test that names its id.
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const a = await seedCandidate(accountA.accountId, "2026-08-05", 10_000n);
    const b = await seedCandidate(accountA.accountId, "2026-08-06", 20_000n);
    const untouched = await seedCandidate(accountA.accountId, "2026-08-20", 30_000n);

    // Both classified as "ignore", which writes no ledger entry — so the
    // account's seq never moves off 0 between these two calls. A deposit
    // outcome would need expectedSeq: 1 for the second call instead.
    for (const id of [a, b]) {
      await withAuthenticatedDb(accountA.managerUserId, (c) =>
        classifyCandidate(c, classifyInput({
          accountId: accountA.accountId, candidateId: id, outcome: "ignore",
          note: "Reviewed", expectedSeq: 0,
        })),
      );
    }

    const { rows } = await withTestClient((c) =>
      c.query<{ status: string }>(
        `select status from public.compound_capital_event_candidate where id = $1`,
        [untouched],
      ),
    );
    expect(rows[0]!.status).toBe("pending");
  });
});

describe("the persistence-boundary gap this task found: compound_commit_reading_plan has no independent pending-candidate check", () => {
  // compound_commit_deposit (Task 12) and compound_commit_payout (Task 13),
  // read directly from the plan, both run an independent query —
  //   select min(trade_date) from compound_capital_event_candidate
  //    where account_id = $1 and status = 'pending'
  // — before allowing a write, so a NEW pending candidate that call did not
  // create still blocks it. compound_commit_reading_plan (Task 5, already
  // merged, "finished" — not modified here) does not: its CX002 check only
  // fires when the CALLER passes p_candidate in that same call. A hand-built
  // advance plan (candidate always null) reaches it with nothing to check
  // against, regardless of what else is pending on the account. This
  // describe block proves that gap empirically, using only already-merged
  // code (commitReadingPlan) plus this task's own classifyCandidate.
  //
  // This was flagged to the seam owner (Task 11) while both were still in
  // progress, before either side had this proof: postReading's draft built
  // exactly this kind of plan and had nothing standing between it and the
  // gap below. The seam owner confirmed it by reading the same SQL and
  // fixed it at the CALLER level — postReading now re-runs planFor at
  // commit time and refuses unless the outcome is idle, closing the door
  // this describe block walks through. The underlying gap in
  // compound_commit_reading_plan itself is unchanged (Task 5's file, out of
  // both tasks' scope to modify) — what changed is that nothing in this
  // product still reaches it with a plan built the way this test builds
  // one. The tests below are kept as regression coverage for that
  // boundary, not as a report of a currently-live hole.
  //
  // They also answer this task's central question directly: classifying
  // one candidate cannot, by itself, move any reading past another
  // (compound_classify_candidate never touches the cursor or any OTHER
  // candidate row — see the describe block above). What CAN move a reading
  // past a still-pending candidate is a hand-built advance plan reaching
  // compound_commit_reading_plan with no candidate attached — a property of
  // Task 5's writer, not of classification, and (as of the seam's fix) no
  // longer reachable through this product's own UI.

  it("classifying the earlier of two pending candidates does not, by itself, let a reading commit dated after the later one", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const managerId = accountA.holderIds[0]!;

    // Two genuine halts, recorded through the real writer, exactly as the
    // reconciler would leave them behind — not a raw row insert.
    await withAuthenticatedDb(accountA.managerUserId, (c) => commitReadingPlan(c, {
      accountId: accountA.accountId, actorUserId: accountA.managerUserId,
      plan: {
        kind: "halt", readings: [], newCursorDate: null,
        candidate: {
          tradeDate: "2026-08-10", previousDate: "2026-08-09",
          balanceDeltaCents: 500_000n, explainedCents: 0n, unexplainedCents: 500_000n,
        },
        droppedDeals: [],
      } satisfies ReadingPlan,
    }));
    const early = (await withAuthenticatedDb(accountA.managerUserId, (c) => listCandidates(c, accountA.accountId, "pending")))[0]!;
    expect(early.tradeDate).toBe("2026-08-10");

    // Classify the EARLIER candidate only.
    await withAuthenticatedDb(accountA.managerUserId, (c) =>
      classifyCandidate(c, classifyInput({
        accountId: accountA.accountId, candidateId: early.id, outcome: "ignore",
        note: "Reviewed 2026-08-13", expectedSeq: 0,
      })),
    );

    // A second, later, still-pending candidate the manager has NOT touched.
    await withAuthenticatedDb(accountA.managerUserId, (c) => commitReadingPlan(c, {
      accountId: accountA.accountId, actorUserId: accountA.managerUserId,
      plan: {
        kind: "halt", readings: [], newCursorDate: null,
        candidate: {
          tradeDate: "2026-08-12", previousDate: "2026-08-11",
          balanceDeltaCents: -157_836n, explainedCents: 0n, unexplainedCents: -157_836n,
        },
        droppedDeals: [],
      } satisfies ReadingPlan,
    }));
    const pendingAfter = await withAuthenticatedDb(accountA.managerUserId, (c) => listCandidates(c, accountA.accountId, "pending"));
    expect(pendingAfter.map((k) => k.tradeDate)).toEqual(["2026-08-12"]);

    // THE GAP: a hand-built advance plan (what postReading's draft sends —
    // no candidate attached) dated after the still-pending 2026-08-12
    // candidate. compound_commit_deposit / compound_commit_payout would
    // refuse this with CX002 via their own independent query.
    // compound_commit_reading_plan does not, because nothing here passed it
    // a p_candidate for THIS call.
    const result = await withAuthenticatedDb(accountA.managerUserId, (c) => commitReadingPlan(c, {
      accountId: accountA.accountId, actorUserId: accountA.managerUserId,
      plan: {
        kind: "advance",
        readings: [{ occurredOn: "2026-08-15", equityCents: 6_000_000n }],
        newCursorDate: "2026-08-15",
        droppedDeals: [],
      } satisfies ReadingPlan,
    }));

    // This SUCCEEDING is the finding, not the desired behaviour: a reading
    // landed on 2026-08-15, on or after the 2026-08-12 candidate's date,
    // while that candidate is still pending. NAV crossed an unclassified
    // capital event through this door. Flagged to the seam owner (Task 11)
    // as a gap in postReading's draft, not fixed here — commit-plan.ts and
    // compound_commit_reading_plan are Task 5's and out of this task's scope
    // to modify.
    expect(result.readingsInserted).toBe(1);
    expect(result.cursorDate).toBe("2026-08-15");
    const stillPending = await withAuthenticatedDb(accountA.managerUserId, (c) => listCandidates(c, accountA.accountId, "pending"));
    expect(stillPending.map((k) => k.tradeDate)).toEqual(["2026-08-12"]);
  });

  // it.todo, not a body that always passes: compound_commit_payout does not
  // exist in this worktree yet (Task 13 is a sibling, still in progress),
  // so there is nothing to call. An `expect(true).toBe(true)` here would be
  // exactly the shape of assertion this plan's own lessons table warns
  // against — it would stay green forever regardless of what Task 13 ships.
  // Once compound_commit_payout lands, replace this with a real call proving
  // it refuses a payout dated on/after a pending candidate THAT CALL did not
  // create, via its own independent query — the property this describe
  // block shows compound_commit_reading_plan lacks.
  it.todo(
    "compound_commit_payout's independent pending-candidate check (Task 13) refuses the equivalent case — verify once Task 13 lands",
  );
});
