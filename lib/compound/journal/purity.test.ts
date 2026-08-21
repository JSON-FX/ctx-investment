/**
 * journal/ is pure: no React, no I/O, no floating point (the design plan's
 * Architecture section states this claim in those words).
 *
 * FORBIDDEN below is the mechanical half of that claim, not the whole of
 * it: each entry is a regex over one source file's stripped text, so it
 * catches literal text in this directory's own top-level files, not I/O
 * reached indirectly — a helper imported from outside this directory, a
 * dynamic `import()`, or a `require()` call could all still slip past a
 * text scan. Within that limit, "no I/O" here specifically means: no
 * db/next/react/@supabase import, no `node:` builtin import (`node:fs`,
 * `node:https`, ...), and no bare `fetch(` call — on top of the
 * pre-existing bans on Date, parseFloat and decimal literals below.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "@/lib/compound/testing/strip-comments";

const DIR = __dirname;

/** int.ts is the single sanctioned bigint-to-number conversion point. */
const NUMBER_EXEMPT = new Set(["int.ts"]);

const FORBIDDEN: Array<[string, RegExp]> = [
  ["imports the db layer", /from\s+["']@?[./\w-]*\/compound\/db/],
  ["imports the ui layer", /from\s+["']@?[./\w-]*\/compound\/ui/],
  ["imports next", /from\s+["']next/],
  ["imports react", /from\s+["']react/],
  ["imports @supabase", /from\s+["']@supabase/],
  // Real I/O. A planted `readFileSync` call in int.ts stayed invisible to
  // every check above it — none of them look for the filesystem, the
  // network, or a child process. `node:` covers the prefixed form every
  // built-in module supports (node:fs, node:https, node:child_process, ...);
  // the bare-name alternation covers the same three modules' unprefixed
  // form, which Node accepts identically and is the more common style in
  // the wild, so relying on the prefix alone would leave the trivial
  // workaround of just dropping it. fetch() is the network case neither
  // pattern reaches on its own.
  ["imports a node: builtin", /from\s+["']node:/],
  ["imports fs, https, http or child_process unprefixed", /from\s+["'](fs|https?|child_process)(\/|["'])/],
  ["calls fetch", /\bfetch\s*\(/],
  // A month grid or a day key built from a local Date shifts west of UTC.
  // reconcile/date-key.ts is where Date is allowed; nothing here needs it.
  ["constructs a Date", /new\s+Date\s*\(/],
  ["reads the clock", /Date\.now\s*\(/],
  ["uses parseFloat", /\bparseFloat\s*\(/],
  // A decimal literal in this layer is a float amount of money or a float
  // threshold. Both are forbidden by spec section 4.
  ["contains a decimal literal", /(?<![\w.])\d+\.\d+(?![\w.])/],
];

function sourceFiles(): string[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
}

describe("journal purity", () => {
  it("has source files to check", () => {
    // Mutation caught: the guard silently passing because it is pointed at an
    // empty directory. This is the assertion plan 1 learned to write first.
    // Ratchet: 1 (int.ts) at Task 1, 2 (+ history.ts) at Task 2, 3
    // (+ trade-stats.ts) at Task 3, 5 (+ calendar-aggregate.ts, streaks.ts) at
    // Task 4, 7 (+ trade-equity.ts, histogram.ts) at Task 5, 8
    // (+ equity-series.ts) at Task 6, 9 (+ rows.ts) at Task 7, 13
    // (+ order-display.ts, order-filters.ts, table-state.ts, trade-filters.ts)
    // at Task 8. Raise this bound whenever a task adds a top-level source
    // file to this directory, so a scan that silently stops finding a file
    // fails loudly instead of passing on a smaller-than-expected set.
    expect(sourceFiles().length).toBeGreaterThan(12);
  });

  it("guards every module this directory is supposed to have built so far", () => {
    // Mutation caught: a module dropped from the directory, or the guard being
    // pointed somewhere it no longer sees them. The engine build's lesson: a
    // guard with nothing to guard passes silently.
    expect(sourceFiles()).toEqual([
      "calendar-aggregate.ts",
      "equity-series.ts",
      "histogram.ts",
      "history.ts",
      "int.ts",
      "order-display.ts",
      "order-filters.ts",
      "rows.ts",
      "streaks.ts",
      "table-state.ts",
      "trade-equity.ts",
      "trade-filters.ts",
      "trade-stats.ts",
    ]);
  });

  // stripComments is shared with db/'s and present/'s purity guards (see
  // lib/compound/testing/strip-comments.ts) rather than kept as a local copy;
  // its own test suite covers the string, regex, and template-literal edge
  // cases this file used to test locally.
  it.each(sourceFiles())("%s stays pure", (file) => {
    const src = stripComments(readFileSync(join(DIR, file), "utf8"));
    for (const [label, pattern] of FORBIDDEN) {
      expect({ file, label, matched: pattern.test(src) }).toEqual({
        file,
        label,
        matched: false,
      });
    }
  });

  // Not `it.each(nonExempt)`: Jest 29 throws ("called with an empty Array of
  // table data") rather than passing when the table is empty, and right now
  // it legitimately is — int.ts is the only source file and it is exempt.
  // A single test with an internal loop handles zero, one or many non-exempt
  // files without that crash, and still names the offending file and rule in
  // the failure diff, exactly like the FORBIDDEN loop above.
  it("source files outside the Number() exemption do not call it", () => {
    const nonExempt = sourceFiles().filter((f) => !NUMBER_EXEMPT.has(f));
    for (const file of nonExempt) {
      const src = stripComments(readFileSync(join(DIR, file), "utf8"));
      expect({ file, matched: /\bNumber\s*\(/.test(src) }).toEqual({
        file,
        matched: false,
      });
    }
  });
});
