/**
 * The ownership rail. Green means THE POOL, DIVIDED — darkest first — and it
 * means neither "yours" nor "gain", both of which are carried by other hues
 * (design spec section 8.2).
 *
 * The ramp interpolates `--own` (#14532D) to `--own-2` (#D6E9DE) in integer
 * sRGB. Spec section 8.2 rejected teal/emerald pairings for this because they
 * separate from `--gain` by hue alone; a markedly darker green separates by
 * lightness too, which is what a colourblind reader has left to go on.
 *
 * The ramp is a FUNCTION, not a set of tokens (agreement A8, decision-adjacent
 * to D-K). Spec section 8.1 defines exactly two green values and says
 * additional holders take progressively lighter tints of the same green;
 * inventing a custom property per holder would not scale past a fixed count
 * and would put a presentation decision — how many holders an account has —
 * inside a stylesheet that cannot count them.
 *
 * Beyond `RAIL_MAX_SOLID` holders the ramp cycles, and every repeated tint is
 * marked `hatched`, so no two adjacent segments render as the same fill —
 * design spec section 8.4 forbids colour as the sole carrier of meaning, and
 * a cycling ramp with no hatch would make holder 7 look identical to holder
 * 1 on a chart whose entire subject is "who owns what". The ramp is always a
 * convenience alongside a label, never the only information on the segment.
 */
import type { Units } from "@/lib/compound/engine/money";
import type { PoolState } from "@/lib/compound/engine/replay";

const OWN = [0x14, 0x53, 0x2d] as const;
const OWN_2 = [0xd6, 0xe9, 0xde] as const;

/** Six solid tints before the ramp repeats and starts hatching. */
export const RAIL_MAX_SOLID = 6;

const PPM = 1_000_000n;

/**
 * Shares in parts per million, allocated by largest remainder so they sum to
 * exactly 1,000,000 — the same construction `allocateValues` (engine/nav.ts)
 * uses for cents, applied to a reporting percentage instead of money.
 *
 * Flooring each holder's share independently is short by up to one ppm per
 * holder. On this project's fixture the floors sum to 999,998, so a rail
 * built from them would leave a two-ppm gap and not fill its container.
 *
 * This allocates a REPORTING quantity — it never moves value — so the
 * conservative floor/ceil rule that governs issuance and redemption in
 * engine/nav.ts does not apply here. Ties break by holder order, matching
 * `allocateValues`.
 */
export function allocateShares(holderUnits: readonly Units[], totalUnits: Units): number[] {
  if (holderUnits.length === 0) return [];
  if (totalUnits <= 0n) return holderUnits.map(() => 0);

  const sum = holderUnits.reduce((s, u) => s + u, 0n);
  if (sum !== totalUnits) {
    throw new RangeError(`holder units ${sum} do not sum to pool units ${totalUnits}`);
  }

  const floors = holderUnits.map((u) => (u * PPM) / totalUnits);
  const remainders = holderUnits.map((u, i) => u * PPM - floors[i]! * totalUnits);
  let short = PPM - floors.reduce((s, p) => s + p, 0n);

  const order = remainders
    .map((r, i) => [r, i] as const)
    .sort((a, b) => (a[0] !== b[0] ? (a[0] > b[0] ? -1 : 1) : a[1] - b[1]));

  const out = [...floors];
  for (let k = 0; short > 0n && k < order.length; k += 1, short -= 1n) {
    const idx = order[k]![1];
    out[idx] = out[idx]! + 1n;
  }
  return out.map((p) => Number(p));
}

/**
 * Integer interpolation between `OWN` and `OWN_2`. No float touches a colour
 * channel: `Math.trunc(span / 2)` is a rounding offset added before integer
 * division, giving round-to-nearest without ever producing a fractional
 * intermediate value.
 */
function rampAt(position: number, steps: number): string {
  if (steps <= 1 || position <= 0) return "#14532d";
  const span = steps - 1;
  const k = Math.min(position, span);
  const channel = (i: 0 | 1 | 2) =>
    Math.trunc((OWN[i] * (span - k) + OWN_2[i] * k + Math.trunc(span / 2)) / span);
  return `#${[0, 1, 2].map((i) => channel(i as 0 | 1 | 2).toString(16).padStart(2, "0")).join("")}`;
}

/** Index 0 is always `--own`. The manager is always index 0 (see `railSegments`). */
export function railTint(index: number, count: number): string {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`bad index ${index}`);
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`bad count ${count}`);
  const solid = Math.min(count, RAIL_MAX_SOLID);
  return rampAt(index % solid, solid);
}

/** True once the ramp has wrapped and this tint is a repeat of an earlier one. */
export function railIsHatched(index: number, count: number): boolean {
  return index >= Math.min(count, RAIL_MAX_SOLID);
}

export interface RailSegment {
  holderId: number;
  label: string;
  /** Parts per million. The segments sum to exactly 1,000,000. */
  ppm: number;
  tint: string;
  hatched: boolean;
  isManager: boolean;
}

/**
 * The manager first, then investors by descending stake, then by holder id.
 * "Darkest first" is the spec's own phrasing, and the manager is always
 * darkest — `railTint(0, …)` is pinned to `--own` regardless of pool size.
 *
 * Holders with no units are omitted: a zero-width segment is invisible and
 * its legend entry would name a holder with nothing to point at.
 */
export function railSegments(state: PoolState, names: Record<number, string>): RailSegment[] {
  const held = state.holders.filter((h) => h.units > 0n);
  const ordered = [...held].sort((a, b) => {
    if (a.isManager !== b.isManager) return a.isManager ? -1 : 1;
    if (a.units !== b.units) return a.units > b.units ? -1 : 1;
    return a.holderId - b.holderId;
  });

  const shares = allocateShares(
    ordered.map((h) => h.units),
    ordered.reduce((s, h) => s + h.units, 0n),
  );

  return ordered.map((h, i) => ({
    holderId: h.holderId,
    label: names[h.holderId] ?? `Holder #${h.holderId}`,
    ppm: shares[i]!,
    tint: railTint(i, ordered.length),
    hatched: railIsHatched(i, ordered.length),
    isManager: h.isManager,
  }));
}
