/**
 * Integer arithmetic for the journal layer.
 *
 * This module exists for one reason: BigInt's `/` truncates toward zero, and
 * almost every statistic on a journal surface can be negative. -2773n / 3n is
 * -924n, not -925n. Truncation is not floor, and a codebase that assumes it is
 * will be right for winners and wrong for losers — the worst possible split,
 * because the tests are usually written with winners.
 *
 * Spec section 4 sets the engine's bias: floor. These are display figures that
 * move no money, so the direction is chosen for consistency with the engine
 * rather than for safety, and consistency is the point — one rounding
 * direction in the product, not two.
 *
 * This is also the ONLY file in lib/compound/journal/ permitted to call
 * Number(). purity.test.ts exempts it by name.
 */

/** Floor division. `n / d` truncates toward zero; this does not. */
export function divFloor(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError("divFloor: division by zero");
  const q = n / d;
  if (n % d === 0n) return q;
  return n < 0n !== d < 0n ? q - 1n : q;
}

export function absBig(n: bigint): bigint {
  return n < 0n ? -n : n;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * A bigint used as an array index.
 *
 * Throws rather than silently losing precision. The ceiling is deliberately
 * far below 2^53 — nothing in this layer indexes a million-element array, so a
 * value that large means the caller computed an index from a money figure by
 * mistake, and a loud failure is worth more than a correct conversion.
 */
export function toIndex(n: bigint): number {
  if (n < 0n || n > 1_000_000n) {
    throw new RangeError(`toIndex: out of range: ${n}`);
  }
  return Number(n);
}
