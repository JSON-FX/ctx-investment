import { render, screen } from "@testing-library/react";
import { fold, totalsOf } from "@/lib/compound/engine/replay";
import { deskFigures } from "@/lib/compound/present/derive";
import { HOLDER_NAMES, LEDGER, LIVE, SEEDS } from "@/lib/compound/present/fixture";
import { DeltaMoney, FeeMoney, Money } from "./primitives";
import { KpiStrip, StatementHead } from "./statement";

const STATE = fold(LEDGER, SEEDS);
const FIGURES = deskFigures(STATE, HOLDER_NAMES);

describe("StatementHead", () => {
  beforeEach(() => {
    render(
      <StatementHead
        totals={totalsOf(STATE)}
        currency="USD"
        asOf={STATE.lastReadingOn}
        entryCount={LEDGER.length}
        holderCount={FIGURES.holderCount}
        live={LIVE}
      />,
    );
  });

  it("shows the committed equity as the headline figure", () => {
    expect(screen.getByLabelText("Account equity").textContent).toBe("$55,743.91");
  });

  it("shows NAV per unit at four places", () => {
    expect(screen.getByLabelText("NAV / unit").textContent).toBe("1.3858");
  });

  it("shows growth since inception, signed", () => {
    expect(screen.getByLabelText("Since inception").textContent).toBe("+38.58%");
  });

  it("shows units issued and the holder count", () => {
    expect(screen.getByLabelText("Units issued").textContent).toBe("40,222.4547");
    expect(screen.getByLabelText("Holders").textContent).toBe("3");
  });

  it("says how many ledger entries the figure came from and as of when", () => {
    expect(screen.getByText(/derived from 6 ledger entries · as of 14 Aug 2026/))
      .toBeInTheDocument();
  });

  it("labels the live figure as not posted, and keeps it apart from equity", () => {
    // 55,930.00 is the live equity. It must never appear as the headline.
    expect(screen.getByLabelText("Account equity").textContent).not.toContain("55,930");
    expect(screen.getByLabelText("Live equity").textContent).toBe("$55,930.00");
    expect(screen.getByText(/Live · not yet posted/)).toBeInTheDocument();
    expect(screen.getByText(/18 Aug 2026, 09:14 UTC/)).toBeInTheDocument();
  });

  it("shows floating P/L with a sign", () => {
    expect(screen.getByLabelText("Floating P/L").textContent).toBe("+$125.00");
  });
});

describe("StatementHead — before any reading is posted", () => {
  it("says so rather than printing a date", () => {
    const empty = fold([], SEEDS);
    render(
      <StatementHead
        totals={totalsOf(empty)} currency="USD" asOf={null}
        entryCount={0} holderCount={0} live={null}
      />,
    );
    expect(screen.getByText(/derived from 0 ledger entries · no reading posted yet/))
      .toBeInTheDocument();
    expect(screen.getByLabelText("NAV / unit").textContent).toBe("1.0000");
  });
});

describe("KpiStrip", () => {
  it("labels each figure so it can be read without its neighbours", () => {
    render(
      <KpiStrip
        items={[
          { key: "in", label: "Investor capital in", value: <Money cents={FIGURES.investorBasisCents} /> },
          { key: "val", label: "Investor value now", value: <Money cents={FIGURES.investorValueCents} /> },
          { key: "pl", label: "Investor P/L", value: <DeltaMoney cents={FIGURES.investorProfitCents} /> },
          { key: "fee", label: "Fee if everyone paid out today", tone: "fee",
            value: <FeeMoney cents={FIGURES.feeIfAllExitCents} /> },
        ]}
      />,
    );
    expect(screen.getByLabelText("Investor capital in").textContent).toBe("$17,500.00");
    expect(screen.getByLabelText("Investor value now").textContent).toBe("$21,096.65");
    expect(screen.getByLabelText("Investor P/L").textContent).toBe("+$3,596.65");
    expect(screen.getByLabelText("Fee if everyone paid out today").textContent).toBe("$1,409.67");
  });

  it("paints only the fee tile amber", () => {
    const { container } = render(
      <KpiStrip items={[
        { key: "a", label: "Investor capital in", value: <Money cents={1n} /> },
        { key: "b", label: "Fee if everyone paid out today", tone: "fee", value: <FeeMoney cents={1n} /> },
      ]} />,
    );
    expect(container.querySelectorAll(".kpi-item.is-fee")).toHaveLength(1);
  });
});
