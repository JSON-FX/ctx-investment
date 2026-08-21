import { utcDateKey, absGapMs } from "./date-key";

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

describe("absGapMs", () => {
  it("returns the gap in whole milliseconds", () => {
    expect(absGapMs("2026-05-04T07:09:00Z", "2026-05-04T10:09:00Z")).toBe(10_800_000);
  });

  it("is unsigned — swapping the arguments gives the same answer", () => {
    // Not a reflexivity check: the two calls take different arguments, so an
    // implementation that forgot Math.abs would return +3h one way and -3h
    // the other and fail here.
    const earlier = "2026-05-04T07:09:00Z";
    const later = "2026-05-04T10:09:00Z";
    expect(absGapMs(earlier, later)).toBe(10_800_000);
    expect(absGapMs(later, earlier)).toBe(10_800_000);
  });

  it("is zero for the same instant written with different offsets", () => {
    // 07:09Z and 10:09+03:00 are the same moment. This fails under any
    // implementation that compares the strings instead of parsing them.
    expect(absGapMs("2026-05-04T07:09:00Z", "2026-05-04T10:09:00+03:00")).toBe(0);
  });

  it("rejects a first argument that is not a timestamp", () => {
    expect(() => absGapMs("nope", "2026-05-04T07:09:00Z"))
      .toThrow(/not an ISO timestamp: "nope"/);
  });

  it("rejects a second argument that is not a timestamp", () => {
    expect(() => absGapMs("2026-05-04T07:09:00Z", "nope"))
      .toThrow(/not an ISO timestamp: "nope"/);
  });
});
