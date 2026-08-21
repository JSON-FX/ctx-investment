/**
 * The columns of compound_ledger_entry that fold() must never see.
 *
 * note, recorded_at and created_by are provenance. They belong on a screen and
 * in a dispute, and they must not reach the reducer: an entry's effect on the
 * pool cannot depend on who typed it or when the row was written. Plan 3's
 * LedgerEntry deliberately omits them, and this reader deliberately returns
 * nothing else — the two shapes cannot be confused for one another.
 *
 * recorded_at is UTC and occurred_on is a broker-server date. Spec section 4
 * keeps both because they answer different questions: what day the broker says
 * it happened, and what moment this office wrote it down.
 *
 * This type is NOT imported by lib/compound/ui/ledger-table.tsx. ui/purity.test.ts
 * forbids any import from "@/lib/compound/db" in a ui/ source file — including
 * a type-only import, since the regex matches the module specifier regardless
 * of the `type` keyword. ledger-table.tsx instead declares the shape of its
 * `meta` prop structurally; TypeScript's structural typing means a real
 * Map<number, LedgerEntryMeta> built here still satisfies it at the page,
 * with no import needed in either direction.
 */
import type { Queryable } from "./types";
import { toId, utcIsoExpr } from "./sql";

export interface LedgerEntryMeta {
  id: number;
  /** ISO 8601, UTC. */
  recordedAt: string;
  note: string | null;
  /** public.users id, or null for an entry written by a job. */
  createdBy: string | null;
}

export async function listLedgerMeta(
  c: Queryable,
  accountId: number,
): Promise<LedgerEntryMeta[]> {
  const { rows } = await c.query<{
    id: string; recorded_at: string; note: string | null; created_by: string | null;
  }>(
    `select id, ${utcIsoExpr("recorded_at")} as recorded_at, note, created_by
       from public.compound_ledger_entry
      where account_id = $1
      order by seq asc`,
    [accountId],
  );
  return rows.map((r) => ({
    id: toId(r.id, "compound_ledger_entry.id"),
    recordedAt: r.recorded_at,
    note: r.note,
    createdBy: r.created_by,
  }));
}
