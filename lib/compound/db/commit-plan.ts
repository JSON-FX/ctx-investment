/**
 * The only writer in Compound v1.
 *
 * It hands the whole plan to one SQL function, which is one transaction by
 * construction. Three client calls in a row would not be: a crash between them
 * leaves readings with no cursor, and the next run re-posts them.
 *
 * Money is serialised as strings. JSON.stringify throws outright on a BigInt,
 * and a JSON number above 2^53 is not the number that was sent.
 */
import type { ReadingPlan } from "@/lib/compound/reconcile/interlock";
import type { Queryable } from "./types";
import { toId } from "./sql";

export interface CommitResult {
  readingsInserted: number;
  /** The seq assigned to each reading, in the order they were posted. */
  seqs: number[];
  /** The candidate row, whether newly created or already present. */
  candidateId: number | null;
  /** Where the cursor ended up. Null when nothing has ever been posted. */
  cursorDate: string | null;
}

const CALL = `select public.compound_commit_reading_plan($1, $2::jsonb, $3::jsonb, $4::date, $5)
                as result`;

interface RawResult {
  seqs: string[];
  candidate_id: string | null;
  cursor_date: string | null;
}

export async function commitReadingPlan(
  c: Queryable,
  input: { accountId: number; plan: ReadingPlan; actorUserId: string | null },
): Promise<CommitResult> {
  const { accountId, plan, actorUserId } = input;

  // An idle plan is the common case — the reconciler runs on a schedule and
  // most runs have nothing to do. Taking a row lock to write nothing is waste,
  // so idle does not touch the database at all.
  if (plan.kind === "idle") {
    return { readingsInserted: 0, seqs: [], candidateId: null, cursorDate: null };
  }

  const readings = plan.readings.map((r) => ({
    occurred_on: r.occurredOn,
    equity_cents: r.equityCents.toString(),
  }));

  const candidate =
    plan.kind === "halt"
      ? {
          trade_date: plan.candidate.tradeDate,
          balance_delta_cents: plan.candidate.balanceDeltaCents.toString(),
          explained_cents: plan.candidate.explainedCents.toString(),
          unexplained_cents: plan.candidate.unexplainedCents.toString(),
        }
      : null;

  const { rows } = await c.query<{ result: RawResult }>(CALL, [
    accountId,
    JSON.stringify(readings),
    candidate === null ? null : JSON.stringify(candidate),
    plan.newCursorDate,
    actorUserId,
  ]);

  const raw = rows[0]?.result;
  if (!raw) throw new Error("compound_commit_reading_plan returned no row");

  return {
    readingsInserted: raw.seqs.length,
    seqs: raw.seqs.map((s, i) => toId(s, `commit result seqs[${i}]`)),
    candidateId: raw.candidate_id === null ? null : toId(raw.candidate_id, "candidate_id"),
    cursorDate: raw.cursor_date,
  };
}
