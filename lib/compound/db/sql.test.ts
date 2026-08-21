import {
  centsExpr,
  dateKeyExpr,
  milliLotsExpr,
  toCents,
  toDateKey,
  toId,
  toSide,
  utcIsoExpr,
} from "./sql";

describe("the SQL fragments do the arithmetic, not JavaScript", () => {
  it("centsExpr casts to numeric before multiplying, and back to bigint", () => {
    expect(centsExpr("balance_close")).toBe("round(balance_close::numeric * 100)::bigint");
  });

  it("milliLotsExpr does the same for lots", () => {
    expect(milliLotsExpr("volume")).toBe("round(volume::numeric * 1000)::int");
  });

  it("dateKeyExpr renders text rather than letting the driver build a Date", () => {
    expect(dateKeyExpr("occurred_on")).toBe("to_char(occurred_on, 'YYYY-MM-DD')");
  });

  it("utcIsoExpr pins the instant to UTC and emits ISO 8601", () => {
    expect(utcIsoExpr("close_time")).toBe(
      `to_char(close_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    );
  });
});

describe("toCents", () => {
  it("parses an integer cent string", () => {
    expect(toCents("1000005", "balance")).toBe(1000005n);
  });

  it("parses a negative one", () => {
    expect(toCents("-205", "swap")).toBe(-205n);
  });

  it("keeps a value above 2^53 exact", () => {
    expect(toCents("9007199254740993", "equity")).toBe(9007199254740993n);
  });

  it("passes a bigint straight through", () => {
    expect(toCents(29n, "commission")).toBe(29n);
  });

  it("refuses a JavaScript number, and says why", () => {
    expect(() => toCents(1000005, "balance")).toThrow(
      /got a JavaScript number \(1000005\) where integer cents were expected/,
    );
  });

  it("refuses a decimal string — that is dollars, not cents", () => {
    expect(() => toCents("10000.05", "balance")).toThrow(/not an integer cent string/);
  });

  it("refuses null", () => {
    expect(() => toCents(null, "balance")).toThrow(/expected an integer cent string, got object/);
  });
});

describe("toDateKey", () => {
  it("passes a well-formed key through", () => {
    expect(toDateKey("2026-08-12", "trade_date")).toBe("2026-08-12");
  });

  it("refuses a Date, and explains the local-midnight hazard", () => {
    expect(() => toDateKey(new Date("2026-08-12T00:00:00Z"), "trade_date")).toThrow(
      /pg builds a date at LOCAL midnight/,
    );
  });

  it("refuses a timestamp string", () => {
    expect(() => toDateKey("2026-08-12T00:00:00Z", "trade_date")).toThrow(/expected YYYY-MM-DD/);
  });

  it("refuses a two-digit year", () => {
    expect(() => toDateKey("26-08-12", "trade_date")).toThrow(/expected YYYY-MM-DD/);
  });
});

describe("toId", () => {
  it("parses a bigserial string", () => {
    expect(toId("42", "id")).toBe(42);
  });

  it("accepts a number that is already safe", () => {
    expect(toId(42, "id")).toBe(42);
  });

  it("refuses an id past the safe integer range rather than rounding it", () => {
    expect(() => toId("9007199254740993", "id")).toThrow(/id out of safe range/);
  });

  it("refuses a negative id", () => {
    expect(() => toId("-1", "id")).toThrow(/expected an id/);
  });
});

describe("toSide", () => {
  it("accepts buy and sell", () => {
    expect(toSide("buy", "side")).toBe("buy");
    expect(toSide("sell", "side")).toBe("sell");
  });

  it("refuses a differently cased value rather than casting it", () => {
    expect(() => toSide("BUY", "side")).toThrow(/expected "buy" or "sell", got "BUY"/);
  });

  it("refuses an unexpected value and names it", () => {
    expect(() => toSide("balance", "side")).toThrow(/got "balance"/);
  });
});
