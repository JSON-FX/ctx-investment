-- ============================================================================
-- LOCAL FIXTURE SEED — entirely fictional, for local dev / integration tests
-- only. No real account numbers, broker names, balances or holder names.
-- Re-run automatically by `supabase db reset`; see supabase/README section
-- "Local Supabase (dev stack)" in the repo README for the reconciler
-- scenarios this seed is built to exercise.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- auth.users / auth.identities — two fictional users so compound_* RLS
-- policies (added by a later migration) have real auth.uid() values to test
-- against, and so licenses.user_id has something to point at.
--
-- instance_id 00000000-0000-0000-0000-000000000000 is GoTrue's standard
-- fixed local/self-hosted instance id, not a project secret. The user ids
-- below are deliberately all-zeroes-plus-a-digit so they read as fixtures
-- at a glance.
--
-- NOTE: the `role` hint in raw_app_meta_data below is this fixture's own
-- best guess at where Compound will look for admin/investor role — it is
-- NOT a confirmed fact about the live CopyTraderX auth schema (that lives
-- in a sibling repo this migration cannot see). Verify before relying on it.
-- ----------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data,
  is_super_admin, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000000001',
    'authenticated', 'authenticated',
    'manager@example.com',
    crypt('fixture-only-not-a-real-password', gen_salt('bf')),
    now(), '', '', '', '',
    '{"provider":"email","providers":["email"],"role":"admin"}',
    '{"full_name":"Fixture Manager"}',
    false, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000000002',
    'authenticated', 'authenticated',
    'investor@example.com',
    crypt('fixture-only-not-a-real-password', gen_salt('bf')),
    now(), '', '', '', '',
    '{"provider":"email","providers":["email"],"role":"investor"}',
    '{"full_name":"Fixture Investor"}',
    false, now(), now()
  );

insert into auth.identities (
  id, provider_id, user_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
) values
  (
    gen_random_uuid(),
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    '{"sub":"00000000-0000-0000-0000-000000000001","email":"manager@example.com"}',
    'email', now(), now(), now()
  ),
  (
    gen_random_uuid(),
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000002',
    '{"sub":"00000000-0000-0000-0000-000000000002","email":"investor@example.com"}',
    'email', now(), now(), now()
  );

-- ----------------------------------------------------------------------------
-- licenses — resolves the fixture MT5 account to its owner (the manager;
-- investors hold units in the pool, they do not own the MT5 account).
-- ----------------------------------------------------------------------------
insert into public.licenses (mt5_account, product, status, user_id) values
  (90000001, 'copytraderx-impulse', 'active', '00000000-0000-0000-0000-000000000001');

-- ----------------------------------------------------------------------------
-- account_snapshots_daily — ten weekday rows, 2026-08-03 through 2026-08-14.
-- balance_close[n] - balance_close[n-1] is exactly explained by that
-- window's deals, EXCEPT 2026-08-12 (the deliberate unexplained jump).
-- equity_close == balance_close throughout: nothing is left open overnight
-- in this fixture, so there is no floating P/L at any day's close.
--
-- Running balance starts from an implicit prior close of 50,000.00 (not
-- itself stored — there is no 2026-08-02 row).
-- ----------------------------------------------------------------------------
insert into public.account_snapshots_daily
  (mt5_account, trade_date, balance_close, equity_close, daily_pnl) values
  (90000001, '2026-08-03', 50120.00, 50120.00,   120.00), -- +120 (ticket 90010001)
  (90000001, '2026-08-04', 50075.00, 50075.00,   -45.00), -- -45  (ticket 90010002)
  (90000001, '2026-08-05', 50375.00, 50375.00,   300.00), -- +300 (ticket 90010003)
  (90000001, '2026-08-06', 50455.00, 50455.00,    80.00), -- +80  (ticket 90010004; duplicate 90019999 must NOT be double-counted)
  (90000001, '2026-08-07', 50395.00, 50395.00,   -60.00), -- -60  (ticket 90010005)
  -- weekend gap: no 2026-08-08 (Sat) or 2026-08-09 (Sun) row. A trade
  -- closes Saturday (ticket 90010006, BTCUSD, trades 24/7); its +200.00
  -- explains the entire Fri -> Mon delta below.
  (90000001, '2026-08-10', 50595.00, 50595.00,   200.00), -- +200 (ticket 90010006, closed Sat 08-08)
  (90000001, '2026-08-11', 50745.00, 50745.00,   150.00), -- +150 (ticket 90010007)
  -- THE candidate: +5000.00 balance move, daily_pnl 0.00, zero deals this
  -- day. This is the case reconcile/detect.ts exists to catch.
  (90000001, '2026-08-12', 55745.00, 55745.00,     0.00), -- +5000 jump, NO trade -> capital-event candidate
  (90000001, '2026-08-13', 55835.00, 55835.00,    90.00), -- +90  (ticket 90010008)
  (90000001, '2026-08-14', 55805.00, 55805.00,   -30.00); -- -30  (ticket 90010009)

-- ----------------------------------------------------------------------------
-- account_snapshots_current — the live/"now" row, deliberately different
-- from the last daily close: an open position is carrying +125.00 of
-- floating P/L that has not closed (and so does not appear in `deals` or
-- in the 2026-08-14 daily row). This is what exercises the "committed NAV
-- vs live NAV" distinction in ARCHITECTURE.md section 5 — a payout must
-- never settle against this row directly.
-- ----------------------------------------------------------------------------
insert into public.account_snapshots_current
  (mt5_account, balance, equity, margin, free_margin,
   margin_level, floating_pnl, drawdown_pct, leverage, currency, server, pushed_at)
values
  (90000001, 55805.00, 55930.00, 500.00, 55430.00,
   11186.00, 125.00, 0.00, 100, 'USD', 'FixtureBroker-Demo', '2026-08-14T18:45:00+00');

-- ----------------------------------------------------------------------------
-- deals — nine real closed trades plus one deliberate duplicate.
--
-- swap and commission are 0.00 on every row on purpose, so profit alone
-- carries the whole daily_pnl delta above and the arithmetic stays exact
-- and easy to eyeball.
-- ----------------------------------------------------------------------------
insert into public.deals
  (mt5_account, ticket, ea_source, symbol, side, volume,
   open_price, close_price, sl, tp, open_time, close_time,
   profit, swap, commission, comment, magic)
values
  (90000001, 90010001, 'fixture-ea-v1', 'EURUSD', 'buy',  0.10,
   1.08500, 1.08620, null, null,
   '2026-08-03T07:00:00+00', '2026-08-03T09:00:00+00',
   120.00, 0.00, 0.00, null, null),

  (90000001, 90010002, 'fixture-ea-v1', 'GBPUSD', 'sell', 0.05,
   1.27300, 1.28200, null, null,
   '2026-08-04T08:00:00+00', '2026-08-04T10:30:00+00',
   -45.00, 0.00, 0.00, null, null),

  (90000001, 90010003, 'fixture-ea-v1', 'XAUUSD', 'buy',  0.02,
   2400.00, 2415.00, null, null,
   '2026-08-05T06:00:00+00', '2026-08-05T13:00:00+00',
   300.00, 0.00, 0.00, null, null),

  -- the real fill of the duplicate-deal pair
  (90000001, 90010004, 'fixture-ea-v1', 'EURUSD', 'sell', 0.10,
   1.08700, 1.08620, null, null,
   '2026-08-06T07:00:00+00', '2026-08-06T08:00:00+00',
   80.00, 0.00, 0.00, null, null),

  -- the upstream-defect duplicate: identical symbol/side/volume/profit/swap,
  -- BOTH timestamps shifted +3h, ticket deliberately out of sequence
  -- (90019999 does not fit between 90010004 and 90010005). Models broker
  -- server time (UTC+3) being stored as if it were already UTC.
  (90000001, 90019999, 'fixture-ea-v1', 'EURUSD', 'sell', 0.10,
   1.08700, 1.08620, null, null,
   '2026-08-06T10:00:00+00', '2026-08-06T11:00:00+00',
   80.00, 0.00, 0.00, null, null),

  (90000001, 90010005, 'fixture-ea-v1', 'GBPUSD', 'buy',  0.05,
   1.28100, 1.26900, null, null,
   '2026-08-07T09:00:00+00', '2026-08-07T14:00:00+00',
   -60.00, 0.00, 0.00, null, null),

  -- closes on a Saturday: BTCUSD trades 24/7, unlike the FX pairs above.
  -- Explains the entire Fri 08-07 -> Mon 08-10 daily-snapshot delta.
  (90000001, 90010006, 'fixture-ea-v1', 'BTCUSD', 'buy',  0.01,
   61000.00, 61500.00, null, null,
   '2026-08-08T10:00:00+00', '2026-08-08T15:00:00+00',
   200.00, 0.00, 0.00, null, null),

  (90000001, 90010007, 'fixture-ea-v1', 'EURUSD', 'sell', 0.15,
   1.09000, 1.07800, null, null,
   '2026-08-11T07:30:00+00', '2026-08-11T12:00:00+00',
   150.00, 0.00, 0.00, null, null),

  -- NOTE: no deal on 2026-08-12 at all -- that is the point of that day.

  (90000001, 90010008, 'fixture-ea-v1', 'GBPUSD', 'buy',  0.05,
   1.26500, 1.28300, null, null,
   '2026-08-13T08:00:00+00', '2026-08-13T11:00:00+00',
   90.00, 0.00, 0.00, null, null),

  (90000001, 90010009, 'fixture-ea-v1', 'XAUUSD', 'sell', 0.01,
   2410.00, 2413.00, null, null,
   '2026-08-14T06:00:00+00', '2026-08-14T09:00:00+00',
   -30.00, 0.00, 0.00, null, null);
