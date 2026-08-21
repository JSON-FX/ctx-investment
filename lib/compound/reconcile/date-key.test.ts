import { utcDateKey, absGapMs, signedGapMs } from "./date-key";

describe("test runner environment (I1)", () => {
  it("does not run under UTC", () => {
    // jest.config.mjs pins TZ=Asia/Manila for exactly this reason: a mutant
    // utcDateKey that reads the LOCAL calendar day (getFullYear/getMonth/
    // getDate) instead of the UTC one is indistinguishable from the correct
    // implementation whenever the runner's local TZ happens to already be
    // UTC — which is most CI runners by default. Every boundary-case
    // assertion below silently loses its discriminating power in that case.
    // If this reports 0, the pin above was removed or overridden, and this
    // failure is the loud signal that should replace the silent one.
    expect(new Date().getTimezoneOffset()).not.toBe(0);
  });
});

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

describe("signedGapMs", () => {
  // dedupe.ts is the only source caller, and it only ever compares two
  // signedGapMs results for equality and then takes Math.abs of one of them
  // (`openShift === closeShift && Math.abs(openShift) === offsetMs`). A full
  // sign flip (returning `tf - tt` instead of `tt - tf`) flips both sides of
  // that equality together and leaves the abs value unchanged, so it is
  // invisible through dedupe.ts, its tests, and the property-based fuzzing
  // over dedupe — confirmed: all 206 tests, including the fuzz suite, still
  // passed under that exact mutation. Sign is the one thing this function
  // has that absGapMs does not, so it has to be tested directly.
  const earlier = "2026-05-04T07:09:00Z";
  const later = "2026-05-04T10:09:00Z";

  it("is positive when `to` is later than `from`", () => {
    expect(signedGapMs(earlier, later)).toBe(10_800_000);
  });

  it("is negative when `to` is earlier than `from`", () => {
    // The mutation this test alone catches: return tf - tt instead of
    // tt - tf. That mutant returns +10_800_000 here, not -10_800_000.
    expect(signedGapMs(later, earlier)).toBe(-10_800_000);
  });

  it("is zero for the same instant written with different offsets", () => {
    expect(signedGapMs("2026-05-04T07:09:00Z", "2026-05-04T10:09:00+03:00")).toBe(0);
  });

  it("rejects a first argument that is not a timestamp", () => {
    expect(() => signedGapMs("nope", "2026-05-04T07:09:00Z"))
      .toThrow(/not an ISO timestamp: "nope"/);
  });

  it("rejects a second argument that is not a timestamp", () => {
    expect(() => signedGapMs("2026-05-04T07:09:00Z", "nope"))
      .toThrow(/not an ISO timestamp: "nope"/);
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
