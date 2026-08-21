-- ============================================================================
-- The broker's UTC offset, per account.
-- ============================================================================
--
-- reconcile/dedupe.ts groups duplicate deals on (symbol, side, volume, profit,
-- swap) and keeps the lowest ticket where close times differ by exactly the
-- broker's offset. The offset is a property of the broker's server, so it
-- belongs on the account and not in configuration.
--
-- NULLABLE, and with NO DEFAULT, deliberately. A default of 0 would mean "no
-- shift", and dedupe at a zero shift is a no-op — so a brand-new account would
-- silently run with duplicate-deal protection disabled and nobody would know.
-- Null means NOT CONFIGURED, and the application refuses to reconcile until it
-- is set. Reconciling undeduplicated inflates the explained figure and can hide
-- a real capital event, which is the most expensive failure this product has.
--
-- Range is 1..14, MATCHING dedupeDeals' own MIN_OFFSET_HOURS..MAX_OFFSET_HOURS.
-- The column holds the MAGNITUDE of the broker server's UTC offset, because
-- that is all dedupeDeals uses: it looks for pairs whose close times differ by
-- exactly that many hours, in either direction.
--
-- The range deliberately excludes 0. dedupeDeals throws a RangeError on 0, so a
-- column that permitted it would store a value the engine refuses, and the
-- failure would surface as a crash inside a reconcile run rather than as a
-- refused edit. A broker genuinely running on UTC is therefore not supported;
-- see the note below the migration for what that would take.
-- ============================================================================

alter table public.compound_account
  add column broker_offset_hours int;

alter table public.compound_account
  add constraint compound_account_broker_offset_hours_range
  check (broker_offset_hours is null or broker_offset_hours between 1 and 14);

comment on column public.compound_account.broker_offset_hours is
  'Magnitude of the broker server UTC offset, in hours, 1..14. NULL means not '
  'configured, and disables reconciliation rather than running the duplicate-deal '
  'guard as a no-op. Matches dedupeDeals MIN_OFFSET_HOURS..MAX_OFFSET_HOURS.';

-- A limitation, stated rather than discovered later: dedupe.ts sets
-- MIN_OFFSET_HOURS = 1, so an account whose broker runs on UTC exactly cannot
-- be reconciled — there is no legal value to store here. At a zero offset the
-- duplicate class this guard exists for cannot arise, so dedupe would be a
-- no-op there anyway; the product's current answer is "you cannot configure
-- this account" rather than "no dedupe is needed here". Fixing that means
-- widening MIN_OFFSET_HOURS to 0 in the reconciler and letting dedupeDeals
-- return everything untouched — a reconciler change, out of scope here and not
-- made. No broker in use has a zero offset.
