/**
 * Spec section 8 states four contrast ratios as facts. Here they are as
 * assertions, computed from the stylesheet rather than from a transcription.
 * `token()` reads app/globals.css off disk on every run — delete the file,
 * or change a hex, and these tests fail. They do not carry their own copy
 * of the values to compare against.
 *
 * Deviation from spec section 8.1, on record here because this file is what
 * enforces it:
 *
 *   - --ink-3 ships at #5f6b7c, not the spec's #8a96a6. The spec's value is
 *     3.00:1 on --card; section 8.4 puts body text at 4.5:1. Both cannot be
 *     true, and the shipped stylesheet used --ink-3 for eyebrows, column
 *     headers and secondary labels. #5f6b7c clears 4.5:1 on --card (5.41:1)
 *     and is what --ink-3 now means everywhere: a third, usable text tier.
 *     It does NOT clear 4.5:1 on --paper (4.49:1 — see the dedicated test
 *     below), so it is card-background text only until that changes.
 *   - --rule stays at the spec's #d2d8e0. It is NOT changed to #8a96a6.
 *     See the long comment above the --rule declaration in globals.css for
 *     why: --rule already exists in spec section 8.1 as a distinct, heavily
 *     used token (every panel, table, chip, field and sheet border in this
 *     file), and #8a96a6 was --ink-3's old value, not a free name. Giving
 *     --rule that value would be a real, sitewide recolour of every hairline
 *     and border in the product, undocumented in the spec, and would fight
 *     plan 5's sibling build against the same spec text. That is out of
 *     this task's authority to do silently; see the Task 1 report.
 *
 * Two of the checks below look backwards and are not:
 *
 *   - --fee is asserted to be BELOW 4.5:1. It is a structural colour: fills,
 *     chips and marks. If someone darkens it so it can carry text, this test
 *     goes red and forces the question "what is amber for?" to be answered in
 *     the spec rather than in a hurry.
 *   - --rule is asserted to be BELOW 3:1 on both grounds. That is today's
 *     real, tracked state (WCAG 1.4.11 non-text contrast — this token draws
 *     .field's input borders among others) — not a claim that it is fine.
 *     It is a known gap, deliberately visible here rather than silently
 *     absent, so a future change to --rule is a conscious, reviewed number
 *     rather than an unnoticed drift.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(join(__dirname, "../../../app/globals.css"), "utf8");

// Block comments can quote CSS syntax as prose (this very file's header does,
// to explain the rules below) — an offender scan over raw CSS would flag its
// own documentation. Real proof this was live, not theoretical: this file's
// first draft asserted `color: var(--fee)` never appears, and the header
// comment saying so — in backticks — tripped the assertion it was next to.
// Strip comments before scanning for declarations; `token()` still reads the
// raw text, since a token's own definition is never inside a comment.
const CSS_WITHOUT_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

function token(name: string): string {
  const m = new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6})`).exec(CSS);
  if (!m) throw new Error(`token --${name} is not defined in app/globals.css`);
  return m[1]!.toLowerCase();
}

function colorDeclarationOffenders(varName: string): string[] {
  const re = new RegExp(`(^|[^-])color\\s*:\\s*var\\(--${varName}\\)`);
  return CSS_WITHOUT_COMMENTS.split("\n").filter((l) => re.test(l));
}

export function luminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const CARD = "#ffffff";
const PAPER = "#e7eaef";

describe("the contrast formula itself, against a value nobody transcribed from this project", () => {
  it("black on white is exactly 21:1 — the WCAG-defined maximum", () => {
    // Not derived from the spec or the plan. If this fails, the formula is
    // wrong and nothing else in this file can be trusted regardless of what
    // it reports.
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 6);
  });

  it("a colour against itself is exactly 1:1", () => {
    expect(contrast("#5f6b7c", "#5f6b7c")).toBeCloseTo(1, 6);
  });
});

describe("the tokens in app/globals.css", () => {
  const expected: Record<string, string> = {
    paper: "#e7eaef", card: "#ffffff",
    ink: "#0f1b2d", "ink-2": "#4a5768", "ink-3": "#5f6b7c",
    rule: "#d2d8e0", "rule-soft": "#e6eaef",
    gain: "#0b6b45", loss: "#a32a2b",
    own: "#14532d", "own-2": "#d6e9de",
    fee: "#f59e0b", "fee-ink": "#b45309", "fee-bg": "#fef6e4",
  };
  for (const [name, hex] of Object.entries(expected)) {
    it(`--${name} is ${hex}`, () => expect(token(name)).toBe(hex));
  }
});

describe("figure and body colours clear the 4.5:1 floor on --card", () => {
  it.each([
    ["gain", 6.56], ["loss", 7.18], ["own", 9.11], ["fee-ink", 5.02],
    ["ink", 17.28], ["ink-2", 7.36], ["ink-3", 5.41],
  ])("--%s is %f:1 on --card", (name, ratio) => {
    expect(contrast(token(name), CARD)).toBeCloseTo(ratio, 2);
    expect(contrast(token(name), CARD)).toBeGreaterThanOrEqual(4.5);
  });

  // fee-ink is deliberately not in this list. It clears --card at 5.02:1 but
  // NOT --paper — see the dedicated test below. It was in this list in an
  // earlier draft (matching the plan's Task 1 snippet) and the run failed:
  // real evidence the --card pass does not imply the --paper pass, which is
  // exactly why each ground is checked separately instead of assumed.
  it.each([["gain"], ["loss"], ["own"], ["ink"], ["ink-2"]])(
    "--%s also clears 4.5:1 on --paper",
    (name) => expect(contrast(token(name), PAPER)).toBeGreaterThanOrEqual(4.5),
  );

  it("--ink-3 does NOT clear 4.5:1 on --paper (4.49:1) — card-background text only", () => {
    // 4.4872, a hair under the floor. This is not the same failure as the
    // spec's old --ink-3: it is close enough that a future task reaching
    // for --ink-3 on a --paper background (rather than inside a --card
    // panel) needs to notice, not assume the --card clearance covers it.
    const r = contrast(token("ink-3"), PAPER);
    expect(r).toBeCloseTo(4.49, 2);
    expect(r).toBeLessThan(4.5);
  });

  it("--fee-ink does NOT clear 4.5:1 on --paper (4.16:1) — card-background text only", () => {
    // Found by running this test, not by reading the plan: the plan's Task 1
    // snippet lists fee-ink in the "also clears --paper" batch without a
    // pinned number, alongside gain/loss/own/ink/ink-2 which do all clear
    // it. fee-ink does not — a darker background lowers contrast against a
    // dark foreground, and 5.02:1 on --card has less room than the other
    // five. Every fee-ink consumer in this stylesheet (.fee, .kpi-item.is-fee
    // .v, .receipt-line.is-fee .r, .chip.is-fee) sits on --card or --fee-bg,
    // never bare --paper, which is what keeps the product compliant despite
    // this.
    const r = contrast(token("fee-ink"), PAPER);
    expect(r).toBeCloseTo(4.16, 2);
    expect(r).toBeLessThan(4.5);
  });
});

describe("amber is structural, and the stylesheet does not forget it", () => {
  it("--fee is 2.15:1 on white and therefore cannot carry text", () => {
    expect(contrast(token("fee"), CARD)).toBeCloseTo(2.15, 2);
    expect(contrast(token("fee"), CARD)).toBeLessThan(4.5);
  });

  it("no rule sets `color` to var(--fee)", () => {
    expect(colorDeclarationOffenders("fee")).toEqual([]);
  });

  it("--ink on --fee is 8.05:1, so amber may back dark text", () => {
    expect(contrast(token("ink"), token("fee"))).toBeCloseTo(8.05, 2);
  });

  it("--fee-ink on --fee-bg is 4.67:1, so the fee chip is legible", () => {
    expect(contrast(token("fee-ink"), token("fee-bg"))).toBeCloseTo(4.67, 2);
  });
});

describe("--rule never carries text (the non-text-only token)", () => {
  it("no rule sets `color` to var(--rule)", () => {
    expect(colorDeclarationOffenders("rule")).toEqual([]);
  });

  it("no rule sets `color` to var(--rule-soft) either", () => {
    expect(colorDeclarationOffenders("rule-soft")).toEqual([]);
  });

  // Tracked, not hidden: --rule is below the 3:1 non-text floor (WCAG
  // 1.4.11) today. See the file-header comment for why this task does not
  // change the value. A future task raising --rule to clear 3:1 should
  // update these two numbers deliberately, which is the point of pinning
  // them instead of leaving this gap unmeasured.
  it("--rule is 1.43:1 on --card — below the 3:1 non-text floor (known, tracked gap)", () => {
    const r = contrast(token("rule"), CARD);
    expect(r).toBeCloseTo(1.43, 2);
    expect(r).toBeLessThan(3);
  });

  it("--rule is 1.19:1 on --paper — also below the 3:1 non-text floor", () => {
    const r = contrast(token("rule"), PAPER);
    expect(r).toBeCloseTo(1.19, 2);
    expect(r).toBeLessThan(3);
  });
});

describe("every figure is monospaced and tabular (section 8.3)", () => {
  it(".num sets both the family and tabular-nums", () => {
    const rule = /\.num\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    expect(rule).toMatch(/font-family:\s*var\(--mono\)/);
    expect(rule).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});

describe("reduced motion is respected (section 8.4)", () => {
  it("the stylesheet carries a prefers-reduced-motion block", () => {
    expect(CSS).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});

describe("focus is visible (section 8.4)", () => {
  it("a :focus-visible rule sets an outline", () => {
    expect(CSS).toMatch(/:focus-visible\s*\{[^}]*outline:/);
  });
});
