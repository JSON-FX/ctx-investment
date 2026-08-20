/**
 * Timestamp handling. Date is permitted here — it never touches money.
 *
 * Deliberately parses rather than slicing the string. A timestamp carrying a
 * non-UTC offset slices to the wrong calendar day, and attributing a trade to
 * the wrong day is exactly how a reconciler invents a capital event that never
 * happened.
 */
export function utcDateKey(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    throw new RangeError(`not an ISO timestamp: ${JSON.stringify(iso)}`);
  }
  return new Date(t).toISOString().slice(0, 10);
}

/** Absolute gap between two timestamps, in whole milliseconds. */
export function absGapMs(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta)) throw new RangeError(`not an ISO timestamp: ${JSON.stringify(a)}`);
  if (Number.isNaN(tb)) throw new RangeError(`not an ISO timestamp: ${JSON.stringify(b)}`);
  return Math.abs(ta - tb);
}
