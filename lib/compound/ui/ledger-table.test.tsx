/**
 * Direct coverage: LedgerTable rendered with real engine types, no mocks.
 *
 * The reversal fixture below was checked against a real run of ledgerSteps
 * before being written down (see the module doc on ledger-table.tsx and this
 * task's report). ledgerSteps folds the PREFIX up to each row's own seq, so a
 * row before the reversal's own seq is not retroactively rewritten — it folds
 * exactly as it would have without the reversal existing at all, because the
 * reversal has not "happened yet" at that point in the prefix. Only the
 * reversal's own row, and anything after it, reflects the correction. A
 * dry-run draft of this test asserted the ORIGINAL entry's row (seq 5) shows
 * equity as though the deposit never applied ($41,883.07) — that does not
 * reproduce: fold() only skips a voided id when the entry that reverses it is
 * actually present in the slice being folded, and at seq 5 it is not yet.
 * The real value, read off a real render, is $49,383.07 — identical to the
 * un-reversed canonical fixture's own seq-5 line, which is the correct
 * behaviour for an append-only ledger: an earlier row is never rewritten by a
 * later correction, only annotated.
 */
import { render, screen, within } from "@testing-library/react";
import type { LedgerEntry } from "@/lib/compound/engine/replay";
import { ledgerSteps } from "@/lib/compound/present/derive";
import { ADA_ID, GRACE_ID, HOLDER_NAMES, LEDGER, SEEDS } from "@/lib/compound/present/fixture";
import { LedgerTable, type LedgerRowMeta } from "./ledger-table";

const META = new Map<number, LedgerRowMeta>(
  LEDGER.map((e) => [e.id, {
    id: e.id,
    recordedAt: `2026-08-19T1${e.seq}:05:00.000Z`,
    note: null,
    createdBy: "00000000-0000-0000-0000-000000000001",
  }]),
);

function cellsOf(seq: string): string[] {
  const row = screen.getByRole("row", { name: new RegExp(`^${seq}\\s`) });
  return [
    ...within(row).getAllByRole("rowheader"),
    ...within(row).getAllByRole("cell"),
  ].map((c) => c.textContent ?? "");
}

function renderLedger(entries: readonly LedgerEntry[] = LEDGER, meta = META) {
  return render(
    <LedgerTable
      accountId={7}
      steps={ledgerSteps(entries, SEEDS)}
      meta={meta}
      names={HOLDER_NAMES}
      currency="USD"
    />,
  );
}

describe("LedgerTable — page identity", () => {
  it("announces itself as a level-1 heading named 'Ledger'", () => {
    renderLedger();
    expect(screen.getByRole("heading", { level: 1, name: "Ledger" })).toBeInTheDocument();
  });

  it("still announces itself with no entries posted yet", () => {
    // The empty-state branch is a separate return (steps.length === 0), not
    // a fallthrough of the populated one above.
    render(
      <LedgerTable accountId={7} steps={[]} meta={new Map()} names={{}} currency="USD" />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Ledger" })).toBeInTheDocument();
  });
});

describe("LedgerTable — the running state", () => {
  beforeEach(() => renderLedger());

  it("renders the genesis deposit at NAV 1.0000", () => {
    expect(cellsOf("1")).toEqual([
      "1", "2 Mar 2026", "Deposit", "J. Marsh",
      "+$25,000.00", "+25,000.0000",
      "$25,000.00", "25,000.0000", "1.0000",
      "19 Aug 2026, 11:05 UTC",
    ]);
  });

  it("shows a reading moving equity and NAV without moving cash or units", () => {
    const c = cellsOf("2");
    expect(c[2]).toBe("Equity reading");
    expect(c[4]).toBe("—");          // cash: a reading restates, it does not move
    expect(c[5]).toBe("—");          // units
    expect(c[6]).toBe("$27,431.19");
    expect(c[8]).toBe("1.0972");
  });

  it("issues Ada units at the prevailing NAV, leaving NAV alone", () => {
    const c = cellsOf("3");
    expect(c[3]).toBe("Ada Lovelace");
    expect(c[4]).toBe("+$10,000.00");
    expect(c[5]).toBe("+9,113.7132");
    expect(c[8]).toBe("1.0972");     // unchanged from seq 2
  });

  it("ends on the state the desk shows", () => {
    const c = cellsOf("6");
    expect(c[6]).toBe("$55,743.91");
    expect(c[7]).toBe("40,222.4547");
    expect(c[8]).toBe("1.3858");
  });

  it("shows the recorded-at stamp in UTC, distinct from the occurred date", () => {
    const c = cellsOf("1");
    expect(c[1]).toBe("2 Mar 2026");                   // broker-server date
    expect(c[9]).toBe("19 Aug 2026, 11:05 UTC");       // when it was written down
  });
});

describe("LedgerTable — a payout", () => {
  const payout: LedgerEntry = {
    id: 7, seq: 7, holderId: ADA_ID, occurredOn: "2026-08-18", type: "payout",
    amountCents: 263_060n, feeSettlement: "units", splitBpsApplied: 4000, reversesId: null,
  };

  it("shows the cash that LEFT, not the amount that was requested", () => {
    // The entry says 2630.60. 1578.36 left; the fee stayed in as units.
    renderLedger([...LEDGER, payout]);
    const c = cellsOf("7");
    expect(c[4]).toBe("-$1,578.36");
    expect(c[4]).not.toBe("-$2,630.60");
  });

  it("nets the unit movement across the redemption and the fee units", () => {
    renderLedger([...LEDGER, payout]);
    // Ada surrenders 1,898.1300; the manager is issued 759.2520. Net -1,138.8780.
    expect(cellsOf("7")[5]).toBe("-1,138.8780");
  });

  it("says how the fee settled", () => {
    renderLedger([...LEDGER, payout]);
    expect(cellsOf("7")[2]).toContain("fee as units");
  });

  it("leaves NAV where it was", () => {
    renderLedger([...LEDGER, payout]);
    expect(cellsOf("7")[8]).toBe("1.3858");
  });
});

describe("LedgerTable — a reversal", () => {
  const reversal: LedgerEntry = {
    id: 7, seq: 7, holderId: GRACE_ID, occurredOn: "2026-08-20", type: "deposit",
    amountCents: -750_000n, feeSettlement: null, splitBpsApplied: null, reversesId: 5,
  };

  it("strikes both entries, names which one voided which, and names what the reversal reverses", () => {
    renderLedger([...LEDGER, reversal]);
    expect(cellsOf("5")[2]).toContain("voided by #7");
    expect(cellsOf("7")[2]).toContain("voided");
    expect(cellsOf("7")[2]).toContain("reverses #5");
    expect(screen.getByRole("row", { name: /^5\s/ })).toHaveClass("voided");
    expect(screen.getByRole("row", { name: /^7\s/ })).toHaveClass("voided");
  });

  it("does not rewrite a voided entry's own row — an earlier row folds exactly as it would without the correction", () => {
    renderLedger([...LEDGER, reversal]);
    // At seq 5 the reversal (seq 7) is not part of the prefix yet, so this
    // row's own figures are identical to the un-reversed canonical fixture:
    // Grace's deposit is fully reflected here. Verified against a real
    // render, not predicted — see the module doc above.
    const c = cellsOf("5");
    expect(c[4]).toBe("+$7,500.00");
    expect(c[5]).toBe("+6,108.7415");
    expect(c[6]).toBe("$49,383.07");
    expect(c[7]).toBe("40,222.4547");
  });

  it("removes exactly the voided deposit's units from the reversal's own row onward, leaving equity where the next reading already put it", () => {
    renderLedger([...LEDGER, reversal]);
    const c = cellsOf("7");
    // seq 6's reading re-anchored equity to 55,743.91 independent of any one
    // holder's unit count, so the correction does not move it.
    expect(c[6]).toBe("$55,743.91");
    // Units fall back to exactly the level right after Ada's deposit (seq 3)
    // — Grace's 6,108.7415 units are gone and nothing else moved the pool's
    // unit count between seq 3 and this row.
    expect(c[7]).toBe("34,113.7132");
    // The reversal entry itself moves no net cash.
    expect(c[4]).toBe("—");
  });
});

describe("LedgerTable — provenance and safety", () => {
  it("offers no edit and no delete", () => {
    renderLedger();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link", { name: /edit|delete|void|reverse/i })).toBeNull();
  });

  it("says the ledger is append-only in words, not only by omission", () => {
    renderLedger();
    expect(screen.getByText(/append-only\. There is no edit and no delete/))
      .toBeInTheDocument();
  });

  it("renders a dash rather than crashing when metadata is missing", () => {
    renderLedger(LEDGER, new Map());
    expect(cellsOf("1")[9]).toBe("—");
  });

  it("says what the page is for when there is nothing on it", () => {
    render(
      <LedgerTable accountId={7} steps={[]} meta={new Map()} names={{}} currency="USD" />,
    );
    expect(screen.getByText("No entries yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
