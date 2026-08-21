# Task 5 report — property suite for the interlock

Branch: `feat/reconcile-property`
Commit: `23da6388cf6a92cd04e746c3a20d7f92bd0400a6` — `test(reconcile): property suite for the interlock's safety invariant`
File added: `lib/compound/reconcile/reconcile.property.test.ts` (254 lines, new file, only file in the commit)

## What was added

Transcribed the Task 5 brief (`docs/superpowers/plans/2026-08-21-compound-reconciler.md`,
lines 1218–1409) into `lib/compound/reconcile/reconcile.property.test.ts`: seven
`fc.assert` properties over a shared `build()` fixture that generates arbitrary
day sequences (traded P/L, capital events, skipped/weekend days) and checks
`dedupeDeals`, `reconcileDays`, and `planReadings` against them.

I diffed my final file against the brief's verbatim code block
(`sed -n '1218,1409p'` of the plan doc) to confirm the only deviations are the
ones below — imports, `dayArb`, `dateAt`, the `Day` interface, `OFFSET_HOURS`,
and five of the seven properties are byte-for-byte identical to the brief.

## R3 — `utcDateKey`, not `.slice`

Added `import { utcDateKey } from "./date-key";` and, in the last property
("every reconciled interval covers each trade exactly once"), replaced
`d.closeTime.slice(0, 10)` with `utcDateKey(d.closeTime)`. No behavioral
effect today (the generator's `closeTime` values all carry a literal `Z`
suffix, so slicing and parsing agree), but it stops the property from rotting
silently if the fixture ever grows a non-UTC offset.

## R8 — per-date equity/balance divergence

**a.** Added `FIXTURE_EPOCH` and `floatingFor(tradeDate)` (identical in shape
to the helper already established in `interlock.test.ts` and `detect.test.ts`
for the same reason). Updated both snapshot-push sites in `build()` — the
initial `dateAt(0)` snapshot and the per-day snapshot inside `days.forEach`
— so `equityCloseCents: balance + floatingFor(date)` instead of
`equityCloseCents: balance`.

**b.** Appended the new property `"posts each snapshot's equity, never its
balance"`, exactly as specified, asserting every `PlannedReading.equityCents`
matches its snapshot's `equityCloseCents`, with an error message naming both
figures.

## Did an existing property change behaviour under R8?

**No property's pass/fail depends on R8.** R8 only changes `equityCloseCents`
values, and of the six brief-original properties, none reads
`equityCloseCents` — only the new seventh property does. I confirmed this
both by inspection and by the fact that reverting R8 mentally (setting
`floatingFor` to constant 0, i.e. the brief's original `equityCloseCents:
balance`) changes nothing about `balance` or `deals`, which are all the other
six properties consume.

**However, running the transcribed file for the first time did turn up one
failure**, in "every reconciled interval covers each trade exactly once" —
and I want to be precise that this was **not caused by R3 or R8**. Full
account below, since it's the one place I deviated from the brief beyond the
two authorized rulings.

### The defect I found, and why it isn't R3/R8

First run (`pnpm test -- reconcile.property --verbose`), 6 passed, 1 failed:

```
● reconciler properties › every reconciled interval covers each trade exactly once

  Property failed after 3 tests
  { seed: -298128364, path: "2:1:0:1:1:1:0:1:0:0:0:0:0:0:0:0:0:0:0:0:0:0", endOnFailure: true }
  Counterexample: [[{"tradedCents":0n,"capitalCents":0n,"skipped":false},{"tradedCents":1n,"capitalCents":0n,"skipped":true}]]
  Shrunk 21 time(s)
  Got error: intervals explained 0, deals net 1
```

Tracing `build()` on this counterexample: day 2 (`tradedCents: 1n, skipped:
true`) produces a deal that closes on `2026-05-04`, but because it's
`skipped`, **no snapshot is ever written for `2026-05-04`** — and it's the
last day in the sequence, so no later snapshot exists either. `reconcileDays`
correctly has nothing to say about that deal: it only produces intervals
between *consecutive pairs of snapshots it's given*, i.e. it covers exactly
`(first snapshot date, last snapshot date]`. A deal closing after the last
snapshot belongs to a future interval that hasn't arrived yet.

The brief's oracle only bounded the filter on the *start* side
(`d.closeTime.slice(0,10) > snapshots[0].tradeDate`) and never on the *end*
side, so it counted that trailing deal as "should be explained" when
`reconcileDays` — correctly — never included it anywhere.

This is provably orthogonal to both rulings:
- **R8**: this property never reads `equityCloseCents`; only `balanceCloseCents`
  (via `reconcileDays`) and `deals`. R8 cannot change its outcome.
- **R3**: `.slice(0, 10)` and `utcDateKey()` agree on every timestamp this
  generator produces (all carry a literal `Z`). Swapping one for the other
  cannot change which deals pass the filter.

I also found the exact symmetric case already tested and documented as
*intentional, correct* behavior in `detect.test.ts`:

> `"does not count a trade that closed before the interval opened"` — *"The
> 05-03 close belongs to the interval ending 05-03, not the one ending
> 05-04."*

That's the same boundary rule at the other end of the span. So: **the
implementation (`detect.ts`) is correct; the brief's test oracle had an
unbounded upper edge.** This would have failed with the identical
counterexample on a byte-for-byte verbatim transcription of the brief, with
neither ruling applied — R8 just happened to be the run that surfaced it,
because it's the first time this file was executed at all.

### The fix

Bounded the filter on both ends, using the snapshot span's actual first and
last dates:

```typescript
const firstDate = snapshots[0]!.tradeDate;
const lastDate = snapshots[snapshots.length - 1]!.tradeDate;
const totalNet = deals
  .filter((d) => {
    const day = utcDateKey(d.closeTime);
    return day > firstDate && day <= lastDate;
  })
  .reduce((s, d) => s + d.profitCents + d.swapCents + d.commissionCents, 0n);
```

This is strictly more precise, not weaker — it can only *remove* false
failures outside `reconcileDays`' documented span; any real mismatch inside
`(first, last]` is still caught exactly as before. After the fix, all 7
properties pass (see green run below).

**This is a deviation beyond R3/R8 that the task's "transcribe faithfully"
instruction didn't explicitly authorize, so I'm flagging it prominently
rather than treating it as routine.** I did not touch `dedupe.ts`, `detect.ts`,
`interlock.ts`, `date-key.ts`, or `types.ts` — only my own test file's oracle.
If the controller disagrees with this judgment call, the revert is a two-line
change back to the brief's original filter (it will then need `minLength: 2`
on the outer array reduced or the skipped-trailing-day case otherwise
excluded, or the test will be flaky against this exact class of input).

## Full green run

```
$ pnpm typecheck && pnpm test

> ctx-investment@0.1.0 typecheck
> tsc --noEmit
                                              (clean, no output)

> ctx-investment@0.1.0 test
> jest

PASS lib/compound/reconcile/reconcile.property.test.ts
PASS lib/compound/engine/engine.property.test.ts
PASS lib/compound/engine/replay.test.ts
PASS lib/compound/engine/nav.test.ts
PASS lib/compound/reconcile/interlock.test.ts
PASS lib/compound/engine/quote.test.ts
PASS lib/compound/engine/invariants.test.ts
PASS lib/compound/reconcile/dedupe.test.ts
PASS lib/compound/reconcile/detect.test.ts
PASS lib/compound/engine/money.test.ts
PASS lib/compound/reconcile/purity.test.ts
PASS lib/compound/reconcile/date-key.test.ts
PASS lib/compound/engine/purity.test.ts
PASS lib/compound/reconcile/types.test.ts

Test Suites: 14 passed, 14 total
Tests:       186 passed, 186 total
```

186 = 179 baseline (confirmed before touching anything) + 7 new. The new
suite alone (`pnpm test -- reconcile.property --verbose`):

```
PASS lib/compound/reconcile/reconcile.property.test.ts
  reconciler properties
    ✓ never plans a reading on or after the day it halted on (18 ms)
    ✓ plans readings in strictly ascending date order, with no repeats (13 ms)
    ✓ a run with no capital events posts every snapshot (12 ms)
    ✓ resuming from the returned cursor never re-posts or skips a day (15 ms)
    ✓ dedupe never changes the net of the deals it keeps when there are no twins (6 ms)
    ✓ every reconciled interval covers each trade exactly once (14 ms)
    ✓ posts each snapshot's equity, never its balance (11 ms)

Tests: 7 passed, 7 total
```

## Probe 1 — move `readings.push` above the `isExplained` check

Edited `interlock.ts` so the current day's reading is pushed *before* the
halt check (so the unexplained day gets posted, then the halt still fires).
Ran `pnpm test -- reconcile.property --verbose`:

```
FAIL lib/compound/reconcile/reconcile.property.test.ts
  reconciler properties
    ✕ never plans a reading on or after the day it halted on (10 ms)
    ✓ plans readings in strictly ascending date order, with no repeats (17 ms)
    ✓ a run with no capital events posts every snapshot (12 ms)
    ✓ resuming from the returned cursor never re-posts or skips a day (16 ms)
    ✓ dedupe never changes the net of the deals it keeps when there are no twins (5 ms)
    ✓ every reconciled interval covers each trade exactly once (14 ms)
    ✓ posts each snapshot's equity, never its balance (10 ms)

  ● reconciler properties › never plans a reading on or after the day it halted on

    Property failed after 2 tests
    { seed: -803015607, path: "1:1:2:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:2:2", endOnFailure: true }
    Counterexample: [[{"tradedCents":0n,"capitalCents":1n,"skipped":false},{"tradedCents":0n,"capitalCents":0n,"skipped":false}]]
    Shrunk 19 time(s)
    Got error: posted 2026-05-03 at or past the unexplained day 2026-05-03

Tests: 1 failed, 6 passed, 7 total
```

Exactly the target property failed, immediately (2 tests, 19 shrinks) — this
is precisely the off-by-one the interlock exists to prevent: the unexplained
day (`2026-05-03`) got posted at the same moment it became the halt
candidate. The other 6 properties were unaffected. Reverted with
`git checkout -- lib/compound/reconcile/interlock.ts`; confirmed
`git diff lib/compound/reconcile/interlock.ts` empty and the suite green
again (7/7) before moving to probe 2.

## Probe 2 — post `balanceCloseCents` instead of `equityCloseCents`

Edited both sites in `interlock.ts` that populate `PlannedReading.equityCents`
(the `equityByDate` map and the cursor-null baseline push) to read
`balanceCloseCents`. Diff of the probe:

```diff
-  const equityByDate = new Map(ordered.map((s) => [s.tradeDate, s.equityCloseCents]));
+  const equityByDate = new Map(ordered.map((s) => [s.tradeDate, s.balanceCloseCents]));
...
-    readings.push({ occurredOn: first.tradeDate, equityCents: first.equityCloseCents });
+    readings.push({ occurredOn: first.tradeDate, equityCents: first.balanceCloseCents });
```

Ran `pnpm test -- reconcile.property --verbose`:

```
FAIL lib/compound/reconcile/reconcile.property.test.ts
  reconciler properties
    ✓ never plans a reading on or after the day it halted on (17 ms)
    ✓ plans readings in strictly ascending date order, with no repeats (12 ms)
    ✓ a run with no capital events posts every snapshot (13 ms)
    ✓ resuming from the returned cursor never re-posts or skips a day (16 ms)
    ✓ dedupe never changes the net of the deals it keeps when there are no twins (5 ms)
    ✓ every reconciled interval covers each trade exactly once (15 ms)
    ✕ posts each snapshot's equity, never its balance (7 ms)

  ● reconciler properties › posts each snapshot's equity, never its balance

    Property failed after 1 tests
    { seed: 78621432, path: "0:0:0:0", endOnFailure: true }
    Counterexample: [[{"tradedCents":0n,"capitalCents":0n,"skipped":false}]]
    Shrunk 3 time(s)
    Got error: posted 100000 for 2026-05-02; that snapshot's equity is 101580 and its balance is 100000

Tests: 1 failed, 6 passed, 7 total
```

R8's new property failed immediately (1 test, 3 shrinks), with the error
message showing exactly what it's designed to show: the posted value
(100000), the correct equity (101580), and the balance it was confused with
(100000) — clearly distinct, which is R8's whole point. Under the brief's
original fixture (`equityCloseCents: balance`), this same probe would have
posted `100000` while the snapshot's "equity" was also `100000` — a silent
pass, catching nothing. The other 6 properties were unaffected. Reverted with
`git checkout -- lib/compound/reconcile/interlock.ts`.

## `interlock.ts` unmodified — confirmed

```
$ git diff lib/compound/reconcile/interlock.ts
                                              (empty)
$ git status
On branch feat/reconcile-property
nothing to commit, working tree clean
```

Checked immediately before the commit. The commit
(`23da6388cf6a92cd04e746c3a20d7f92bd0400a6`) contains exactly one file:
`lib/compound/reconcile/reconcile.property.test.ts` (254 insertions, 0
deletions, new file). `dedupe.ts`, `detect.ts`, `interlock.ts`, `date-key.ts`,
and `types.ts` are byte-for-byte what they were at the start of this task.

## Self-review

- Diffed the final test file against the brief's verbatim code block
  (`sed -n '1218,1409p'` of the plan doc). The only deltas are: the
  `utcDateKey` import, `FIXTURE_EPOCH`/`floatingFor`, the two `build()`
  snapshot pushes, the last property's filter (R3 + the bound fix, discussed
  above), and the appended seventh property. Everything else — imports,
  `dayArb`, `dateAt`, the `Day` interface, `OFFSET_HOURS`, and five of the
  seven properties — is character-for-character identical to the brief.
- Confirmed the `floatingFor` divergence is genuinely non-zero and non-constant
  across every date this fixture can produce: `dateAt(0)` through `dateAt(29)`
  land at `days = 121..151` relative to `FIXTURE_EPOCH` (2026-01-01), so
  `floatingFor` ranges `1580n..1957n` — always positive, always distinct
  between consecutive dates (step size `13 × gap-in-days`, never 0). Matches
  the pattern already established and reviewed in `interlock.test.ts` and
  `detect.test.ts` for the identical reason.
- Verified `pnpm typecheck` clean and `pnpm test` green (186/186, 14/14
  suites) as the very last action before writing this report, after both
  probes were reverted.
- Confirmed no floating point on money: every money value in the new file is
  `bigint`; `number` is used only for `ticket`, `volumeMilliLots`,
  `OFFSET_HOURS`, and array indices, matching the global constraint.
  `Math.floor(...)`/`Date.parse(...)` in `floatingFor` operate on
  millisecond timestamps, not money, mirroring the existing, already-reviewed
  helper in the sibling test files.
- Confirmed `reconcile/` purity is untouched — I added a test file, which
  `purity.test.ts` explicitly excludes from its scan (`!f.endsWith(".test.ts")`),
  and the new file imports only from `fast-check` and sibling modules under
  `./`, nothing from `db/`, `next`, `react`, or `@supabase/*`.
- Did not push, did not merge, did not open a PR — commit sits locally on
  `feat/reconcile-property` per instructions.

## Concerns

1. **The interval-property date-bound fix is the one place I went beyond the
   two authorized rulings.** I'm confident in the diagnosis (backed by
   `detect.ts`'s own symmetric, already-tested boundary rule at the start of
   the span) and confident the fix is a tightening, not a weakening — but the
   task's framing was strict about touching nothing outside R3/R8, so this
   deserves a specific look rather than being waved through with the rest.
2. No other concerns. All three failures observed during this task (the one
   real oracle defect, plus the two deliberate probes) are accounted for
   above with counterexamples, and none implicate `dedupe.ts`, `detect.ts`,
   `interlock.ts`, `date-key.ts`, or `types.ts`.

---

# Fix round — R13

Coordinator review came back: **approved with two fixes.** R3, R8, and the
R12 oracle fix (the interval-property date-bound correction flagged as a
concern above) were all independently confirmed correct — the reviewer
traced R12 across two runs and confirmed the deferred trade is counted
exactly once when its snapshot arrives. `detect.ts` was right and the
brief's oracle was wrong; that diagnosis stands, and the concern from the
first round is resolved. Two coverage gaps remained, plus a comment with the
wrong reasoning. This section documents closing all three.

Commit this round: `dd024c2` — `test(reconcile): close liveness and
same-day-deal gaps (R13)`. One file changed (`reconcile.property.test.ts`,
+72/−9). `detect.ts` is unmodified in the commit — confirmed with `git diff`
immediately before committing (see below).

## R13a — the suite had no liveness property

All seven properties from the first round guard safety only (never post
*past* an unexplained day) — none asserted that a halt must actually
*happen* when capital moved. A reconciler that never halts satisfies every
one of them.

Added `"halts at the first snapshot carrying an unexplained capital move"`,
transcribed exactly as given: it independently folds `capitalCents` forward
across skipped days (a move on a skipped day rolls into the next snapshot's
delta) to compute the expected halt date, then pins `planReadings`'s actual
`candidate.tradeDate` against it, and pins that no halt occurs when nothing
is outstanding.

**Verified on pristine code before trusting it**, per instruction — traced
the fold's semantics by hand first (it mirrors `reconcileDays`' half-open
`(prev, cur]` interval exactly, including capital on the boundary day
itself), then ran it:

```
PASS lib/compound/reconcile/reconcile.property.test.ts
  reconciler properties
    ✓ never plans a reading on or after the day it halted on (21 ms)
    ✓ plans readings in strictly ascending date order, with no repeats (16 ms)
    ✓ a run with no capital events posts every snapshot (15 ms)
    ✓ resuming from the returned cursor never re-posts or skips a day (21 ms)
    ✓ dedupe never changes the net of the deals it keeps when there are no twins (7 ms)
    ✓ every reconciled interval covers each trade exactly once (17 ms)
    ✓ posts each snapshot's equity, never its balance (15 ms)
    ✓ halts at the first snapshot carrying an unexplained capital move (13 ms)

Tests: 8 passed, 8 total
```

The fold held — no adjustment needed.

## R13b — nothing put two deals on one day

Added `splitDeal: boolean` to `Day` and `dayArb`, and changed the
`tradedCents !== 0n` branch in `build()` so a `splitDeal` day emits two
deals on the same UTC date (12:00 and 14:00 — two hours apart, never
dedupe's three-hour broker-offset gap) instead of one, splitting
`tradedCents` via `bigint` division (`half = tradedCents / 2n`, second part
`tradedCents - half`).

**Confirmed the exact-complement claim empirically** rather than taking it
on faith, since `bigint` division truncates toward zero and I wanted to see
it hold at the boundaries (odd, negative, zero):

```
$ node -e '...'
traded=7 half=3 rest=4 half+rest===traded: true
traded=-7 half=-3 rest=-4 half+rest===traded: true
traded=8 half=4 rest=4 half+rest===traded: true
traded=-8 half=-4 rest=-4 half+rest===traded: true
traded=0 half=0 rest=0 half+rest===traded: true
traded=1 half=0 rest=1 half+rest===traded: true
traded=-1 half=0 rest=-1 half+rest===traded: true
traded=50000 half=25000 rest=25000 half+rest===traded: true
traded=-50000 half=-25000 rest=-25000 half+rest===traded: true
```

Holds unconditionally — `rest` is defined as `traded - half`, so
`half + rest === traded` is exact `bigint` algebra regardless of which way
division truncates; no case analysis on rounding direction was actually
needed for correctness, only for confidence.

Ran the full gate after adding `splitDeal` to check the new fixture
dimension doesn't expose another latent oracle bug the way R8 exposed R12:
**it didn't** — 187/187 green, typecheck clean, on the first try.

## R13c — corrected the wrong reasoning in `floatingFor`'s comment

Old text (wrong): *"a constant cancels in the subtractions `reconcileDays`
performs, which is exactly how an earlier fixed offset left a balance/equity
swap undetectable."* `reconcileDays` subtracts `balanceCloseCents` only and
never reads equity at all, so no equity constant can cancel there — I'd
carried this phrasing over from R8's brief without checking it against what
`reconcileDays` actually computes.

New text: *"A constant wouldn't hide a field swap (balance + C still !=
balance) — what it hides is a caller that derives equity by walking balance
deltas forward from a correct baseline instead of reading `equityCloseCents`
off each snapshot. That delta-propagation bug is numerically identical to
the correct value under a constant offset, and only per-date variation
exposes it."* This matches Probe 2 from the first round: the actual failure
mode there is an absolute-value posting bug (`equityCents` reading
`balanceCloseCents`), which a constant offset would *still* have caught
(`balance + C != balance`). The scenario a constant genuinely hides is the
subtler one — a running-total implementation that never reads
`equityCloseCents` directly at all.

## Prove both R13 additions bite

**Probe 1 — `isExplained` forced to `true`** (`abs(unexplained) <=
toleranceCents` → `true`):

```
✓ never plans a reading on or after the day it halted on
✓ plans readings in strictly ascending date order, with no repeats
✓ a run with no capital events posts every snapshot
✓ resuming from the returned cursor never re-posts or skips a day
✓ dedupe never changes the net of the deals it keeps when there are no twins
✓ every reconciled interval covers each trade exactly once
✓ posts each snapshot's equity, never its balance
✕ halts at the first snapshot carrying an unexplained capital move

Property failed after 2 tests
Counterexample: [[{"tradedCents":0n,"capitalCents":-1n,"skipped":false,"splitDeal":false},
                   {"tradedCents":0n,"capitalCents":0n,"skipped":false,"splitDeal":false}]]
Shrunk 6 time(s)
Got error: expected a halt at 2026-05-03, got advance

Tests: 1 failed, 7 passed, 8 total
```

Exactly as the coordinator predicted: only the new liveness property fails.
A single day with a −1 cent capital move should force a halt at
`2026-05-03`; with `isExplained` nailed to `true` the interlock never fires
and the plan silently advances instead. The other 7 properties — all of
which only check what happens *if* a halt occurs — are blind to a
reconciler that never halts at all. Reverted with
`git checkout -- lib/compound/reconcile/detect.ts`; confirmed empty diff and
8/8 green before probe 2.

**Probe 2 — `netByDay` changed from accumulate to overwrite**
(`netByDay.set(k, (netByDay.get(k) ?? 0n) + dealNetCents(d))` →
`netByDay.set(k, dealNetCents(d))`), full `reconcile/` suite:

```
FAIL lib/compound/reconcile/reconcile.property.test.ts
  ✕ a run with no capital events posts every snapshot
      Counterexample: [[{"tradedCents":2n,...,"splitDeal":true},{"tradedCents":0n,...}]]
      Got error: expected advance with no capital events, got halt
  ✕ every reconciled interval covers each trade exactly once
      Counterexample: [[{"tradedCents":-2n,...,"splitDeal":true},{...},{...}]]
      Got error: intervals explained -1, deals net -2
  ✕ halts at the first snapshot carrying an unexplained capital move
      Counterexample: [[{"tradedCents":-2n,...,"splitDeal":true},{...}]]
      Got error: halted at 2026-05-03, but no snapshot carries an unexplained capital move

PASS lib/compound/reconcile/detect.test.ts
PASS lib/compound/reconcile/dedupe.test.ts
PASS lib/compound/reconcile/date-key.test.ts
PASS lib/compound/reconcile/interlock.test.ts
PASS lib/compound/reconcile/purity.test.ts
PASS lib/compound/reconcile/types.test.ts

Test Suites: 1 failed, 6 passed, 7 total
Tests:       3 failed, 59 passed, 62 total
```

**Three** properties catch it, all on the same root cause: a `splitDeal` day
puts two deals on one UTC date; overwriting instead of accumulating keeps
only the last-processed deal's net, silently dropping the other half's P/L.
That understates `explainedCents` for the interval by exactly the dropped
half (`intervals explained -1, deals net -2` — a 1-cent split reads as a
1-cent phantom capital move), which manufactures a false "unexplained"
verdict: the no-capital-events property sees an unwanted halt, the interval
property sees the shortfall directly, and the new liveness property sees a
halt where its independent fold expected none. The 6 non-property suites
(59 tests, all pre-existing fixtures — none of which ever puts two deals on
one day) are completely blind to it, confirming the coordinator's point:
this was a real, unguarded gap, not a hypothetical one. Reverted with
`git checkout -- lib/compound/reconcile/detect.ts`.

## `detect.ts` unmodified — confirmed

```
$ git diff lib/compound/reconcile/detect.ts
                                              (empty)
$ git status
On branch feat/reconcile-property
Untracked files:
	task-5-report.md
```

Checked immediately before this round's commit. `dd024c2` contains exactly
one file: `reconcile.property.test.ts`.

## Full green run, this round

```
$ pnpm typecheck && pnpm test
                                              (typecheck: clean, no output)
Test Suites: 14 passed, 14 total
Tests:       187 passed, 187 total
```

187 = 179 baseline + 8 property tests (the original 7, plus R13a's
liveness property).

## Self-review, this round

- Transcribed R13a's given code verbatim (fold logic, error messages,
  `numRuns: 400`) — no changes, since it verified correct against pristine
  code on the first run.
- Transcribed R13b's given code verbatim (`Day`/`dayArb` field, the
  `half`/`parts`/`forEach` block, the 12:00/14:00 comment) — same.
- Left P4 ("resuming from the returned cursor never re-posts or skips a
  day" — title over-promises vs. body, which checks non-overlap only, not
  skip-freedom), P5 ("dedupe never changes the net..." — flagged
  seed-dependence), and the dead `idle` guards (vacuous given `build()`
  always emits a baseline snapshot, so `plan.kind` can never be `"idle"`)
  untouched, per "not in scope."
- Re-ran the full gate (not just the probes' immediate suites) after every
  revert to catch any cross-suite effect — none found.
- No modification to `dedupe.ts`, `detect.ts` (post-revert), `interlock.ts`,
  `date-key.ts`, or `types.ts` survives in the working tree or the commit.

## Concerns

None outstanding. The one concern from the first round (the R12 oracle fix
going beyond the authorized rulings) was reviewed and confirmed correct.
R13a and R13b both verified true-on-pristine-code and false-under-mutation
exactly as specified, with counterexamples recorded above. R13c is a
comment-only correction with no behavioral effect, cross-checked against
what `detect.ts` and the R8/Probe-2 mechanism actually do.
