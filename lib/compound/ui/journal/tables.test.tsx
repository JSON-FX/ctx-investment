/**
 * Rendered with @testing-library/react's `render`, not `renderToStaticMarkup`
 * — see chrome.test.tsx's header for why: under this project's jsdom "ui"
 * Jest project, react-dom/server's renderToStaticMarkup throws
 * `ReferenceError: MessageChannel is not defined` the moment it is imported.
 * The plan's own draft of this file used renderToStaticMarkup; that was
 * verified against a real run here and does not work, so every render below
 * goes through the same working pattern chrome.test.tsx already established.
 */
import { render } from "@testing-library/react";
import { applyTradeFilters, symbolsOf, TRADE_SPEC } from "@/lib/compound/journal/trade-filters";
import {
  applyOrderFilters,
  applyPositionSort,
  ORDER_SPEC,
  POSITION_SPEC,
} from "@/lib/compound/journal/order-filters";
import { parseTableState } from "@/lib/compound/journal/table-state";
import { buildTradeHistory } from "@/lib/compound/journal/history";
import { RAW_DEALS, fixtureHistory } from "@/lib/compound/journal/__fixtures__/deals";
import type { OpenPosition, OrderRow } from "@/lib/compound/journal/rows";
import { GuardNotice } from "./guard-notice";
import { OrdersTable } from "./orders-table";
import { PositionsTable } from "./positions-table";
import { TradesTable } from "./trades-table";

const BASE = "/a/7/journal";
const HISTORY = fixtureHistory();
const state = parseTableState({}, TRADE_SPEC, "t");
const html = render(
  <TradesTable
    result={applyTradeFilters(HISTORY.deals, state)}
    state={state}
    symbols={symbolsOf(HISTORY.deals)}
    basePath={BASE}
    params={{}}
  />,
).container.innerHTML;

describe("TradesTable", () => {
  // Mutation caught: rendering fewer rows than the page holds, or rendering
  // the planted duplicate.
  it("renders one row per trade on the page", () => {
    const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    expect(body.split("<tr>").length - 1).toBe(9);
    expect(html).not.toContain(">5092<");
  });

  // Mutation caught: every <tr> sharing one key (e.g. a literal instead of
  // d.ticket). The plan predicted this would also fail the row-count test
  // above; verified against a real run and it does not — React still
  // renders every row on a first, non-updating render regardless of key
  // collisions (see the task report's probe section for the confirmed
  // console.error text and why a snapshot-of-rendered-HTML assertion can
  // never see a `key` prop at all, since React never serialises it into the
  // DOM). This test reaches the one place the collision is actually
  // observable: React's own dev-mode warning.
  it("uses a unique key per row, so React logs no duplicate-key warning", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    render(
      <TradesTable
        result={applyTradeFilters(HISTORY.deals, state)}
        state={state}
        symbols={symbolsOf(HISTORY.deals)}
        basePath={BASE}
        params={{}}
      />,
    );
    const keyWarnings = spy.mock.calls.filter((args) => String(args[0]).includes("same key"));
    spy.mockRestore();
    expect(keyWarnings).toEqual([]);
  });

  // Mutation caught: rendering a money value through a float. 1,237.00 with
  // the grouping comma is the exact string the formatter must produce.
  it("renders signed money with tabular figures", () => {
    expect(html).toContain("+12.37");
    expect(html).toContain("−4.09");
    expect(html).toContain('class="num pos"');
    expect(html).toContain('class="num neg"');
  });

  // Mutation caught: a footer computed from the visible rows. The footer must
  // state the filtered totals, which for the whole fixture are 3458 gross,
  // 3163 net and -295 in fees.
  it("states the filtered totals in the footer", () => {
    const foot = html.slice(html.indexOf("<tfoot>"));
    expect(foot).toContain("+34.58");
    expect(foot).toContain("+31.63");
    expect(foot).toContain("−2.95");
    expect(foot).toContain("9 trades");
    expect(foot).toContain("5W / 3L");
  });

  // Mutation caught: reading the footer off result.rows (the visible PAGE)
  // instead of result.summary (the full filtered set, computed inside
  // applyTradeFilters before pagination). The module-level `html` above
  // cannot catch this: at the default size (25) all 9 filtered rows fit on
  // one page, so rows and the filtered set are identical there and the two
  // sources agree by coincidence. This test forces size=4, where the page
  // holds 4 of 9 rows, so the two sources disagree unless the component
  // reads the right one. Confirmed against a live mutation while writing
  // this task — see the task report's probe section.
  it("states the full filtered total, not just the visible page, when the page is smaller than the filtered set", () => {
    const small = { page: 1, size: 4, sort: "closed_desc", search: "", filters: {} };
    const out = render(
      <TradesTable
        result={applyTradeFilters(HISTORY.deals, small)}
        state={small}
        symbols={symbolsOf(HISTORY.deals)}
        basePath={BASE}
        params={{}}
      />,
    ).container.innerHTML;
    const foot = out.slice(out.indexOf("<tfoot>"));
    expect(foot).toContain("9 trades");
    expect(foot).toContain("+34.58");
  });

  // Mutation caught: colour as the sole carrier. Spec section 8.4.
  it("carries the sign in the text, not only in the class", () => {
    expect(html).toContain("−15.11");
    expect(html.replace(/class="[^"]*"/g, "")).toContain("−15.11");
  });

  it("offers a symbol chip for every symbol in the history", () => {
    for (const s of ["BTCUSD", "EURUSD", "GBPUSD", "XAUUSD"]) {
      expect(html).toContain(`t.symbol=${s}`);
    }
  });

  it("says so plainly when a filter matches nothing", () => {
    const empty = parseTableState({ "t.symbol": "NOPE" }, TRADE_SPEC, "t");
    const out = render(
      <TradesTable
        result={applyTradeFilters(HISTORY.deals, empty)}
        state={empty}
        symbols={symbolsOf(HISTORY.deals)}
        basePath={BASE}
        params={{ "t.symbol": "NOPE" }}
      />,
    ).container.innerHTML;
    expect(out).toContain("No trades match these filters.");
  });
});

describe("GuardNotice", () => {
  // Mutation caught: rendering nothing when the guard did not run, which
  // shows inflated counts with no indication.
  it("says the guard is inactive when no offset is configured", () => {
    const out = render(
      <GuardNotice history={buildTradeHistory(RAW_DEALS, null)} />,
    ).container.innerHTML;
    expect(out).toContain("Duplicate-deal protection is inactive");
  });

  // Mutation caught: silently dropping rows with no notice, so a manager
  // comparing against the terminal sees a different count and no reason.
  it("names the excluded tickets when the guard dropped rows", () => {
    const out = render(<GuardNotice history={HISTORY} />).container.innerHTML;
    expect(out).toContain("1 duplicate deal excluded");
    expect(out).toContain("5092");
    expect(out).toContain("10 rows");
  });

  it("renders nothing when the guard ran and found nothing", () => {
    const clean = buildTradeHistory(RAW_DEALS.filter((d) => d.ticket !== 5092), 3);
    expect(render(<GuardNotice history={clean} />).container.innerHTML).toBe("");
  });
});

// ---------------------------------------------------------------------------
// PositionsTable and OrdersTable have no shared plan fixture (Task 2's
// branded-deal fixture is deals-only), so each gets a small fixture built
// the same way order-filters.test.ts builds its own — inline, minimal, and
// with the one property that matters for THIS component under test.
// ---------------------------------------------------------------------------

const openPos = (over: Partial<OpenPosition>): OpenPosition => ({
  ticket: 8801,
  symbol: "EURUSD",
  side: "buy",
  volumeMilliLots: 50,
  openPrice: "1.09341",
  currentPrice: "1.09507",
  slPrice: null,
  tpPrice: null,
  profitCents: 830n,
  swapCents: -5n,
  commissionCents: -29n,
  openTime: "2026-05-08T07:00:00.000Z",
  comment: null,
  ...over,
});

const POSITIONS: OpenPosition[] = [
  // 830 - 5 - 29 = 796 -> "+7.96". SL/TP set, so this row proves the
  // non-null branch renders the real price, not the em-dash fallback.
  openPos({
    ticket: 8801,
    slPrice: "1.08800",
    tpPrice: "1.10200",
    openTime: "2026-05-08T07:00:00.000Z",
  }),
  // -1250 - 10 - 15 = -1275 -> "−12.75".
  openPos({
    ticket: 8802,
    symbol: "XAUUSD",
    side: "sell",
    profitCents: -1250n,
    swapCents: -10n,
    commissionCents: -15n,
    slPrice: null,
    tpPrice: null,
    openTime: "2026-05-08T09:15:00.000Z",
  }),
];

describe("PositionsTable", () => {
  const posState = parseTableState({}, POSITION_SPEC, "p");
  const posHtml = render(
    <PositionsTable
      result={applyPositionSort(POSITIONS, posState)}
      state={posState}
      basePath={BASE}
      params={{}}
    />,
  ).container.innerHTML;

  // Mutation caught: reading only profitCents for the Floating column
  // (dropping swap/commission), which is exactly the gross-vs-net confusion
  // Task 10's own footnote warns a reader about.
  it("renders floating P/L as profit plus swap plus commission, signed", () => {
    expect(posHtml).toContain("+7.96");
    expect(posHtml).toContain("−12.75");
  });

  // Mutation caught: rendering "null" or an empty cell instead of an em dash
  // for a position with no SL/TP, and the mirror case — a real SL swallowed
  // by an over-eager null check.
  it("shows the real price when SL/TP are set and an em dash when they are not", () => {
    expect(posHtml).toContain("1.08800");
    expect(posHtml).toContain("1.10200");
    expect(posHtml).toContain("—"); // em dash, ticket 8802's SL/TP
  });

  // Mutation caught: a footer summed from the wrong field, or one that drops
  // the long/short split.
  it("states count, side split and total floating P/L in the footer", () => {
    const foot = posHtml.slice(posHtml.indexOf("<tfoot>"));
    expect(foot).toContain("2 open");
    expect(foot).toContain("1 long / 1 short");
    expect(foot).toContain("−4.79");
  });

  // Mutation caught: importing plan 4's LiveChip and rendering it with a
  // fabricated pushedAt, or dropping the live-vs-committed note entirely.
  // loadOpenPositions returns OpenPosition[] with no pushedAt field, so
  // this page cannot honestly build a LiveChip; it says the same thing in
  // its own words instead, per this task's own judgement call (see report).
  it("marks floating P/L as live, not a committed reading", () => {
    expect(posHtml).toContain("Live");
    expect(posHtml).toContain("not part of a committed daily reading");
  });

  it("says so plainly when there are no open positions", () => {
    const emptyHtml = render(
      <PositionsTable
        result={applyPositionSort([], posState)}
        state={posState}
        basePath={BASE}
        params={{}}
      />,
    ).container.innerHTML;
    expect(emptyHtml).toContain("No open positions.");
  });

  it("renders no FilterBar — POSITION_SPEC.filterKeys is empty", () => {
    expect(posHtml).not.toContain("filters-search");
  });
});

const order = (over: Partial<OrderRow>): OrderRow => ({
  ticket: 7701,
  symbol: "EURUSD",
  type: "order_type_buy_limit",
  state: "order_state_filled",
  volumeInitialMilliLots: 100,
  volumeCurrentMilliLots: 0,
  priceOpen: "1.08500",
  priceCurrent: "1.08620",
  slPrice: null,
  tpPrice: null,
  timeSetup: "2026-05-08T06:00:00.000Z",
  timeDone: "2026-05-08T06:05:00.000Z",
  comment: null,
  ...over,
});

const ORDERS: OrderRow[] = [
  order({ ticket: 7701, symbol: "EURUSD", type: "order_type_buy_limit", state: "order_state_filled" }),
  order({
    ticket: 7702,
    symbol: "XAUUSD",
    type: "order_type_sell_stop",
    state: "order_state_placed",
    priceOpen: "2410.00",
    priceCurrent: null,
    timeSetup: "2026-05-09T08:00:00.000Z",
    timeDone: null,
  }),
  order({
    ticket: 7703,
    symbol: "EURUSD",
    type: "order_type_buy",
    state: "order_state_canceled",
    priceOpen: null,
    priceCurrent: null,
    timeSetup: "2026-05-07T09:00:00.000Z",
    timeDone: "2026-05-07T09:01:00.000Z",
  }),
];

describe("OrdersTable", () => {
  const orderState = parseTableState({}, ORDER_SPEC, "o");
  const symbols = [...new Set(ORDERS.map((o) => o.symbol))].sort();
  const orderHtml = render(
    <OrdersTable
      result={applyOrderFilters(ORDERS, orderState)}
      state={orderState}
      symbols={symbols}
      basePath={BASE}
      params={{}}
    />,
  ).container.innerHTML;

  // Mutation caught: rendering the raw MT5 constant instead of running it
  // through order-display.ts's humanizer.
  it("renders humanized type and state labels, never the raw MT5 constant", () => {
    expect(orderHtml).toContain("Buy Limit");
    expect(orderHtml).toContain("Sell Stop");
    expect(orderHtml).toContain("Filled");
    expect(orderHtml).toContain("Pending");
    expect(orderHtml).toContain("Canceled");
    expect(orderHtml).not.toContain("order_type_buy_limit");
    expect(orderHtml).not.toContain("order_state_placed");
  });

  // Mutation caught: rendering "null" for an order that has not completed,
  // instead of the same em-dash convention every other nullable column uses.
  it("shows an em dash for time done and price when they are null", () => {
    expect(orderHtml).toContain("—");
    expect(orderHtml).toContain("2026-05-08 06:05"); // ticket 7701's real timeDone
  });

  // Mutation caught: a FilterBar wired to raw MT5 constants instead of the
  // four state buckets classifyOrderState actually produces.
  it("offers a chip for every state bucket and every symbol present", () => {
    for (const bucket of ["filled", "open", "canceled", "partial"]) {
      expect(orderHtml).toContain(`o.state=${bucket}`);
    }
    expect(orderHtml).toContain("o.symbol=EURUSD");
    expect(orderHtml).toContain("o.symbol=XAUUSD");
  });

  // Mutation caught: a footer that counts rows instead of reading
  // OrderSummary's own filled/open/canceled fields.
  it("states filled, pending and canceled counts in the footer", () => {
    const foot = orderHtml.slice(orderHtml.indexOf("<tfoot>"));
    expect(foot).toContain("3 orders");
    expect(foot).toContain("1 filled");
    expect(foot).toContain("1 pending");
    expect(foot).toContain("1 canceled");
  });

  it("says so plainly when a filter matches nothing", () => {
    const empty = parseTableState({ "o.symbol": "NOPE" }, ORDER_SPEC, "o");
    const out = render(
      <OrdersTable
        result={applyOrderFilters(ORDERS, empty)}
        state={empty}
        symbols={symbols}
        basePath={BASE}
        params={{ "o.symbol": "NOPE" }}
      />,
    ).container.innerHTML;
    expect(out).toContain("No orders match these filters.");
  });
});
