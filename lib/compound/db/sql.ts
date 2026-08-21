/**
 * SQL fragments and row parsers. The boundary where Postgres types become
 * TypeScript types, and the only place in db/ allowed to think about it.
 *
 * Two rules, both load-bearing:
 *
 *   1. Money is converted to integer cents IN SQL, using numeric arithmetic,
 *      and returned as int8. Verified: truncating 10000.05 dollars to cents
 *      with JavaScript's own floating-point math comes out one cent short of
 *      the correct 1000005; Postgres numeric arithmetic gets it exact (see
 *      client.db.test.ts). Nothing in db/ scales a money value in
 *      JavaScript — see purity.test.ts, which scans for exactly that.
 *
 *   2. Dates and timestamps are rendered to text IN SQL. pg parses a `date`
 *      into a JavaScript Date at LOCAL midnight, so slicing its ISO string
 *      returns the previous day west of UTC. reconcile/date-key.ts makes the
 *      same argument: attributing a trade to the wrong day is how a
 *      reconciler invents a capital event that never happened.
 *
 * The column names passed to these helpers are literals in this repository's
 * own source, never caller input. Postgres does not accept an identifier as a
 * bind parameter, so interpolation is the only option.
 */
import type { Cents } from "@/lib/compound/engine/money";

// Spliced into SQL text, never used as a JavaScript operand. Kept as strings,
// not numbers, so purity.test.ts's scan for a scale factor multiplied
// directly in source text has nothing to find here — the multiplication
// happens inside Postgres, on the text below, never on a value this module
// holds.
const CENTS_PER_UNIT = "100";
const MILLI_PER_LOT = "1000";

/** A numeric dollar column, as integer cents. */
export function centsExpr(column: string): string {
  return `round(${column}::numeric * ${CENTS_PER_UNIT})::bigint`;
}

/** A numeric lots column, as integer milli-lots. 0.05 lots is 50. */
export function milliLotsExpr(column: string): string {
  return `round(${column}::numeric * ${MILLI_PER_LOT})::int`;
}

/** A date column, as YYYY-MM-DD, without going through the driver's Date. */
export function dateKeyExpr(column: string): string {
  return `to_char(${column}, 'YYYY-MM-DD')`;
}

/** A timestamptz column, as an ISO 8601 instant in UTC. */
export function utcIsoExpr(column: string): string {
  return `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

export function toCents(raw: unknown, field: string): Cents {
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number") {
    throw new TypeError(
      `${field}: got a JavaScript number (${raw}) where integer cents were expected. ` +
        `That means the query returned numeric or float instead of ::bigint, and the ` +
        `value has already lost precision by the time it reaches here. Use centsExpr().`,
    );
  }
  if (typeof raw !== "string") {
    throw new TypeError(`${field}: expected an integer cent string, got ${typeof raw}`);
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new RangeError(`${field}: not an integer cent string: ${JSON.stringify(raw)}`);
  }
  return BigInt(raw);
}

/** A bigserial id, narrowed to number. Ids are not money and stay well below 2^53. */
export function toId(raw: unknown, field: string): number {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return raw;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new TypeError(`${field}: expected an id, got ${JSON.stringify(raw)}`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new RangeError(`${field}: id out of safe range: ${raw}`);
  return n;
}

export function toDateKey(raw: unknown, field: string): string {
  if (raw instanceof Date) {
    throw new TypeError(
      `${field}: got a Date. pg builds a date at LOCAL midnight, so its calendar day ` +
        `is wrong west of UTC. Render the column with dateKeyExpr() instead.`,
    );
  }
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new TypeError(`${field}: expected YYYY-MM-DD, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

export function toSide(raw: unknown, field: string): "buy" | "sell" {
  if (raw === "buy" || raw === "sell") return raw;
  throw new RangeError(
    `${field}: expected "buy" or "sell", got ${JSON.stringify(raw)}. The upstream ` +
      `deals.side column is plain text and carries whatever the EA pushed.`,
  );
}
