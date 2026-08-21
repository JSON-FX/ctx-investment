/**
 * Integration. Runs under jest.db.config.mjs against the local stack.
 *
 * Follows holders.db.test.ts's pattern rather than this task's own plan
 * text: seedTwoAccounts calls seedUser, which inserts into auth.users — a
 * write only postgres (or supabase_auth_admin) can make, and service_role
 * cannot. Seeding therefore runs on the harness's postgres-connected pool
 * (withTestClient); listLedgerMeta itself still runs through client.ts's
 * withDb, the same service_role pool requireAccount and every other loader
 * borrow in production.
 *
 * Two disagreements between this task's plan draft and the real harness,
 * checked against a real run rather than assumed — the same two
 * holders.db.test.ts already documents for its own file, reconfirmed here
 * because this file hits both independently:
 *
 *   1. The plan's Step 5 snippet imported seedTwoAccounts from
 *      "@/lib/compound/db/test-harness" and destructured { mine, theirs }.
 *      The real helper lives at lib/compound/db/testing/harness.ts and
 *      returns { accountA, accountB } (TwoAccountSeed).
 *
 *   2. The plan's snippet called `seedLedger(c, mine.accountId)` with no
 *      entries argument, and asserted against `ids.inSeqOrder`. The real
 *      seedLedger signature is (c, accountId, entries: LedgerSeedEntry[]) =>
 *      Promise<number[]> — seq is caller-controlled (never generated), so
 *      nothing could have produced an "inSeqOrder" grouping without the
 *      caller supplying the entries that define it. The sort-order test
 *      below builds that disagreement explicitly: three entries are inserted
 *      in the array order seq 3, seq 1, seq 2, so insertion order (and
 *      therefore id order, since bigserial ids are assigned in call order)
 *      is [seq3Id, seq1Id, seq2Id] — a permutation that disagrees with the
 *      seq-ascending order [seq1Id, seq2Id, seq3Id] this function must
 *      return. A fixture that was already in seq order could not fail this
 *      test if `order by seq asc` were changed to `order by id asc`.
 */
import { closePool, withDb } from "@/lib/compound/db/client";
import { listLedgerMeta } from "@/lib/compound/db/ledger-meta";
import {
  closeTestPool,
  resetCompoundTables,
  seedLedger,
  seedTwoAccounts,
  withTestClient,
} from "@/lib/compound/db/testing/harness";
import { LOCAL_SUPABASE_DB_URL } from "@/lib/compound/db/testing/env";

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

describe("listLedgerMeta", () => {
  it("returns entries in seq order, not id (insertion) order", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const holderId = accountA.holderIds[1]!; // the seeded investor

    // Inserted out of seq order on purpose: array position 0 carries seq 3,
    // position 1 carries seq 1, position 2 carries seq 2. bigserial ids are
    // assigned in call order, so the returned ids are also out of seq order.
    // Note this fixture's dates happen to increase WITH seq (seq 1 is the
    // earliest date), so on its own it cannot tell "sort by seq" apart from
    // "sort by occurred_on" — it only rules out id/insertion order. The next
    // test rules out occurred_on specifically.
    const ids = await withTestClient((c) =>
      seedLedger(c, accountA.accountId, [
        { seq: 3, occurredOn: "2026-01-03", type: "equity_reading", amountCents: 100_000n },
        { seq: 1, occurredOn: "2026-01-01", type: "deposit", amountCents: 50_000n, holderId },
        { seq: 2, occurredOn: "2026-01-02", type: "deposit", amountCents: 20_000n, holderId },
      ]),
    );
    const seq3Id = ids[0]!;
    const seq1Id = ids[1]!;
    const seq2Id = ids[2]!;

    const meta = await withDb((c) => listLedgerMeta(c, accountA.accountId));

    expect(meta.map((m) => m.id)).toEqual([seq1Id, seq2Id, seq3Id]);
    // Insertion (== id-ascending) order is the wrong-answer shape this
    // fixture exists to rule out.
    expect(meta.map((m) => m.id)).not.toEqual(ids);
  });

  it("returns entries in seq order, not occurred_on order — three entries share one date", async () => {
    // Section 6.2: seq, not occurred_on, defines order, because two events on
    // the same broker-server date still need a definite order. All three
    // entries below carry the SAME occurred_on, so an implementation sorting
    // by occurred_on has no date information to fall back on for any of
    // them — it can only reproduce the right answer by accident. seq is
    // deliberately NOT insertion order either (array position 0 carries
    // seq 2, so the id/insertion order [posId, thenId, firstId] is a third,
    // independently-wrong candidate this fixture also rules out).
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const holderId = accountA.holderIds[1]!;
    const SHARED_DATE = "2026-02-14";

    const ids = await withTestClient((c) =>
      seedLedger(c, accountA.accountId, [
        { seq: 2, occurredOn: SHARED_DATE, type: "deposit", amountCents: 11_000n, holderId },
        { seq: 3, occurredOn: SHARED_DATE, type: "deposit", amountCents: 12_000n, holderId },
        { seq: 1, occurredOn: SHARED_DATE, type: "equity_reading", amountCents: 90_000n },
      ]),
    );
    const posId = ids[0]!;  // seq 2
    const thenId = ids[1]!; // seq 3
    const firstId = ids[2]!; // seq 1

    const meta = await withDb((c) => listLedgerMeta(c, accountA.accountId));

    expect(meta.map((m) => m.id)).toEqual([firstId, posId, thenId]);
  });

  it("returns recorded_at as a UTC ISO string, not a Date", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const holderId = accountA.holderIds[1]!;
    await withTestClient((c) =>
      seedLedger(c, accountA.accountId, [
        { seq: 1, occurredOn: "2026-01-01", type: "deposit", amountCents: 50_000n, holderId },
      ]),
    );

    const meta = await withDb((c) => listLedgerMeta(c, accountA.accountId));
    const first = meta[0]!;

    expect(typeof first.recordedAt).toBe("string");
    expect(first.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("carries note and created_by through, and null through when they are null", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    const holderId = accountA.holderIds[1]!;
    const managerUserId = accountA.managerUserId;

    await withTestClient((c) =>
      seedLedger(c, accountA.accountId, [
        {
          seq: 1, occurredOn: "2026-01-01", type: "deposit", amountCents: 50_000n,
          holderId, note: "wired same day", createdBy: managerUserId,
        },
        { seq: 2, occurredOn: "2026-01-02", type: "deposit", amountCents: 10_000n, holderId },
      ]),
    );

    const meta = await withDb((c) => listLedgerMeta(c, accountA.accountId));
    expect(meta[0]).toMatchObject({ note: "wired same day", createdBy: managerUserId });
    expect(meta[1]).toMatchObject({ note: null, createdBy: null });
  });

  it("returns only this account's entries", async () => {
    const { accountA, accountB } = await withTestClient((c) => seedTwoAccounts(c));
    const holderA = accountA.holderIds[1]!;
    const holderB = accountB.holderIds[0]!;

    await withTestClient((c) =>
      seedLedger(c, accountA.accountId, [
        { seq: 1, occurredOn: "2026-01-01", type: "deposit", amountCents: 50_000n, holderId: holderA },
      ]),
    );
    await withTestClient((c) =>
      seedLedger(c, accountB.accountId, [
        { seq: 1, occurredOn: "2026-01-01", type: "deposit", amountCents: 30_000n, holderId: holderB },
      ]),
    );

    const metaA = await withDb((c) => listLedgerMeta(c, accountA.accountId));
    const metaB = await withDb((c) => listLedgerMeta(c, accountB.accountId));

    expect(metaA.length).toBeGreaterThan(0);
    const overlap = metaA.filter((m) => metaB.some((b) => b.id === m.id));
    expect(overlap).toEqual([]);
  });

  it("returns an empty array for an account with no ledger entries, not null", async () => {
    const { accountA } = await withTestClient((c) => seedTwoAccounts(c));
    expect(await withDb((c) => listLedgerMeta(c, accountA.accountId))).toEqual([]);
  });
});
