/**
 * MT5 constants to labels and tone variants. Ported unchanged in substance
 * from the upstream module: it has no money in it, no I/O, and it has been
 * right for a year.
 *
 * The fallback title-cases an unrecognised constant instead of throwing or
 * echoing it raw. MT5 gains order types between builds, and a journal that
 * renders "Order Type Sell Stop Limit Whatever" is usable while one that
 * renders "order_type_..." or crashes is not.
 *
 * One thing the upstream did not have to guard against, which this module
 * does: TYPE_MAP and STATE_MAP are plain object literals, and a plain object
 * inherits `constructor`, `toString`, `hasOwnProperty` and friends from
 * Object.prototype. `TYPE_MAP["constructor"]` is not undefined — it is the
 * Object constructor function — so a naive `TYPE_MAP[raw] ?? fallback` would
 * "recognise" a raw value of "constructor" as a hit, then render a function
 * with no `.label`. `lookup` below checks `Object.hasOwn` first, so only a
 * key this module actually declared can ever be returned; every other raw
 * value, including every inherited key, falls to the same titleCase fallback
 * as a genuinely unknown MT5 constant.
 */
export type OrderSideVariant = "buy" | "sell" | "neutral";
export type OrderStateVariant = "ok" | "warn" | "bad" | "info" | "neutral";

export interface OrderTypeDisplay {
  label: string;
  variant: OrderSideVariant;
  /** Pending orders render outlined; market orders render solid. */
  outline: boolean;
}

export interface OrderStateDisplay {
  label: string;
  variant: OrderStateVariant;
}

const TYPE_MAP: Readonly<Record<string, OrderTypeDisplay>> = {
  order_type_buy: { label: "Buy", variant: "buy", outline: false },
  order_type_sell: { label: "Sell", variant: "sell", outline: false },
  order_type_buy_limit: { label: "Buy Limit", variant: "buy", outline: true },
  order_type_sell_limit: { label: "Sell Limit", variant: "sell", outline: true },
  order_type_buy_stop: { label: "Buy Stop", variant: "buy", outline: true },
  order_type_sell_stop: { label: "Sell Stop", variant: "sell", outline: true },
  order_type_buy_stop_limit: { label: "Buy Stop Limit", variant: "buy", outline: true },
  order_type_sell_stop_limit: { label: "Sell Stop Limit", variant: "sell", outline: true },
  order_type_close_by: { label: "Close By", variant: "neutral", outline: false },
};

const STATE_MAP: Readonly<Record<string, OrderStateDisplay>> = {
  order_state_filled: { label: "Filled", variant: "ok" },
  order_state_canceled: { label: "Canceled", variant: "neutral" },
  order_state_partial: { label: "Partial", variant: "warn" },
  order_state_placed: { label: "Pending", variant: "info" },
  order_state_rejected: { label: "Rejected", variant: "bad" },
  order_state_expired: { label: "Expired", variant: "neutral" },
};

/** Only a key the map actually declares — never one merely inherited. */
function lookup<T>(map: Readonly<Record<string, T>>, raw: string): T | undefined {
  return Object.hasOwn(map, raw) ? map[raw] : undefined;
}

function titleCase(value: string): string {
  return value
    .replace(/^order_(type|state)_/, "")
    .split("_")
    .filter((w) => w !== "")
    .map((w) => `${w[0]!.toUpperCase()}${w.slice(1).toLowerCase()}`)
    .join(" ");
}

export function humanizeOrderType(raw: string): OrderTypeDisplay {
  return lookup(TYPE_MAP, raw) ?? { label: titleCase(raw), variant: "neutral", outline: false };
}

export function humanizeOrderState(raw: string): OrderStateDisplay {
  return lookup(STATE_MAP, raw) ?? { label: titleCase(raw), variant: "neutral" };
}
