/**
 * ui/ renders. It does not read.
 *
 * If a component can reach the database, then testing what it renders means
 * standing up a database, which means the arithmetic tests get slow and then
 * get skipped. Every component in here takes engine types as props and the
 * route decides where they came from.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIR = __dirname;
const FORBIDDEN: [RegExp, string][] = [
  [/from\s+["']@\/lib\/compound\/db/, "the db layer"],
  [/from\s+["']@\/lib\/compound\/load/, "the loaders"],
  [/from\s+["']pg["']/, "pg"],
  [/from\s+["']next\/headers["']/, "next/headers"],
  [/from\s+["']@supabase/, "supabase"],
  [/\bnew Date\b/, "new Date"],
  [/\bDate\.now\b/, "Date.now"],
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...sources(full)); continue; }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

describe("ui/ purity", () => {
  it("has sources to check", () => {
    expect(sources(DIR).length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN)("imports nothing matching %s (%s)", (pattern, label) => {
    const offenders = sources(DIR).filter((f) => pattern.test(readFileSync(f, "utf8")));
    expect({ label, offenders }).toEqual({ label, offenders: [] });
  });

  it("declares no client component that takes a bigint prop", () => {
    // A bigint does not survive the server/client boundary and a formatted
    // string is not a value. If a component ever needs "use client", its
    // money props must be decimal strings.
    const offenders = sources(DIR)
      .map((f) => [f, readFileSync(f, "utf8")] as const)
      .filter(([, src]) => /^["']use client["']/m.test(src))
      .filter(([, src]) => /:\s*(Cents|Units|bigint)\b/.test(src))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });
});
