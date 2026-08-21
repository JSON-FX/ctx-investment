/**
 * P/L distribution with integer bin edges.
 *
 * Upstream computes a float step, indexes with Math.floor and clamps the top
 * edge, then decides each bin's sign against a 0.0001 threshold to work around
 * float dust. In integers none of that is needed: the edges are exact cents,
 * the top bin is closed rather than half-open, and a bin's sign is the sign of
 * its integer midpoint.
 *
 * The step is floor(range / binCount), so the top bin absorbs the remainder
 * and is at most binCount-1 cents wider than the others. Distributing the
 * remainder across bins would make the edges uneven and buy nothing — these
 * are display buckets, not an accounting path.
 *
 * Which edge a bin owns, stated explicitly: every bin is half-open on the
 * low side and closed on the low edge — [startCents, endCents) — EXCEPT the
 * last bin, which is closed on both ends — [startCents, endCents] — so the
 * observed maximum always lands somewhere rather than one past the end. A
 * value sitting exactly on an interior edge therefore belongs to the bin for
 * which it is the START, i.e. the UPPER of the two bins it touches, never the
 * lower one. This is not the only defensible choice — owning the edge on the
 * low side (value belongs to the bin below) is equally coherent — but it is
 * the one this function implements, and histogram.test.ts pins it: a value
 * planted exactly on zero, and values exactly on non-zero interior edges on
 * both sides of zero, all resolve to their upper bin, and the test fails if
 * that ownership flips.
 */
import type { Cents } from "@/lib/compound/engine/money";
import { divFloor, toIndex } from "./int";

export type BinSign = "win" | "loss" | "zero";

export interface HistogramBin {
  startCents: Cents;
  /** Inclusive on the last bin, exclusive on every other. */
  endCents: Cents;
  count: number;
  sign: BinSign;
}

export interface HistogramResult {
  bins: HistogramBin[];
  minCents: Cents;
  maxCents: Cents;
  /** Values binned. Equals the sum of every bin's count. */
  total: number;
}

function signOf(startCents: Cents, endCents: Cents): BinSign {
  const mid = divFloor(startCents + endCents, 2n);
  return mid > 0n ? "win" : mid < 0n ? "loss" : "zero";
}

export function binNetPnl(values: readonly Cents[], binCount: number): HistogramResult {
  if (!Number.isInteger(binCount) || binCount <= 0) {
    throw new RangeError(`binCount must be a positive integer, got ${binCount}`);
  }
  if (values.length === 0) {
    return { bins: [], minCents: 0n, maxCents: 0n, total: 0 };
  }

  let minCents = values[0]!;
  let maxCents = values[0]!;
  for (const v of values) {
    if (v < minCents) minCents = v;
    if (v > maxCents) maxCents = v;
  }

  if (minCents === maxCents) {
    return {
      bins: [
        {
          startCents: minCents,
          endCents: maxCents,
          count: values.length,
          sign: signOf(minCents, maxCents),
        },
      ],
      minCents,
      maxCents,
      total: values.length,
    };
  }

  const range = maxCents - minCents;
  // A range narrower than the requested bin count would give a zero step.
  // Narrow the histogram instead of dividing by zero.
  const effective = range < BigInt(binCount) ? toIndex(range) : binCount;
  const step = range / BigInt(effective);

  const bins: HistogramBin[] = [];
  for (let i = 0; i < effective; i += 1) {
    const startCents = minCents + step * BigInt(i);
    const endCents = i === effective - 1 ? maxCents : minCents + step * BigInt(i + 1);
    bins.push({ startCents, endCents, count: 0, sign: signOf(startCents, endCents) });
  }

  for (const v of values) {
    const raw = toIndex((v - minCents) / step);
    // The maximum lands one past the last bin: (max-min)/step is exactly
    // `effective` when the range divides evenly, and can exceed it when the
    // remainder went to the top bin. The clamp is load-bearing, not defensive.
    const idx = raw >= effective ? effective - 1 : raw;
    bins[idx]!.count += 1;
  }

  return { bins, minCents, maxCents, total: values.length };
}
