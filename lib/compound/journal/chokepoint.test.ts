import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(__dirname, "..", "..", "..");
const SCANNED = ["lib", "app"];
// Build/vendor/VCS output only — never a place source could legitimately
// hide. Do NOT add fixture or test-data directories here: SKIP_DIRS used to
// carry "__fixtures__" too, matched by basename, which meant ANY directory
// named __fixtures__ anywhere under lib/ or app/ — not just the one at
// journal/__fixtures__ — was silently exempt from every check below. A file
// dropped in a second, differently-located __fixtures__ directory could then
// brand DedupedDeals or call getClosedDeals with a clean tsc and a green
// scan. Fixture files don't need an exemption: they hold raw ClosedDeal[]
// data and neither cast to DedupedDeals nor call getClosedDeals, so scanning
// them costs nothing. The one file structurally allowed to construct the
// brand (history.ts) is exempted below by its own path, not by trusting a
// directory name.
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

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
  //
  // TypeScript has two cast syntaxes and both must be covered, or the ban is
  // only as strong as whichever one someone remembers to type:
  //   - `as` casts:      raw as DedupedDeals / raw as unknown as DedupedDeals
  //   - angle-bracket:   <DedupedDeals>raw
  // The angle-bracket form is confirmed to compile directly (no `unknown`
  // bridge needed) when the source is a readonly array type, exactly what
  // every real call site passes in. The negative lookbehind on the second
  // alternative excludes a legitimate generic reference like
  // `Array<DedupedDeals>` or `Foo<DedupedDeals>`, which is preceded by an
  // identifier character rather than the start of an expression.
  const DEDUPED_DEALS_CAST =
    /as\s+(unknown\s+as\s+)?DedupedDeals\b|(?<![\w.])<DedupedDeals>/;

  it("brands DedupedDeals only inside history.ts", () => {
    const offenders = sources()
      .filter((f) => !f.endsWith(join("journal", "history.ts")))
      .filter((f) => DEDUPED_DEALS_CAST.test(readFileSync(f, "utf8")))
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
