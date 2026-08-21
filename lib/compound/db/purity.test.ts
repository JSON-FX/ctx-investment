import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "@/lib/compound/testing/strip-comments";

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

describe("db purity", () => {
  const files = sourceFiles(DB_DIR);

  // Ratchet. If the glob ever stops matching, the loop below iterates nothing
  // and passes having checked nothing. The floor is raised as db/ grows —
  // Task 8 took it to 6; Task 5 adds holders.ts and users.ts, taking it to 8;
  // Task 6 adds write-account.ts, taking it to 9; plan 4 Task 9 adds
  // ledger-meta.ts, taking it to 10; plan 4 Task 12 adds write-holder.ts and
  // write-deposit.ts, taking it to 12.
  it("scans every source file in db/", () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  // Comments are stripped before matching (see strip-comments.ts): a doc
  // comment quoting the very expression this guard forbids — sql.ts cites
  // Math.trunc(10000.05 * 100) as the reason the rule exists — must not trip
  // the rule it is explaining. stripComments is shared with journal/ and
  // present/'s purity guards rather than reimplemented here; its own test
  // suite (lib/compound/testing/strip-comments.test.ts) covers the string,
  // regex, and template-literal edge cases this file used to test locally.
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
