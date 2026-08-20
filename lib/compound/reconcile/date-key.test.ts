import { utcDateKey } from "./date-key";

describe("utcDateKey", () => {
  it("returns the UTC calendar date of a timestamp", () => {
    expect(utcDateKey("2026-08-19T12:37:37Z")).toBe("2026-08-19");
    expect(utcDateKey("2026-08-19T12:37:37+00:00")).toBe("2026-08-19");
  });

  it("converts a non-UTC offset to the correct UTC date", () => {
    // 01:30 at +03:00 is 22:30 the PREVIOUS day in UTC. Slicing the string
    // would wrongly answer 2026-08-19.
    expect(utcDateKey("2026-08-19T01:30:00+03:00")).toBe("2026-08-18");
  });

  it("handles the other side of midnight too", () => {
    // 23:30 at -05:00 is 04:30 the NEXT day in UTC.
    expect(utcDateKey("2026-08-19T23:30:00-05:00")).toBe("2026-08-20");
  });

  it("rejects a value that is not a timestamp", () => {
    expect(() => utcDateKey("not a date")).toThrow(/not an ISO timestamp/);
  });
});
