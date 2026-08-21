import { render, screen, within } from "@testing-library/react";
import { UNIT_SCALE } from "@/lib/compound/engine/money";
import { fold, totalsOf, type PoolState } from "@/lib/compound/engine/replay";
import { ledgerSteps } from "@/lib/compound/present/derive";
import { holderPosition, holderStatement } from "@/lib/compound/present/holder";
import { ADA_ID, LEDGER, LEDGER_UNDERWATER, SEEDS } from "@/lib/compound/present/fixture";
import { HolderStatement, type HolderIdentity } from "./holder-statement";

const ADA: HolderIdentity = {
  id: ADA_ID, accountId: 7, name: "Ada Lovelace", email: "ada@example.com",
  userId: null, isManager: false, splitBps: 4000, joinedAt: "2026-05-04", status: "active",
};

function renderFor(ledger = LEDGER, holder: HolderIdentity = ADA) {
  const state = fold(ledger, SEEDS);
  return render(
    <HolderStatement
      holder={holder}
      position={holderPosition(state, holder.id)}
      rows={holderStatement(ledgerSteps(ledger, SEEDS), holder.id)}
      totals={totalsOf(state)}
      currency="USD"
    />,
  );
}

describe("HolderStatement — the position", () => {
  beforeEach(() => renderFor());

  it("reads back every headline figure", () => {
    expect(screen.getByLabelText("Units held").textContent).toBe("9,113.7132");
    expect(screen.getByLabelText("Share of the pool").textContent).toBe("22.66%");
    expect(screen.getByLabelText("What Ada Lovelace has put in").textContent).toBe("$10,000.00");
    expect(screen.getByLabelText("Value on this statement").textContent).toBe("$12,630.61");
    expect(screen.getByLabelText("Profit").textContent).toBe("+$2,630.60");
  });

  it("states both values and where the cent goes, before anyone has to ask", () => {
    const note = screen.getByText(/This statement values the holding at/);
    expect(note.textContent).toContain("$12,630.61");
    expect(note.textContent).toContain("$12,630.60");
    expect(note.textContent).toContain("so the pool is never short");
  });

  it("states the terms in a sentence, using Ada's own split", () => {
    expect(screen.getByText(/Ada Lovelace keeps 60% of profit and you keep 40%/))
      .toBeInTheDocument();
  });
});

describe("HolderStatement — the withdrawal preview, above the mark", () => {
  beforeEach(() => renderFor());

  it("shows the value it would settle at, not the statement value", () => {
    expect(screen.getByLabelText(/Value at today's NAV/).textContent).toBe("$12,630.60");
  });

  it("splits the profit and names the fee as the fee", () => {
    expect(screen.getByLabelText("Ada Lovelace's share of the profit (60%)").textContent)
      .toBe("$1,578.36");
    expect(screen.getByLabelText("Your fee (40%)").textContent).toBe("$1,052.24");
  });

  it("shows what a full exit would pay", () => {
    expect(screen.getByLabelText(/Exit in full — Ada Lovelace receives/).textContent)
      .toBe("$11,578.36");
  });

  it("puts the fee line in amber and nothing else", () => {
    expect(document.querySelectorAll(".receipt-line.is-fee")).toHaveLength(1);
  });

  it("adds up: the holder's share plus the fee is the profit", () => {
    const share = BigInt(screen.getByLabelText(/share of the profit/).textContent!.replace(/\D/g, ""));
    const fee = BigInt(screen.getByLabelText("Your fee (40%)").textContent!.replace(/\D/g, ""));
    const profit = BigInt(screen.getByLabelText("Profit above that").textContent!.replace(/\D/g, ""));
    expect(share + fee).toBe(profit);
  });
});

describe("HolderStatement — below the mark", () => {
  beforeEach(() => renderFor(LEDGER_UNDERWATER));

  it("says so, and states the recovery figure", () => {
    expect(screen.getByText("Below the high-water mark")).toBeInTheDocument();
    expect(screen.getByText(/\$1,364\.84 of recovery is needed/)).toBeInTheDocument();
  });

  it("keeps the exit available, with no fee, in the same block", () => {
    expect(screen.getByText(/still available, at today's value of \$8,635\.16, with no fee/))
      .toBeInTheDocument();
  });

  it("shows no fee line at all, rather than a fee of zero", () => {
    expect(screen.queryByLabelText(/Your fee/)).toBeNull();
  });

  it("shows profit negative with a sign", () => {
    expect(screen.getByLabelText("Profit").textContent).toBe("-$1,364.84");
  });
});

describe("HolderStatement — exactly at the mark", () => {
  // Deliberately tiny and deliberately awkward, matching present/holder.test.ts's
  // own atMark fixture: 700 cents across 3 units, one holder, so statement and
  // settlement value coincide exactly and profitCents is exactly zero.
  //
  // This case exists because quote().belowHighWaterMark is `profitCents <=
  // 0n` — true for a holder sitting exactly on the mark, not only a holder
  // below it. Rendering that boolean directly (rather than position.markState,
  // which the presenter corrects to a tri-state) would show "Below the
  // high-water mark, $0.00 of recovery is needed" for a holder who owes
  // nothing and has lost nothing — indistinguishable from a glitch. Probed
  // directly: this case is the ONLY one where markState and
  // belowHighWaterMark disagree, so it is also the only test in this file
  // that can catch a component reverted to read the engine's boolean instead
  // of the presenter's tri-state.
  const AT_MARK: PoolState = {
    equityCents: 700n,
    units: 3n * UNIT_SCALE,
    holders: [{
      holderId: 1, isManager: false, splitBps: 4000,
      units: 3n * UNIT_SCALE, basisCents: 700n, status: "active",
    }],
    lastReadingOn: "2026-08-14",
    seq: 1,
  };

  beforeEach(() => {
    render(
      <HolderStatement
        holder={{ ...ADA, id: 1, name: "At Mark Holder" }}
        position={holderPosition(AT_MARK, 1)}
        rows={[]}
        totals={totalsOf(AT_MARK)}
        currency="USD"
      />,
    );
  });

  it("says AT the mark, not below it", () => {
    expect(screen.getByText("Exactly at the high-water mark")).toBeInTheDocument();
    expect(screen.queryByText("Below the high-water mark")).toBeNull();
  });

  it("does not claim any recovery is needed", () => {
    expect(screen.queryByText(/of recovery is needed/)).toBeNull();
    expect(screen.getByText(/no profit to withdraw yet/)).toBeInTheDocument();
  });

  it("still offers a fee-free exit at today's value", () => {
    // 700 CENTS, not 700 dollars.
    expect(screen.getByText(/still available, at today's value of \$7\.00, with no fee/))
      .toBeInTheDocument();
  });
});

describe("HolderStatement — the history", () => {
  beforeEach(() => renderFor());

  it("starts at her deposit, marking the entries that are not hers", () => {
    const rows = screen.getAllByRole("row").filter((r) => within(r).queryAllByRole("cell").length > 0);
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.textContent?.includes("account-wide"))).toHaveLength(3);
  });

  it("shows nothing from before she held anything", () => {
    // The fixture has account activity predating Ada's 4 May deposit. Those
    // steps render as zero units, zero basis and zero value for her — rows
    // that say "nothing happened to you" and imply she was present for a
    // period she had no stake in. Her statement begins where she does.
    const rows = screen.getAllByRole("row").filter((r) => within(r).queryAllByRole("cell").length > 0);
    const first = rows[0]!;
    expect(first.textContent).toMatch(/4 May 2026/);
    expect(first.textContent).toMatch(/Deposit/);
    // And no row anywhere reports her holding nothing.
    for (const r of rows) {
      const cells = within(r).getAllByRole("cell").map((c) => c.textContent);
      expect(cells[2]).not.toBe("0.0000");   // units held after
    }
  });

  it("explains a value change she had no part in", () => {
    const revalue = screen.getAllByRole("row", { name: /Account revalued/ });
    expect(revalue.length).toBe(2);
    // 30 Jun 2026: her units do not move, her value does.
    const row = screen.getByRole("row", { name: /30 Jun 2026/ });
    const cells = within(row).getAllByRole("cell").map((c) => c.textContent);
    expect(cells[1]).toBe("—");                       // units in/out
    expect(cells[5]).toMatch(/^\+\$/);                // change is positive
  });

  it("leaves her untouched by Grace's deposit", () => {
    const row = screen.getByRole("row", { name: /6 Jul 2026/ });
    const cells = within(row).getAllByRole("cell").map((c) => c.textContent);
    expect(cells[1]).toBe("—");   // units in/out
    expect(cells[5]).toBe("—");   // change
  });

  it("ends on the value the position block shows", () => {
    const row = screen.getByRole("row", { name: /14 Aug 2026/ });
    expect(within(row).getAllByRole("cell")[4]!.textContent).toBe("$12,630.61");
  });
});

describe("HolderStatement — the manager", () => {
  it("says no fee is charged on their own holding, and shows none", () => {
    renderFor(LEDGER, {
      ...ADA, id: 1, name: "J. Marsh", isManager: true, splitBps: 0, joinedAt: "2026-03-02",
    });
    expect(screen.getByText(/No fee is charged on your own holding/)).toBeInTheDocument();
    expect(screen.getByLabelText("Your fee (0%)").textContent).toBe("$0.00");
  });
});

describe("HolderStatement — closed vs merely never funded (decision D-M)", () => {
  // Two holders share zero units for opposite reasons: #2 exited in full
  // (fold set status "closed"); #3 was seeded but has never deposited (fold
  // leaves status "active"). Both are zero-unit; only one should read
  // "Closed". The HolderIdentity prop's own `status` is set to the OPPOSITE
  // of what fold derived for each, on purpose — if the component ever reads
  // holder.status instead of position.holder.status, one of these two
  // assertions flips and catches it.
  const MIXED: PoolState = {
    equityCents: 1000n,
    units: 1n * UNIT_SCALE,
    holders: [
      { holderId: 1, isManager: true, splitBps: 0, units: 1n * UNIT_SCALE, basisCents: 1000n, status: "active" },
      { holderId: 2, isManager: false, splitBps: 4000, units: 0n, basisCents: 0n, status: "closed" },
      { holderId: 3, isManager: false, splitBps: 4000, units: 0n, basisCents: 0n, status: "active" },
    ],
    lastReadingOn: "2026-08-14",
    seq: 5,
  };

  it("tags a holder fold() closed, even though the identity row claims active", () => {
    render(
      <HolderStatement
        holder={{ ...ADA, id: 2, name: "Exited Holder", status: "active" }}
        position={holderPosition(MIXED, 2)}
        rows={[]}
        totals={totalsOf(MIXED)}
        currency="USD"
      />,
    );
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("does not tag a never-funded holder, even though the identity row claims closed", () => {
    render(
      <HolderStatement
        holder={{ ...ADA, id: 3, name: "Not Yet Funded", status: "closed" }}
        position={holderPosition(MIXED, 3)}
        rows={[]}
        totals={totalsOf(MIXED)}
        currency="USD"
      />,
    );
    expect(screen.queryByText("Closed")).toBeNull();
  });
});

describe("HolderStatement — Phase A", () => {
  it("previews a withdrawal without offering to make one", () => {
    renderFor();
    expect(screen.queryByRole("link", { name: /Pay out/ })).toBeNull();
  });
});

describe("HolderStatement — editing", () => {
  it("offers no way to edit when the page does not pass one", () => {
    renderFor();
    expect(screen.queryByRole("link", { name: /Edit/ })).toBeNull();
  });

  it("renders whatever edit control the page hands it", () => {
    const state = fold(LEDGER, SEEDS);
    render(
      <HolderStatement
        holder={ADA}
        position={holderPosition(state, ADA.id)}
        rows={holderStatement(ledgerSteps(LEDGER, SEEDS), ADA.id)}
        totals={totalsOf(state)}
        currency="USD"
        editAction={<a className="btn" href="/a/7/holders/2/edit">Edit</a>}
      />,
    );
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href", "/a/7/holders/2/edit",
    );
  });
});
