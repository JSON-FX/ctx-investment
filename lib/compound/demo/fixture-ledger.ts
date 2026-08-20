/**
 * A fictional ledger used to demonstrate the engine end to end.
 *
 * This is DEMONSTRATION DATA. Every name and figure here is invented. The
 * repository is public, so no real account, balance or holder appears anywhere
 * in it — see the design spec, §10 "Secrets discipline".
 *
 * The sequence deliberately exercises the interesting paths: genesis, a
 * staggered second and third entry at different NAVs, a drawdown, and a
 * profit-only payout whose fee is retained as units.
 */
import { centsFromDecimal } from "@/lib/compound/engine/money";
import type { HolderSeed, LedgerEntry, LedgerEntryType } from "@/lib/compound/engine/replay";

export const DEMO_HOLDERS: HolderSeed[] = [
  { holderId: 0, isManager: true, splitBps: 0 },
  { holderId: 1, isManager: false, splitBps: 4000 },
  { holderId: 2, isManager: false, splitBps: 4000 },
  { holderId: 3, isManager: false, splitBps: 3500 },
];

export const DEMO_HOLDER_NAMES: Record<number, string> = {
  0: "You",
  1: "Investor A",
  2: "Investor B",
  3: "Investor C",
};

interface Step {
  type: LedgerEntryType;
  on: string;
  amount: string;
  holderId?: number;
  feeSettlement?: "units" | "cash";
  splitBpsApplied?: number;
  note: string;
}

const STEPS: Step[] = [
  { type: "deposit", on: "2026-03-02", amount: "6000", holderId: 0, note: "Founding capital" },
  { type: "deposit", on: "2026-03-02", amount: "9000", holderId: 1, note: "Founding investor" },
  { type: "equity_reading", on: "2026-03-20", amount: "15720", note: "Weekly reading" },
  { type: "equity_reading", on: "2026-04-06", amount: "16340", note: "Weekly reading" },
  { type: "equity_reading", on: "2026-04-21", amount: "15880", note: "Drawdown week" },
  { type: "equity_reading", on: "2026-05-04", amount: "17410", note: "Recovered" },
  { type: "deposit", on: "2026-05-11", amount: "14000", holderId: 2, note: "Merged in at prevailing NAV" },
  { type: "equity_reading", on: "2026-05-28", amount: "32900", note: "Weekly reading" },
  { type: "equity_reading", on: "2026-06-15", amount: "34620", note: "Weekly reading" },
  {
    type: "payout",
    on: "2026-06-18",
    amount: "0",
    holderId: 1,
    feeSettlement: "units",
    splitBpsApplied: 4000,
    note: "Profit taken · fee retained as units",
  },
  { type: "equity_reading", on: "2026-07-02", amount: "35980", note: "Weekly reading" },
  { type: "equity_reading", on: "2026-07-19", amount: "34910", note: "Choppy fortnight" },
  { type: "deposit", on: "2026-07-27", amount: "11000", holderId: 3, note: "Merged in at prevailing NAV" },
  { type: "equity_reading", on: "2026-08-09", amount: "47850", note: "Weekly reading" },
  { type: "equity_reading", on: "2026-08-21", amount: "49640", note: "Latest reading" },
];

export const DEMO_NOTES: Record<number, string> = Object.fromEntries(
  STEPS.map((s, i) => [i + 1, s.note]),
);

export const DEMO_LEDGER: LedgerEntry[] = STEPS.map((s, i) => ({
  id: i + 1,
  seq: i + 1,
  holderId: s.holderId ?? null,
  occurredOn: s.on,
  type: s.type,
  amountCents: centsFromDecimal(s.amount),
  feeSettlement: s.feeSettlement ?? null,
  splitBpsApplied: s.splitBpsApplied ?? null,
  reversesId: null,
}));
