-- ============================================================================
-- P6 — partial capital withdrawal. Widen compound_ledger_entry to accept the
-- new 'withdrawal' entry type.
-- ============================================================================
--
-- Migrations are append-only (this repository never edits a shipped file),
-- so the four CHECK constraints compound_core_tables.sql defined on `type`
-- are dropped and recreated here rather than altered in place. Each is
-- widened by exactly one value, 'withdrawal', and is otherwise identical to
-- the original — see that file for the full reasoning behind each one.
--
-- 'withdrawal' behaves like 'payout' and 'exit' for three of the four
-- constraints (it needs a holder, it needs split_bps_applied, and it may
-- carry fee_settlement) and is a new, fifth arm of the account_seq_key
-- constraint's sibling, the type list itself.
-- ============================================================================

alter table public.compound_ledger_entry
  drop constraint compound_ledger_entry_type_check;
alter table public.compound_ledger_entry
  add constraint compound_ledger_entry_type_check check (type in
    ('deposit','payout','exit','withdrawal','equity_reading','adjustment'));

alter table public.compound_ledger_entry
  drop constraint compound_ledger_entry_payout_needs_split;
alter table public.compound_ledger_entry
  add constraint compound_ledger_entry_payout_needs_split check (
    type not in ('payout','exit','withdrawal') or split_bps_applied is not null
  );

alter table public.compound_ledger_entry
  drop constraint compound_ledger_entry_holder_presence;
alter table public.compound_ledger_entry
  add constraint compound_ledger_entry_holder_presence check (
    (type in ('equity_reading','adjustment') and holder_id is null)
    or (type in ('deposit','payout','exit','withdrawal') and holder_id is not null)
    or type not in ('equity_reading','adjustment','deposit','payout','exit','withdrawal')
  );

alter table public.compound_ledger_entry
  drop constraint compound_ledger_entry_fee_settlement_scope;
alter table public.compound_ledger_entry
  add constraint compound_ledger_entry_fee_settlement_scope check (
    fee_settlement is null or type in ('payout','exit','withdrawal')
  );
