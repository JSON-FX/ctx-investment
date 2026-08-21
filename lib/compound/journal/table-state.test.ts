import {
  DEFAULT_SIZES,
  flattenParams,
  hrefWith,
  paginate,
  parseTableState,
  splitSort,
  toggleSort,
  type Params,
  type TableSpec,
} from "./table-state";

const SPEC: TableSpec = {
  sorts: ["closed_desc", "closed_asc", "profit_desc", "profit_asc"],
  defaultSort: "closed_desc",
  filterKeys: ["outcome", "symbol"],
};

describe("parseTableState", () => {
  it("reads a well-formed prefixed state", () => {
    const s = parseTableState(
      { "t.page": "3", "t.size": "50", "t.sort": "profit_asc", "t.q": "XAU", "t.symbol": "XAUUSD" },
      SPEC,
      "t",
    );
    expect(s).toEqual({
      page: 3,
      size: 50,
      sort: "profit_asc",
      search: "XAU",
      filters: { symbol: "XAUUSD" },
    });
  });

  // Mutation caught: trusting the URL. Every one of these is a value a user
  // can type, and every fallback is the safe one.
  it.each([
    ["sort not in the allowlist", { "t.sort": "profit_desc; drop table" }, "sort", "closed_desc"],
    ["sort of a column that exists but a direction that does not", { "t.sort": "profit_sideways" }, "sort", "closed_desc"],
    ["empty sort", { "t.sort": "" }, "sort", "closed_desc"],
    // Mutation caught: an allowlist implemented as a case-insensitive or
    // substring match instead of an exact membership test.
    ["sort in a different case than any allowlisted entry", { "t.sort": "PROFIT_DESC" }, "sort", "closed_desc"],
    ["sort with mixed case matching an entry letter-for-letter otherwise", { "t.sort": "Closed_Desc" }, "sort", "closed_desc"],
    // Mutation caught: trimming before the allowlist check, which would let
    // a padded value slip through as if it were exact.
    ["sort with a trailing space", { "t.sort": "closed_desc " }, "sort", "closed_desc"],
    ["sort with a leading space", { "t.sort": " closed_desc" }, "sort", "closed_desc"],
    // Mutation caught: coercing before comparing, which would let a numeric
    // string land in an enum slot no numeric value belongs in.
    ["a bare numeric string where an enum is expected", { "t.sort": "12345" }, "sort", "closed_desc"],
  ])("falls back on %s", (_label, params, field, expected) => {
    const s = parseTableState(params, SPEC, "t") as unknown as Record<string, unknown>;
    expect(s[field]).toBe(expected);
  });

  it.each([
    ["a size outside the allowlist", "1000000", 25],
    ["a non-numeric size", "big", 25],
    ["a negative size", "-50", 25],
    ["an allowed size", "100", 100],
  ])("handles %s", (_label, raw, expected) => {
    expect(parseTableState({ "t.size": raw }, SPEC, "t").size).toBe(expected);
  });

  it.each([
    ["zero", "0", 1],
    ["negative", "-3", 1],
    ["fractional", "2.7", 2], // parseInt takes the leading integer
    ["absurd", "99999999", 10_000],
    ["valid", "4", 4],
  ])("clamps page %s", (_label, raw, expected) => {
    expect(parseTableState({ "t.page": raw }, SPEC, "t").page).toBe(expected);
  });

  // Mutation caught: no length cap, which lets a 100KB query string reach the
  // filter loop and the rendered chip.
  it("caps free text at 64 characters", () => {
    const long = "x".repeat(500);
    expect(parseTableState({ "t.q": long }, SPEC, "t").search).toHaveLength(64);
    expect(parseTableState({ "t.symbol": long }, SPEC, "t").filters.symbol).toHaveLength(64);
  });

  // Mutation caught: ignoring the prefix, which would make the orders table
  // read the trades table's parameters.
  it("reads only its own prefix", () => {
    const params = { "t.sort": "profit_asc", "o.sort": "closed_asc", "t.symbol": "EURUSD" };
    expect(parseTableState(params, SPEC, "o").sort).toBe("closed_asc");
    expect(parseTableState(params, SPEC, "o").filters).toEqual({});
    expect(parseTableState(params, SPEC, "t").filters).toEqual({ symbol: "EURUSD" });
  });

  // Mutation caught: copying every parameter into filters rather than only the
  // declared keys, which would turn `?t.page=2` into a filter on "page".
  it("keeps only declared filter keys", () => {
    const s = parseTableState({ "t.nonsense": "1", "t.outcome": "wins" }, SPEC, "t");
    expect(s.filters).toEqual({ outcome: "wins" });
  });

  it("uses the first declared size as the default", () => {
    expect(parseTableState({}, SPEC, "t").size).toBe(DEFAULT_SIZES[0]);
  });

  // Mutation caught: dropping the `typeof v === "string"` guard in `get`.
  // Next.js's searchParams type is `string | string[] | undefined` — a
  // repeated key in the query string (?t.q=a&t.q=b) arrives as an array, not
  // a string. An array is not `undefined`, so a bare `?? ""` does not catch
  // it, and arrays have their own `.slice`, so it does not throw here either
  // — it would sail through as an array-shaped "string" and only blow up
  // later, in trade-filters.ts's `.toLowerCase()`. This must be rejected at
  // the boundary, not downstream.
  it("treats an array value the same as absent, for every field", () => {
    const hostile = {
      "t.sort": ["profit_desc", "closed_asc"],
      "t.size": ["100"],
      "t.page": ["3"],
      "t.q": ["a", "b"],
      "t.symbol": ["EURUSD", "GBPUSD"],
    } as unknown as Params;
    const s = parseTableState(hostile, SPEC, "t");
    expect(s.sort).toBe("closed_desc");
    expect(s.size).toBe(25);
    expect(s.page).toBe(1);
    expect(s.search).toBe("");
    expect(s.filters).toEqual({});
    // The type contract says every filter value is a string. Confirm the
    // runtime value actually is one — not an array that merely satisfies
    // `!== undefined && !== ""` and rides along unconverted.
    expect(Object.values(s.filters).every((v) => typeof v === "string")).toBe(true);
  });

  // Mutation caught: the same array-tolerance bug, isolated to `search`
  // specifically, and proven by actually calling the method that would
  // throw rather than by inspecting the shape. If `get` ever again returns
  // an array for "q", this line throws instead of the assertions above
  // merely failing.
  it("never returns a search value that lacks string methods", () => {
    const hostile = { "t.q": ["a", "b"] } as unknown as Params;
    const s = parseTableState(hostile, SPEC, "t");
    expect(() => s.search.toLowerCase()).not.toThrow();
  });
});

describe("hrefWith", () => {
  // Mutation caught: replacing the whole query string instead of merging,
  // which resets every other table on the page.
  it("preserves parameters it is not changing", () => {
    expect(hrefWith("/a/1/journal", { "t.sort": "profit_asc", "o.page": "2" }, { "t.page": "3" })).toBe(
      "/a/1/journal?o.page=2&t.page=3&t.sort=profit_asc",
    );
  });

  // Mutation caught: writing an empty value instead of removing the key,
  // leaving `?t.symbol=` in every subsequent link.
  it("removes a parameter set to null or empty", () => {
    expect(hrefWith("/a/1/journal", { "t.symbol": "EURUSD" }, { "t.symbol": null })).toBe(
      "/a/1/journal",
    );
    expect(hrefWith("/a/1/journal", { "t.symbol": "EURUSD" }, { "t.symbol": "" })).toBe(
      "/a/1/journal",
    );
  });

  // Mutation caught: string concatenation without encoding, which breaks on
  // any symbol or comment containing & or a space.
  it("encodes keys and values", () => {
    expect(hrefWith("/a/1/journal", {}, { "t.q": "a b&c=d" })).toBe("/a/1/journal?t.q=a%20b%26c%3Dd");
  });

  it("returns the bare path when nothing is left", () => {
    expect(hrefWith("/a/1/calendar", {}, {})).toBe("/a/1/calendar");
  });

  // Mutation caught: dropping the typeof guard on the read side of
  // hrefWith's merge loop, which would let an array value from an
  // unnormalised searchParams object reach encodeURIComponent and produce a
  // silently wrong link (Array#toString joins with commas) instead of being
  // excluded like any other absent parameter.
  it("excludes an array-valued parameter instead of stringifying it", () => {
    const hostile = { "t.symbol": ["EURUSD", "GBPUSD"] } as unknown as Params;
    expect(hrefWith("/a/1/journal", hostile, {})).toBe("/a/1/journal");
  });
});

describe("toggleSort and splitSort", () => {
  // Mutation caught: always returning `_desc`, so a column can never be
  // sorted ascending; or always flipping, so clicking a new column inherits
  // the previous column's direction.
  it("flips only the active column and starts new columns descending", () => {
    expect(toggleSort("closed_desc", "closed")).toBe("closed_asc");
    expect(toggleSort("closed_asc", "closed")).toBe("closed_desc");
    expect(toggleSort("closed_asc", "profit")).toBe("profit_desc");
  });

  // Mutation caught: splitting on the FIRST underscore, which turns
  // "time_setup_desc" into ["time", "setup_desc"] and then defaults to desc
  // for every direction.
  it("splits on the last underscore", () => {
    expect(splitSort("profit_desc")).toEqual(["profit", "desc"]);
    expect(splitSort("time_setup_asc")).toEqual(["time_setup", "asc"]);
    expect(splitSort("garbage")).toEqual(["garbage", "desc"]);
  });
});

describe("paginate", () => {
  const rows = Array.from({ length: 9 }, (_, i) => i + 1);
  const state = { page: 1, size: 4, sort: "x_desc", search: "", filters: {} };

  it("slices the requested page and reports the count", () => {
    expect(paginate(rows, { ...state, page: 2 })).toEqual({
      rows: [5, 6, 7, 8],
      total: 9,
      page: 2,
      pageCount: 3,
    });
    expect(paginate(rows, { ...state, page: 3 }).rows).toEqual([9]);
  });

  // Mutation caught: no clamp, so a bookmark to page 9 renders an empty table
  // with no explanation.
  it("clamps a page beyond the end back to the last page", () => {
    expect(paginate(rows, { ...state, page: 99 })).toEqual({
      rows: [9],
      total: 9,
      page: 3,
      pageCount: 3,
    });
  });

  // Mutation caught: pageCount 0 for an empty table, which renders "Page 1 of 0".
  it("reports one page for an empty table", () => {
    expect(paginate([], state)).toEqual({ rows: [], total: 0, page: 1, pageCount: 1 });
  });
});

describe("flattenParams", () => {
  // Mutation caught: taking the LAST value, so appending &t.sort=<anything>
  // to a link overrides what the page itself put there.
  it("takes the first value of a repeated parameter and drops undefined", () => {
    expect(flattenParams({ a: ["1", "2"], b: "x", c: undefined, d: [] })).toEqual({
      a: "1",
      b: "x",
    });
  });
});
