/**
 * Cents to pixels. THE ONLY PLACE IN THE PRODUCT WHERE A MONEY VALUE BECOMES
 * A NUMBER, and the number it becomes is a coordinate that never returns to
 * an accounting path.
 *
 * Even here the float never holds a money magnitude. The position is computed
 * as an integer ratio out of PRECISION using bigint arithmetic, and only that
 * small ratio — bounded by 0..100000 — is converted. A balance of
 * 90,071,992,547,409.93 therefore plots exactly, where
 * `Number(cents) / Number(span)` would already have lost the value before the
 * division.
 */
const PRECISION = 100_000n;
const PRECISION_F = 100_000;

export interface VerticalScale {
  minCents: bigint;
  maxCents: bigint;
  /** SVG y for a cent value. Larger values sit higher. */
  y(v: bigint): number;
  /** y of the zero line, or null when zero is outside the domain. */
  zeroY: number | null;
  /** True when every value was identical and the line is horizontal. */
  flat: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function verticalScale(
  values: readonly bigint[],
  height: number,
  pad: number,
): VerticalScale {
  if (values.length === 0) {
    const mid = round2(height / 2);
    return { minCents: 0n, maxCents: 0n, y: () => mid, zeroY: mid, flat: true };
  }

  let minCents = values[0]!;
  let maxCents = values[0]!;
  for (const v of values) {
    if (v < minCents) minCents = v;
    if (v > maxCents) maxCents = v;
  }

  const span = maxCents - minCents;
  const usable = height - 2 * pad;

  if (span === 0n) {
    const mid = round2(height / 2);
    return { minCents, maxCents, y: () => mid, zeroY: minCents === 0n ? mid : null, flat: true };
  }

  const y = (v: bigint): number => {
    const clamped = v < minCents ? minCents : v > maxCents ? maxCents : v;
    // Integer ratio first. The float only ever holds 0..100000.
    const ratio = Number(((clamped - minCents) * PRECISION) / span) / PRECISION_F;
    return round2(pad + usable * (1 - ratio));
  };

  return {
    minCents,
    maxCents,
    y,
    zeroY: minCents <= 0n && maxCents >= 0n ? y(0n) : null,
    flat: false,
  };
}

/** Evenly spaced x for index i of count points. A single point sits at the left pad. */
export function horizontalScale(count: number, width: number, pad: number): (i: number) => number {
  const usable = width - 2 * pad;
  return (i) => (count <= 1 ? round2(pad) : round2(pad + (usable * i) / (count - 1)));
}

/** "x,y x,y ..." for a polyline. */
export function polylinePoints(
  values: readonly bigint[],
  scale: VerticalScale,
  x: (i: number) => number,
): string {
  return values.map((v, i) => `${x(i)},${scale.y(v)}`).join(" ");
}
