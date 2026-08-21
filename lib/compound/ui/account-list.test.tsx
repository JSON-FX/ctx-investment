import { render, screen, within } from "@testing-library/react";
import type { ResolvedAccount } from "@/lib/compound/load/account";
import { AccountList, maskMt5 } from "./account-list";

const ACCOUNTS: ResolvedAccount[] = [
  {
    id: 7, mt5Account: 90_000_001, label: "Pooled — live", broker: "Fictional Markets",
    currency: "USD", defaultSplitBps: 4000, inceptionDate: "2026-03-02",
    managerUserId: "00000000-0000-0000-0000-000000000001", brokerOffsetHours: 3,
  },
  {
    id: 8, mt5Account: 90_000_002, label: "Pooled — second", broker: null,
    currency: "EUR", defaultSplitBps: 3700, inceptionDate: "2026-06-01",
    managerUserId: "00000000-0000-0000-0000-000000000001", brokerOffsetHours: null,
  },
];

describe("maskMt5", () => {
  it("shows only the last four digits", () => {
    expect(maskMt5(90_000_001)).toBe("••••0001");
  });

  it("leaves a short number alone rather than masking it to nothing", () => {
    expect(maskMt5(42)).toBe("42");
  });
});

describe("AccountList", () => {
  beforeEach(() => render(<AccountList accounts={ACCOUNTS} />));

  it("links each account to its desk", () => {
    expect(screen.getByRole("link", { name: "Pooled — live" })).toHaveAttribute("href", "/a/7");
    expect(screen.getByRole("link", { name: "Pooled — second" })).toHaveAttribute("href", "/a/8");
  });

  it("never renders a full MT5 account number", () => {
    expect(screen.queryByText(/90000001/)).toBeNull();
    expect(screen.getByText("••••0001")).toBeInTheDocument();
  });

  it("shows each account's own default split", () => {
    const row = screen.getByRole("row", { name: /Pooled — second/ });
    expect(within(row).getByText("63 / 37")).toBeInTheDocument();
  });

  it("flags an account whose broker offset is not configured", () => {
    expect(within(screen.getByRole("row", { name: /Pooled — second/ }))
      .getByText("Broker offset not set")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Pooled — live/ }))
      .queryByText("Broker offset not set")).toBeNull();
  });

  it("shows a configured offset with its sign", () => {
    expect(within(screen.getByRole("row", { name: /Pooled — live/ }))
      .getByText("±3h")).toBeInTheDocument();
  });

  it("renders a dash where a broker is unknown, not the word null", () => {
    const row = screen.getByRole("row", { name: /Pooled — second/ });
    expect(within(row).getByText("—")).toBeInTheDocument();
    expect(row.textContent).not.toContain("null");
  });
});

describe("AccountList — empty", () => {
  it("offers the way out instead of an empty table", () => {
    render(<AccountList accounts={[]} />);
    expect(screen.getByText("No accounts yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add an account" }))
      .toHaveAttribute("href", "/accounts/new");
    expect(screen.queryByRole("table")).toBeNull();
  });
});
