/**
 * This is the shape every component test in this plan follows: a known
 * PoolState in, figures out, located the way a reader locates them.
 */
import { render, screen, within } from "@testing-library/react";
import { fold } from "@/lib/compound/engine/replay";
import { deskFigures } from "@/lib/compound/present/derive";
import {
  ADA_ID, HOLDER_NAMES, LEDGER, LEDGER_UNDERWATER, SEEDS,
} from "@/lib/compound/present/fixture";
import { HolderTable } from "./holder-table";

const FIGURES = deskFigures(fold(LEDGER, SEEDS), HOLDER_NAMES);

function cells(holderName: string): string[] {
  const row = screen.getByRole("row", { name: new RegExp(holderName) });
  return [
    ...within(row).getAllByRole("rowheader"),
    ...within(row).getAllByRole("cell"),
  ].map((c) => c.textContent ?? "");
}

beforeEach(() => {
  render(<HolderTable accountId={7} figures={FIGURES} currency="USD" />);
});

describe("HolderTable — the figures", () => {
  it("renders Ada's row exactly", () => {
    expect(cells("Ada Lovelace")).toEqual([
      "Ada Lovelace",
      "$10,000.00",
      "9,113.7132",
      "22.66%",
      "$12,630.61",
      "+$2,630.61",
      "60 / 40",
      "$1,052.24",
      "Pay out",
    ]);
  });

  it("renders Grace's row with her own 63 / 37 split and the fee it produces", () => {
    // Grace is 3700 bps. At the 4000 default her fee would read $386.41.
    const c = cells("Grace Hopper");
    expect(c[6]).toBe("63 / 37");
    expect(c[7]).toBe("$357.43");
  });

  it("shows the manager no split and no fee", () => {
    const c = cells("J. Marsh");
    expect(c[6]).toBe("—");
    expect(c[7]).toBe("—");
  });

  it("totals investors, excluding the manager", () => {
    const foot = screen.getByRole("row", { name: /Investors, active/ });
    const c = [
      ...within(foot).getAllByRole("rowheader"),
      ...within(foot).getAllByRole("cell"),
    ].map((x) => x.textContent ?? "");
    expect(c[1]).toBe("$17,500.00");   // capital in
    expect(c[4]).toBe("$21,096.65");   // value now
    expect(c[5]).toBe("+$3,596.65");   // P/L
    expect(c[7]).toBe("$1,409.67");    // fee if all paid out
  });

  it("sums the value column to account equity, to the cent", () => {
    const values = ["J. Marsh", "Ada Lovelace", "Grace Hopper"]
      .map((n) => cells(n)[4]!)
      .map((s) => BigInt(s.replace(/[^0-9]/g, "")));
    expect(values.reduce((a, b) => a + b, 0n)).toBe(5_574_391n);
  });

  it("sums the share column to 100.00 percent", () => {
    const shares = ["J. Marsh", "Ada Lovelace", "Grace Hopper"]
      .map((n) => Number(cells(n)[3]!.replace("%", "")));
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 2);
  });

  it("marks the manager's row and only the manager's row", () => {
    expect(within(screen.getByRole("row", { name: /J. Marsh/ })).getByText("Manager"))
      .toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Ada Lovelace/ })).queryByText("Manager"))
      .toBeNull();
  });

  it("links each holder to their statement and offers a payout", () => {
    const row = screen.getByRole("row", { name: /Ada Lovelace/ });
    expect(within(row).getByRole("link", { name: "Ada Lovelace" }))
      .toHaveAttribute("href", `/a/7/holders/${ADA_ID}`);
    expect(within(row).getByRole("link", { name: "Pay out" }))
      .toHaveAttribute("href", `/a/7/actions/payout/${ADA_ID}`);
  });

  it("gives every column a header, so a figure is never orphaned", () => {
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Holder", "Capital in", "Units", "Share", "Value now",
      "P/L", "Split", "Fee if paid out", " ",
    ]);
  });
});

describe("HolderTable — a pool under water", () => {
  it("shows every P/L negative and every fee as a dash", () => {
    // Reuses the canonical fixture's own underwater ledger rather than a
    // second, hand-built one, per the fixture's own reason for existing:
    // a round underwater figure would let a floored-vs-allocated bug hide.
    const under = deskFigures(fold(LEDGER_UNDERWATER, SEEDS), HOLDER_NAMES);
    render(<HolderTable accountId={7} figures={under} currency="USD" />);
    const rows = screen.getAllByRole("row", { name: /Hopper/ });
    const c = [
      ...within(rows[rows.length - 1]!).getAllByRole("rowheader"),
      ...within(rows[rows.length - 1]!).getAllByRole("cell"),
    ].map((x) => x.textContent ?? "");
    expect(c[5]).toBe("-$1,712.02");
    expect(c[7]).toBe("—");
  });
});

describe("HolderTable — currency", () => {
  it("uses the account's symbol, not a hard-coded dollar", () => {
    render(<HolderTable accountId={7} figures={FIGURES} currency="EUR" />);
    expect(screen.getAllByRole("row", { name: /Ada Lovelace/ }).at(-1)!.textContent)
      .toContain("€12,630.61");
  });
});
