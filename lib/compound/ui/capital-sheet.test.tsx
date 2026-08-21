import { render, screen, within } from "@testing-library/react";
import type { HolderRow } from "@/lib/compound/db/holders";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { previewEntry } from "@/lib/compound/present/derive";
import { ADA_ID, GRACE_ID, LEDGER, MANAGER_ID, SEEDS } from "@/lib/compound/present/fixture";
import { CapitalSheet } from "./capital-sheet";

const HOLDERS: HolderRow[] = [
  { id: MANAGER_ID, accountId: 7, name: "J. Marsh", email: null, userId: null,
    isManager: true, splitBps: 0, joinedAt: "2026-03-02", status: "active" },
  { id: ADA_ID, accountId: 7, name: "Ada Lovelace", email: null, userId: null,
    isManager: false, splitBps: 4000, joinedAt: "2026-05-04", status: "active" },
  { id: GRACE_ID, accountId: 7, name: "Grace Hopper", email: null, userId: null,
    isManager: false, splitBps: 3700, joinedAt: "2026-07-06", status: "active" },
];

const PREVIEW = previewEntry({
  accountId: 7, entries: LEDGER, seeds: SEEDS,
  proposed: {
    holderId: ADA_ID, occurredOn: "2026-08-18", type: "deposit",
    amountCents: centsFromDecimal("4250.00"), feeSettlement: null, splitBpsApplied: null,
  },
});

const noop = async () => {};

function renderSheet(over: Partial<Parameters<typeof CapitalSheet>[0]> = {}) {
  return render(
    <CapitalSheet
      accountId={7}
      holders={HOLDERS}
      currency="USD"
      preview={over.preview === undefined ? PREVIEW : over.preview}
      form={over.form ?? { holderId: String(ADA_ID), amount: "4250.00", occurredOn: "2026-08-18" }}
      error={over.error}
      backHref="/a/7"
      commitAction={noop}
      blocked={over.blocked}
    />,
  );
}

describe("CapitalSheet — the receipt", () => {
  beforeEach(() => renderSheet());

  it("shows the amount and the NAV it buys at", () => {
    expect(screen.getByLabelText("Amount").textContent).toBe("$4,250.00");
    expect(screen.getByLabelText("NAV units are issued at").textContent).toBe("1.3858");
  });

  it("shows units issued to ten places, floored", () => {
    // 4250.00 at NAV 1.3858... is 3066.6207821498... Ceiling it would end
    // 1499 and would lower NAV for everyone else.
    expect(screen.getByLabelText("Units issued").textContent).toBe("3,066.6207821498");
  });

  it("shows units in issue before and after, differing by exactly what was issued", () => {
    expect(screen.getByLabelText("Units in issue").textContent)
      .toBe("40,222.4547 → 43,289.0755");
  });

  it("shows NAV unchanged, and says why that is the point", () => {
    expect(screen.getByLabelText("NAV per unit").textContent).toBe("1.3858 → 1.3858");
    expect(screen.getByText(/issues units at the prevailing NAV/)).toBeInTheDocument();
  });

  it("shows the resulting equity", () => {
    expect(screen.getByLabelText("Account equity after").textContent).toBe("$59,993.91");
  });
});

describe("CapitalSheet — what it does to everyone", () => {
  beforeEach(() => renderSheet());

  function row(name: string): string[] {
    const r = screen.getByRole("row", { name: new RegExp(name) });
    return [...within(r).getAllByRole("rowheader"), ...within(r).getAllByRole("cell")]
      .map((c) => c.textContent ?? "");
  }

  it("dilutes every existing holder's share", () => {
    expect(row("J. Marsh").slice(1, 3)).toEqual(["62.15%", "57.75%"]);
    expect(row("Grace Hopper").slice(1, 3)).toEqual(["15.19%", "14.11%"]);
  });

  it("leaves every existing holder's value exactly where it was", () => {
    expect(row("J. Marsh").slice(3, 5)).toEqual(["$34,647.26", "$34,647.26"]);
    expect(row("Grace Hopper").slice(3, 5)).toEqual(["$8,466.04", "$8,466.04"]);
  });

  it("raises the depositor's share and their value by the amount deposited", () => {
    expect(row("Ada Lovelace").slice(1, 3)).toEqual(["22.66%", "28.14%"]);
    expect(row("Ada Lovelace").slice(3, 5)).toEqual(["$12,630.61", "$16,880.61"]);
  });

  it("keeps both share columns summing to a full pool", () => {
    for (const col of [1, 2]) {
      const total = ["J. Marsh", "Ada Lovelace", "Grace Hopper"]
        .map((n) => Number(row(n)[col]!.replace("%", "")))
        .reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(100, 1);
    }
  });

  it("says in words what the two columns show", () => {
    expect(screen.getByText(/share falls and their value does not move/)).toBeInTheDocument();
    expect(screen.getByText(/upward, never down/)).toBeInTheDocument();
  });
});

describe("CapitalSheet — the interlock", () => {
  it("refuses while a capital event is unclassified, and explains the NAV problem", () => {
    renderSheet({ preview: null, blocked: { candidateDate: "2026-08-12", reviewHref: "/a/7/review" } });
    expect(screen.getByText(/unexplained balance move on 12 Aug 2026/)).toBeInTheDocument();
    expect(screen.getByText(/units issued at the wrong NAV cannot be corrected/))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Record this deposit/ })).toBeNull();
  });
});

describe("CapitalSheet — a first deposit for a brand-new investor", () => {
  it("issues them units and leaves everyone else's value alone", () => {
    const seeds = [...SEEDS, { holderId: 4, isManager: false, splitBps: 4000 }];
    const preview = previewEntry({
      accountId: 7, entries: LEDGER, seeds,
      proposed: {
        holderId: 4, occurredOn: "2026-08-18", type: "deposit",
        amountCents: centsFromDecimal("6000.00"), feeSettlement: null, splitBpsApplied: null,
      },
    });
    render(
      <CapitalSheet
        accountId={7}
        holders={[...HOLDERS, { ...HOLDERS[1]!, id: 4, name: "Katherine Johnson" }]}
        currency="USD" preview={preview}
        form={{ holderId: "4", amount: "6000.00", occurredOn: "2026-08-18" }}
        backHref="/a/7" commitAction={noop}
      />,
    );
    expect(screen.getByLabelText("Units issued").textContent).toBe("4,329.3469865645");
    expect(screen.getByLabelText("NAV per unit").textContent).toBe("1.3858 → 1.3858");
    const r = screen.getByRole("row", { name: /Katherine Johnson/ });
    const cells = [...within(r).getAllByRole("cell")].map((c) => c.textContent);
    expect(cells[0]).toBe("0.00%");
    expect(cells[1]).toBe("9.72%");
    expect(cells[2]).toBe("$0.00");
    expect(cells[3]).toBe("$6,000.00");
  });
});

describe("CapitalSheet — the NAV-neutrality probe", () => {
  // This task's own report requires proof, not assertion: NAV before and
  // after a deposit is EXACTLY unchanged, not merely close. navTimes1e4 is
  // an exact integer (x10^4, truncated once — see nav.ts) — comparing the
  // two integers is the exact comparison, with no tolerance smuggled in by
  // formatting two numbers to the same displayed string.
  it("computes the identical navTimes1e4 before and after, as bigints, not just the same 4dp string", () => {
    expect(PREVIEW.navAfterX1e4).toBe(PREVIEW.navBeforeX1e4);
    expect(PREVIEW.navResidualX1e4).toBe(0n);
  });
});
