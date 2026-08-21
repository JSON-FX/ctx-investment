-- ============================================================================
-- Compound's own six tables. Design spec section 6.
-- ============================================================================
--
-- Unlike the copytraderx_fixture_tables migration, these tables DO eventually
-- belong in the live CopyTraderX Supabase project (decision D2: same project,
-- compound_ prefix, no sync layer). Applying them there is a separate,
-- human-approved step. Nothing in this repository does it automatically.
--
-- Two things this schema deliberately does NOT store, per section 6.1:
--   * units and cost basis anywhere. Both are derived by folding the ledger.
--   * units_delta and nav_at_entry on a ledger entry. Storing a derived value
--     creates a second truth that can disagree with engine/replay.ts after any
--     change to it.
-- split_bps_applied is the single exception: the terms in force at the moment
-- of a payout are an input, because a holder's split may change afterwards.
--
-- Every uuid foreign key points at public.users, not auth.users. The spec's
-- section 6 sketch says auth.users; CopyTraderX puts an application-level
-- projection table in between, and licenses, subscriptions and
-- subscription_extensions all reference public.users(id). Compound's account
-- is owned by an application user with a role, which is what public.users
-- models. See decision P1 in the plan.
-- ============================================================================

create table public.compound_account (
  id                bigserial   primary key,
  mt5_account       bigint      not null unique,
  label             text        not null,
  broker            text,
  currency          text        not null default 'USD',
  default_split_bps int         not null default 4000
                      check (default_split_bps between 0 and 10000),
  inception_date    date        not null,
  manager_user_id   uuid        not null references public.users (id),
  created_at        timestamptz not null default now()
);

-- Every RLS policy in the next migration resolves through manager_user_id.
create index compound_account_manager_user_id_idx
  on public.compound_account (manager_user_id);

comment on column public.compound_account.manager_user_id is
  'Manager identity is data, not a role (section 9). Keeps D5 multi-account open '
  'without inventing a role per manager, and lets D1 be relaxed later without a '
  'role migration.';

create table public.compound_holder (
  id         bigserial   primary key,
  account_id bigint      not null references public.compound_account (id),
  name       text        not null,
  email      text,
  user_id    uuid        references public.users (id),
  is_manager boolean     not null default false,
  split_bps  int         not null check (split_bps between 0 and 10000),
  joined_at  date,
  status     text        not null check (status in ('active','closed')),
  created_at timestamptz not null default now()
);

create index compound_holder_account_id_idx on public.compound_holder (account_id);

-- engine/replay.ts resolves the fee-receiving manager with
-- holders.find(h => h.isManager) and throws when there is none. With two, it
-- would silently pick whichever came back first and the choice would depend on
-- row order. One per account, enforced here.
create unique index compound_holder_one_manager_per_account
  on public.compound_holder (account_id)
  where is_manager;

comment on table public.compound_holder is
  'Identity and terms only. units, cost_basis, lifetime_deposited, '
  'lifetime_withdrawn and lifetime_fees are deliberately absent — all derived '
  'from the ledger (section 6.1).';

create table public.compound_ledger_entry (
  id                bigserial   primary key,
  account_id        bigint      not null references public.compound_account (id),
  holder_id         bigint      references public.compound_holder (id),
  seq               bigint      not null check (seq > 0),
  occurred_on       date        not null,
  recorded_at       timestamptz not null default now(),
  type              text        not null check (type in
                      ('deposit','payout','exit','equity_reading','adjustment')),
  amount_cents      bigint      not null,
  fee_settlement    text        check (fee_settlement in ('units','cash')),
  split_bps_applied int         check (split_bps_applied between 0 and 10000),
  note              text,
  reverses_id       bigint      references public.compound_ledger_entry (id),
  created_by        uuid        references public.users (id),

  -- seq, not occurred_on, defines replay order (section 6.2). Monotonic per
  -- account, assigned server-side by compound_commit_reading_plan.
  constraint compound_ledger_entry_account_seq_key unique (account_id, seq),

  -- replay.ts refuses to fold a payout or exit with no splitBpsApplied,
  -- because replaying against the holder's *current* split would make history
  -- depend on mutable state. Refuse the row instead of the fold.
  constraint compound_ledger_entry_payout_needs_split check (
    type not in ('payout','exit') or split_bps_applied is not null
  ),

  -- A reading and an adjustment move the pool; they belong to no holder.
  -- A deposit, payout or exit always belongs to one. The third arm defers to
  -- compound_ledger_entry_type_check for any type outside those five: without
  -- it, an invalid type satisfies neither of the first two arms and this
  -- constraint fails too, so which of the two error messages Postgres reports
  -- becomes a coin flip instead of type_check owning "is the type valid" and
  -- this constraint owning "does holder presence match the type category".
  constraint compound_ledger_entry_holder_presence check (
    (type in ('equity_reading','adjustment') and holder_id is null)
    or (type in ('deposit','payout','exit') and holder_id is not null)
    or type not in ('equity_reading','adjustment','deposit','payout','exit')
  ),

  -- fee_settlement carries the units-or-cash choice for the fee crystallised
  -- inside a payout. There is no separate 'fee' entry type — a separate
  -- applied entry would double-count (section 6.1).
  constraint compound_ledger_entry_fee_settlement_scope check (
    fee_settlement is null or type in ('payout','exit')
  )
);

create index compound_ledger_entry_account_occurred_idx
  on public.compound_ledger_entry (account_id, occurred_on);

create index compound_ledger_entry_holder_idx
  on public.compound_ledger_entry (holder_id)
  where holder_id is not null;

comment on table public.compound_ledger_entry is
  'The only truth. Append-only: corrections are reversing entries pointing at '
  'reverses_id, never edits. Enforced by grants and triggers in the '
  'compound_ledger_append_only migration.';

create table public.compound_capital_event_candidate (
  id                       bigserial   primary key,
  account_id               bigint      not null references public.compound_account (id),
  trade_date               date        not null,
  balance_delta_cents      bigint      not null,
  explained_cents          bigint      not null,
  unexplained_cents        bigint      not null,
  status                   text        not null default 'pending'
                             check (status in ('pending','classified','ignored')),
  resolved_ledger_entry_id bigint      references public.compound_ledger_entry (id),
  detected_at              timestamptz not null default now(),
  resolved_at              timestamptz,
  resolved_by              uuid        references public.users (id),

  -- One candidate per account per day. This is what makes a repeated
  -- reconciler run against an unresolved event a no-op rather than a pile of
  -- duplicate review items.
  constraint compound_capital_event_candidate_account_date_key
    unique (account_id, trade_date)
);

create index compound_capital_event_candidate_pending_idx
  on public.compound_capital_event_candidate (account_id, trade_date)
  where status = 'pending';

create table public.compound_reconcile_cursor (
  account_id        bigint primary key references public.compound_account (id),
  last_reading_date date,
  last_run_at       timestamptz
);

comment on table public.compound_reconcile_cursor is
  'How far equity readings have been posted. The safety interlock (section 5.3) '
  'is this cursor refusing to cross an unclassified capital event.';

-- account_id is not in the spec sketch. Added so compound_audit can carry the
-- same RLS key as the other five tables (decision P6). Nullable, because an
-- action may precede any account existing.
create table public.compound_audit (
  id          bigserial   primary key,
  account_id  bigint      references public.compound_account (id),
  actor       uuid        references public.users (id),
  action      text        not null,
  entity      text        not null,
  entity_id   bigint,
  prior_state jsonb,
  at          timestamptz not null default now()
);

create index compound_audit_account_idx on public.compound_audit (account_id, at desc);
