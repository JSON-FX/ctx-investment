import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DB_DIR = join(__dirname);

/**
 * Money arithmetic belongs in SQL (see sql.ts). Any of these in a db/ source
 * file means a cent value is being scaled in JavaScript, which is where
 * Math.trunc(10000.05 * 100) quietly returns 1000004.
 *
 * Number() is deliberately NOT here: ids legitimately use it, and they are not
 * money.
 */
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ["parseFloat", /\bparseFloat\s*\(/],
  // A global pg type parser is the one way to undo every other rule here at
  // once: setTypeParser(20, Number) turns EVERY int8 in the app into a JS
  // number, silently, including money. Task 5 probed this at runtime and found
  // the blast radius contained to a single Jest file by module-registry
  // isolation — which means the runtime probe is a test-runner artifact, not a
  // production guarantee. A source scan is, because it does not depend on which
  // module registry happened to load first. Tests may still call it; only
  // non-test sources in db/ are scanned.
  ["pg setTypeParser", /\bsetTypeParser\s*\(/],
  ["Math.round", /\bMath\.round\s*\(/],
  ["Math.trunc", /\bMath\.trunc\s*\(/],
  ["Math.floor", /\bMath\.floor\s*\(/],
  ["multiply by 100", /\*\s*100\b/],
  ["multiply by 1000", /\*\s*1000\b/],
  ["divide by 100", /\/\s*100\b/],
  ["next import", /from\s+["']next/],
  ["react import", /from\s+["']react/],
  ["supabase-js import", /from\s+["']@supabase/],
];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".test.ts"))
    .map((f) => join(dir, f));
}

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
 * Why this exists: sql.ts's module doc explains the whole reason this guard
 * exists by citing the exact failure it prevents — Math.trunc(10000.05 * 100)
 * losing a cent to float rounding. Quoting that expression in prose used to
 * trip this very guard: "Math.trunc" and "multiply by 100" both matched,
 * inside a comment, on text that scales nothing at runtime. A comment cannot
 * put a float into a money value, so scanning prose for these patterns is
 * pure false-positive surface. This runs once per file, before the FORBIDDEN
 * check below.
 *
 * Ported from journal/purity.test.ts's stripComments, which solved the same
 * false-positive problem for the journal layer. Copied rather than imported:
 * every purity.test.ts under lib/compound/ (engine/, reconcile/, present/,
 * ui/, this one) is a standalone guard with no dependency on its siblings —
 * that independence is deliberate, since a guard that imports shared code is
 * a guard that can be weakened by an edit somewhere else entirely. This fix
 * keeps that shape rather than wiring a new cross-directory dependency into
 * the one file whose job is catching things that shouldn't be wired
 * together.
 *
 * Two things this deliberately gets right, both required by the fix, not
 * just convenient:
 *
 * - A comment is replaced with a single SPACE, never deleted outright. Two
 *   tokens that were only adjacent because a comment sat between them (think
 *   `from`, a block comment, then `"next"`) must stay separated by
 *   whitespace after stripping, or a pattern like `from\s+["']next` would
 *   silently stop matching and a real violation would be smuggled through by
 *   comment syntax.
 * - Strings, template literals and regex literals are copied through
 *   verbatim. A `//` inside a URL string, or an escaped `\/\/` inside a
 *   regex, is data, not a comment start, and must survive unchanged so the
 *   FORBIDDEN checks still see exactly what was written.
 *
 * Not a full parser. Regex-vs-division is resolved from the preceding
 * significant token — the standard lightweight-tokenizer heuristic, correct
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

describe("db purity", () => {
  const files = sourceFiles(DB_DIR);

  // Ratchet. If the glob ever stops matching, the loop below iterates nothing
  // and passes having checked nothing. The floor is raised as db/ grows —
  // Task 8 took it to 6; Task 5 adds holders.ts and users.ts, taking it to 8;
  // Task 6 adds write-account.ts, taking it to 9.
  it("scans every source file in db/", () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  it("never scales money in JavaScript, and never imports the UI stack", () => {
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

  // THE FALSE-POSITIVE FIX ITSELF. Mutation caught: reverting to scanning raw
  // source, which is exactly what made sql.ts's module doc (citing
  // Math.trunc(10000.05 * 100) as the worked example of why this guard
  // exists) fail its own guard.
  it("removes a forbidden-looking construct that only appears in a comment", () => {
    const src =
      "// Verified: Math.trunc(10000.05 * 100) comes out one cent short.\nexport const CENTS_PER_UNIT = \"100\";";
    const stripped = stripComments(src);
    for (const [, pattern] of FORBIDDEN) {
      expect(pattern.test(stripped)).toBe(false);
    }
  });

  // DIRECTION 1: do not strip something that only looks like a comment.
  // Mutation caught: a naive stripper truncating this string at the `//`,
  // which would both corrupt the source and silently hide whatever followed
  // it on the same line.
  it("does not treat a // inside a string literal as a comment", () => {
    const src = 'const url = "https://example.com/path";';
    expect(stripComments(src)).toBe(src);
  });

  // DIRECTION 1, regex variant. "/https:\/\//" contains two literal `/`
  // characters back to back (an escaped slash butting against the closing
  // delimiter) — exactly the substring a naive `//`-based stripper matches
  // on. Mutation caught: the same naive stripper, corrupting the regex
  // instead of a string, and silently deleting whatever code followed it —
  // proven empirically against present/purity.test.ts's line-based codeOnly
  // helper, which truncates this exact input and drops a trailing
  // Math.round( call from the scan entirely.
  it("does not treat a // inside a regex literal as a comment", () => {
    const src = "const re = /https:\\/\\//;";
    expect(stripComments(src)).toBe(src);
  });

  // DIRECTION 1, template-literal variant: a `//` inside a template literal
  // is data, not a comment start.
  it("does not treat a // inside a template literal as a comment", () => {
    const src = "const url = `https://example.com/${path}`;";
    expect(stripComments(src)).toBe(src);
  });

  // DIRECTION 2: do not let the strip become a hiding place. Mutation
  // caught: deleting the comment instead of replacing it with a space, which
  // would turn `from/* pkg */"next"` into `from"next"` — no longer matching
  // /from\s+["']next/ — and let a real import through disguised as a comment
  // dropped mid-statement.
  it("keeps a real import detectable across an adjacent comment, rather than joining the tokens", () => {
    const src = 'import x from/* pkg */"next";';
    expect(/from\s+["']next/.test(stripComments(src))).toBe(true);
  });

  // The same concern, opposite failure mode: deleting the comment instead of
  // spacing it could splice two separate tokens into text that reads as one.
  it("does not let a comment splice two adjacent tokens together", () => {
    expect(stripComments("const a = 1/* not fused */00;")).toBe(
      "const a = 1 00;",
    );
  });

  // A real, uncommented violation must survive the strip untouched. Mutation
  // caught: a stripComments that eats real code along with comments — for
  // instance, one that discards everything after the first `/` it sees
  // regardless of context.
  it("leaves a real violation in actual code intact", () => {
    const src = "export const scaled = amount * 100; // not from a comment";
    expect(/\*\s*100\b/.test(stripComments(src))).toBe(true);
  });

  it("resumes a template literal correctly after a nested ${} interpolation", () => {
    const src = "const s = `a${ 1 + 2 }b // not a comment`;";
    expect(stripComments(src)).toContain("b // not a comment");
  });
});
