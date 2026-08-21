/**
 * Rendered with @testing-library/react's `render`, not `renderToStaticMarkup`
 * — the plan's draft proposed the latter on the theory that it "needs no
 * DOM, so these run in whichever Jest project picks the file up". Verified
 * against a real run instead of trusted: under this project's jsdom "ui"
 * project, react-dom/server resolves to its browser build, which throws
 * `ReferenceError: MessageChannel is not defined` the moment it is imported
 * — jsdom supplies enough of a browser-like global to steer module
 * resolution there, but not that constructor. Every other *.test.tsx file
 * in lib/compound/ui/ already renders with @testing-library/react instead;
 * this follows that established, working pattern rather than the plan's.
 */
import { render } from "@testing-library/react";
import { ORDER_SPEC, POSITION_SPEC } from "@/lib/compound/journal/order-filters";
import {
  paginate,
  parseTableState,
  splitSort,
  toggleSort,
  type TableSpec,
} from "@/lib/compound/journal/table-state";
import { TRADE_SPEC } from "@/lib/compound/journal/trade-filters";
import { FilterBar } from "./filter-bar";
import { Pager } from "./pager";
import { SortHeader } from "./sort-header";

const BASE = "/a/7/journal";

describe("SortHeader", () => {
  const renderHtml = (sort: string, column: string, params = {}) =>
    render(
      <table><thead><tr>
        <SortHeader label="Profit" column={column} sort={sort} prefix="t" basePath={BASE} params={params} numeric />
      </tr></thead></table>,
    ).container.innerHTML;

  // Mutation caught: rendering the CURRENT sort in the href, so clicking the
  // active column does nothing.
  it("links to the flipped direction on the active column", () => {
    expect(renderHtml("profit_desc", "profit")).toContain("t.sort=profit_asc");
    expect(renderHtml("profit_asc", "profit")).toContain("t.sort=profit_desc");
  });

  it("links to descending on an inactive column", () => {
    expect(renderHtml("closed_desc", "profit")).toContain("t.sort=profit_desc");
  });

  // Mutation caught: dropping aria-sort, which leaves the arrow glyph as the
  // sole carrier of the sort state — spec section 8.4 forbids that.
  it("announces the sort state to assistive technology", () => {
    expect(renderHtml("profit_desc", "profit")).toContain('aria-sort="descending"');
    expect(renderHtml("profit_asc", "profit")).toContain('aria-sort="ascending"');
    expect(renderHtml("closed_desc", "profit")).toContain('aria-sort="none"');
  });

  // Mutation caught: keeping the page number across a re-sort, which shows
  // page 4 of a differently ordered table.
  it("drops the page number when the sort changes", () => {
    expect(renderHtml("profit_desc", "profit", { "t.page": "4" })).not.toContain("t.page");
  });

  /**
   * The round-trip proof this task's dispatch asked for: every column each
   * REAL table spec in this codebase declares — not an invented fixture —
   * emits, via toggleSort, a sort value that Task 8's parseTableState
   * accepts unchanged, from any starting sort. This is the actual allowlist
   * these pages will run against in Task 10/11, not a stand-in for it.
   *
   * Scope, stated plainly: this proves toggleSort's `${column}_asc` /
   * `${column}_desc` shape matches what each spec's `sorts` array already
   * lists, for every column each spec lists today. It cannot prove that a
   * future <SortHeader column="…"> call site in Task 10/11 will name a
   * column the same way its spec does — that binding does not exist until
   * those pages are written. What "a click lands on the default silently"
   * looks like when that binding is wrong is demonstrated in this task's
   * report under the break-and-confirm-red probe.
   */
  describe.each<[string, TableSpec]>([
    ["TRADE_SPEC", TRADE_SPEC],
    ["ORDER_SPEC", ORDER_SPEC],
    ["POSITION_SPEC", POSITION_SPEC],
  ])("every column %s declares round-trips through parseTableState", (_name, spec) => {
    const columns = [...new Set(spec.sorts.map((s) => splitSort(s)[0]))];

    it.each(columns)("column %s", (column) => {
      for (const startingSort of [spec.defaultSort, `${column}_asc`, `${column}_desc`]) {
        const emitted = toggleSort(startingSort, column);
        expect(spec.sorts).toContain(emitted); // shape the allowlist admits
        const parsed = parseTableState({ "t.sort": emitted }, spec, "t").sort;
        expect(parsed).toBe(emitted); // survives the validator unchanged
      }
    });
  });
});

describe("Pager", () => {
  const renderHtml = (page: number, pageCount: number) =>
    render(
      <Pager page={page} pageCount={pageCount} total={9} prefix="t" basePath={BASE} params={{}} noun="trade" />,
    ).container.innerHTML;

  // Mutation caught: rendering a live link at the ends, which produces
  // ?t.page=0 and ?t.page=4 on a three-page table.
  it("disables previous on the first page and next on the last", () => {
    const first = renderHtml(1, 3);
    expect(first).toContain('aria-disabled="true"');
    expect(first).not.toContain("t.page=0");
    expect(first).toContain("t.page=2");

    const last = renderHtml(3, 3);
    expect(last).not.toContain("t.page=4");
    expect(last).toContain("t.page=2");
  });

  it("states the position in words as well as in controls", () => {
    expect(renderHtml(2, 3)).toContain("page 2 of 3");
    expect(renderHtml(2, 3)).toContain("9 trades");
  });

  /**
   * "A pager must not be able to emit an out-of-range page" — the
   * dispatch's own phrasing — read as a property of the component, not of
   * every future caller's discipline. paginate() (Task 8) already clamps
   * page for the request path a person actually drives; this proves Pager
   * holds even when handed a page directly outside [1, pageCount], which is
   * the shape a caller bug (not a hostile query string) would take.
   */
  it("clamps a page fed to it directly past the end, and before the start", () => {
    const past = render(
      <Pager page={99} pageCount={3} total={9} prefix="t" basePath={BASE} params={{}} noun="trade" />,
    );
    expect(past.container.innerHTML).toContain("page 3 of 3");
    expect(past.container.innerHTML).not.toContain("t.page=100");
    expect(past.container.innerHTML).not.toContain("t.page=4");
    // Next is disabled at the clamped last page, not left live because the
    // raw prop (99) was never compared against pageCount unclamped. Scoped
    // to this render's own container — two Pagers are mounted in this test
    // and the global `screen` would search across both.
    expect(past.getByText("Next").getAttribute("aria-disabled")).toBe("true");

    const before = render(
      <Pager page={0} pageCount={3} total={9} prefix="t" basePath={BASE} params={{}} noun="trade" />,
    );
    expect(before.container.innerHTML).toContain("page 1 of 3");
    expect(before.container.innerHTML).not.toContain("t.page=-1");
    expect(before.container.innerHTML).not.toContain("t.page=0");
  });

  /**
   * End-to-end version of the same guarantee, through the actual boundary:
   * a URL asking for a page far past the end, parsed by parseTableState and
   * clamped by paginate(), produces a page/pageCount pair Pager renders as
   * the last page — not a blank table and not an out-of-range control.
   */
  it("renders the last page, not a blank one, for a page far past the end via the real pipeline", () => {
    const spec: TableSpec = TRADE_SPEC;
    const state = parseTableState({ "t.page": "99999" }, spec, "t");
    const rows = Array.from({ length: 9 }, (_, i) => i + 1);
    const paged = paginate(rows, state);
    expect(paged.page).toBe(paged.pageCount); // paginate's own clamp

    const { container } = render(
      <Pager
        page={paged.page}
        pageCount={paged.pageCount}
        total={paged.total}
        prefix="t"
        basePath={BASE}
        params={{}}
        noun="trade"
      />,
    );
    expect(container.innerHTML).toContain(`page ${paged.pageCount} of ${paged.pageCount}`);
    expect(paged.rows).not.toEqual([]); // the last page's real rows, not empty
  });
});

describe("FilterBar", () => {
  const GROUPS = [
    {
      name: "outcome",
      label: "Outcome",
      options: [
        { value: "wins", label: "Wins" },
        { value: "losses", label: "Losses" },
      ],
    },
  ];
  const renderHtml = (active: Record<string, string>, params = {}, search = "") =>
    render(
      <FilterBar groups={GROUPS} active={active} search={search} prefix="t" basePath={BASE} params={params} />,
    ).container.innerHTML;

  // Mutation caught: always setting the value, so an active chip cannot be
  // switched off by clicking it again.
  it("toggles an active chip off and an inactive chip on", () => {
    expect(renderHtml({})).toContain("t.outcome=wins");
    const on = renderHtml({ outcome: "wins" }, { "t.outcome": "wins" });
    expect(on).toContain('aria-pressed="true"');
    // The Wins chip now clears itself, so its href carries no t.outcome.
    expect(on).not.toContain("t.outcome=wins&amp;");
    expect(on).toContain("t.outcome=losses");
  });

  // Mutation caught: a form with no hidden inputs, which drops every other
  // table's state the moment anyone searches.
  it("carries the other tables' parameters through the search form", () => {
    const html = renderHtml({}, { "o.sort": "setup_asc", "t.page": "3" });
    expect(html).toContain('name="o.sort"');
    expect(html).toContain('value="setup_asc"');
    // Its own page and query are excluded — the form sets those.
    expect(html).not.toContain('name="t.page"');
  });

  // Mutation caught: always rendering Clear, so the control is present when
  // there is nothing to clear.
  it("offers Clear only when something is filtering", () => {
    expect(renderHtml({})).not.toContain(">Clear<");
    expect(renderHtml({ outcome: "wins" })).toContain(">Clear<");
    expect(renderHtml({}, {}, "xau")).toContain(">Clear<");
  });
});
