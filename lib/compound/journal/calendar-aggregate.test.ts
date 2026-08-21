import {
  aggregateCalendar,
  dayOfWeekUtc,
  daysFromEpoch,
  daysInMonth,
  isLeapYear,
  monthGrid,
  monthSummary,
  parseMonth,
  shiftMonth,
} from "./calendar-aggregate";
import { buildTradeHistory } from "./history";
import { FIXTURE_OFFSET_HOURS, fixtureHistory, fixtureHistoryUnguarded } from "./__fixtures__/deals";

describe("aggregateCalendar", () => {
  const days = aggregateCalendar(fixtureHistory().deals);

  it("covers exactly the five trading days in the fixture", () => {
    expect([...days.keys()].sort()).toEqual([
      "2026-05-04",
      "2026-05-05",
      "2026-05-06",
      "2026-05-07",
      "2026-05-08",
    ]);
  });

  // Mutation caught: `out.set(key, {...one deal...})` instead of accumulating,
  // which keeps only the last trade of a day. THIS IS THE MUTATION THAT
  // SURVIVED A FULL SUITE IN THE SIBLING PROJECT, because its fixture had one
  // trade per day. Both counts and both money figures are asserted.
  it("accumulates two trades on the same day rather than keeping one", () => {
    const d = days.get("2026-05-04")!;
    expect(d.tradeCount).toBe(2);
    expect(d.wins).toBe(1);
    expect(d.losses).toBe(1);
    expect(d.grossCents).toBe(828n);
    expect(d.netCents).toBe(769n);
  });

  it("accumulates three trades on the same day", () => {
    const d = days.get("2026-05-08")!;
    expect(d.tradeCount).toBe(3);
    expect(d.netCents).toBe(451n);
  });

  // Mutation caught: counting wins on net rather than gross. Ticket 5009 is
  // gross +5 and net -26. On net, 2026-05-08 has one win and two losses.
  it("counts a fee-eroded winner as a win but as negative money", () => {
    const d = days.get("2026-05-08")!;
    expect(d.wins).toBe(2);
    expect(d.losses).toBe(1);
    expect(d.grossCents).toBe(561n);
    expect(d.netCents).toBe(451n);
  });

  // Mutation caught: netCents computed from profit only. 2026-05-07's gross is
  // 677 and its net is 644 — the flat trade's -7 commission is the difference.
  it("includes swap and commission in the day's money figure", () => {
    const d = days.get("2026-05-07")!;
    expect(d.tradeCount).toBe(2);
    expect(d.flat).toBe(1);
    expect(d.grossCents).toBe(677n);
    expect(d.netCents).toBe(644n);
  });

  // Mutation caught: keying on the BROKER day (close_time + offset) or on a
  // local Date. Ticket 5003 closes at 23:30Z; at +3 its broker date is 05-06.
  // Run under TZ=Pacific/Kiritimati to make the local-Date variant fail too.
  it("keys the 23:30 UTC close on the UTC day, not the broker day", () => {
    expect(days.get("2026-05-05")!.tradeCount).toBe(1);
    expect(days.get("2026-05-05")!.netCents).toBe(2821n);
    expect(days.get("2026-05-06")!.tradeCount).toBe(1);
    expect(days.get("2026-05-06")!.netCents).toBe(-1522n);
  });

  // THE DEDUPE ASSERTION for this module.
  it("differs from the undeduplicated answer on 2026-05-08", () => {
    const bad = aggregateCalendar(fixtureHistoryUnguarded().deals);
    expect(bad.get("2026-05-08")!.tradeCount).toBe(4);
    expect(bad.get("2026-05-08")!.netCents).toBe(1804n);
    expect(bad.get("2026-05-08")!.netCents).not.toBe(days.get("2026-05-08")!.netCents);
  });

  it("returns an empty map for no deals", () => {
    expect(aggregateCalendar(buildTradeHistory([], FIXTURE_OFFSET_HOURS).deals).size).toBe(0);
  });
});

describe("monthSummary", () => {
  const days = aggregateCalendar(fixtureHistory().deals);

  // Mutation caught: `key.startsWith(month)` without the trailing dash, which
  // would make "2026-0" match; and summing every day regardless of month.
  it("sums only the days inside the month", () => {
    const s = monthSummary(days, "2026-05");
    expect(s.tradeCount).toBe(9);
    expect(s.tradingDays).toBe(5);
    expect(s.netCents).toBe(3163n);
    expect(s.grossCents).toBe(3458n);
    expect(s.wins).toBe(5);
    expect(s.losses).toBe(3);
  });

  it("returns zeros for a month with no trading", () => {
    const s = monthSummary(days, "2026-06");
    expect(s.tradeCount).toBe(0);
    expect(s.tradingDays).toBe(0);
    expect(s.netCents).toBe(0n);
  });
});

describe("calendar arithmetic", () => {
  // Mutation caught: `year % 4 === 0` alone, which makes 2100 a leap year;
  // and `year % 4 === 0 && year % 100 !== 0` alone, which makes 2000 common.
  it.each([
    [2024, true],
    [2026, false],
    [2028, true],
    [2100, false],
    [2000, true],
  ])("isLeapYear(%i) is %p", (y, expected) => {
    expect(isLeapYear(y)).toBe(expected);
  });

  it("gives February the right length in each of those years", () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  // Mutation caught: any error in days_from_civil. The epoch is the anchor.
  it("anchors on the epoch", () => {
    expect(daysFromEpoch(1970, 1, 1)).toBe(0);
    expect(daysFromEpoch(1969, 12, 31)).toBe(-1);
    expect(daysFromEpoch(2026, 5, 1)).toBe(20574);
  });

  // Mutation caught: the +4 epoch-day offset being wrong, which rotates the
  // whole calendar by a fixed amount and is invisible without a known date.
  it("puts known dates on the right weekday", () => {
    expect(dayOfWeekUtc("1970-01-01")).toBe(4); // Thursday
    expect(dayOfWeekUtc("2026-05-01")).toBe(5); // Friday
    expect(dayOfWeekUtc("2026-05-04")).toBe(1); // Monday
    expect(dayOfWeekUtc("2026-03-01")).toBe(0); // Sunday
  });

  it("rejects a malformed date key rather than guessing", () => {
    expect(() => dayOfWeekUtc("2026-5-1")).toThrow(/not a date key/);
    expect(() => parseMonth("2026-13")).toThrow(/out of range/);
    expect(() => parseMonth("May 2026")).toThrow(/not a month/);
  });

  // Mutation caught: `zero % 12` without the double modulo, which produces
  // month 0 or a negative month when stepping back across January.
  it("steps months across a year boundary in both directions", () => {
    expect(shiftMonth("2026-05", 1)).toBe("2026-06");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-01", -13)).toBe("2024-12");
  });
});

describe("monthGrid", () => {
  // Mutation caught: leading blanks computed from a local Date, or off by one.
  it("puts 2026-05-01 in the Friday column with five leading blanks", () => {
    const rows = monthGrid("2026-05");
    expect(rows[0]!.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(rows[0]![5]).toBe("2026-05-01");
    expect(rows[0]![6]).toBe("2026-05-02");
  });

  // Mutation caught: an off-by-one that only shows up on a single leading
  // blank, which a 0-blank test (Sunday) and a 5-blank test (Friday) both
  // miss. 2026-06-01 is a Monday.
  it("puts a single leading blank when the month starts on a Monday", () => {
    const rows = monthGrid("2026-06");
    expect(rows[0]![0]).toBeNull();
    expect(rows[0]![1]).toBe("2026-06-01");
    expect(rows[0]![2]).toBe("2026-06-02");
  });

  // Mutation caught: always emitting a leading blank. March 2026 starts on a
  // Sunday, so the first cell is the first of the month.
  it("emits no leading blank when the month starts on a Sunday", () => {
    const rows = monthGrid("2026-03");
    expect(rows[0]![0]).toBe("2026-03-01");
  });

  it("emits whole weeks and the natural number of rows", () => {
    expect(monthGrid("2026-05")).toHaveLength(6);
    expect(monthGrid("2026-02")).toHaveLength(4); // starts Sunday, 28 days
    for (const rows of [monthGrid("2026-05"), monthGrid("2026-02"), monthGrid("2028-02")]) {
      for (const row of rows) expect(row).toHaveLength(7);
    }
  });

  it("emits every day of the month exactly once, in order", () => {
    const flat = monthGrid("2028-02").flat().filter((d): d is string => d !== null);
    expect(flat).toHaveLength(29); // leap
    expect(flat[0]).toBe("2028-02-01");
    expect(flat[28]).toBe("2028-02-29");
    expect(new Set(flat).size).toBe(29);
  });

  // Mutation caught: single-digit days rendered without padding, which would
  // never match a utcDateKey and would silently show every early-month day as
  // empty.
  it("zero-pads day and month so the keys match utcDateKey", () => {
    const flat = monthGrid("2026-05").flat().filter((d): d is string => d !== null);
    expect(flat[0]).toBe("2026-05-01");
    expect(flat).toContain("2026-05-09");
    const days = aggregateCalendar(fixtureHistory().deals);
    expect(flat.filter((d) => days.has(d))).toHaveLength(5);
  });
});
