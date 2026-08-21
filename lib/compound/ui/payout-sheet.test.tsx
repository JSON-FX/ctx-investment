import { render, screen, within } from "@testing-library/react";
import type { HolderRow } from "@/lib/compound/db/holders";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { fold } from "@/lib/compound/engine/replay";
import { fingerprintOf, previewEntry } from "@/lib/compound/present/derive";
import { holderPosition } from "@/lib/compound/present/holder";
import { ADA_ID, LEDGER, LEDGER_UNDERWATER, SEEDS } from "@/lib/compound/present/fixture";
import { PayoutSheet, type PayoutForm } from "./payout-sheet";

const ADA: HolderRow = {
  id: ADA_ID, accountId: 7, name: "Ada Lovelace", email: null, userId: null,
  isManager: false, splitBps: 4000, joinedAt: "2026-05-04", status: "active",
};
const noop = async () => {};

function build(ledger = LEDGER, mode: "payout" | "exit" = "payout", fee: "units" | "cash" = "units") {
  const state = fold(ledger, SEEDS);
  const position = holderPosition(state, ADA_ID);
  const q = mode === "exit" ? position.exitQuote : position.profitQuote;
  const preview = previewEntry({
    accountId: 7, entries: ledger, seeds: SEEDS,
    proposed: {
      holderId: ADA_ID, occurredOn: "2026-08-18", type: mode,
      amountCents: q.grossCents, feeSettlement: fee, splitBpsApplied: q.splitBpsApplied,
    },
  });
  return { position, preview };
}

function renderSheet(
  ledger = LEDGER,
  form: PayoutForm = { mode: "payout", fee: "units", occurredOn: "2026-08-18", equity: "55743.91" },
  step2 = true,
) {
  const { position, preview } = build(ledger, form.mode ?? "payout", form.fee ?? "units");
  return render(
    <PayoutSheet
      accountId={7} holder={ADA} position={position}
      preview={step2 ? preview : null} form={form} currency="USD"
      backHref="/a/7/holders/2" commitAction={noop}
      liveEquityCents={centsFromDecimal("55930.00")}
    />,
  );
}

describe("the receipt — profit only, fee retained as units", () => {
  beforeEach(() => renderSheet());

  it("shows the units held", () => {
    expect(screen.getByLabelText("Units held").textContent).toBe("9,113.7132");
  });

  it("shows the value at the NAV this settles against", () => {
    expect(screen.getByLabelText("Value at today's NAV (1.3858)").textContent)
      .toBe("$12,630.60");
  });

  it("shows what Ada has put in, by that name", () => {
    expect(screen.getByLabelText("What Ada Lovelace has put in").textContent)
      .toBe("$10,000.00");
  });

  it("explains the high-water mark without using the term as a label", () => {
    expect(screen.getByText(/rises when Ada Lovelace adds capital/)).toBeInTheDocument();
    expect(screen.getByText(/resets to zero on a full exit/)).toBeInTheDocument();
  });

  it("shows profit above that, signed", () => {
    expect(screen.getByLabelText("Profit above that").textContent).toBe("+$2,630.60");
  });

  it("shows Ada's share and the manager's fee, and they sum to the profit", () => {
    const share = screen.getByLabelText("Ada Lovelace's share of the profit (60%)").textContent!;
    const fee = screen.getByLabelText("Your fee (40%)").textContent!;
    expect(share).toBe("$1,578.36");
    expect(fee).toBe("$1,052.24");
    const n = (s: string) => BigInt(s.replace(/\D/g, ""));
    expect(n(share) + n(fee)).toBe(263_060n);
  });

  it("uses Ada's own split in the labels, not the account default", () => {
    // Grace is 37%. A hard-coded 40 would still pass on Ada, which is why the
    // Grace case below exists.
    expect(screen.getByLabelText(/share of the profit \(60%\)/)).toBeInTheDocument();
  });

  it("shows the units given up and the units kept, with what they are worth", () => {
    expect(screen.getByLabelText("Units Ada Lovelace gives up").textContent).toBe("1,898.1300");
    expect(screen.getByLabelText("Units Ada Lovelace keeps").textContent).toBe("7,215.5832");
    // The plan's own text has a colon here ("...this payout: $10,000.00"),
    // but present/wording.ts's unitsKeptHint (Task 10, bootstrapped verbatim
    // from the plan) ends the sentence with a period, and payout-sheet.tsx
    // concatenates the figure straight after it with a space, not a colon —
    // confirmed by running this and reading the actual rendered hint text.
    // Matching what is actually on the page rather than "fixing" the render
    // to match a plan comment that disagrees with the plan's own wording.ts.
    expect(screen.getByText(/immediately after this payout\. \$10,000\.00/)).toBeInTheDocument();
  });

  it("shows what Ada actually receives, as the total", () => {
    expect(screen.getByLabelText("Ada Lovelace receives").textContent).toBe("$1,578.36");
  });

  it("names the amount on the button, so the confirm click is not blind", () => {
    expect(screen.getByRole("button", { name: "Pay Ada Lovelace $1,578.36" }))
      .toBeInTheDocument();
  });

  it("puts exactly one line in amber, and it is the fee", () => {
    const amber = document.querySelectorAll(".receipt-line.is-fee");
    expect(amber).toHaveLength(1);
    expect(amber[0]!.textContent).toContain("Your fee (40%)");
  });

  it("shows what it does to the account, at constant NAV", () => {
    expect(screen.getByLabelText("Account equity").textContent)
      .toBe("$55,743.91 → $54,165.55");
    expect(screen.getByLabelText("Units in issue").textContent)
      .toBe("40,222.4547 → 39,083.5767");
    expect(screen.getByLabelText("NAV per unit").textContent).toBe("1.3858 → 1.3858");
  });

  it("explains that the fee stays in the pool as units", () => {
    expect(screen.getByText(/cash stays in the pool and you are issued units/))
      .toBeInTheDocument();
    expect(screen.getByText(/capital in rises by the fee/)).toBeInTheDocument();
  });
});

describe("the receipt — profit only, fee taken as cash", () => {
  beforeEach(() => renderSheet(LEDGER, { mode: "payout", fee: "cash", occurredOn: "2026-08-18", equity: "55743.91" }));

  it("pays Ada the same figure — the settlement choice is yours, not hers", () => {
    expect(screen.getByLabelText("Ada Lovelace receives").textContent).toBe("$1,578.36");
    expect(screen.getByLabelText("Your fee (40%)").textContent).toBe("$1,052.24");
  });

  it("takes the fee out of the account as well as Ada's cash", () => {
    expect(screen.getByLabelText("Account equity").textContent)
      .toBe("$55,743.91 → $53,113.31");
    expect(screen.getByLabelText("Units in issue").textContent)
      .toBe("40,222.4547 → 38,324.3247");
  });

  it("still settles at constant NAV", () => {
    expect(screen.getByLabelText("NAV per unit").textContent).toBe("1.3858 → 1.3858");
  });
});

describe("the receipt — exit in full", () => {
  beforeEach(() => renderSheet(LEDGER, { mode: "exit", fee: "units", occurredOn: "2026-08-18", equity: "55743.91" }));

  it("pays the whole value less the fee", () => {
    expect(screen.getByLabelText("Ada Lovelace receives").textContent).toBe("$11,578.36");
  });

  it("charges the same fee — a fee is on profit, not on the amount withdrawn", () => {
    expect(screen.getByLabelText("Your fee (40%)").textContent).toBe("$1,052.24");
  });

  it("surrenders every unit, and says so", () => {
    expect(screen.getByLabelText("Units Ada Lovelace gives up").textContent)
      .toBe("9,113.7132 (all of them)");
    expect(screen.getByLabelText("Units Ada Lovelace keeps").textContent).toBe("0.0000");
  });

  it("still settles at constant NAV", () => {
    expect(screen.getByLabelText("Account equity").textContent)
      .toBe("$55,743.91 → $44,165.55");
    expect(screen.getByLabelText("NAV per unit").textContent).toBe("1.3858 → 1.3858");
  });
});

describe("below the high-water mark", () => {
  beforeEach(() =>
    renderSheet(LEDGER_UNDERWATER, { mode: "payout", occurredOn: "2026-08-18", equity: "38110.44" }, false));

  it("says so, and states the recovery figure", () => {
    expect(screen.getByText("Below the high-water mark")).toBeInTheDocument();
    expect(screen.getByText(/\$1,364\.84 of recovery is needed before any profit can be withdrawn/))
      .toBeInTheDocument();
  });

  it("disables profit-only and repeats the recovery figure on the control itself", () => {
    const profitOnly = screen.getByRole("radio", { name: /Profit only/ });
    expect(profitOnly).toBeDisabled();
    expect(screen.getByText("$1,364.84 of recovery is needed first.")).toBeInTheDocument();
  });

  it("keeps exit available, at current value, with no fee", () => {
    expect(screen.getByRole("radio", { name: /Exit in full/ })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /Exit in full/ })).toBeChecked();
    expect(screen.getByText(/still available, at today's value of \$8,635\.16, with no fee/))
      .toBeInTheDocument();
  });
});

describe("exactly at the high-water mark", () => {
  it("does not claim the holder is below it", () => {
    // A holder whose value equals their basis exactly. quote() reports
    // belowHighWaterMark true here; the sheet must not.
    const ledger = [...LEDGER, {
      id: 7, seq: 7, holderId: null, occurredOn: "2026-08-18",
      type: "equity_reading" as const,
      // The plan's own literal value here, "44133.62", does NOT land Ada on
      // her mark — confirmed by running it: holderPosition reports profit
      // of -9 cents (i.e. nine cents BELOW the mark, not AT it), which is
      // exactly the failure mode this test's own guard below exists to
      // catch. Ada holds 91,137,132,585,206 scaled units against
      // 402,224,547,963,043 total; floor(unitsAda * equityCents /
      // totalUnits) == 1,000,000 (her $10,000.00 basis, in cents) holds for
      // equityCents in [4413400, 4413403] — solved directly with the same
      // mulDivFloor arithmetic engine/nav.ts uses, not guessed. 44134.00 is
      // the round end of that range.
      amountCents: centsFromDecimal("44134.00"),
      feeSettlement: null, splitBpsApplied: null, reversesId: null,
    }];
    const position = holderPosition(fold(ledger, SEEDS), ADA_ID);
    render(
      <PayoutSheet
        accountId={7} holder={ADA} position={position} preview={null}
        form={{ mode: "payout" }} currency="USD" backHref="/a/7/holders/2"
        commitAction={noop} liveEquityCents={null}
      />,
    );
    if (position.markState === "at") {
      expect(screen.getByText("Exactly at the high-water mark")).toBeInTheDocument();
      expect(screen.queryByText("Below the high-water mark")).toBeNull();
      expect(screen.getByText(/no profit to withdraw yet/)).toBeInTheDocument();
    } else {
      // The reading above must be tuned until markState is "at". Do not delete
      // this branch — make it unreachable by picking the right figure, and
      // leave the guard so a later fixture change cannot silently skip the case.
      throw new Error(
        `fixture does not sit on the mark: profit is ${position.profitCents}. ` +
          `Adjust the equity_reading amount until holderPosition reports "at".`,
      );
    }
  });
});

describe("guards", () => {
  it("refuses a holder with no units, and says what to do", () => {
    const empty = holderPosition(fold(LEDGER, SEEDS), 1);
    render(
      <PayoutSheet
        accountId={7} holder={{ ...ADA, id: 1, name: "Nobody" }}
        position={{ ...empty, holder: { ...empty.holder, units: 0n } }}
        preview={null} form={{}} currency="USD" backHref="/a/7"
        commitAction={noop} liveEquityCents={null}
      />,
    );
    expect(screen.getByText("Nobody holds no units.")).toBeInTheDocument();
    expect(screen.getByText(/Add capital for Nobody first/)).toBeInTheDocument();
  });

  it("refuses while a capital event is unclassified, because a payout settles at NAV", () => {
    const { position } = build();
    render(
      <PayoutSheet
        accountId={7} holder={ADA} position={position} preview={null}
        form={{}} currency="USD" backHref="/a/7" commitAction={noop}
        liveEquityCents={null}
        blocked={{ candidateDate: "2026-08-12", reviewHref: "/a/7/review" }}
      />,
    );
    expect(screen.getByText(/NAV must not cross it, and a payout settles at NAV/))
      .toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers the live figure as the settlement default, labelled as CopyTraderX's", () => {
    renderSheet(LEDGER, { mode: "payout" }, false);
    expect(screen.getByText(/CopyTraderX's latest live figure is \$55,930\.00/))
      .toBeInTheDocument();
  });

  it("carries the pre-reading seq in the fingerprint, not the settlement reading's", () => {
    renderSheet();
    expect(document.querySelector<HTMLInputElement>('input[name="fpSeq"]')!.value).toBe("6");
  });
});

describe("a holder on a non-default split", () => {
  it("uses their split in every label and every figure", () => {
    const GRACE: HolderRow = { ...ADA, id: 3, name: "Grace Hopper", splitBps: 3700 };
    const state = fold(LEDGER, SEEDS);
    const position = holderPosition(state, 3);
    const preview = previewEntry({
      accountId: 7, entries: LEDGER, seeds: SEEDS,
      proposed: {
        holderId: 3, occurredOn: "2026-08-18", type: "payout",
        amountCents: position.profitQuote.grossCents, feeSettlement: "units",
        splitBpsApplied: position.profitQuote.splitBpsApplied,
      },
    });
    render(
      <PayoutSheet
        accountId={7} holder={GRACE} position={position} preview={preview}
        form={{ mode: "payout", fee: "units", occurredOn: "2026-08-18", equity: "55743.91" }}
        currency="USD" backHref="/a/7" commitAction={noop} liveEquityCents={null}
      />,
    );
    expect(screen.getByLabelText("Grace Hopper's share of the profit (63%)").textContent)
      .toBe("$608.61");
    expect(screen.getByLabelText("Your fee (37%)").textContent).toBe("$357.43");
    expect(screen.getByLabelText("Grace Hopper receives").textContent).toBe("$608.61");
  });
});

/**
 * Regression coverage for a bug found while building this task, NOT present
 * in the plan's own test suite above (docs/superpowers/plans/
 * 2026-08-21-compound-desk.md, Task 13 Step 4). See
 * app/a/[id]/actions/payout/[hid]/page.tsx's inline comment and
 * .superpowers/desk-task-13-report.md for the full trace.
 *
 * The plan's own "carries the pre-reading seq" guard test above (in
 * `describe("guards")`) uses `build()`, which calls `previewEntry` with the
 * plain `LEDGER` — it never constructs the synthetic settlement-reading entry
 * the real page does. It also always uses a settlement equity IDENTICAL to
 * the ledger's last committed reading ("55743.91"), so even a test that did
 * fold the synthetic reading in would see equityCents/units come out
 * unchanged either way and could still miss a seq-only regression.
 *
 * This block instead reproduces the real page's construction — prepend a
 * synthetic equity_reading, fold it, quote against it, call previewEntry with
 * the 7-entry array — using a settlement figure that has genuinely MOVED from
 * the last committed reading (55930.00 vs 55743.91, CopyTraderX's live
 * figure from the fixture). Confirmed by running it before the fix landed:
 * previewEntry's own fingerprint carries seq 7 and the POST-reading
 * equity/units in this scenario, which would make every payout attempt
 * refuse itself as stale on the very first try. This asserts the page's
 * override lands on the true pre-reading values instead.
 */
describe("the fingerprint, when the settlement equity has actually moved", () => {
  function buildRealPageStyle(settlementEquity: string) {
    const withReading = [
      ...LEDGER,
      {
        id: Math.max(0, ...LEDGER.map((e) => e.id)) + 1,
        seq: Math.max(0, ...LEDGER.map((e) => e.seq)) + 1,
        holderId: null, occurredOn: "2026-08-18", type: "equity_reading" as const,
        amountCents: centsFromDecimal(settlementEquity),
        feeSettlement: null, splitBpsApplied: null, reversesId: null,
      },
    ];
    const position = holderPosition(fold(withReading, SEEDS), ADA_ID);
    const q = position.profitQuote;
    const rawPreview = previewEntry({
      accountId: 7, entries: withReading, seeds: SEEDS,
      proposed: {
        holderId: ADA_ID, occurredOn: "2026-08-18", type: "payout",
        amountCents: q.grossCents, feeSettlement: "units", splitBpsApplied: q.splitBpsApplied,
      },
    });
    return { rawPreview, position, q };
  }

  it("previewEntry alone gets this wrong — documents the bug, not the fix", () => {
    const { rawPreview } = buildRealPageStyle("55930.00");
    // This is the buggy value a literal transcription of the plan's page.tsx
    // would embed in the form. If this assertion ever starts failing because
    // previewEntry's behaviour changed, page.tsx's override may no longer be
    // necessary — re-read this whole describe block before deleting it.
    expect(rawPreview.fingerprint.seq).toBe(7);
    expect(rawPreview.fingerprint.equityCents).toBe("5593000");
  });

  it("the page's fix — fingerprintOf(accountId, fold(entries, seeds)) — recovers seq 6 and the real committed equity", () => {
    const { rawPreview } = buildRealPageStyle("55930.00");
    const fixed = fingerprintOf(7, fold(LEDGER, SEEDS));
    const preview = { ...rawPreview, fingerprint: fixed };

    expect(preview.fingerprint.seq).toBe(6);
    expect(preview.fingerprint.equityCents).toBe("5574391");
    expect(preview.fingerprint.units).toBe("402224547963043");

    render(
      <PayoutSheet
        accountId={7} holder={ADA} position={buildRealPageStyle("55930.00").position}
        preview={preview}
        form={{ mode: "payout", fee: "units", occurredOn: "2026-08-18", equity: "55930.00" }}
        currency="USD" backHref="/a/7/holders/2" commitAction={noop} liveEquityCents={null}
      />,
    );
    const value = (n: string) =>
      document.querySelector<HTMLInputElement>(`input[name="${n}"]`)!.value;
    expect(value("fpSeq")).toBe("6");
    expect(value("fpEquityCents")).toBe("5574391");

    // The DISPLAY figures, unlike the fingerprint, correctly show the
    // settlement-adjusted equity (55930.00) as "before" — that part of the
    // page's construction was never wrong, only the fingerprint was.
    expect(screen.getByLabelText("Account equity").textContent).toMatch(/^\$55,930\.00 →/);
  });

  it("a staleness-style comparison against the real committed ledger would refuse the buggy fingerprint but accept the fixed one", () => {
    // Mirrors what payout/[hid]/actions.ts's staleness() actually does at
    // commit time: re-fold the REAL ledger (no synthetic reading — it is not
    // in compound_ledger_entry yet) and compare.
    const currentRealFingerprint = fingerprintOf(7, fold(LEDGER, SEEDS));
    const { rawPreview } = buildRealPageStyle("55930.00");

    expect(rawPreview.fingerprint.seq).not.toBe(currentRealFingerprint.seq); // buggy: false "stale"
    const fixed = fingerprintOf(7, fold(LEDGER, SEEDS));
    expect(fixed).toEqual(currentRealFingerprint); // fixed: matches, so it is NOT refused
  });
});
