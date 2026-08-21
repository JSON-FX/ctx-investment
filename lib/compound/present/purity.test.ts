/**
 * present/ is pure. It formats and derives; it renders nothing and reads
 * nothing. Keeping React out of it is what lets every arithmetic test in this
 * plan run in the fast node project rather than under jsdom, and keeping db/
 * out of it is what lets those tests run with no database at all.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = __dirname;

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ["react import", /from\s+["']react/],
  ["next import", /from\s+["']next/],
  ["the db layer", /from\s+["']@\/lib\/compound\/db/],
  ["pg import", /from\s+["']pg["']/],
  // Determinism: a pure formatter that reads the clock or the RNG can render
  // a different string for the same PoolTotals on two calls, which is the
  // same "second truth" failure mode D-D exists to rule out for previews.
  ["Math.random", /\bMath\.random\s*\(/],
  ["Date.now", /\bDate\.now\s*\(/],
  // formatDate/formatUtcStamp parse dates with a regex specifically to avoid
  // resolving a broker-server date string in the reader's local zone. `new
  // Date` reintroduces exactly that bug — see format.test.ts's "does not
  // shift the day west of UTC" case, which this is the second line of
  // defence behind.
  ["new Date", /\bnew Date\b/],
  // Money is never a Number on its way through this module (see format.ts's
  // module doc, rule 1). toFixed and Intl.NumberFormat both round a float,
  // and neither function in this file needs either — formatSplit renders a
  // basis-point percentage with plain integer div/mod instead.
  ["toFixed", /\.toFixed\s*\(/],
  ["Intl.NumberFormat", /Intl\.NumberFormat/],
];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")))
    .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
    .map((f) => join(dir, f));
}

/** True for a line that is entirely a comment: `//...`, `/**`, or a JSDoc
 *  continuation (` * ...`). Used to exempt documentation prose — this
 *  module's own comments cite figures like "1312.71" and code shapes like
 *  the `Date` constructor by name, and neither is an expression this file
 *  evaluates. */
function isWholeLineComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/**");
}

/**
 * Strips quoted string contents and a trailing `//` comment from a line,
 * leaving only the code shape. Exists so a money string like
 * `centsFromDecimal("25000.00")` — the exact safe pattern this module's
 * fixture relies on — cannot trip a check meant to catch a bare numeric
 * literal in actual arithmetic. Good enough for this codebase's style
 * (single- or double-quoted strings, no embedded template expressions in the
 * lines this runs against); it does not need to be a full tokenizer.
 */
function codeOnly(line: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\") { i += 1; continue; } // skip the escaped character
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "/" && line[i + 1] === "/") break; // rest of the line is a comment
    out += c;
  }
  return out;
}

describe("present/ purity", () => {
  const files = sourceFiles(DIR);

  // Ratchet, following lib/compound/db/purity.test.ts. If the glob ever stops
  // matching — a rename, a filter typo, a directory move — the loop below
  // iterates nothing and every forbidden-pattern check passes having checked
  // nothing. Pinning the count (not just "> 0") also catches a *partial*
  // miss, where the filter silently drops one file out of several rather
  // than all of them. The floor is raised as present/ grows: Task 2 added
  // format.ts and fixture.ts (2); Task 3 added rail.ts and derive.ts, taking
  // it to 4; Task 9 adds figures.ts, taking it to 5.
  it("scans every source file in present/", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it("imports neither React nor the data layer, touches no clock or RNG, and never rounds a float", () => {
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const [label, pattern] of FORBIDDEN) {
        expect({ file, label, matched: pattern.test(src) }).toEqual({
          file,
          label,
          matched: false,
        });
      }
    }
  });

  it("contains no floating-point literal in a money or unit expression", () => {
    // A bare decimal literal in actual code here is either a percentage
    // divisor written the wrong way or a bug — the engine has none at all,
    // and present/ only ever divides by integer bps/ppm scales (100,
    // 10_000, 1_000_000), never by a decimal. Two things are not that, and
    // are exempted before the check runs: doc comments citing a figure like
    // "1312.71" as evidence for the number they document, and money strings
    // like `centsFromDecimal("25000.00")` — a string is not a float, and
    // that is the whole point of the fixture using centsFromDecimal at all.
    const offenders: string[] = [];
    for (const file of files) {
      for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
        if (isWholeLineComment(line)) continue;
        if (/\b\d+\.\d+\b/.test(codeOnly(line))) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
