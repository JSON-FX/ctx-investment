import { dealNetCents } from "./types";
import type { ClosedDeal } from "./types";

const DEAL: ClosedDeal = {
  ticket: 1,
  symbol: "GBPUSD",
  side: "buy",
  volumeMilliLots: 50,
  openTime: "2026-08-14T07:00:52Z",
  closeTime: "2026-08-19T12:37:37Z",
  profitCents: 19_750n,
  swapCents: -292n,
  commissionCents: -100n,
};

describe("dealNetCents", () => {
  it("sums profit, swap and commission", () => {
    expect(dealNetCents(DEAL)).toBe(19_358n);
  });

  it("is signed — a loser nets negative", () => {
    expect(dealNetCents({ ...DEAL, profitCents: -4_384n, swapCents: 0n, commissionCents: 0n }))
      .toBe(-4_384n);
  });

  it("does not silently drop swap or commission", () => {
    // Each component must move the answer, or a regression that ignores one
    // would go unnoticed.
    expect(dealNetCents({ ...DEAL, swapCents: 0n })).toBe(19_650n);
    expect(dealNetCents({ ...DEAL, commissionCents: 0n })).toBe(19_458n);
  });
});
