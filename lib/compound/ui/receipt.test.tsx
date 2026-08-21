/**
 * receipt.tsx is "the component the whole product turns on" per the plan,
 * but Task 4 is only the frame — Task 13 supplies the payout wording that
 * proves it in place. Nothing in this plan's other test files renders a
 * Receipt at all, so this file exercises the frame itself: a label ties to
 * its figure by aria-labelledby exactly like every other figure in the kit,
 * a fee line is distinguishable by more than colour, and a total reads back
 * distinctly from an ordinary line. Money figures are rendered through the
 * real primitives (not bare strings), so a bug in Money or DeltaMoney would
 * turn up here too.
 */
import { render, screen } from "@testing-library/react";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { DeltaMoney, FeeMoney, Money } from "./primitives";
import { Receipt, ReceiptLine, ReceiptTotal } from "./receipt";

function renderSample() {
  return render(
    <Receipt label="Ada Lovelace's payout">
      <ReceiptLine label="What Ada has put in" hint="her high-water mark">
        <Money cents={centsFromDecimal("10000.00")} />
      </ReceiptLine>
      <ReceiptLine label="Value now">
        <Money cents={centsFromDecimal("12630.60")} />
      </ReceiptLine>
      <ReceiptLine label="Profit">
        <DeltaMoney cents={centsFromDecimal("2630.60")} />
      </ReceiptLine>
      <ReceiptLine label="Manager's fee" tone="fee" hint="40% of profit">
        <FeeMoney cents={centsFromDecimal("1052.24")} />
      </ReceiptLine>
      <ReceiptTotal label="Ada receives">
        <Money cents={centsFromDecimal("11578.36")} />
      </ReceiptTotal>
    </Receipt>,
  );
}

describe("Receipt", () => {
  it("names the whole receipt for a screen reader", () => {
    const { container } = renderSample();
    const dl = container.querySelector("dl.receipt")!;
    expect(dl).toHaveAttribute("aria-label", "Ada Lovelace's payout");
  });

  it("reads back every line by its own label, not by position", () => {
    renderSample();
    expect(screen.getByLabelText("What Ada has put in").textContent).toBe("$10,000.00");
    expect(screen.getByLabelText("Value now").textContent).toBe("$12,630.60");
    expect(screen.getByLabelText("Profit").textContent).toBe("+$2,630.60");
    expect(screen.getByLabelText("Manager's fee").textContent).toBe("$1,052.24");
    expect(screen.getByLabelText("Ada receives").textContent).toBe("$11,578.36");
  });

  it("shows the sub-label under its line, for the reader who is not an accountant", () => {
    renderSample();
    expect(screen.getByText("her high-water mark")).toBeInTheDocument();
    expect(screen.getByText("40% of profit")).toBeInTheDocument();
  });

  it("keeps the hint out of the label's own accessible name", () => {
    // "What Ada has put in" carries a hint; "Value now" does not. Both must
    // resolve to exactly their own label text with nothing glued on — the
    // hint is wired in as a description, not folded into the name.
    renderSample();
    const withHint = screen.getByLabelText("What Ada has put in");
    expect(withHint).toHaveAccessibleDescription("her high-water mark");
    const withoutHint = screen.getByLabelText("Value now");
    expect(withoutHint).not.toHaveAttribute("aria-describedby");
  });

  it("marks the fee line amber and no other line", () => {
    const { container } = renderSample();
    expect(container.querySelectorAll(".receipt-line.is-fee")).toHaveLength(1);
    expect(container.querySelector(".receipt-line.is-fee")!.textContent).toContain("Manager's fee");
  });

  it("marks the total distinctly from every ordinary line", () => {
    const { container } = renderSample();
    const totals = container.querySelectorAll(".receipt-total");
    expect(totals).toHaveLength(1);
    expect(totals[0]!.textContent).toContain("Ada receives");
    expect(container.querySelector(".receipt-total.is-fee")).toBeNull();
  });
});
