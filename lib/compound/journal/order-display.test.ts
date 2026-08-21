import { humanizeOrderState, humanizeOrderType } from "./order-display";

describe("humanizeOrderType", () => {
  it("labels a market order solid and a pending order outlined", () => {
    expect(humanizeOrderType("order_type_buy")).toEqual({
      label: "Buy",
      variant: "buy",
      outline: false,
    });
    expect(humanizeOrderType("order_type_sell_stop_limit")).toEqual({
      label: "Sell Stop Limit",
      variant: "sell",
      outline: true,
    });
  });

  // Mutation caught: throwing or echoing the raw constant. MT5 adds order
  // types between builds and a journal must survive one it has not seen.
  it("title-cases an unknown constant instead of failing", () => {
    expect(humanizeOrderType("order_type_future_thing")).toEqual({
      label: "Future Thing",
      variant: "neutral",
      outline: false,
    });
    expect(humanizeOrderState("order_state_who_knows").label).toBe("Who Knows");
  });

  // Mutation caught: `Object.prototype` lookup leaking through the map. A raw
  // value of "constructor" must not return a function.
  it("does not resolve a prototype key", () => {
    expect(humanizeOrderType("constructor").label).toBe("Constructor");
    expect(humanizeOrderState("toString").variant).toBe("neutral");
  });
});

describe("humanizeOrderState", () => {
  it.each([
    ["order_state_filled", "Filled", "ok"],
    ["order_state_placed", "Pending", "info"],
    ["order_state_rejected", "Rejected", "bad"],
    ["order_state_partial", "Partial", "warn"],
  ])("maps %s to %s", (raw, label, variant) => {
    expect(humanizeOrderState(raw)).toEqual({ label, variant });
  });
});
