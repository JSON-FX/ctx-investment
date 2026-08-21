import { decodeDroppedDeals, encodeDroppedDeals } from "./reconcile";
import type { DroppedDeal } from "@/lib/compound/reconcile/dedupe";
import type { ClosedDeal } from "@/lib/compound/reconcile/types";

function deal(ticket: number): ClosedDeal {
  return {
    ticket, symbol: "EURUSD", side: "buy", volumeMilliLots: 100,
    openTime: "2026-08-01T00:00:00.000Z", closeTime: "2026-08-01T01:00:00.000Z",
    profitCents: 100n, swapCents: 0n, commissionCents: 0n,
  };
}

describe("encodeDroppedDeals / decodeDroppedDeals", () => {
  it("round-trips an empty list to an empty string, and back to an empty array", () => {
    expect(encodeDroppedDeals([])).toBe("");
    expect(decodeDroppedDeals("")).toEqual([]);
  });

  it("round-trips one dropped deal", () => {
    const dropped: DroppedDeal[] = [{ deal: deal(1234), duplicateOfTicket: 1230 }];
    const encoded = encodeDroppedDeals(dropped);
    expect(encoded).toBe("1234:1230");
    expect(decodeDroppedDeals(encoded)).toEqual([{ ticket: 1234, duplicateOfTicket: 1230 }]);
  });

  it("round-trips several, preserving order", () => {
    const dropped: DroppedDeal[] = [
      { deal: deal(1234), duplicateOfTicket: 1230 },
      { deal: deal(1236), duplicateOfTicket: 1230 },
      { deal: deal(1240), duplicateOfTicket: 1239 },
    ];
    expect(decodeDroppedDeals(encodeDroppedDeals(dropped))).toEqual([
      { ticket: 1234, duplicateOfTicket: 1230 },
      { ticket: 1236, duplicateOfTicket: 1230 },
      { ticket: 1240, duplicateOfTicket: 1239 },
    ]);
  });

  it("decodes null/undefined as no dropped deals, rather than throwing", () => {
    expect(decodeDroppedDeals(null)).toEqual([]);
    expect(decodeDroppedDeals(undefined)).toEqual([]);
  });

  it("drops a malformed pair rather than crashing on a tampered URL", () => {
    expect(decodeDroppedDeals("1234:1230,not-a-pair,1240:1239")).toEqual([
      { ticket: 1234, duplicateOfTicket: 1230 },
      { ticket: 1240, duplicateOfTicket: 1239 },
    ]);
  });
});
