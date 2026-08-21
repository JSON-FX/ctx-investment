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
  // Task 8 takes it to 6.
  it("scans every source file in db/", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it("never scales money in JavaScript, and never imports the UI stack", () => {
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
});
