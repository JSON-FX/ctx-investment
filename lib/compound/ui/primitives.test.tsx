/**
 * The plan's Task 4 test list covers primitives.tsx only indirectly, through
 * HolderTable and StatementHead. That leaves UnitCount, EmptyState, Chip's
 * "fee" tone, DeltaMoney's zero case, and LabelledFigure's own contract
 * (custom class names, no id collisions across instances) with no test that
 * would go red if any one of them broke. This file is that coverage,
 * asserted the same way as the rest of the kit: by accessible name and by
 * the actual text of the figure, never by "did it render something".
 */
import { render, screen } from "@testing-library/react";
import { centsFromDecimal, unitsFromDecimal } from "@/lib/compound/engine/money";
import {
  Chip, DeltaMoney, EmptyState, FeeMoney, LabelledFigure, Money, PageHeading, Share, Tag,
  UnitCount,
} from "./primitives";

describe("Money", () => {
  it("renders a plain figure with the currency symbol", () => {
    render(<Money cents={centsFromDecimal("12630.61")} />);
    expect(screen.getByText("$12,630.61")).toBeInTheDocument();
  });

  it("uses the currency it is given, not a hard-coded dollar", () => {
    render(<Money cents={centsFromDecimal("12630.61")} currency="EUR" />);
    expect(screen.getByText("€12,630.61")).toBeInTheDocument();
  });
});

describe("DeltaMoney", () => {
  it("signs a gain with + and paints it --gain via the pos class", () => {
    const { container } = render(<DeltaMoney cents={centsFromDecimal("2630.61")} />);
    expect(screen.getByText("+$2,630.61")).toBeInTheDocument();
    expect(container.querySelector(".pos")).not.toBeNull();
    expect(container.querySelector(".neg")).toBeNull();
  });

  it("signs a loss with - and paints it --loss via the neg class", () => {
    const { container } = render(<DeltaMoney cents={centsFromDecimal("-1712.02")} />);
    expect(screen.getByText("-$1,712.02")).toBeInTheDocument();
    expect(container.querySelector(".neg")).not.toBeNull();
    expect(container.querySelector(".pos")).toBeNull();
  });

  it("signs zero as + — break-even is not a loss — and paints neither colour", () => {
    const { container } = render(<DeltaMoney cents={0n} />);
    expect(screen.getByText("+$0.00")).toBeInTheDocument();
    expect(container.querySelector(".pos")).toBeNull();
    expect(container.querySelector(".neg")).toBeNull();
  });
});

describe("FeeMoney", () => {
  it("renders a positive fee in the fee colour", () => {
    const { container } = render(<FeeMoney cents={centsFromDecimal("1052.24")} />);
    expect(screen.getByText("$1,052.24")).toBeInTheDocument();
    expect(container.querySelector(".fee")).not.toBeNull();
  });

  it("renders zero as a figure by default", () => {
    render(<FeeMoney cents={0n} />);
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("renders zero as a dash when told to, so an uncharged manager row is not read as $0.00", () => {
    render(<FeeMoney cents={0n} zeroAs="dash" />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).toBeNull();
  });
});

describe("UnitCount", () => {
  it("renders the truncated unit count with a units suffix, at 4dp by default", () => {
    render(<UnitCount units={unitsFromDecimal("9113.71329999")} />);
    // Truncated, not rounded — decision D-K. 71329999 at 4dp truncates to
    // 7132, not 7133, which is what a naive round would give.
    expect(screen.getByText(/9,113\.7132/)).toBeInTheDocument();
    expect(screen.getByText("units")).toBeInTheDocument();
  });

  it("honours a caller-supplied precision", () => {
    render(<UnitCount units={unitsFromDecimal("9113.71")} dp={2} />);
    expect(screen.getByText(/9,113\.71\b/)).toBeInTheDocument();
  });
});

describe("Share", () => {
  it("renders a ppm value as a percentage at 2dp", () => {
    render(<Share ppm={226_583} />);
    expect(screen.getByText("22.66%")).toBeInTheDocument();
  });

  it("refuses a ppm value outside 0..1,000,000 rather than printing a wrong percentage", () => {
    expect(() => render(<Share ppm={-1} />)).toThrow(/ppm must be an integer/);
  });
});

describe("Tag and Chip", () => {
  it("renders a tag's own text", () => {
    render(<Tag>Manager</Tag>);
    expect(screen.getByText("Manager")).toBeInTheDocument();
  });

  it("paints a chip's tone as a class, and no tone as the base chip", () => {
    const { container, rerender } = render(<Chip>Untoned</Chip>);
    expect(container.querySelector(".chip")).not.toBeNull();
    expect(container.querySelector(".is-live")).toBeNull();
    expect(container.querySelector(".is-fee")).toBeNull();

    rerender(<Chip tone="live">Live</Chip>);
    expect(container.querySelector(".chip.is-live")).not.toBeNull();

    rerender(<Chip tone="fee">Fee</Chip>);
    expect(container.querySelector(".chip.is-fee")).not.toBeNull();
  });
});

describe("PageHeading", () => {
  it("is a level-1 heading, named for the route", () => {
    render(<PageHeading>Journal</PageHeading>);
    expect(screen.getByRole("heading", { level: 1, name: "Journal" })).toBeInTheDocument();
  });

  it("is visually hidden rather than adding a visible title to the design", () => {
    render(<PageHeading>Journal</PageHeading>);
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("sr-only");
  });
});

describe("EmptyState", () => {
  it("shows its title, and its hint only when one is given", () => {
    const { rerender } = render(<EmptyState title="No holders yet" />);
    expect(screen.getByText("No holders yet")).toBeInTheDocument();

    rerender(<EmptyState title="No holders yet">Add the first investor to get started.</EmptyState>);
    expect(screen.getByText("Add the first investor to get started.")).toBeInTheDocument();
  });
});

describe("LabelledFigure", () => {
  it("names its value with the label via aria-labelledby, not aria-label", () => {
    render(<LabelledFigure label="Fee if everyone paid out today">$1,409.67</LabelledFigure>);
    const value = screen.getByLabelText("Fee if everyone paid out today");
    expect(value.textContent).toBe("$1,409.67");
    // aria-labelledby names without suppressing the number — aria-label would
    // hide it from the accessibility tree's text content.
    expect(value).toHaveAttribute("aria-labelledby");
    expect(value).not.toHaveAttribute("aria-label");
  });

  it("gives every instance its own id, so two figures on one screen never collide", () => {
    render(
      <>
        <LabelledFigure label="Investor capital in">$17,500.00</LabelledFigure>
        <LabelledFigure label="Investor value now">$21,096.65</LabelledFigure>
      </>,
    );
    expect(screen.getByLabelText("Investor capital in").textContent).toBe("$17,500.00");
    expect(screen.getByLabelText("Investor value now").textContent).toBe("$21,096.65");
  });

  it("applies caller-supplied class names to the label and value", () => {
    render(
      <LabelledFigure label="NAV / unit" labelClassName="eyebrow" valueClassName="num">
        1.3858
      </LabelledFigure>,
    );
    const value = screen.getByLabelText("NAV / unit");
    expect(value).toHaveClass("num");
    expect(document.getElementById(value.getAttribute("aria-labelledby")!)).toHaveClass("eyebrow");
  });
});
