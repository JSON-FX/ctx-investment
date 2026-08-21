import { render, screen } from "@testing-library/react";
import { ADA_ID, MANAGER_ID } from "@/lib/compound/present/fixture";
import { ClassifySheet, type SheetHolder } from "./classify-sheet";
import type { ReviewCandidate } from "./review-queue";

const HOLDERS: SheetHolder[] = [
  { id: MANAGER_ID, name: "J. Marsh", isManager: true },
  { id: ADA_ID, name: "Ada Lovelace", isManager: false },
];
const FP = { accountId: 7, seq: 6, equityCents: "5574391", units: "402224547963043" };
const noop = async () => {};

function candidate(over: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    id: 12, tradeDate: "2026-08-12",
    balanceDeltaCents: 500_000n, explainedCents: 0n, unexplainedCents: 500_000n,
    ...over,
  };
}

function renderSheet(
  k = candidate(),
  matchable: Parameters<typeof ClassifySheet>[0]["matchable"] = [],
) {
  return render(
    <ClassifySheet
      accountId={7} candidate={k} holders={HOLDERS} matchable={matchable}
      fingerprint={FP} currency="USD" form={{}} backHref="/a/7/review"
      commitAction={noop}
    />,
  );
}

describe("ClassifySheet — a positive move", () => {
  beforeEach(() => renderSheet());

  it("restates the arithmetic before asking for a decision", () => {
    expect(screen.getByLabelText("Nobody has accounted for").textContent).toBe("+$5,000.00");
  });

  it("offers all three outcomes", () => {
    expect(screen.getByRole("radio", { name: /A deposit/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Already recorded here/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Not a capital event/ })).toBeInTheDocument();
  });

  it("defaults the deposit amount to the unexplained figure", () => {
    expect(screen.getByLabelText(/Amount, USD/)).toHaveValue("5000.00");
  });

  it("says units are issued at the NAV of the event's own day", () => {
    expect(screen.getByText(/Units are issued to them at the NAV on 12 Aug 2026/))
      .toBeInTheDocument();
  });

  it("disables matching when nothing in the ledger could account for it", () => {
    expect(screen.getByRole("radio", { name: /Already recorded here/ })).toBeDisabled();
    expect(screen.getByText(/No entry in the ledger has a cash movement/)).toBeInTheDocument();
  });

  it("requires a note to ignore, and says why", () => {
    expect(screen.getByLabelText("Why (required)")).toBeInTheDocument();
    expect(screen.getByText(/only record of the decision/)).toBeInTheDocument();
  });

  it("says what ignoring actually does to the money", () => {
    expect(screen.getByText(/absorbed into NAV pro-rata/)).toBeInTheDocument();
    expect(screen.getByText(/right for money that belongs to every holder, and wrong for money that belongs to one/))
      .toBeInTheDocument();
  });

  it("carries the fingerprint so a stale classification cannot be committed", () => {
    expect(document.querySelector<HTMLInputElement>('input[name="fpSeq"]')!.value).toBe("6");
  });

  it("carries every fingerprint field, not just seq", () => {
    // fpSeq alone would miss the case fingerprintMismatch itself guards:
    // an entry written and reversed leaves seq higher with the pool
    // unchanged, or a reversal of an OLD entry leaves the pool different at
    // a seq the reader might still recognise. All four fields must round-trip.
    expect(document.querySelector<HTMLInputElement>('input[name="fpAccountId"]')!.value).toBe("7");
    expect(document.querySelector<HTMLInputElement>('input[name="fpEquityCents"]')!.value).toBe("5574391");
    expect(document.querySelector<HTMLInputElement>('input[name="fpUnits"]')!.value).toBe("402224547963043");
  });

  it("names the manager distinctly among the deposit's holder choices", () => {
    expect(screen.getByRole("option", { name: "J. Marsh (you)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Ada Lovelace" })).toBeInTheDocument();
  });
});

describe("ClassifySheet — a negative move", () => {
  beforeEach(() => renderSheet(candidate({
    balanceDeltaCents: -500_000n, explainedCents: 0n, unexplainedCents: -500_000n,
  })));

  it("does not offer a deposit for money that left", () => {
    expect(screen.queryByRole("radio", { name: /A deposit/ })).toBeNull();
  });

  it("sends a withdrawal to the payout screen, for its exact amount", () => {
    // P6 shipped, so the advice is no longer "full exit only, or wait". A
    // withdrawal is still not a classification outcome — D-J holds, and two
    // ways to record the same money one click apart would be worse than one.
    expect(screen.getByText(/record it on the\s+payout screen/)).toBeInTheDocument();
    expect(screen.getByText(/for the exact amount, or as a full exit/)).toBeInTheDocument();
    // And it must not still claim the feature is missing.
    expect(screen.queryByText(/deferred/)).toBeNull();
    expect(screen.queryByText(/cannot record it yet/)).toBeNull();
  });

  it("warns that ignoring a withdrawal gives the loss to everyone", () => {
    expect(screen.getByText(/spread the\s+loss across every holder pro-rata/))
      .toBeInTheDocument();
  });

  it("defaults to \"already recorded here\", not \"not a capital event\"", () => {
    // There is no deposit radio to default to on a negative move, and
    // defaulting to "ignore" would be one click away from mis-splitting a
    // real withdrawal's loss across every holder — "match" is the safer
    // default when a negative move is shown at all.
    expect(screen.getByRole("radio", { name: /Already recorded here/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Not a capital event/ })).not.toBeChecked();
  });
});

describe("ClassifySheet — matching an existing entry", () => {
  it("offers the entries whose cash movement matches, with their figures", () => {
    renderSheet(
      candidate({ balanceDeltaCents: -157_836n, explainedCents: 0n, unexplainedCents: -157_836n }),
      [{
        entry: {
          id: 7, seq: 7, holderId: ADA_ID, occurredOn: "2026-08-18", type: "payout",
          amountCents: 263_060n, feeSettlement: "units", splitBpsApplied: 4000, reversesId: null,
        },
        cashCents: -157_836n,
      }],
    );
    const option = screen.getByRole("option", { name: /#7 · 18 Aug 2026 · payout · -\$1,578\.36/ });
    expect(option).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Already recorded here/ })).toBeEnabled();
  });

  it("explains why a recorded payout shows up here at all", () => {
    renderSheet(
      candidate({ unexplainedCents: -157_836n }),
      [{
        entry: {
          id: 7, seq: 7, holderId: ADA_ID, occurredOn: "2026-08-18", type: "payout",
          amountCents: 263_060n, feeSettlement: "units", splitBpsApplied: 4000, reversesId: null,
        },
        cashCents: -157_836n,
      }],
    );
    expect(screen.getByText(/compares balance against closed trades and a withdrawal is neither/))
      .toBeInTheDocument();
  });
});

describe("ClassifySheet — resubmitting a rejected form", () => {
  it("re-selects the outcome the manager chose, not the default", () => {
    render(
      <ClassifySheet
        accountId={7} candidate={candidate()} holders={HOLDERS} matchable={[]}
        fingerprint={FP} currency="USD"
        form={{ outcome: "ignore", note: "Broker rebate, ticket 4471" }}
        backHref="/a/7/review" commitAction={noop}
      />,
    );
    expect(screen.getByRole("radio", { name: /Not a capital event/ })).toBeChecked();
    expect(screen.getByLabelText("Why (required)")).toHaveValue("Broker rebate, ticket 4471");
  });

  it("shows the error banner, and states nothing committed", () => {
    render(
      <ClassifySheet
        accountId={7} candidate={candidate()} holders={HOLDERS} matchable={[]}
        fingerprint={FP} currency="USD" form={{}}
        error="Choose what this was before classifying it."
        backHref="/a/7/review" commitAction={noop}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Nothing was committed.");
    expect(screen.getByText("Choose what this was before classifying it.")).toBeInTheDocument();
  });
});
