import { render, screen, within } from "@testing-library/react";
import { centsFromDecimal } from "@/lib/compound/engine/money";
import { fold } from "@/lib/compound/engine/replay";
import { deskFigures } from "@/lib/compound/present/derive";
import { railSegments } from "@/lib/compound/present/rail";
import { GRACE_ID, HOLDER_NAMES, LEDGER, LIVE, SEEDS } from "@/lib/compound/present/fixture";
import { Desk } from "./desk";

const STATE = fold(LEDGER, SEEDS);
const NAMES = HOLDER_NAMES;

function renderDesk(over: Partial<Parameters<typeof Desk>[0]> = {}) {
  const state = over.state ?? STATE;
  return render(
    <Desk
      accountId={7}
      state={state}
      figures={over.figures ?? deskFigures(state, NAMES)}
      segments={over.segments ?? railSegments(state, NAMES)}
      currency={over.currency ?? "USD"}
      entryCount={over.entryCount ?? LEDGER.length}
      live={over.live === undefined ? LIVE : over.live}
      actions={over.actions}
      holderActions={over.holderActions}
    />,
  );
}

describe("Desk — page identity", () => {
  it("announces itself as a level-1 heading named 'Desk'", () => {
    renderDesk();
    expect(screen.getByRole("heading", { level: 1, name: "Desk" })).toBeInTheDocument();
  });

  it("still announces itself on a brand-new account with nothing posted", () => {
    // The empty-state branch is a separate return, not a fallthrough of the
    // one above — desk.tsx's own early return for entryCount === 0. A screen
    // reader landing here needs page identity exactly as much as it does on
    // a funded account; nothing about "empty" makes it not the Desk.
    renderDesk({ state: fold([], SEEDS), entryCount: 0, live: null });
    expect(screen.getByRole("heading", { level: 1, name: "Desk" })).toBeInTheDocument();
  });
});

describe("Desk — the statement head", () => {
  beforeEach(() => renderDesk());

  it("headlines the committed equity, not the live figure", () => {
    expect(screen.getByLabelText("Account equity").textContent).toBe("$55,743.91");
    expect(screen.getByLabelText("Live equity").textContent).toBe("$55,930.00");
  });

  it("shows NAV, growth, units and the holder count", () => {
    expect(screen.getByLabelText("NAV / unit").textContent).toBe("1.3858");
    expect(screen.getByLabelText("Since inception").textContent).toBe("+38.58%");
    expect(screen.getByLabelText("Units issued").textContent).toBe("40,222.4547");
    expect(screen.getByLabelText("Holders").textContent).toBe("3");
  });
});

describe("Desk — the KPI strip", () => {
  beforeEach(() => renderDesk());

  it("reads back every headline figure", () => {
    expect(screen.getByLabelText("Investor capital in").textContent).toBe("$17,500.00");
    expect(screen.getByLabelText("Investor value now").textContent).toBe("$21,096.65");
    expect(screen.getByLabelText("Investor P/L").textContent).toBe("+$3,596.65");
    expect(screen.getByLabelText("Your holding").textContent).toBe("$34,647.26");
    expect(screen.getByLabelText("Fee if everyone paid out today").textContent).toBe("$1,409.67");
  });

  it("separates the manager's holding from the investors' totals", () => {
    // 34,647.26 + 21,096.65 = 55,743.91. If the manager leaked into the
    // investor totals, "Investor value now" would read the equity figure.
    const investors = BigInt(screen.getByLabelText("Investor value now").textContent!.replace(/\D/g, ""));
    const yours = BigInt(screen.getByLabelText("Your holding").textContent!.replace(/\D/g, ""));
    expect(investors + yours).toBe(5_574_391n);
  });

  it("carries exactly one amber tile, and it is the fee", () => {
    const amber = document.querySelectorAll(".kpi-item.is-fee");
    expect(amber).toHaveLength(1);
    expect(amber[0]!.textContent).toContain("Fee if everyone paid out today");
  });
});

describe("Desk — the ownership rail", () => {
  beforeEach(() => renderDesk());

  it("shows the manager darkest and first", () => {
    const segs = document.querySelectorAll<HTMLElement>(".seg");
    expect(segs[0]!.style.background).toBe("rgb(20, 83, 45)");
  });

  it("labels every segment with a name and a share", () => {
    const legend = screen.getByRole("list", { name: "Ownership legend" });
    expect(legend.textContent).toContain("J. Marsh (manager)");
    expect(legend.textContent).toContain("62.15%");
  });

  it("fills the rail exactly — segment widths sum to 100.00%, not the 99.9998% three independent floors would leave", () => {
    // allocateShares (present/rail.ts) largest-remainder-allocates the 999,998
    // ppm three independent floors would produce on this fixture up to
    // 1,000,000. If the desk ever rendered segments built by flooring each
    // holder independently, the rail would visibly fail to fill its
    // container — this reads the actual DOM widths, not the ppm inputs, so
    // it also catches OwnershipRail mis-rendering a correct segment list.
    const segs = document.querySelectorAll<HTMLElement>(".seg");
    const total = [...segs].reduce((sum, el) => sum + Number(el.style.width.replace("%", "")), 0);
    expect(total).toBeCloseTo(100, 6);
  });
});

describe("Desk — the holder table", () => {
  it("agrees with the KPI strip on Ada's value", () => {
    renderDesk();
    const row = screen.getByRole("row", { name: /Ada Lovelace/ });
    expect(within(row).getAllByRole("cell")[3]!.textContent).toBe("$12,630.61");
  });

  it("offers no payout link in Phase A, where nothing can be committed", () => {
    renderDesk();
    expect(screen.queryByRole("link", { name: "Pay out" })).toBeNull();
  });

  it("stays off merely because the action bar is wired — Task 13 owns turning it on", () => {
    renderDesk({ actions: <a className="btn" href="/a/7/actions/reading">Post a reading</a> });
    expect(screen.queryByRole("link", { name: "Pay out" })).toBeNull();
  });

  it("offers one once holderActions is on", () => {
    renderDesk({
      actions: <a className="btn" href="/a/7/actions/reading">Post a reading</a>,
      holderActions: true,
    });
    expect(screen.getAllByRole("link", { name: "Pay out" }).length).toBeGreaterThan(0);
  });

  it("renders exactly one row per holder, so a table that silently drops a row cannot hide behind an unchanged total", () => {
    renderDesk();
    for (const name of Object.values(NAMES)) {
      expect(screen.getByRole("row", { name: new RegExp(name) })).toBeInTheDocument();
    }
    // One column-header row, one row per holder (3), one totals row.
    expect(screen.getAllByRole("row")).toHaveLength(Object.keys(NAMES).length + 2);
  });
});

describe("Desk — an account under water", () => {
  const underwater = fold([...LEDGER, {
    id: 7, seq: 7, holderId: null, occurredOn: "2026-08-18",
    type: "equity_reading" as const, amountCents: 3_811_044n,
    feeSettlement: null, splitBpsApplied: null, reversesId: null,
  }], SEEDS);

  beforeEach(() => renderDesk({ state: underwater, entryCount: 7, live: null }));

  it("shows the accrued fee as zero, because no one is above their mark", () => {
    expect(screen.getByLabelText("Fee if everyone paid out today").textContent).toBe("$0.00");
  });

  it("shows investor P/L negative, with a minus sign and not only a colour", () => {
    // Spec 8.4: colour is never the sole carrier. The sign is the carrier.
    // The plan's own Task 8 snippet transcribes this as -$3,076.86; the real
    // engine run (and derive.test.ts's already-landed "everyone under water"
    // case: Ada -1364.83 + Grace -1712.02) gives -$3,076.85. Confirmed by
    // running it, not by trusting either transcription — see the task report.
    expect(screen.getByLabelText("Investor P/L").textContent).toBe("-$3,076.85");
  });

  it("shows growth since inception as negative", () => {
    expect(screen.getByLabelText("Since inception").textContent).toBe("-5.26%");
  });

  it("omits the live block entirely when nothing has been pushed", () => {
    expect(screen.queryByLabelText("Live equity")).toBeNull();
    expect(screen.queryByText(/Live · not yet posted/)).toBeNull();
  });
});

describe("Desk — a new account", () => {
  it("says what to do instead of rendering a statement of zeroes", () => {
    renderDesk({ state: fold([], SEEDS), entryCount: 0, live: null });
    expect(screen.getByText("Nothing posted yet")).toBeInTheDocument();
    expect(screen.queryByLabelText("Account equity")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("Desk — currency", () => {
  it("renders every figure in the account's currency", () => {
    renderDesk({ currency: "EUR" });
    expect(screen.getByLabelText("Account equity").textContent).toBe("€55,743.91");
    expect(screen.getByLabelText("Fee if everyone paid out today").textContent).toBe("€1,409.67");
  });
});

describe("Desk — a holder who has fully exited", () => {
  // Grace exits every unit she holds after seq 6, crystallising her accrued
  // fee to the manager as units (same feeSettlement:"units" shape
  // derive.test.ts's payout fixtures use). fold() marks her `status:
  // "closed"` and zeroes her units and basis. Neither the canonical fixture
  // (fixture.ts) nor any test built through Task 7 exercises a closed holder
  // through a real rendered page — deskFigures and railSegments both carry a
  // status/units filter for exactly this case, and this is the first test
  // that renders both together and checks every surface they touch: the
  // Holders count, the two investor KPI tiles, the rail's segment count, and
  // the table row itself.
  const exitEntry = {
    id: 7, seq: 7, holderId: GRACE_ID, occurredOn: "2026-08-20",
    type: "exit" as const, amountCents: centsFromDecimal("8466.04"),
    feeSettlement: "units" as const, splitBpsApplied: 3700, reversesId: null,
  };
  const entries = [...LEDGER, exitEntry];
  const closedState = fold(entries, SEEDS);

  it("excludes the closed holder from the Holders count", () => {
    renderDesk({ state: closedState, entryCount: entries.length });
    expect(screen.getByLabelText("Holders").textContent).toBe("2");
  });

  it("excludes the closed holder's capital and value from the investor KPI tiles", () => {
    // Before the exit these read $17,500.00 and $21,096.65 (Ada + Grace).
    // With Grace closed they must fall to Ada's figures alone — not stay at
    // the pre-exit total, which is what a filter keyed on unit count rather
    // than status would do if it ran before fold() zeroed her units.
    renderDesk({ state: closedState, entryCount: entries.length });
    expect(screen.getByLabelText("Investor capital in").textContent).toBe("$10,000.00");
    expect(screen.getByLabelText("Investor value now").textContent).toBe("$12,630.61");
  });

  it("drops the closed holder's segment from the ownership rail entirely", () => {
    renderDesk({ state: closedState, entryCount: entries.length });
    const segs = document.querySelectorAll<HTMLElement>(".seg");
    expect(segs).toHaveLength(2);
    const legend = screen.getByRole("list", { name: "Ownership legend" });
    expect(legend.textContent).not.toContain("Grace Hopper");
  });

  it("still lists the closed holder in the table, tagged Closed, with no payout link even once holderActions is on", () => {
    renderDesk({
      state: closedState,
      entryCount: entries.length,
      actions: <a className="btn" href="/a/7/actions/reading">Post a reading</a>,
      holderActions: true,
    });
    const row = screen.getByRole("row", { name: /Grace Hopper/ });
    expect(within(row).getByText("Closed")).toBeInTheDocument();
    expect(within(row).queryByRole("link", { name: "Pay out" })).toBeNull();
    // The column itself exists — an active holder still gets the link — so
    // the absence above is because she is closed, not because Phase A hid
    // the whole column.
    const active = screen.getByRole("row", { name: /Ada Lovelace/ });
    expect(within(active).getByRole("link", { name: "Pay out" })).toBeInTheDocument();
  });
});
