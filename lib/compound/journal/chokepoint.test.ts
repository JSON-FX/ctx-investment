import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(__dirname, "..", "..", "..");
const SCANNED = ["lib", "app"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "__fixtures__"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

function sources(): string[] {
  return SCANNED.flatMap((d) => {
    const full = join(REPO, d);
    return statSync(full).isDirectory() ? walk(full) : [];
  });
}

describe("the dedupe choke point", () => {
  it("scans a plausible number of files", () => {
    // Mutation caught: a broken walker returning [], which would make every
    // assertion below pass vacuously. This is the ratchet the carried-forward
    // note asks for.
    expect(sources().length).toBeGreaterThan(10);
  });

  // Mutation caught: `deals as unknown as DedupedDeals` written in a page to
  // get past the compiler. The brand is only as strong as the ban on casting.
  it("brands DedupedDeals only inside history.ts", () => {
    const offenders = sources()
      .filter((f) => !f.endsWith(join("journal", "history.ts")))
      .filter((f) => /as\s+(unknown\s+as\s+)?DedupedDeals/.test(readFileSync(f, "utf8")))
      .map((f) => relative(REPO, f));
    expect(offenders).toEqual([]);
  });

  // Mutation caught: a page calling getClosedDeals directly and handing the
  // rows to a component — precisely what the sibling product does.
  it("calls getClosedDeals only from db/ and load/", () => {
    const allowed = [join("compound", "db"), join("compound", "load")];
    const offenders = sources()
      .filter((f) => !allowed.some((a) => f.includes(a)))
      .filter((f) => /\bgetClosedDeals\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => relative(REPO, f));
    expect(offenders).toEqual([]);
  });
});
