/**
 * present/ is pure. It formats and derives; it renders nothing and reads
 * nothing. Keeping React out of it is what lets every arithmetic test in this
 * plan run in the fast node project rather than under jsdom, and keeping db/
 * out of it is what lets those tests run with no database at all.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "@/lib/compound/testing/strip-comments";

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

/**
 * Removes quoted string CONTENT (and its delimiting quotes) from a line —
 * used only by the decimal-literal check below, on text that has already
 * been through the shared stripComments. A money string like
 * `centsFromDecimal("25000.00")` — the exact pattern fixture.ts's real
 * ledger data relies on throughout this file — is data, not a float
 * expression, and must not trip a check meant to catch a bare numeric
 * literal in actual arithmetic.
 *
 * Deliberately narrower than its ancestor, codeOnly, which this replaces.
 * codeOnly tried to detect `//` comments itself in the same pass as
 * quote-tracking, and that combination is what made it wrong: it had no
 * concept of a regex or template literal, so a `//` inside either one (a URL
 * regex, or a template literal containing the substring "//") truncated the
 * line and silently dropped whatever real code — including a genuine
 * decimal literal — followed it on that line. Proven against the actual
 * codeOnly source:
 *
 *   codeOnly('const re = /https:\\/\\//;  const y = 5.5;')
 *     -> 'const re = /https:\\/\\'          (5.5 silently dropped)
 *   codeOnly('const s = `a // b`; const y = 5.5;')
 *     -> 'const s = `a '                    (5.5 silently dropped)
 *
 * Comments are now handled once, correctly — including that regex and that
 * template literal — by stripComments, before this function ever runs. This
 * one only tracks quotes, which was never the part that was broken.
 */
function withoutQuotedContent(line: string): string {
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
  // it to 4; Task 9 adds figures.ts, taking it to 5; Task 10 adds wording.ts
  // and holder.ts, taking it to 7.
  it("scans every source file in present/", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  // Comments are stripped before matching, the same as db/'s and journal's
  // FORBIDDEN checks — this used to run on raw, unstripped source, which
  // left exactly the false-positive class this whole effort exists to
  // close: a comment reading "avoid Math.random() here" or "don't call
  // toFixed" would trip this check today just as surely as db/'s sql.ts doc
  // comment tripped its own guard before that fix. Stripping only ever adds
  // whitespace where a comment used to be, never deletes adjacent code (see
  // strip-comments.ts's `from`/`"next"` case), so this can only remove false
  // positives — it cannot hide a real one, and does not change the result
  // for any file that passes today.
  it("imports neither React nor the data layer, touches no clock or RNG, and never rounds a float", () => {
    for (const file of files) {
      const src = stripComments(readFileSync(file, "utf8"));
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
    // "1312.71" as evidence for the number they document (removed whole-file
    // by the shared stripComments), and money strings like
    // `centsFromDecimal("25000.00")` — a string is not a float, and that is
    // the whole point of fixture.ts using centsFromDecimal at all (removed
    // per-line by withoutQuotedContent, after comments are already gone).
    //
    // stripComments preserves the stripped text's line count exactly, even
    // across a multi-line block comment (see its own test for that
    // property), so the original file and its stripped form can be walked
    // in lockstep here and every offender still names the real source line.
    const offenders: string[] = [];
    for (const file of files) {
      const original = readFileSync(file, "utf8");
      const originalLines = original.split("\n");
      const strippedLines = stripComments(original).split("\n");
      for (const [i, line] of strippedLines.entries()) {
        if (/\b\d+\.\d+\b/.test(withoutQuotedContent(line))) {
          offenders.push(`${file}:${i + 1}: ${(originalLines[i] ?? "").trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("withoutQuotedContent", () => {
  it("removes the content of a quoted string, leaving the surrounding code shape", () => {
    expect(withoutQuotedContent('centsFromDecimal("25000.00")')).toBe("centsFromDecimal()");
  });

  it("leaves an unquoted decimal literal untouched", () => {
    expect(withoutQuotedContent("const rate = 1.5;")).toBe("const rate = 1.5;");
  });

  // THE FIX: codeOnly conflated quote-tracking with its own (buggy) `//`
  // comment detection. This function only tracks quotes — comment detection
  // is the shared stripComments' job, run before this on the whole file — so
  // a bare "//" that reaches this function (it never does in real use; this
  // proves the function itself no longer treats it as special) passes
  // through untouched rather than truncating the line.
  it("does not treat // as a comment marker — stripComments already removed real comments before this runs", () => {
    expect(withoutQuotedContent("http://example.com/1.5")).toBe("http://example.com/1.5");
  });
});
