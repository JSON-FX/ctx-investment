/**
 * The presentation boundary. Design spec section 4: "Where a NAV figure must
 * be displayed it is computed and rounded to 4dp at the presentation boundary
 * only." This module is that boundary, and nothing downstream of it does
 * arithmetic — everything here formats a value the engine already computed.
 *
 * Two rules hold throughout:
 *
 *   1. No floating point on a money or unit value. Group separators, sign
 *      handling and decimal placement are string operations on the exact
 *      integer (or bigint) the engine produced. A money or unit value never
 *      becomes a `Number` on its way to a screen. `number` is used only for
 *      basis points, ppm shares and array indices — quantities that are
 *      already integers and never carry money precision.
 *   2. Unit counts TRUNCATE, they do not round (decision D-K). `formatUnits`
 *      already truncates, and rounding up would print a holding larger than
 *      the holder owns — which contradicts the floor bias every value-moving
 *      operation in the engine uses. Four decimal places: two hides
 *      differences that matter on a small pool, ten is unreadable.
 *
 * This module does not decide which of `allocateValues` or `valueOfUnits` a
 * caller should format (decision D-A) — it formats whatever `Cents` it is
 * given, identically, regardless of which engine function produced it. Two
 * different Cents values format to two different strings; nothing here
 * merges or reconciles them.
 */
import {
  formatCents,
  formatUnits,
  type Cents,
  type Units,
} from "@/lib/compound/engine/money";
import { navTimes1e4, type PoolTotals } from "@/lib/compound/engine/nav";

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

function symbolFor(currency: string): string {
  return SYMBOLS[currency] ?? `${currency} `;
}

/** Inserts thousands separators into a run of digits. String work, never math. */
function group(digits: string): string {
  let out = "";
  for (let i = digits.length; i > 0; i -= 3) {
    out = digits.slice(Math.max(0, i - 3), i) + (out === "" ? "" : ",") + out;
  }
  return out;
}

/**
 * Splits a money figure into its major and minor parts so a statement head
 * can render the cents smaller. Returns the parts, never a concatenation, so
 * a caller cannot accidentally style them as one run.
 */
export function splitMoney(c: Cents, currency = "USD"): { whole: string; cents: string } {
  const raw = formatCents(c); // e.g. "-55743.91"
  const negative = raw.startsWith("-");
  const [whole = "0", cents = "00"] = (negative ? raw.slice(1) : raw).split(".");
  return {
    whole: `${negative ? "-" : ""}${symbolFor(currency)}${group(whole)}`,
    cents,
  };
}

/**
 * `sign: "always"` prefixes a non-negative figure with "+". Use it for P/L
 * and for nothing else — a balance with a plus sign reads as a change. Zero
 * is signed positive under "always": zero P/L is break-even, not a loss.
 */
export function formatMoney(
  c: Cents,
  opts: { currency?: string; sign?: "auto" | "always" } = {},
): string {
  const { whole, cents } = splitMoney(c, opts.currency ?? "USD");
  const plus = opts.sign === "always" && c >= 0n ? "+" : "";
  return `${plus}${whole}.${cents}`;
}

/** A unit count, grouped and truncated at `dp` places (default 4; see D-K). */
export function formatUnitsDp(u: Units, dp = 4): string {
  const raw = formatUnits(u, dp); // truncates, by design — never rounds
  const negative = raw.startsWith("-");
  const [whole = "0", frac] = (negative ? raw.slice(1) : raw).split(".");
  return `${negative ? "-" : ""}${group(whole)}${frac === undefined ? "" : `.${frac}`}`;
}

/**
 * NAV per unit, 4dp, truncated — the one place NAV is computed for display.
 * `navTimes1e4` already floors to an integer (NAV x 10^4); this function only
 * places the decimal point and pads the fraction. It performs no division of
 * its own, so there is no separate rounding decision here to get wrong.
 */
export function formatNav(t: PoolTotals): string {
  const n = navTimes1e4(t);
  return `${group((n / 10_000n).toString())}.${(n % 10_000n).toString().padStart(4, "0")}`;
}

/**
 * Growth since inception: (NAV - 1) x 100, two decimals, always signed.
 * `navTimes1e4(t) - 10_000n` is exactly the figure in hundredths of a
 * percent — the same precision `navTimes1e4` already carries — so, like
 * `formatNav`, this places digits rather than rounding them.
 */
export function formatSinceInception(t: PoolTotals): string {
  const bp = navTimes1e4(t) - 10_000n; // hundredths of a percent
  const negative = bp < 0n;
  const abs = negative ? -bp : bp;
  return `${negative ? "-" : "+"}${group((abs / 100n).toString())}.${(abs % 100n)
    .toString()
    .padStart(2, "0")}%`;
}

/**
 * A share expressed in parts per million, rendered at 2dp. `ppm` is always an
 * already-reduced integer (never money), so plain-number arithmetic is in
 * bounds here (see the module doc). `Math.round` only ever resolves an exact
 * half — every ppm/100 that lands on a rounding boundary is of the form
 * `k + 0.5`, which is exactly representable in IEEE-754 — so there is no
 * float-imprecision risk despite the division.
 */
export function formatPpm(ppm: number): string {
  if (!Number.isInteger(ppm) || ppm < 0 || ppm > 1_000_000) {
    throw new RangeError(`ppm must be an integer 0..1000000, got ${ppm}`);
  }
  const hundredths = Math.round(ppm / 100);
  return `${Math.trunc(hundredths / 100)}.${(hundredths % 100).toString().padStart(2, "0")}%`;
}

/**
 * Renders one side of a basis-point split as a percentage, dropping the
 * fraction when it is a whole percent. Pure integer arithmetic — no
 * `toFixed`, so there is no dependency on IEEE-754 string-rounding behaviour
 * for a value this module treats as money-adjacent.
 */
function pctOfBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = bps % 100;
  return frac === 0 ? `${whole}` : `${whole}.${frac.toString().padStart(2, "0")}`;
}

/** Both sides of a split, investor first — matches how terms are spoken ("60/40"). */
function splitParts(splitBps: number): [investor: string, manager: string] {
  if (!Number.isInteger(splitBps) || splitBps < 0 || splitBps > 10_000) {
    throw new RangeError(`splitBps must be an integer 0..10000, got ${splitBps}`);
  }
  return [pctOfBps(10_000 - splitBps), pctOfBps(splitBps)];
}

/** "60 / 40" — investor first, manager second, matching how terms are spoken. */
export function formatSplit(splitBps: number): string {
  const [investor, manager] = splitParts(splitBps);
  return `${investor} / ${manager}`;
}

/** The same terms in a sentence, for a sheet that must be read rather than scanned. */
export function formatSplitWords(splitBps: number, holderName: string): string {
  const [investor, manager] = splitParts(splitBps);
  return (
    `${holderName} keeps ${investor}% of profit and you keep ${manager}%. ` +
    `The fee is charged only when ${holderName} withdraws, and only on profit ` +
    `above what ${holderName} has put in.`
  );
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * YYYY-MM-DD to "14 Aug 2026". No `Date` object: the input is a broker-server
 * date string, and constructing a `Date` from it resolves the string in the
 * reader's local zone, which can land on the wrong calendar day.
 *
 * The month lookup is checked explicitly rather than trusted: under
 * `noUncheckedIndexedAccess` a `\d{2}` capture like "13" would otherwise index
 * past the end of `MONTHS` and the `undefined` result would print as the
 * literal string "undefined" instead of failing.
 */
export function formatDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new RangeError(`not a YYYY-MM-DD date: ${JSON.stringify(isoDate)}`);
  const monthName = MONTHS[Number(m[2]) - 1];
  if (monthName === undefined) {
    throw new RangeError(`month out of range in ${JSON.stringify(isoDate)}`);
  }
  return `${Number(m[3])} ${monthName} ${m[1]}`;
}

/**
 * An ISO 8601 UTC timestamp to "18 Aug 2026, 09:14 UTC". Parsed with a regex
 * rather than handed to the `Date` constructor, whose hour/minute accessors
 * read back in the reader's local zone — a `pushed_at` that moves with the
 * reader is a support ticket waiting to happen.
 */
export function formatUtcStamp(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) throw new RangeError(`not an ISO 8601 timestamp: ${JSON.stringify(iso)}`);
  return `${formatDate(`${m[1]}-${m[2]}-${m[3]}`)}, ${m[4]}:${m[5]} UTC`;
}

export function signOf(c: Cents): "pos" | "neg" | "zero" {
  return c > 0n ? "pos" : c < 0n ? "neg" : "zero";
}
