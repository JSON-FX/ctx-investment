/**
 * Two states that look similar and are not, and conflating them is the bug.
 *
 * LiveChip — the figure beside it is intraday, from account_snapshots_current,
 * and no reading has been posted for it. NAV is fine; the number is simply not
 * committed. Spec section 5.2.
 *
 * InterlockBanner — the reconciler found a balance move that closed trades do
 * not explain, so readings have STOPPED. Every figure on the account is as of
 * the frozen date and will stay there until the event is classified. Spec
 * section 5.3. This is not a staleness warning; it is a refusal to guess.
 */
import type { ReactNode } from "react";
import { formatDate, formatUtcStamp } from "@/lib/compound/present/format";
import { Chip } from "./primitives";

export function LiveChip({ pushedAt }: { pushedAt: string }) {
  return (
    <Chip tone="live">
      <span>Live · not yet posted</span>
      <span className="muted"> · {formatUtcStamp(pushedAt)}</span>
    </Chip>
  );
}

export function InterlockBanner({
  frozenAt, candidateDate, reviewHref,
}: { frozenAt: string | null; candidateDate: string; reviewHref: string }) {
  return (
    <div className="banner-halt" role="status">
      <strong>Figures frozen at {frozenAt === null ? "inception" : formatDate(frozenAt)}.</strong>{" "}
      An unexplained balance move on {formatDate(candidateDate)} is waiting to be classified.
      NAV will not advance past {frozenAt === null ? "inception" : formatDate(frozenAt)} until
      it is. <a href={reviewHref}>Review it</a>.
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="banner" role="status">{children}</div>;
}
