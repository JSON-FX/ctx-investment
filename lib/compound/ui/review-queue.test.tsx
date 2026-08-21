import { render, screen, within } from "@testing-library/react";
import type { CapitalEventCandidateRow } from "@/lib/compound/db/compound";
import type { DroppedDeal } from "@/lib/compound/reconcile/dedupe";
import type { ClosedDeal } from "@/lib/compound/reconcile/types";
import type { ReadingPlan } from "@/lib/compound/reconcile/interlock";
import { ReviewQueue, SuppressedDeals } from "./review-queue";

const CANDIDATE: CapitalEventCandidateRow = {
  id: 12, accountId: 7, tradeDate: "2026-08-12",
  balanceDeltaCents: 500_000n, explainedCents: 0n, unexplainedCents: 500_000n,
  status: "pending", detectedAt: "2026-08-13T02:00:00.000Z",
};

const DEAL: ClosedDeal = {
  ticket: 90_019_999, symbol: "EURUSD", side: "sell", volumeMilliLots: 100,
  openTime: "2026-08-06T08:00:00.000Z", closeTime: "2026-08-06T11:00:00.000Z",
  profitCents: 8_000n, swapCents: 0n, commissionCents: 0n,
};
const DROPPED: DroppedDeal[] = [{ deal: DEAL, duplicateOfTicket: 90_010_004 }];

const IDLE: ReadingPlan = { kind: "idle", droppedDeals: DROPPED };
const refresh = <button type="button">Refresh readings</button>;

function renderQueue(over: Partial<Parameters<typeof ReviewQueue>[0]> = {}) {
  return render(
    <ReviewQueue
      accountId={7}
      currency="USD"
      plan={over.plan === undefined ? IDLE : over.plan}
      pending={over.pending ?? [CANDIDATE]}
      frozenAt={over.frozenAt === undefined ? "2026-08-11" : over.frozenAt}
      defect={over.defect ?? null}
      notConfigured={over.notConfigured ?? false}
      refreshAction={refresh}
    />,
  );
}

describe("ReviewQueue — a pending candidate", () => {
  beforeEach(() => renderQueue());

  it("shows the arithmetic as an equation the reader can check", () => {
    expect(screen.getByLabelText("The balance moved by").textContent).toBe("+$5,000.00");
    expect(screen.getByLabelText("Closed trades explain").textContent).toBe("+$0.00");
    expect(screen.getByLabelText("Nobody has accounted for").textContent).toBe("+$5,000.00");
  });

  it("adds up: explained plus unexplained is the balance move", () => {
    const n = (label: string) => {
      const t = screen.getByLabelText(label).textContent!;
      return BigInt(t.replace(/[^0-9]/g, "")) * (t.startsWith("-") ? -1n : 1n);
    };
    expect(n("Closed trades explain") + n("Nobody has accounted for"))
      .toBe(n("The balance moved by"));
  });

  it("does not fold the hint into the figure's accessible name", () => {
    // Guards the exact mistake receipt.tsx's own header documents: if the id
    // aria-labelledby points at also contained the hint <small>, this label
    // would stop matching at all, not merely include extra text.
    expect(screen.getByLabelText("The balance moved by")).toBeInTheDocument();
    expect(screen.getByText(/Close-to-close, against the previous snapshot/))
      .toBeInTheDocument();
  });

  it("dates the event and says where figures are frozen", () => {
    expect(screen.getByRole("heading", { name: "12 Aug 2026" })).toBeInTheDocument();
    expect(screen.getByText(/Readings are frozen at 11 Aug 2026/)).toBeInTheDocument();
  });

  it("says why freezing is deliberate rather than apologising for it", () => {
    expect(screen.getByText(/an unrecorded deposit is indistinguishable from profit/))
      .toBeInTheDocument();
  });

  it("links to the classify sheet", () => {
    expect(screen.getByRole("link", { name: "Classify this" }))
      .toHaveAttribute("href", "/a/7/review/12");
  });
});

describe("ReviewQueue — several pending candidates", () => {
  // The signature version of this fixture is one candidate, which makes
  // ordering trivially correct. Two on adjacent days is the case that
  // actually exercises the sort.
  const later: CapitalEventCandidateRow = {
    id: 13, accountId: 7, tradeDate: "2026-08-13",
    balanceDeltaCents: -157_836n, explainedCents: 0n, unexplainedCents: -157_836n,
    status: "pending", detectedAt: "2026-08-14T02:00:00.000Z",
  };
  const earlier: CapitalEventCandidateRow = {
    id: 11, accountId: 7, tradeDate: "2026-08-10",
    balanceDeltaCents: 250_000n, explainedCents: 0n, unexplainedCents: 250_000n,
    status: "pending", detectedAt: "2026-08-11T02:00:00.000Z",
  };

  it("renders every pending candidate as its own item", () => {
    renderQueue({ pending: [CANDIDATE, later, earlier] });
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(screen.getByRole("heading", { name: "10 Aug 2026" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "12 Aug 2026" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "13 Aug 2026" })).toBeInTheDocument();
  });

  it("links each item to its own candidate id, not the first one", () => {
    renderQueue({ pending: [CANDIDATE, later, earlier] });
    const item10 = screen.getByRole("heading", { name: "10 Aug 2026" }).closest("article")!;
    const item12 = screen.getByRole("heading", { name: "12 Aug 2026" }).closest("article")!;
    const item13 = screen.getByRole("heading", { name: "13 Aug 2026" }).closest("article")!;
    expect(within(item10).getByRole("link", { name: "Classify this" }))
      .toHaveAttribute("href", "/a/7/review/11");
    expect(within(item12).getByRole("link", { name: "Classify this" }))
      .toHaveAttribute("href", "/a/7/review/12");
    expect(within(item13).getByRole("link", { name: "Classify this" }))
      .toHaveAttribute("href", "/a/7/review/13");
  });

  it("renders a negative unexplained move signed, not as an absolute value", () => {
    renderQueue({ pending: [later] });
    expect(screen.getByLabelText("Nobody has accounted for").textContent).toBe("-$1,578.36");
  });
});

describe("ReviewQueue — suppressed duplicates", () => {
  it("lists every dropped deal with the ticket it was judged a copy of", () => {
    renderQueue();
    const row = screen.getByRole("row", { name: /90019999/ });
    const cells = [...within(row).getAllByRole("rowheader"), ...within(row).getAllByRole("cell")]
      .map((c) => c.textContent);
    expect(cells).toEqual([
      "90019999", "EURUSD", "sell", "0.100",
      "6 Aug 2026, 11:00 UTC", "+$80.00", "90010004",
    ]);
  });

  it("shows the panel even when nothing is pending, because it is an audit", () => {
    renderQueue({ pending: [] });
    expect(screen.getByText(/Suppressed as duplicates · 1/)).toBeInTheDocument();
  });

  it("says which way a dedupe mistake fails, in both directions", () => {
    renderQueue();
    const note = screen.getByText(/wrongly suppressed/).textContent!;
    expect(note).toContain("explained figure too small");
    expect(note).toContain("loud, and safe");
    expect(note).toContain("wrongly kept makes the explained figure too large");
    expect(note).toContain("silent");
  });

  it("says so plainly when nothing was suppressed", () => {
    render(<SuppressedDeals dropped={[]} currency="USD" />);
    expect(screen.getByText("Nothing was suppressed in this run.")).toBeInTheDocument();
    expect(screen.getByText(/Suppressed as duplicates · 0/)).toBeInTheDocument();
  });
});

describe("ReviewQueue — a data defect is not a halt", () => {
  const message =
    "duplicate snapshot for tradeDate 2026-08-12 in the reading window: two rows both " +
    "claim to close that day";

  beforeEach(() => renderQueue({ pending: [], plan: null, defect: message }));

  it("says the data is wrong, not that something needs classifying", () => {
    expect(screen.getByRole("alert").textContent)
      .toContain("The data upstream is wrong, and this is not a capital event.");
    expect(screen.getByText(/duplicate snapshot for tradeDate 2026-08-12/)).toBeInTheDocument();
  });

  it("offers no classify control, because there is nothing to classify", () => {
    expect(screen.queryByRole("link", { name: /Classify/ })).toBeNull();
  });

  it("warns that the duplicate date may be concealing a real event", () => {
    expect(screen.getByText(/can be concealing a real capital event/)).toBeInTheDocument();
  });

  it("does not claim everything is fine", () => {
    expect(screen.queryByText("Nothing waiting")).toBeNull();
  });

  it("does not render the RangeError message inside a queue-item", () => {
    // The distinction that matters most: a defect must never share markup
    // with a candidate, or a manager skimming the page cannot tell them apart.
    expect(document.querySelector(".queue")).toBeNull();
  });
});

describe("ReviewQueue — nothing pending", () => {
  it("says readings are advancing and when the last one landed", () => {
    renderQueue({ pending: [] });
    expect(screen.getByText("Nothing waiting")).toBeInTheDocument();
    expect(screen.getByText(/Readings are advancing, last posted 11 Aug 2026/))
      .toBeInTheDocument();
  });

  it("says inception when nothing has ever posted, rather than a null date", () => {
    renderQueue({ pending: [], frozenAt: null });
    expect(screen.getByText(/Readings are advancing\./)).toBeInTheDocument();
  });
});

describe("ReviewQueue — reconciliation switched off", () => {
  it("explains the offset, and does not pretend the queue is clear", () => {
    renderQueue({ pending: [], plan: null, notConfigured: true });
    expect(screen.getByText(/broker's UTC offset is not set/)).toBeInTheDocument();
    expect(screen.getByText(/can hide a real capital event/)).toBeInTheDocument();
    expect(screen.queryByText("Nothing waiting")).toBeNull();
  });
});

describe("ReviewQueue — a plan that halted", () => {
  it("still renders the suppressed list, because halt carries droppedDeals too", () => {
    const halt: ReadingPlan = {
      kind: "halt", readings: [], newCursorDate: "2026-08-11",
      candidate: {
        tradeDate: "2026-08-12", previousDate: "2026-08-11",
        balanceDeltaCents: 500_000n, explainedCents: 0n, unexplainedCents: 500_000n,
      },
      droppedDeals: DROPPED,
    };
    renderQueue({ plan: halt });
    expect(screen.getByRole("row", { name: /90019999/ })).toBeInTheDocument();
  });
});
