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

/** Signed gap from `from` to `to`, in whole milliseconds. Negative when `to` is earlier. */
export function signedGapMs(from: string, to: string): number {
  const tf = Date.parse(from);
  const tt = Date.parse(to);
  if (Number.isNaN(tf)) throw new RangeError(`not an ISO timestamp: ${JSON.stringify(from)}`);
  if (Number.isNaN(tt)) throw new RangeError(`not an ISO timestamp: ${JSON.stringify(to)}`);
  return tt - tf;
}

/** Absolute gap between two timestamps, in whole milliseconds. */
export function absGapMs(a: string, b: string): number {
  return Math.abs(signedGapMs(a, b));
}
