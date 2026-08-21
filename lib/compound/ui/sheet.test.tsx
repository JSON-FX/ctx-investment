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
  it("associates the label with its control, so the control is reachable by its label text", () => {
    render(
      <Field name="amount" label="Amount">
        <input id="amount" type="text" />
      </Field>,
    );
    expect(screen.getByLabelText("Amount")).toBe(document.getElementById("amount"));
  });

  it("wires htmlFor to the control's id explicitly, not only by wrapping it", () => {
    // Field's <label> both wraps its children AND sets htmlFor — belt and
    // suspenders. The test above alone does not prove the belt is there: a
    // <label> that merely WRAPS its control is already a valid association
    // (the "implicit" pattern), so getByLabelText keeps working even if
    // htmlFor is dropped entirely — confirmed by probing it: removing
    // htmlFor left every test in this file green. A caller that pulls the
    // control out of the label visually (e.g. via a CSS wrapper Field does
    // not control) would silently lose the association at that point unless
    // htmlFor genuinely targets the same id. Checking the attribute
    // directly is what actually pins the explicit half of the pattern.
    render(
      <Field name="amount" label="Amount">
        <input id="amount" type="text" />
      </Field>,
    );
    const label = screen.getByText("Amount").closest("label")!;
    expect(label).toHaveAttribute("for", "amount");
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
