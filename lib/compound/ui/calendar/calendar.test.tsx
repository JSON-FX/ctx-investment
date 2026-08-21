/**
 * Rendered with @testing-library/react's `render`, not `renderToStaticMarkup`
 * — the plan's draft for this file proposed the latter. Verified against a
 * real run rather than trusted: journal/chrome.test.tsx already recorded that
 * under this project's jsdom "ui" project, react-dom/server resolves to its
 * browser build and throws `ReferenceError: MessageChannel is not defined`
 * the moment it is imported. Confirmed again here rather than assumed from
 * that file's comment — see the task report's probe section. Every other
 * *.test.tsx file in lib/compound/ui/ already renders with
 * @testing-library/react; this follows that established, working pattern.
 */
import { render } from "@testing-library/react";
import {
  aggregateCalendar,
  dayIntensity,
  latestMonth,
  monthSummary,
} from "@/lib/compound/journal/calendar-aggregate";
import { fixtureHistory, fixtureHistoryUnguarded } from "@/lib/compound/journal/__fixtures__/deals";
import { MonthGrid } from "./month-grid";
import { DayPanel } from "./day-panel";

const BASE = "/a/7/calendar";
const DAYS = aggregateCalendar(fixtureHistory().deals);

const gridElement = (month = "2026-05", selectedDay: string | null = null, params = {}) =>
  render(
    <MonthGrid
      month={month}
      days={DAYS}
      summary={monthSummary(DAYS, month)}
      tierOf={dayIntensity(DAYS, month)}
      selectedDay={selectedDay}
      latest={latestMonth(DAYS, "2026-05")}
      basePath={BASE}
      params={params}
    />,
  ).container;

const renderGrid = (month = "2026-05", selectedDay: string | null = null, params = {}) =>
  gridElement(month, selectedDay, params).innerHTML;

describe("MonthGrid", () => {
  const html = renderGrid();

  // Mutation caught: a grid built from local Date objects. Under a non-UTC TZ
  // the leading blanks shift and 2026-05-01 lands in the wrong column.
  //
  // Not an href assertion: the plan's own draft test checked
  // `firstRow.toContain("day=2026-05-01")`, and that does not hold against
  // this component's own documented behaviour (also drawn from the plan) —
  // 2026-05-01 has no trades in the fixture, so MonthGrid's `cell ===
  // undefined` branch renders a bare day number with no <a> at all. Verified
  // by running it: the assertion failed against a correct, unmutated
  // component. See the task report's "plan literal vs reality" section.
  // Checked via the DOM instead of a raw href search, which is what actually
  // discriminates a day landing in the wrong cell regardless of whether that
  // cell happens to carry a link.
  it("puts the first of the month in the Friday column", () => {
    const firstRow = gridElement().querySelector("tbody tr")!;
    const cells = [...firstRow.querySelectorAll("td")];
    expect(cells.filter((td) => td.className === "cal-blank")).toHaveLength(5);
    // Week row has 7 day cells + 1 week-total cell.
    expect(cells).toHaveLength(8);
    expect(cells[5]!.textContent).toContain("1");
    expect(cells[5]!.className).not.toBe("cal-blank");
    expect(cells[6]!.textContent).toContain("2");
  });

  // Mutation caught: rendering only one trade's figure per day. 2026-05-08
  // has three trades netting 451 cents; a keep-the-last bug shows −0.26.
  it("shows the accumulated day total, not one trade's", () => {
    expect(html).toContain("+4.51");
    expect(html).toContain("3 trades");
    expect(html).not.toContain("+18.04"); // the undeduplicated total
  });

  // THE DEDUPE ASSERTION at the render layer.
  it("renders the deduplicated day totals", () => {
    const badDays = aggregateCalendar(fixtureHistoryUnguarded().deals);
    const bad = render(
      <MonthGrid
        month="2026-05"
        days={badDays}
        summary={monthSummary(badDays, "2026-05")}
        tierOf={() => 0}
        selectedDay={null}
        latest="2026-05"
        basePath={BASE}
        params={{}}
      />,
    ).container.innerHTML;
    expect(bad).toContain("4 trades");
    expect(html).not.toContain("4 trades");
  });

  // Mutation caught: summing the week across the whole month, or resetting it
  // per cell. Week of 04–08 nets 3163; every other week is empty.
  it("totals each week row separately", () => {
    expect(html).toContain("+31.63");
    const dashCount = html.split(">—<").length - 1;
    expect(dashCount).toBeGreaterThanOrEqual(4); // the other week rows
  });

  // Mutation caught: colour as the sole carrier of win or loss. Spec 8.4.
  it("prints the figure and the counts as text", () => {
    const stripped = html.replace(/class="[^"]*"/g, "");
    expect(stripped).toContain("−15.22"); // 2026-05-06
    expect(stripped).toContain("8 May 2026: 2 wins, 1 losses");
  });

  // Mutation caught: enabling Next past the newest month with data, which
  // walks the user into an infinite run of empty grids.
  it("disables Next beyond the latest month with data", () => {
    expect(renderGrid("2026-05")).toContain('aria-disabled="true"');
    expect(renderGrid("2026-04")).toContain("month=2026-05");
  });

  // Mutation caught: dropping the other page parameters when the month
  // changes, and keeping ?day when it does.
  it("keeps other parameters and clears the day when the month changes", () => {
    const out = renderGrid("2026-05", null, { day: "2026-05-04", x: "1" });
    const prevHref = out.slice(out.indexOf('href="'), out.indexOf('"', out.indexOf('href="') + 6));
    expect(prevHref).toContain("month=2026-04");
    expect(prevHref).toContain("x=1");
    expect(prevHref).not.toContain("day=");
  });

  it("marks the selected day for assistive technology", () => {
    expect(renderGrid("2026-05", "2026-05-04")).toContain('aria-current="true"');
  });

  // Mutation caught, found by an actual probe (see the task report): a day
  // with no trades rendered as a traded day showing a zero result, rather
  // than as an empty cell with no figure. Every test above this one stayed
  // green against that mutation — it touches no total this file already
  // checks — so this asserts the cell's shape directly. "No data" and
  // "traded and broke even" are different facts and must not render the
  // same signedMoney("0.00").
  it("renders a day with no trades as an empty cell, not a zero result", () => {
    const firstRow = gridElement().querySelector("tbody tr")!;
    const may1 = [...firstRow.querySelectorAll("td")][5]!; // see the Friday-column test
    expect(may1.className).toBe("cal-cell");
    expect(may1.querySelector("a")).toBeNull();
    expect(may1.querySelector(".cal-pnl")).toBeNull();
    expect(may1.querySelector(".cal-count")).toBeNull();
    expect(may1.textContent).toBe("1");
  });

  it("renders an empty month without crashing", () => {
    expect(renderGrid("2026-06")).toContain("0 trading days");
  });
});

describe("DayPanel", () => {
  const { deals } = fixtureHistory();
  const day08 = deals.filter((d) => d.closeTime.startsWith("2026-05-08"));

  const renderPanel = (day: string, cell = DAYS.get(day) ?? null, rows = day08, params = {}) =>
    render(
      <DayPanel day={day} cell={cell} deals={cell === null ? [] : rows} basePath={BASE} params={params} />,
    ).container.innerHTML;

  // Mutation caught: rendering the day's deals unsorted (fixture order), which
  // would put ticket 5009 (15:00 close) before 5007 (07:00 close).
  it("orders the day's trades chronologically, not in fixture order", () => {
    const html = renderPanel("2026-05-08");
    expect(html.indexOf("07:00")).toBeLessThan(html.indexOf("14:15"));
    expect(html.indexOf("14:15")).toBeLessThan(html.indexOf("16:20"));
  });

  // Mutation caught: showing gross instead of net (or vice versa) for a
  // fee-eroded winner. Ticket 5009 is gross +5, net -26 cents.
  it("shows both the gross and the net for a fee-eroded winner", () => {
    const html = renderPanel("2026-05-08");
    expect(html).toContain("+0.05");
    expect(html).toContain("−0.26");
  });

  // Mutation caught: a day panel that renders an empty table instead of the
  // documented sentence when the cell is null (hand-edited ?day= landing on
  // a real, tradeless day in the displayed month).
  it("renders a plain sentence, not an empty table, for a day with no trades", () => {
    const html = renderPanel("2026-05-15", null, []);
    expect(html).toContain("No trades closed on");
    expect(html).not.toContain("<table");
  });

  it("links Close back to the grid with day cleared", () => {
    const html = renderPanel("2026-05-08", DAYS.get("2026-05-08")!, day08, { x: "1" });
    expect(html).toContain("x=1");
    expect(html).not.toContain("day=2026-05-08");
  });
});
