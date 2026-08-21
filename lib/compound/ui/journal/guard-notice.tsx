/**
 * The visible half of the duplicate-deal guard.
 *
 * When broker_offset_hours is not configured the guard cannot run (spec
 * section 6.3's defect is a timezone shift, and a zero-hour shift moves
 * nothing), so the page says so. Rendering nothing would recreate the exact
 * failure this product is built to avoid: numbers that look protected and are
 * not.
 *
 * When the guard did run and dropped rows, that is also stated. A manager
 * comparing this page against the terminal needs to know the counts differ on
 * purpose.
 */
import type { TradeHistory } from "@/lib/compound/journal/history";

export function GuardNotice({ history }: { history: TradeHistory }) {
  if (history.guard === "not-configured") {
    return (
      <p className="filters-notice" role="status">
        <strong>Duplicate-deal protection is inactive.</strong> This account has no broker UTC
        offset set, so the guard against duplicated deals cannot run. Trade counts and P/L may be
        inflated. Set the offset on the account to enable it.
      </p>
    );
  }
  if (history.dropped.length === 0) return null;
  const tickets = history.dropped.map((d) => d.deal.ticket).join(", ");
  return (
    <p className="filters-notice" role="status">
      <strong>
        {history.dropped.length} duplicate {history.dropped.length === 1 ? "deal" : "deals"} excluded
      </strong>{" "}
      from {history.rawCount} rows. Ticket{history.dropped.length === 1 ? "" : "s"}{" "}
      <span className="num">{tickets}</span> repeat an earlier trade under a shifted timestamp — a
      known upstream defect. Counts below exclude them.
    </p>
  );
}
