import { render, screen } from "@testing-library/react";
import type { HolderRow } from "@/lib/compound/db/holders";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { quote as computeQuote, type Quote } from "@/lib/compound/engine/quote";
import { fold, totalsOf } from "@/lib/compound/engine/replay";
import { previewEntry, type Preview } from "@/lib/compound/present/derive";
import { formatUnitsDp } from "@/lib/compound/present/format";
import { holderPosition, type HolderPosition } from "@/lib/compound/present/holder";
import { ADA_ID, LEDGER, SEEDS } from "@/lib/compound/present/fixture";
import { WithdrawSheet, type WithdrawForm } from "./withdraw-sheet";

const ADA: HolderRow = {
  id: ADA_ID, accountId: 7, name: "Ada Lovelace", email: null, userId: null,
  isManager: false, splitBps: 4000, joinedAt: "2026-05-04", status: "active",
};
const noop = async () => {};

// Ada's fixture position: value $12,630.60 (floored), basis $10,000.00,
// profit $2,630.60 (see present/fixture.ts's own header). Withdrawing
// exactly half ($6,315.30) divides every figure evenly — no rounding
// ambiguity — so this test can pin exact rendered numbers without
// re-deriving quote.ts's own arithmetic, which quote.test.ts already covers.
const HALF = centsFromDecimal("6315.30");
const FULL_CAP = centsFromDecimal("12630.60");

function build(amountCents: bigint, fee: "units" | "cash" = "units") {
  const state = fold(LEDGER, SEEDS);
  const position = holderPosition(state, ADA_ID);
  const q: Quote = computeQuote({
    totals: totalsOf(state),
    holderUnits: position.holder.units,
    basisCents: position.holder.basisCents,
    splitBps: position.holder.splitBps,
    isManager: position.holder.isManager,
    mode: "partial",
    amountCents,
  });
  const preview: Preview = previewEntry({
    accountId: 7, entries: LEDGER, seeds: SEEDS,
    proposed: {
      holderId: ADA_ID, occurredOn: "2026-08-18", type: "withdrawal",
      amountCents: q.grossCents, feeSettlement: fee, splitBpsApplied: q.splitBpsApplied,
    },
  });
  return { position, quote: q, preview };
}

function renderSheet(
  amountCents: bigint,
  form: Partial<WithdrawForm> = {},
  fee: "units" | "cash" = "units",
) {
  const { position, quote, preview } = build(amountCents, fee);
  return render(
    <WithdrawSheet
      accountId={7} holder={ADA} position={position}
      quote={quote} preview={preview}
      form={{ occurredOn: "2026-08-18", equity: "55743.91", amount: "6315.30", fee, ...form }}
      currency="USD"
      backHref="/a/7/holders/2" commitAction={noop}
      liveEquityCents={centsFromDecimal("55930.00")}
    />,
  );
}

describe("the receipt — a partial withdrawal, half of Ada's value", () => {
  beforeEach(() => renderSheet(HALF));

  it("shows the units held, before this withdrawal", () => {
    expect(screen.getByLabelText("Units held").textContent).toBe("9,113.7132");
  });

  it("shows the value at today's NAV — the cap", () => {
    expect(screen.getByLabelText("Value at today's NAV (1.3858)").textContent)
      .toBe("$12,630.60");
  });

  it("shows what Ada is asking for", () => {
    expect(screen.getByLabelText("What Ada Lovelace is asking for").textContent)
      .toBe("$6,315.30");
  });

  it("splits the withdrawal into capital and profit, and they sum to the amount requested", () => {
    const capital = screen.getByLabelText("Capital returned").textContent!;
    const profit = screen.getByLabelText("Profit in this withdrawal").textContent!;
    expect(capital).toBe("$5,000.00");
    expect(profit).toBe("+$1,315.30");
    const n = (s: string) => BigInt(s.replace(/[^0-9]/g, ""));
    expect(n(capital) + n(profit)).toBe(631_530n);
  });

  it("charges the fee on the profit slice only, at Ada's own split", () => {
    expect(screen.getByLabelText("Your fee (40%)").textContent).toBe("$526.12");
  });

  it("shows Ada's capital in after this, reduced by the capital slice and nothing more", () => {
    // $10,000.00 - $5,000.00 (the capital returned above), NOT
    // $10,000.00 - $6,315.30 (the whole withdrawal).
    expect(screen.getByLabelText("Ada Lovelace's capital in, after this").textContent)
      .toBe("$5,000.00");
  });

  it("shows units given up and units kept, and they sum to units held", () => {
    // Compared against formatUnitsDp of the real bigints, not a float
    // round-trip of the rendered text — formatUnitsDp truncates rather than
    // rounds (money.ts's own documented rule), and 9,113.7132585206 units
    // truncated to 4dp loses a genuine remainder that a Number() parse of
    // the truncated string can't recover, which is exactly what made the
    // float version of this assertion flaky by one part in the last digit.
    const { position, quote } = build(HALF);
    expect(screen.getByLabelText("Units held").textContent)
      .toBe(formatUnitsDp(position.holder.units));
    expect(screen.getByLabelText("Units Ada Lovelace gives up").textContent)
      .toBe(formatUnitsDp(quote.unitsRedeemed));
    expect(screen.getByLabelText("Units Ada Lovelace keeps").textContent)
      .toBe(formatUnitsDp(position.holder.units - quote.unitsRedeemed));
  });

  it("totals to what Ada receives: requested minus fee", () => {
    expect(screen.getByLabelText("Ada Lovelace receives").textContent).toBe("$5,789.18");
  });

  it("does not show the 'withdrawing everything' banner for a partial amount", () => {
    expect(screen.queryByText("Withdrawing everything")).not.toBeInTheDocument();
  });
});

describe("the receipt — withdrawing the full cap", () => {
  beforeEach(() => renderSheet(FULL_CAP));

  it("shows the 'withdrawing everything' banner, naming the full exit", () => {
    expect(screen.getByText("Withdrawing everything")).toBeInTheDocument();
    expect(screen.getByText(/the same as a full exit/)).toBeInTheDocument();
  });

  it("reduces capital in to zero", () => {
    expect(screen.getByLabelText("Ada Lovelace's capital in, after this").textContent)
      .toBe("$0.00");
  });

  it("marks every unit as given up", () => {
    expect(screen.getByLabelText("Units Ada Lovelace gives up").textContent)
      .toBe("9,113.7132 (all of them)");
  });
});

describe("step one — before a settlement is worked out", () => {
  it("shows the cap as a hint on the amount field", () => {
    const { position } = build(HALF);
    render(
      <WithdrawSheet
        accountId={7} holder={ADA} position={position}
        quote={null} preview={null}
        form={{ occurredOn: "2026-08-18" }}
        currency="USD"
        backHref="/a/7/holders/2" commitAction={noop}
        liveEquityCents={null}
      />,
    );
    expect(screen.getByText(/most that can be requested is \$12,630\.60/)).toBeInTheDocument();
    expect(screen.getByLabelText("Amount to withdraw, USD")).toBeInTheDocument();
  });

  it("shows the refusal sentence when the page caught a cap violation, rather than a blank form", () => {
    const { position } = build(HALF);
    render(
      <WithdrawSheet
        accountId={7} holder={ADA} position={position}
        quote={null} preview={null}
        form={{ occurredOn: "2026-08-18", equity: "55743.91", amount: "99999.99" }}
        currency="USD"
        error="withdrawal amount 9999999 exceeds the holder's value of 1263060 cents"
        backHref="/a/7/holders/2" commitAction={noop}
        liveEquityCents={null}
      />,
    );
    expect(screen.getByText(/exceeds the holder's value/)).toBeInTheDocument();
  });
});
