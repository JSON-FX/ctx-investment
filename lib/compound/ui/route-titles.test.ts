/**
 * A static read of the seven real page.tsx sources under app/a/[id] — not a
 * rendered-component test. app/ sits outside every Jest project's roots
 * (jest.config.mjs's roots are lib/ and lib/compound/ui/ only), so nothing
 * under it can be imported and rendered here. ui/purity.test.ts already
 * establishes the pattern this file follows: a plain node:fs read of real
 * production source, asserting real properties of it, rather than a fixture
 * that only ever proves itself.
 *
 * What this catches that a rendered test of routeTitle() alone cannot: a
 * route whose page.tsx never calls generateMetadata at all — reverted,
 * forgotten, or never wired up — silently falls back to app/layout.tsx's
 * one shared "Compound — Investor Desk" title. That fallback is invisible
 * to any test that only renders routeTitle() in isolation; it is only
 * visible by reading the page source that decides whether routeTitle() is
 * ever called.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(__dirname, "../../../app/a/[id]");

interface PageUnderTest {
  route: string;
  file: string;
  /** The literal first argument PAGE's routeTitle(...) call should carry.
   *  Null for the holder statement, whose title names the holder (a
   *  variable), not a literal string — checked on its own below. */
  surface: string | null;
}

const PAGES: PageUnderTest[] = [
  { route: "desk", file: "page.tsx", surface: "Desk" },
  { route: "ledger", file: "ledger/page.tsx", surface: "Ledger" },
  { route: "journal", file: "journal/page.tsx", surface: "Journal" },
  { route: "calendar", file: "calendar/page.tsx", surface: "Calendar" },
  { route: "performance", file: "performance/page.tsx", surface: "Performance" },
  { route: "review", file: "review/page.tsx", surface: "Review" },
  { route: "holder statement", file: "holders/[hid]/page.tsx", surface: null },
];

function source(relFile: string): string {
  return readFileSync(join(APP_DIR, relFile), "utf8");
}

describe("every route under /a/[id] has its own <title>", () => {
  it.each(PAGES.map(({ route, file }) => [route, file] as const))(
    "%s's page.tsx exports generateMetadata",
    (_route, file) => {
      expect(source(file)).toMatch(/export\s+async\s+function\s+generateMetadata\b/);
    },
  );

  it.each(
    PAGES.filter((p): p is PageUnderTest & { surface: string } => p.surface !== null)
      .map(({ route, file, surface }) => [route, file, surface] as const),
  )("%s (%s) builds its title through routeTitle(%p, …), not a hand-rolled string", (_route, file, surface) => {
    const line = source(file).match(/title:\s*\S[^\n]*/)?.[0];
    expect(line).toBeDefined();
    expect(line).toMatch(
      new RegExp(`^title:\\s*routeTitle\\(\\s*["']${surface}["']\\s*,\\s*account\\.label\\s*\\)`),
    );
  });

  it("the holder statement names the holder, not a literal 'Holder statement'", () => {
    const line = source("holders/[hid]/page.tsx").match(/title:\s*\S[^\n]*/)?.[0];
    expect(line).toBeDefined();
    expect(line).toMatch(/^title:\s*routeTitle\(\s*name\s*,\s*account\.label\s*\)/);
  });

  it("no two of the seven routes build the same literal surface text — the defect this fixes", () => {
    const surfaces = PAGES.map((p) => p.surface ?? "<holder name>");
    expect(new Set(surfaces).size).toBe(surfaces.length);
  });

  it("no title anywhere in app/a/[id] is built without going through routeTitle", () => {
    // Catches the shape of a regression a "does it call routeTitle" check
    // alone would miss: a SECOND, hand-rolled `title:` added beside a
    // correct one (Next.js metadata takes the last one it sees), or a
    // route with no entry in PAGES above growing its own title assignment
    // nobody is watching.
    for (const { file } of PAGES) {
      const titleLines = source(file).match(/title:\s*\S[^\n]*/g) ?? [];
      expect(titleLines.length).toBe(1);
      expect(titleLines[0]!.startsWith("title: routeTitle(")).toBe(true);
    }
  });
});
