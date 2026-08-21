/**
 * The two CopyTraderX row shapes the journal surfaces read, beyond deals.
 *
 * These live in the pure layer, not in db/, for the same reason ClosedDeal
 * does: db/ maps rows ONTO these types and never defines them, so a reader
 * and a filter cannot drift apart. journal/ may not import from db/ at all.
 *
 * PRICES ARE STRINGS. open_price, current_price, sl, tp, price_open and
 * price_current come back exactly as Postgres renders the numeric and are
 * displayed verbatim. They are exchange rates, not money: nothing sums them,
 * no accounting path reads them, and turning a display-only value into a float
 * on the way to a table cell buys nothing and costs the guarantee. It also
 * settles the upstream computePips question — pip arithmetic is float
 * arithmetic over prices, and it is not a spec section 7 requirement.
 *
 * Money on these rows is cents, converted in SQL, same as everywhere else.
 */
import type { Cents } from "@/lib/compound/engine/money";

export interface OpenPosition {
  ticket: number;
  symbol: string;
  side: "buy" | "sell";
  /** Lots x 1000 as an integer. 0.05 lots is 50. */
  volumeMilliLots: number;
  /** Rendered verbatim. Never parsed. */
  openPrice: string;
  currentPrice: string;
  slPrice: string | null;
  tpPrice: string | null;
  /** Floating P/L on this position right now. */
  profitCents: Cents;
  swapCents: Cents;
  commissionCents: Cents;
  /** ISO 8601, UTC. */
  openTime: string;
  comment: string | null;
}

export interface OrderRow {
  ticket: number;
  symbol: string;
  /** Raw MT5 constant, e.g. order_type_buy_limit. Humanised in the UI layer. */
  type: string;
  /** Raw MT5 constant, e.g. order_state_filled. */
  state: string;
  volumeInitialMilliLots: number;
  volumeCurrentMilliLots: number;
  priceOpen: string | null;
  priceCurrent: string | null;
  slPrice: string | null;
  tpPrice: string | null;
  /** ISO 8601, UTC. */
  timeSetup: string;
  timeDone: string | null;
  comment: string | null;
}
