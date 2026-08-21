/**
 * ResolvedAccount is a superset of MastheadAccount (drops managerUserId,
 * brokerOffsetHours, broker, defaultSplitBps, inceptionDate — none of which
 * the masthead renders), so it satisfies AccountSwitcher/Masthead's props
 * structurally with no cast. Same pattern account-list.test.tsx uses against
 * AccountListItem. This file is exempt from ui/purity.test.ts's scan (it
 * ignores *.test.tsx), so importing ResolvedAccount here is fine even though
 * masthead.tsx itself may not.
 */
import { render, screen, within } from "@testing-library/react";
import type { ResolvedAccount } from "@/lib/compound/load/account";
import { AccountSwitcher, Masthead } from "./masthead";

const A: ResolvedAccount = {
  id: 7, mt5Account: 90_000_001, label: "Pooled — live", broker: "Fictional Markets",
  currency: "USD", defaultSplitBps: 4000, inceptionDate: "2026-03-02",
  managerUserId: "u1", brokerOffsetHours: 3,
};
const B: ResolvedAccount = { ...A, id: 8, mt5Account: 90_000_002, label: "Pooled — second", currency: "EUR" };

describe("AccountSwitcher — one account", () => {
  it("shows the account without offering a menu there is nothing in", () => {
    render(<AccountSwitcher current={A} accounts={[A]} />);
    expect(screen.getByText("Pooled — live")).toBeInTheDocument();
    expect(screen.queryByRole("group")).toBeNull();          // <details> has role group
  });
});

describe("AccountSwitcher — several accounts", () => {
  beforeEach(() => render(<AccountSwitcher current={A} accounts={[A, B]} />));

  it("names the current account in the control's accessible name", () => {
    expect(screen.getByLabelText("Account: Pooled — live. Switch account."))
      .toBeInTheDocument();
  });

  it("lists every account, current one included, and marks the current one", () => {
    const menu = screen.getByRole("group");
    expect(within(menu).getByRole("link", { name: /Pooled — live/ }))
      .toHaveAttribute("aria-current", "true");
    expect(within(menu).getByRole("link", { name: /Pooled — second/ }))
      .not.toHaveAttribute("aria-current");
  });

  it("links each entry to its desk", () => {
    expect(screen.getByRole("link", { name: /Pooled — second/ }))
      .toHaveAttribute("href", "/a/8");
  });

  it("offers a way to add another", () => {
    expect(screen.getByRole("link", { name: "+ Add an account" }))
      .toHaveAttribute("href", "/accounts/new");
  });

  it("masks the MT5 number in the strip that appears in every screenshot", () => {
    expect(screen.queryByText(/90000001/)).toBeNull();
    expect(screen.getAllByText(/••••0001/).length).toBeGreaterThan(0);
  });

  it("names a non-default currency in the summary", () => {
    render(<AccountSwitcher current={B} accounts={[A, B]} />);
    expect(screen.getByLabelText(/Account: Pooled — second/).textContent).toContain("EUR");
  });
});

describe("Masthead", () => {
  it("puts the brand mark in the display face and links it home", () => {
    const { container } = render(<Masthead current={A} accounts={[A]} />);
    expect(screen.getByText("Compound").closest("a")).toHaveAttribute("href", "/");
    expect(container.querySelector(".mark")?.textContent).toBe("Compound");
  });
});
