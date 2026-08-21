/**
 * Shared by the purity guards in db/, journal/, and present/ — each scans its
 * own layer's non-test source files for constructs a money-handling layer
 * must never contain (a float scaling a cent value, an import that would
 * pull in I/O or the UI stack, and so on), and none of them may match a
 * comment or a string as if it were the code it describes.
 *
 * Lives here, in lib/compound/testing/, rather than inside db/, journal/, or
 * present/ themselves: each of those three purity.test.ts files globs its
 * OWN directory only (non-recursively, via `readdirSync(__dirname)`) for
 * "*.ts, not *.test.ts" and treats every match as a source file that layer's
 * own rules apply to. A shared helper placed inside any one of them would
 * become a spurious scan target for that layer's guard alone — inflating its
 * file-count ratchet with a file that is test infrastructure, not domain
 * source, and subjecting a generic string-tokenizer to e.g. db/'s "never
 * imports react" rule for no reason connected to what it actually does. A
 * sibling directory next to db/, journal/, and present/ (not underneath any
 * of them) is invisible to all three globs while staying equally reachable
 * by import from all three.
 *
 * History: db/ and journal/ each carried their own copy of a comment-only
 * stripper after a doc comment quoting the exact expression a rule exists to
 * forbid — Math.trunc(10000.05 * 100), in db/'s case — tripped that rule.
 * present/ separately grew a third, lighter implementation (`codeOnly`, a
 * per-line stripper) for its own decimal-literal check. `codeOnly` has two
 * confirmed blind spots neither of the other two ever had: it has no concept
 * of a regex literal, so a `//` inside one (e.g. /https:\/\//) truncates the
 * line and drops whatever real code follows on it; and it never recognizes a
 * backtick at all, so the same happens to a `//`-shaped substring inside a
 * template literal. Both were proven against the actual `codeOnly` source
 * before this fix, not assumed:
 *
 *   codeOnly('const RE = /https:\\/\\//;  Math.round(x)')
 *     -> 'const RE = /https:\\/\\'          (Math.round silently dropped)
 *   codeOnly('const s = `a // b`; const y = 5.5;')
 *     -> 'const s = `a '                    (5.5 silently dropped)
 *
 * Neither failure is hypothetical risk — it is "the guard scans nothing and
 * passes having checked nothing" for every line after the false comment
 * start, which is exactly the assertion-that-cannot-fail shape this project
 * has shipped two dozen times already. This module replaces `codeOnly`
 * everywhere it was used, and is the one implementation db/, journal/, and
 * present/ now all import instead of maintaining their own.
 */

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
 * comment because it sits inside a string, a template literal, or a regex
 * literal.
 *
 * Four things this deliberately gets right, all required by callers, none
 * of them just convenient:
 *
 * - A comment is replaced with a SPACE, never deleted outright. Two tokens
 *   that were only adjacent because a comment sat between them (think
 *   `from`, a block comment, then `"next"`) must stay separated by
 *   whitespace after stripping, or a pattern like `from\s+["']next` would
 *   silently stop matching and a real violation would be smuggled through
 *   by comment syntax.
 * - A multi-line block comment is replaced with a space PLUS as many
 *   newlines as it actually spanned — not collapsed to a single space. Every
 *   FORBIDDEN check in every caller uses `\s`-tolerant patterns, so this
 *   changes nothing about whether those match. It matters for present/'s
 *   decimal-literal check, which reports the ORIGINAL line a violation came
 *   from: that only works if stripping never changes the stripped text's
 *   line count relative to the source it came from.
 * - Strings, template literals and regex literals are copied through
 *   verbatim. A `//` inside a URL string, an escaped `\/\/` inside a regex,
 *   or either one inside a template literal, is data, not a comment start,
 *   and must survive unchanged so callers still see exactly what was
 *   written. (String and template *contents* are otherwise left in place —
 *   this function only removes comments. A caller that additionally needs
 *   to exempt a quoted decimal, such as a money string like
 *   `centsFromDecimal("25000.00")`, does that itself, on top of this: this
 *   module cannot blank out quoted content globally without breaking every
 *   caller's own import-detection checks, which match the string content of
 *   an import specifier — `from "next"` — on purpose.)
 * - Template-literal `${}` interpolation nests correctly via a brace-depth
 *   stack, including a nested template literal inside the interpolation.
 *
 * Not a full parser. Regex-vs-division is resolved from the preceding
 * significant token — the standard lightweight-tokenizer heuristic, correct
 * for every case in this codebase's small, consistently-styled files, but
 * (documented, not hidden) foolable by spacing none of them use, such as a
 * bare `>` comparison immediately followed by a regex with no space.
 */
export function stripComments(src: string): string {
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
      const stop = end === -1 ? n : end + 2;
      const span = src.slice(i, stop);
      let newlineCount = 0;
      for (let k = 0; k < span.length; k += 1) if (span[k] === "\n") newlineCount += 1;
      out += " " + "\n".repeat(newlineCount);
      i = stop;
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
