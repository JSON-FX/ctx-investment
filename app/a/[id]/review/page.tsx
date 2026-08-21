/**
 * The capital-event queue. Spec §5.3 and §7.
 *
 * Agreement A3: this page loads its own data — no PoolState context
 * provider. planFor is Task 11's cache()d loader; this page is the only
 * caller in this plan that needs its `error` / `not-configured` branches
 * rendered distinctly rather than folded into a halt, per the design note in
 * review-queue.tsx and the plan's own Task 14 section: a RangeError from
 * planReadings means the upstream data is wrong, and telling a manager to
 * classify a capital event that does not exist sends them looking in the
 * wrong place while the real one — which a duplicated trade date can be
 * hiding — stays put.
 */
import { withDb } from "@/lib/compound/db/client";
import { listCandidates } from "@/lib/compound/db/compound";
import { requireAccount } from "@/lib/compound/load/account";
import { loadInterlock } from "@/lib/compound/load/interlock";
import { planFor } from "@/lib/compound/load/reconcile";
import { ReviewQueue } from "@/lib/compound/ui/review-queue";
import { refreshReadings } from "../actions/actions";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const account = await requireAccount((await params).id);
  const [outcome, pending, interlock] = await Promise.all([
    planFor(account),
    withDb((c) => listCandidates(c, account.id, "pending")),
    loadInterlock(account.id),
  ]);

  return (
    <ReviewQueue
      accountId={account.id}
      currency={account.currency}
      plan={outcome.kind === "plan" ? outcome.plan : null}
      pending={[...pending].sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1))}
      frozenAt={interlock.frozenAt}
      defect={outcome.kind === "error" ? outcome.message : null}
      notConfigured={outcome.kind === "not-configured"}
      refreshAction={
        <form action={refreshReadings}>
          <input type="hidden" name="accountId" value={account.id} />
          <button className="btn" type="submit">Refresh readings</button>
        </form>
      }
    />
  );
}
