import { stripComments } from "@/lib/compound/testing/strip-comments";

/**
 * db/purity.test.ts, journal/purity.test.ts, and present/purity.test.ts all
 * import stripComments from here and rely on every property proven below.
 * Kept beside the implementation, not inside any of the three directories it
 * serves, for the same reason the implementation itself lives here — see
 * strip-comments.ts's module doc.
 */
describe("stripComments", () => {
  // Mutation caught: reverting to a naive `src.replace(/\/\/.*/g, "")`
  // line-comment strip, which cannot tell a real comment from a `//` sitting
  // inside a string, a template literal, or a regex.
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

  // present/'s decimal-literal check reports the file:line of an offending
  // ORIGINAL line, computed by walking stripComments(src) and original src
  // in lockstep, line by line. That only works if a multi-line block comment
  // doesn't change the stripped text's line count relative to the source it
  // came from — collapsing it to one space (as db/'s and journal/'s earlier,
  // standalone copies of this function did) would silently shift every
  // subsequent line number in the report by however many lines the comment
  // spanned.
  it("preserves line count across a multi-line block comment", () => {
    const src = "const x = 1;\n/* line one\n   line two\n   line three */\nconst y = 2;";
    expect(stripComments(src).split("\n").length).toBe(src.split("\n").length);
  });

  // THE ORIGINAL FALSE-POSITIVE FIX. Mutation caught: reverting to scanning
  // raw source, which is exactly what made db/'s sql.ts module doc (citing
  // Math.trunc(10000.05 * 100) as the worked example of why that guard
  // exists) fail its own guard.
  it("removes a forbidden-looking construct that only appears in a comment", () => {
    const src =
      "// Verified: Math.trunc(10000.05 * 100) comes out one cent short.\nexport const CENTS_PER_UNIT = \"100\";";
    const stripped = stripComments(src);
    expect(/\bMath\.trunc\s*\(/.test(stripped)).toBe(false);
    expect(/\*\s*100\b/.test(stripped)).toBe(false);
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
  // on.
  it("does not treat a // inside a regex literal as a comment", () => {
    const src = "const re = /https:\\/\\//;";
    expect(stripComments(src)).toBe(src);
  });

  it("does not treat a // inside a template literal as a comment", () => {
    const src = "const url = `https://example.com/${path}`;";
    expect(stripComments(src)).toBe(src);
  });

  // THE TWO CONFIRMED present/ codeOnly REGRESSIONS. codeOnly has no concept
  // of a regex literal and never recognizes a backtick at all, so in both
  // cases it truncates the line at the false "//" and silently drops
  // whatever real code follows — here, a genuine decimal literal that
  // present/'s money-purity check exists specifically to catch. Proven
  // against the actual (now-replaced) codeOnly source before this fix:
  //
  //   codeOnly('const re = /https:\\/\\//;  const y = 5.5;')
  //     -> 'const re = /https:\\/\\'                  (5.5 silently dropped)
  //   codeOnly('const s = `a // b`; const y = 5.5;')
  //     -> 'const s = `a '                             (5.5 silently dropped)
  it("does not let a // inside a regex literal hide a real decimal literal later on the same line", () => {
    const src = "const re = /https:\\/\\//; const y = 5.5;";
    const stripped = stripComments(src);
    expect(stripped).toBe(src);
    expect(/\d+\.\d+/.test(stripped)).toBe(true);
  });

  it("does not let a // inside a template literal hide a real decimal literal later on the same line", () => {
    const src = "const s = `a // b`; const y = 5.5;";
    const stripped = stripComments(src);
    expect(stripped).toBe(src);
    expect(/\d+\.\d+/.test(stripped)).toBe(true);
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
