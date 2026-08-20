import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ENGINE_DIR = join(__dirname);
const FORBIDDEN = [
  /from\s+["']@\/lib\/compound\/db/,
  /from\s+["']\.\.\/db/,
  /from\s+["']next/,
  /from\s+["']react/,
  /from\s+["']@supabase/,
  /require\(["']node:fs["']\)/,
];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".test.ts"))
    .map((f) => join(dir, f));
}

describe("engine purity", () => {
  it("has at least one source file to check", () => {
    expect(sourceFiles(ENGINE_DIR).length).toBeGreaterThan(0);
  });

  it("never imports I/O modules", () => {
    for (const file of sourceFiles(ENGINE_DIR)) {
      const src = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        expect({ file, matched: pattern.test(src) }).toEqual({ file, matched: false });
      }
    }
  });
});
