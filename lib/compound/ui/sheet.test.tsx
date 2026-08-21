/**
 * sheet.tsx is the frame every money flow (Tasks 11-14) renders inside, but
 * Task 4 builds only the frame. Nothing else in this plan renders a Sheet or
 * a Field, so this file is the only place that proves the frame itself is
 * sound before a later task starts trusting it: the back link is a real,
 * followable link rather than a styled span, and Field's label is genuinely
 * associated with its control — not just visually adjacent to it — which is
 * exactly the distinction a screen reader cannot see past.
 */
import { render, screen } from "@testing-library/react";
import { Field, FieldError, Sheet, SheetActions } from "./sheet";

describe("Sheet", () => {
  it("renders the title as the sheet's heading", () => {
    render(<Sheet title="Post an equity reading" backHref="/a/7">content</Sheet>);
    expect(screen.getByRole("heading", { name: "Post an equity reading" })).toBeInTheDocument();
  });

  it("shows the lede only when one is given", () => {
    const { rerender } = render(<Sheet title="Add capital" backHref="/a/7">content</Sheet>);
    expect(screen.queryByText(/high-water mark/)).toBeNull();

    rerender(
      <Sheet title="Add capital" backHref="/a/7" lede="Resets nobody's high-water mark.">
        content
      </Sheet>,
    );
    expect(screen.getByText("Resets nobody's high-water mark.")).toBeInTheDocument();
  });

  it("links back to a real href, defaulting the label to Cancel", () => {
    render(<Sheet title="Pay out" backHref="/a/7/holders/2">content</Sheet>);
    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/a/7/holders/2");
  });

  it("honours a caller-supplied back label", () => {
    render(
      <Sheet title="Classify" backHref="/a/7/review" backLabel="Back to queue">
        content
      </Sheet>,
    );
    expect(screen.getByRole("link", { name: "Back to queue" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Cancel" })).toBeNull();
  });

  it("renders its children between the lede and the back link", () => {
    render(
      <Sheet title="Add investor" backHref="/a/7">
        <p>the form goes here</p>
      </Sheet>,
    );
    expect(screen.getByText("the form goes here")).toBeInTheDocument();
  });
});

describe("SheetActions", () => {
  it("renders the actions it is given", () => {
    render(
      <SheetActions>
        <button type="submit">Confirm</button>
      </SheetActions>,
    );
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
  });
});

describe("Field", () => {
  it("associates the label with its control by htmlFor/id, not just by adjacency", () => {
    render(
      <Field name="amount" label="Amount">
        <input id="amount" type="text" />
      </Field>,
    );
    // getByLabelText resolves the real label-for-control association. If
    // Field only positioned the label near the input without wiring
    // htmlFor/id, this lookup fails even though the text is visibly next to
    // the field — the exact gap between "looks right" and "is right".
    expect(screen.getByLabelText("Amount")).toBe(document.getElementById("amount"));
  });

  it("shows its hint when one is given", () => {
    render(
      <Field name="amount" label="Amount" hint="In whole dollars.">
        <input id="amount" type="text" />
      </Field>,
    );
    expect(screen.getByText("In whole dollars.")).toBeInTheDocument();
  });
});

describe("FieldError", () => {
  it("announces itself as an alert and leads with 'Nothing was committed'", () => {
    render(<FieldError>The amount must be positive.</FieldError>);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Nothing was committed. The amount must be positive.");
  });
});
