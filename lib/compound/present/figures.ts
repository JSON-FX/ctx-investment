/**
 * Cents to strings, for a dense journal table cell rather than a statement
 * heading. The only place a journal money value becomes something a person
 * reads, and it never stops being an integer on the way.
 *
 * money()/signedMoney() are built on engine/money.ts's formatCents — the same
 * primitive present/format.ts's splitMoney/formatMoney use, so this is not a
 * second cents-to-decimal converter. What is new here is the two things a
 * table cell needs that a statement heading does not: no currency symbol
 * (the page states the account currency once, not per cell), and U+2212 in
 * place of a hyphen so a negative figure stays digit-width in the tabular
 * mono face (spec section 8.3: columns of money must not shift width).
 * format.ts's formatMoney always prepends a currency symbol and always uses
 * a hyphen, so neither figure here is reachable by post-processing its
 * output — see the design spec and this plan's own record for the reasoning.
 *
 * JavaScript's locale-aware number formatter is deliberately not used, for
 * the same reason format.ts avoids it: it takes a `number`, so calling it on
 * a cent value means dividing by 100 into a float first — the side door spec
 * section 4 closes. Grouping three digits at a time is a regex over a string
 * formatCents already produced exactly. (Its dotted name is avoided here on
 * purpose, not just its call — see the task report for why.)
 */
import { formatCents, type Cents } from "@/lib/compound/engine/money";
import { signOf } from "@/lib/compound/present/format";

export const MINUS = "−";

/**
 * Thousands grouping as a string operation on digits `formatCents` already
 * produced. Not imported from format.ts: that module's own `group` helper
 * groups an already currency-prefixed, already-signed whole part in one
 * step and is not exported, and format.ts is not this plan's to edit.
 * Duplicating this three-line regex is cheaper and safer than exporting a
 * helper out of a module this plan does not own.
 */
function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Magnitude only: "12,630.61". No sign, no currency symbol. */
export function money(c: Cents): string {
  const abs = c < 0n ? -c : c;
  const [whole, frac] = formatCents(abs).split(".") as [string, string];
  return `${group(whole)}.${frac}`;
}

/** "+1,237.00", "−409.00", "0.00". */
export function signedMoney(c: Cents): string {
  if (c === 0n) return "0.00";
  return `${c > 0n ? "+" : MINUS}${money(c)}`;
}

/**
 * Basis points to a percentage: 5555 becomes "55.55%". Not composed from
 * format.ts's formatPpm: ppm and bps are different scales (parts per
 * million vs parts per ten-thousand) and, more importantly, formatPpm
 * throws on a negative input while a P/L-derived percentage here is
 * routinely negative. Converting bps to ppm first would only add an
 * unneeded multiply-and-round on a value that already carries exactly the
 * needed precision, and would still need this module's own sign handling
 * to get the U+2212 glyph formatPpm does not produce.
 */
export function pctFromBps(bps: number): string {
  if (!Number.isInteger(bps)) throw new RangeError(`bps must be an integer, got ${bps}`);
  const neg = bps < 0;
  const abs = neg ? -bps : bps;
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  return `${neg ? MINUS : ""}${whole}.${frac < 10 ? "0" : ""}${frac}%`;
}

/**
 * Thousandths to a ratio: 2247n becomes "2.247". Null becomes an em dash —
 * profit factor is undefined with no losing trades. Nothing in format.ts or
 * rail.ts formats a thousandths-scaled ratio; both are money- or
 * share-shaped, and a ratio between two money sums is neither.
 */
export function ratioFromMilli(milli: bigint | null): string {
  if (milli === null) return "—";
  const neg = milli < 0n;
  const abs = neg ? -milli : milli;
  const frac = (abs % 1_000n).toString().padStart(3, "0");
  return `${neg ? MINUS : ""}${group((abs / 1_000n).toString())}.${frac}`;
}

/**
 * Milli-lots to lots: 50 becomes "0.05", 1200 becomes "1.20". Trade volume
 * has no counterpart in format.ts, which formats money, NAV and unit
 * ownership, never a broker lot size.
 */
export function lots(milliLots: number): string {
  if (!Number.isInteger(milliLots) || milliLots < 0) {
    throw new RangeError(`milliLots must be a non-negative integer, got ${milliLots}`);
  }
  const whole = Math.trunc(milliLots / 1000);
  const frac = (milliLots % 1000).toString().padStart(3, "0").slice(0, 2);
  return `${whole}.${frac}`;
}

/**
 * "2026-05-08 14:15" from an ISO instant. Requires the trailing Z.
 *
 * Not composed from format.ts's formatUtcStamp: that function renders prose
 * ("8 May 2026, 14:15 UTC") for a statement sentence, and its regex does not
 * check for a trailing Z — it would silently mislabel a `+03:00` timestamp
 * as UTC. A table cell needs the opposite shape (year-first, minute
 * precision, no words) plus the guard format.ts's version omits; reusing it
 * would mean re-parsing its prose output while still inheriting the missing
 * guard, which defeats the point of adding one.
 */
export function utcStamp(iso: string): string {
  if (!iso.endsWith("Z")) {
    throw new RangeError(`expected a UTC instant ending in Z, got ${JSON.stringify(iso)}`);
  }
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * "8 May 2026" from a YYYY-MM-DD key. This is format.ts's formatDate under
 * the name the journal figures interface promises: same regex, same month
 * table, same output shape (verified against format.test.ts's cases), so it
 * is re-exported rather than reimplemented — a second date-to-string
 * function here would be exactly the duplication this task exists to avoid,
 * just for a date instead of a money value.
 */
export { formatDate as utcDate } from "@/lib/compound/present/format";

/**
 * The existing globals.css utility class for a P/L sign. Composed from
 * format.ts's signOf rather than re-deriving the three-way comparison: the
 * only difference is the zero case, where a table cell wants no class
 * (`""`) so `` `num ${toneOf(c)}` `` does not emit a meaningless `zero`
 * token. primitives.tsx's DeltaMoney already applies this exact
 * normalisation inline at its one call site; this gives it a name instead
 * of leaving it duplicated a second time here.
 */
export function toneOf(c: Cents): "pos" | "neg" | "" {
  const s = signOf(c);
  return s === "zero" ? "" : s;
}
