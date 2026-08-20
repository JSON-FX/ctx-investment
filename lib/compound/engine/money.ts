/**
 * Integer money and scaled units. No floating point.
 *
 * Money is minor units (cents) as bigint. Units are bigint scaled by
 * UNIT_SCALE, giving 1e-10 precision — rounding units at 2dp accumulates
 * visible drift against the "holder units sum to units issued" invariant.
 */

/** Units carry ten decimal places. */
export const UNIT_SCALE = 10_000_000_000n;

/** Minor units of account currency. */
export type Cents = bigint;

/** Pool units, scaled by UNIT_SCALE. */
export type Units = bigint;

const MONEY_RE = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;
const UNITS_RE = /^(-)?(\d+)(?:\.(\d{1,10}))?$/;

function assertOperands(a: bigint, b: bigint, d: bigint): void {
  if (d === 0n) throw new RangeError("division by zero");
  if (a < 0n || b < 0n || d < 0n) {
    throw new RangeError(`expects non-negative operands, got (${a}, ${b}, ${d})`);
  }
}

/** floor(a * b / d) for non-negative operands. Exact — no intermediate rounding. */
export function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  assertOperands(a, b, d);
  return (a * b) / d;
}

/** ceil(a * b / d) for non-negative operands. */
export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  assertOperands(a, b, d);
  const n = a * b;
  return n === 0n ? 0n : (n + d - 1n) / d;
}

export function centsFromDecimal(input: string): Cents {
  const m = MONEY_RE.exec(input.trim());
  if (!m) throw new RangeError(`not a money string: ${JSON.stringify(input)}`);
  const sign = m[1];
  const whole = m[2] as string;
  const frac = m[3] ?? "";
  const cents = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
  return sign ? -cents : cents;
}

export function formatCents(c: Cents): string {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function unitsFromDecimal(input: string): Units {
  const m = UNITS_RE.exec(input.trim());
  if (!m) throw new RangeError(`not a unit string: ${JSON.stringify(input)}`);
  const sign = m[1];
  const whole = m[2] as string;
  const frac = m[3] ?? "";
  const u = BigInt(whole) * UNIT_SCALE + BigInt(frac.padEnd(10, "0"));
  return sign ? -u : u;
}

/** Truncates rather than rounds — display only, never used for arithmetic. */
export function formatUnits(u: Units, dp = 2): string {
  if (!Number.isInteger(dp) || dp < 0 || dp > 10) {
    throw new RangeError(`dp must be an integer 0..10, got ${dp}`);
  }
  const neg = u < 0n;
  const abs = neg ? -u : u;
  const whole = abs / UNIT_SCALE;
  const fracAll = (abs % UNIT_SCALE).toString().padStart(10, "0");
  const frac = dp === 0 ? "" : `.${fracAll.slice(0, dp)}`;
  return `${neg ? "-" : ""}${whole}${frac}`;
}
