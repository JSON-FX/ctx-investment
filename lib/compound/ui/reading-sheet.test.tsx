import { render, screen } from "@testing-library/react";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { previewEntry } from "@/lib/compound/present/derive";
import { HOLDER_NAMES, LEDGER, SEEDS } from "@/lib/compound/present/fixture";
import { ReadingSheet, type ReadingGate } from "./reading-sheet";

const PREVIEW = previewEntry({
  accountId: 7, entries: LEDGER, seeds: SEEDS,
  proposed: {
    holderId: null, occurredOn: "2026-08-18", type: "equity_reading",
    amountCents: centsFromDecimal("57120.44"), feeSettlement: null, splitBpsApplied: null,
  },
});

const READY: ReadingGate = { kind: "ready", earliestDate: "2026-08-14" };
const noop = async () => {};

function renderSheet(over: Partial<Parameters<typeof ReadingSheet>[0]> = {}) {
  return render(
    <ReadingSheet
      accountId={7}
      gate={over.gate ?? READY}
      currency="USD"
      names={HOLDER_NAMES}
      preview={over.preview === undefined ? PREVIEW : over.preview}
      form={over.form ?? { occurredOn: "2026-08-18", equity: "57120.44" }}
      error={over.error}
      backHref="/a/7"
      commitAction={noop}
    />,
  );
}

describe("ReadingSheet — the receipt", () => {
  beforeEach(() => renderSheet());

  it("shows equity before and after", () => {
    expect(screen.getByLabelText("Account equity").textContent)
      .toBe("$55,743.91 → $57,120.44");
  });

  it("shows NAV before and after", () => {
    expect(screen.getByLabelText("NAV per unit").textContent).toBe("1.3858 → 1.4201");
  });

  it("shows every holder's change, signed", () => {
    expect(screen.getByLabelText("J. Marsh").textContent).toBe("+$855.57");
    expect(screen.getByLabelText("Ada Lovelace").textContent).toBe("+$311.90");
    expect(screen.getByLabelText("Grace Hopper").textContent).toBe("+$209.06");
  });

  it("totals the holder changes to the change in equity, exactly", () => {
    const parts = ["J. Marsh", "Ada Lovelace", "Grace Hopper"]
      .map((n) => BigInt(screen.getByLabelText(n).textContent!.replace(/[^\d-]/g, "")));
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(137_653n);
    expect(screen.getByLabelText("Total change in value").textContent).toBe("+$1,376.53");
  });

  it("carries the fingerprint into the commit form as decimal strings", () => {
    const value = (n: string) =>
      document.querySelector<HTMLInputElement>(`input[name="${n}"]`)!.value;
    expect(value("fpAccountId")).toBe("7");
    expect(value("fpSeq")).toBe("6");
    expect(value("fpEquityCents")).toBe("5574391");
    expect(value("fpUnits")).toBe("402224547963043");
  });

  it("says a reading does not move units", () => {
    expect(screen.getByText(/Units do not change/)).toBeInTheDocument();
  });
});

describe("ReadingSheet — the fence", () => {
  it("refuses while the reconciler has days left to post, and says why", () => {
    renderSheet({ gate: { kind: "unposted", count: 4, through: "2026-08-14" }, preview: null });
    expect(screen.getByText(/CopyTraderX has 4 days up to 14 Aug 2026 that are not posted/))
      .toBeInTheDocument();
    expect(screen.getByText(/absorbed into NAV without anyone seeing it/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Post this reading/ })).toBeNull();
  });

  it("refuses while a capital event is unclassified, and links to it", () => {
    renderSheet({
      gate: { kind: "halted", candidateDate: "2026-08-12", reviewHref: "/a/7/review" },
      preview: null,
    });
    expect(screen.getByText(/unexplained balance move on 12 Aug 2026/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review it" })).toHaveAttribute("href", "/a/7/review");
  });

  it("refuses when the broker offset is not configured", () => {
    renderSheet({ gate: { kind: "not-configured" }, preview: null });
    expect(screen.getByText(/broker UTC offset is not set/)).toBeInTheDocument();
  });

  it("shows a reconciler data defect as an error, not as a halt to be classified", () => {
    // A duplicate trade date is an upstream defect. Rendering it as "classify
    // this capital event" sends the manager looking for one that is not there.
    renderSheet({
      gate: { kind: "error", message: "duplicate snapshot for tradeDate 2026-08-12 in the reading window" },
      preview: null,
    });
    expect(screen.getByText(/duplicate snapshot for tradeDate 2026-08-12/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Review it" })).toBeNull();
  });
});

describe("ReadingSheet — step one", () => {
  it("will not let a date on or before the last posted day be picked", () => {
    renderSheet({ preview: null });
    expect(screen.getByLabelText("Date")).toHaveAttribute("min", "2026-08-14");
  });

  it("asks for equity and says why it is not balance", () => {
    renderSheet({ preview: null });
    expect(screen.getByText(/Equity, not balance/)).toBeInTheDocument();
  });

  it("shows a refusal from a previous attempt", () => {
    renderSheet({ preview: null, error: "There is an unclassified capital event." });
    expect(screen.getByRole("alert").textContent).toContain("unclassified capital event");
    expect(screen.getByRole("alert").textContent).toContain("Nothing was committed");
  });
});
