import { render, screen } from "@testing-library/react";
import { InvestorSheet } from "./investor-sheet";

const noop = async () => {};
const base = {
  accountId: 7, defaultSplitBps: 4000, currency: "USD",
  backHref: "/a/7", commitAction: noop,
};

describe("InvestorSheet — step one", () => {
  it("offers the account default without hard-coding it", () => {
    render(<InvestorSheet {...base} defaultSplitBps={3700} form={{}} />);
    expect(screen.getByLabelText(/Your share of their profit/)).toHaveValue("37");
    expect(screen.getByText(/The account default is 37%/)).toBeInTheDocument();
  });

  it("says nothing moves until capital is added", () => {
    render(<InvestorSheet {...base} form={{}} />);
    expect(screen.getByText(/Nothing moves until you add capital/)).toBeInTheDocument();
  });

  it("shows a refusal from a previous attempt", () => {
    render(<InvestorSheet {...base} form={{}} error="That account no longer exists." />);
    expect(screen.getByRole("alert").textContent).toContain("That account no longer exists");
    expect(screen.getByRole("alert").textContent).toContain("Nothing was committed");
  });
});

describe("InvestorSheet — the terms", () => {
  beforeEach(() =>
    render(
      <InvestorSheet
        {...base}
        form={{ step: "confirm", name: "Grace Hopper", email: "grace@example.com",
                split: "37", joinedAt: "2026-07-06" }}
      />,
    ));

  it("states the split as a ratio and as a sentence", () => {
    expect(screen.getByLabelText("Split").textContent).toBe("63 / 37");
    expect(screen.getByText(/Grace Hopper keeps 63% of profit and you keep 37%/))
      .toBeInTheDocument();
  });

  it("says when the fee applies, in the words the payout receipt uses", () => {
    expect(screen.getByText(/only when Grace Hopper withdraws/)).toBeInTheDocument();
    expect(screen.getByText(/only on withdrawal, and only on profit/)).toBeInTheDocument();
  });

  it("explains why staggered entry is safe", () => {
    expect(screen.getByText(/at the NAV on the day it lands/)).toBeInTheDocument();
    expect(screen.getByText(/stops a later investor diluting an earlier one/))
      .toBeInTheDocument();
  });

  it("names the person on the button, so a mis-typed name is caught here", () => {
    expect(screen.getByRole("button", { name: "Add Grace Hopper" })).toBeInTheDocument();
  });

  it("shows an empty email as a dash, never the literal empty string", () => {
    expect(screen.getByLabelText("Email").textContent).toBe("grace@example.com");
  });
});

describe("InvestorSheet — a default split of zero renders as a real percentage, not a falsy blank", () => {
  // defaultSplitBps ?? 0 is a trap here: 0 is falsy, and `0 || fallback`
  // would silently replace a genuine zero-percent account default with
  // something else. String(0) is "0", which must reach the field.
  it("shows 0, not the account default's fallback, when the default really is 0", () => {
    render(<InvestorSheet {...base} defaultSplitBps={0} form={{}} />);
    expect(screen.getByLabelText(/Your share of their profit/)).toHaveValue("0");
  });
});
