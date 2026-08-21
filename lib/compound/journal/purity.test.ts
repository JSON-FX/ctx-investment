import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = __dirname;

/** int.ts is the single sanctioned bigint-to-number conversion point. */
const NUMBER_EXEMPT = new Set(["int.ts"]);

const FORBIDDEN: Array<[string, RegExp]> = [
  ["imports the db layer", /from\s+["']@?[./\w-]*\/compound\/db/],
  ["imports the ui layer", /from\s+["']@?[./\w-]*\/compound\/ui/],
  ["imports next", /from\s+["']next/],
  ["imports react", /from\s+["']react/],
  ["imports @supabase", /from\s+["']@supabase/],
  // A month grid or a day key built from a local Date shifts west of UTC.
  // reconcile/date-key.ts is where Date is allowed; nothing here needs it.
  ["constructs a Date", /new\s+Date\s*\(/],
  ["reads the clock", /Date\.now\s*\(/],
  ["uses parseFloat", /\bparseFloat\s*\(/],
  // A decimal literal in this layer is a float amount of money or a float
  // threshold. Both are forbidden by spec section 4.
  ["contains a decimal literal", /(?<![\w.])\d+\.\d+(?![\w.])/],
];

/**
 * Punctuation after which a `/` starts a regex literal rather than division.
 * The standard lightweight-tokenizer heuristic: after an operator, an
 * opening bracket, or one of a handful of keywords, a `/` cannot possibly be
 * dividing anything, so it must be starting a regex.
 */
const REGEX_PRECEDENT_PUNCT = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";",
  "+", "-", "*", "%", "<", ">", "^", "~",
]);
const REGEX_PRECEDENT_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "throw", "case",
  "do", "else", "yield", "delete", "void", "await", "default",
]);

function regexAllowedAfter(lastToken: string): boolean {
  if (lastToken === "") return true;
  if (REGEX_PRECEDENT_PUNCT.has(lastToken)) return true;
  return REGEX_PRECEDENT_KEYWORDS.has(lastToken);
}

const IS_IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * Strips `//` line comments and block comments (`/*` ... `*` + `/`) from
 * TypeScript source, without disturbing a `//` that only looks like a
 * comment because it sits inside a string or a regex literal.
 *
 * Why this exists: a decimal literal cited in a doc comment — a worked
 * example like `0.5555...`, or a spec-section quote — is prose, not code. A
 * comment cannot introduce a float, a `new Date(`, or a `Number(` call at
 * runtime, so scanning prose for those patterns is pure false-positive
 * surface. This runs once per file, before every FORBIDDEN check and before
 * the Number() exemption check.
 *
 * Two things this deliberately gets right, both required by the fix, not
 * just convenient:
 *
 * - A comment is replaced with a single SPACE, never deleted outright. Two
 *   tokens that were only adjacent because a comment sat between them
 *   (think `new`, a block comment, then `Date(`) must stay separated by
 *   whitespace after stripping, or a pattern like `new\s+Date\s*\(` would
 *   silently stop matching and a real violation would be smuggled through
 *   by comment syntax. This is also the textually correct semantics — the
 *   grammar already treats a comment as whitespace between tokens, never as
 *   something that can join two identifiers (or two numeric literals) into
 *   one — so deleting it outright is the wrong model, not just a risky one.
 * - Strings, template literals and regex literals are copied through
 *   verbatim. A `//` inside a URL string, or an escaped `\/\/` inside a
 *   regex, is data, not a comment start, and must survive unchanged so the
 *   FORBIDDEN checks still see exactly what was written.
 *
 * Not a full parser. Regex-vs-division is resolved from the preceding
 * significant token, the standard lightweight-tokenizer heuristic — right
 * for every case in this directory's small, consistently-styled files, but
 * (documented, not hidden) foolable by spacing no file here uses, such as a
 * bare `>` comparison immediately followed by a regex with no space.
 * Template-literal `${}` interpolation nests correctly via a brace-depth
 * stack, including a nested template literal inside the interpolation.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let lastToken = "";
  let identBuf = "";
  let mode: "code" | "template" = "code";
  const templateResumeDepth: number[] = [];
  let braceDepth = 0;

  while (i < n) {
    const c = src[i]!;

    if (mode === "template") {
      if (c === "\\") {
        out += c + (src[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (c === "`") {
        out += c;
        i += 1;
        mode = "code";
        lastToken = "`";
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        out += "${";
        i += 2;
        templateResumeDepth.push(braceDepth);
        braceDepth += 1;
        mode = "code";
        continue;
      }
      out += c;
      i += 1;
      continue;
    }

    // mode === "code": flush any identifier run before deciding what `c` is,
    // so a `/` immediately following an identifier sees the whole word, not
    // just its last character.
    if (!IS_IDENT_CHAR.test(c) && identBuf) {
      lastToken = identBuf;
      identBuf = "";
    }

    const c2 = i + 1 < n ? src[i + 1]! : "";

    if (c === "/" && c2 === "/") {
      const end = src.indexOf("\n", i);
      i = end === -1 ? n : end;
      out += " ";
      continue;
    }

    if (c === "/" && c2 === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
      continue;
    }

    if (c === "'" || c === '"') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        const ch = src[i]!;
        if (ch === "\\") {
          out += ch + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += ch;
        i += 1;
        if (ch === quote || ch === "\n") break;
      }
      lastToken = quote;
      continue;
    }

    if (c === "`") {
      out += c;
      i += 1;
      mode = "template";
      continue;
    }

    if (c === "{") {
      out += c;
      braceDepth += 1;
      lastToken = "{";
      i += 1;
      continue;
    }

    if (c === "}") {
      out += c;
      const top = templateResumeDepth[templateResumeDepth.length - 1];
      if (top !== undefined && braceDepth === top + 1) {
        templateResumeDepth.pop();
        braceDepth -= 1;
        mode = "template";
        i += 1;
        continue;
      }
      braceDepth = Math.max(0, braceDepth - 1);
      lastToken = "}";
      i += 1;
      continue;
    }

    if (c === "/" && regexAllowedAfter(lastToken)) {
      const start = i;
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = src[j]!;
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "\n") break;
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) {
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(src[j]!)) j += 1;
        out += src.slice(start, j);
        i = j;
        lastToken = "/";
        continue;
      }
      // No closing delimiter before end of line: not actually a regex. Fall
      // through and treat the `/` as an ordinary (division) character.
    }

    out += c;
    if (IS_IDENT_CHAR.test(c)) {
      identBuf += c;
    } else if (!/\s/.test(c)) {
      lastToken = c;
    }
    i += 1;
  }

  return out;
}

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

describe("stripComments", () => {
  // Mutation caught: reverting to a naive `src.replace(/\/\/.*/g, "")`
  // line-comment strip, which cannot tell a real comment from a `//` sitting
  // inside a string or a regex.
  it("strips a line comment", () => {
    expect(stripComments("const x = 1n; // trailing note\nconst y = 2n;")).toBe(
      "const x = 1n;  \nconst y = 2n;",
    );
  });

  it("strips a block comment, including one that spans multiple lines", () => {
    const src = "const x =\n/* explains\n   the value */\n1n;";
    const stripped = stripComments(src);
    expect(stripped).not.toContain("explains");
    expect(stripped).not.toContain("/*");
    expect(stripped).not.toContain("*/");
  });

  // THE FALSE-POSITIVE FIX ITSELF. Mutation caught: reverting to scanning
  // raw source, which is exactly what made trade-stats.ts's doc comment
  // (quoting "0.5555555555555556" as a worked example) fail the guard.
  it("removes a decimal literal that only appears in a comment", () => {
    const src =
      "// 5 wins in 9 trades is 0.5555555555555556, not a float\nconst bps = 5555;";
    expect(/\d+\.\d+/.test(stripComments(src))).toBe(false);
  });

  // DIRECTION 1: do not strip something that only looks like a comment.
  // Mutation caught: a naive stripper truncating this string at the `//`,
  // which would both corrupt the source and silently hide whatever followed
  // it on the same line.
  it("does not treat a // inside a string literal as a comment", () => {
    const src = 'const url = "https://example.com/path";';
    expect(stripComments(src)).toBe(src);
  });

  // DIRECTION 1, regex variant. "/\/\//" contains two literal `/` characters
  // back to back (the first escaped pair's slash butting against the
  // closing delimiter) — exactly the substring a naive `//`-based stripper
  // matches on. Mutation caught: the same naive stripper, corrupting the
  // regex instead of a string.
  it("does not treat a // inside a regex literal as a comment", () => {
    const src = "const re = /\\/\\//;";
    expect(stripComments(src)).toBe(src);
  });

  // DIRECTION 2: do not let the strip become a hiding place. Mutation
  // caught: deleting the comment instead of replacing it with a space, which
  // would turn `new/* hack */Date(` into `newDate(` — no longer matching
  // /new\s+Date\s*\(/ — and let a real violation through disguised as a
  // comment dropped mid-token.
  it("keeps new/Date detectable across an adjacent comment, rather than joining the tokens", () => {
    const src = "const t = new/* hack */Date();";
    expect(/new\s+Date\s*\(/.test(stripComments(src))).toBe(true);
  });

  // The same concern, opposite failure mode: deleting the comment instead of
  // spacing it would turn `1./* not a fraction */5` into the text `1.5`,
  // which is not a real decimal literal in JS token semantics (`1.` and `5`
  // are two separate numeric literals either side of a comment) but WOULD
  // match \d+\.\d+ if the comment vanished instead of leaving a gap.
  it("does not let a comment splice two numeric tokens into a fake decimal literal", () => {
    const src = "const a = 1./* not a fraction */5;";
    expect(/\d+\.\d+/.test(stripComments(src))).toBe(false);
  });

  // A real, uncommented violation must survive the strip untouched.
  // Mutation caught: a stripComments that eats real code along with
  // comments — for instance, one that discards everything after the first
  // `/` it sees regardless of context.
  it("leaves a real decimal literal in actual code intact", () => {
    const src = "export const RATE = 1.5; // not from a comment";
    expect(/\d+\.\d+/.test(stripComments(src))).toBe(true);
  });

  it("resumes a template literal correctly after a nested ${} interpolation", () => {
    const src = "const s = `a${ 1 + 2 }b // not a comment`;";
    expect(stripComments(src)).toContain("b // not a comment");
  });
});
