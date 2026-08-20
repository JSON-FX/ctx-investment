# Accounting engine — carried forward

Findings raised during the build of `lib/compound/engine/` that were reviewed,
judged non-blocking, and deliberately not fixed. Recorded here so they survive
the throwaway execution workspace.

Branch: `feat/accounting-engine`. Final state: 125 tests, `tsc --noEmit` clean.

---

## Parked residuals — decide before plan 2

These three came out of the final whole-branch review's fix wave. None affects
computed money today. The process allows one fix wave, so they were parked
rather than quietly fixed.

| # | Where | Issue | Suggested fix |
|---|---|---|---|
| P1 | `nav.test.ts:187-191` | `"still rejects negative equity"` asserts only `.toThrow(RangeError)`. It passes even with `assertSolvent` neutered, because `money.ts`'s `assertOperands` throws `RangeError` first — a guard shadowed by a deeper guard of the same error class. The behaviour it guards was independently verified correct. | `.toThrow(/non-positive equity/)` |
| P2 | `nav.ts` — `unitsToRedeem`, `unitsForFee` | Both silently return `0n` for a **positive** amount against a zero-equity pool. `gross / NAV` at NAV 0 is undefined, not zero, and `unitsForFee`'s own comment says units at NAV zero "would be infinite" two lines above returning `0n`. Unreachable from `quote()` today. The reviewer verified switching both to `throw` leaves the suite at 125. | Throw `RangeError`; flip the two tests to `.toThrow` |
| P3 | `engine.property.test.ts` | The every-prefix exited-holder property detects a reverted manager-reactivation bug only ~60% of runs at `numRuns: 200` — only 0.33% of generated ledgers reach the transition. The deterministic test at `replay.test.ts:326` is what actually holds that line. | Raise `numRuns` on that property, or bias the generator toward manager-exit-then-units-fee |

---

## Deferred minors

Seventeen, triaged by the whole-branch review as post-merge. Grouped by whether
they are worth acting on.

### Worth doing when next in the file

- **`quote.ts`** — `belowHighWaterMark: profitCents <= 0n` flags a holder as *below* the mark when they are exactly *at* it. Zero profit is untested.
- **`replay.ts`** — `amountCents` is unread and unvalidated for `payout`/`exit`. The DDL makes it `not null`, so a writer will put something there. A `!== 0n` guard would stop a writer bug being silently ignored.
- **`invariants.ts`** — the `I4_*` codes do not correspond to spec §3.5's invariant 4 (`fee ≥ 0`), which `checkInvariants` structurally cannot check since `PoolState` carries no fee. Rename the codes or note it.
- **`invariants.test.ts`** — `"names both figures in the detail"` asserts only `toMatch(/\d+/)`. Both figures are bigints, so it cannot fail. Assert both values appear.
- **`purity.test.ts`** — nothing enforces spec §4's "no floating point appears anywhere in `engine/`". There is none today. Consider adding float-literal / `Math.random` / `Date.now` detection.
- **`quote.ts`** — `Number.isInteger` rejection of a fractional `splitBps` is implemented but untested.

### Known and accepted

- `purity.test.ts`'s `../db` pattern catches one hop only, not `../../db`; and its `node:fs` pattern catches `require()` only, not ESM import. Both are fine while `engine/` stays flat and the four module-name patterns carry the real constraint.
- `mulDivCeil`'s `n === 0n` guard, `unitsToRedeem`'s `grossCents === 0n` and `unitsForFee`'s `feeCents === 0n` short-circuits are all mathematically redundant. Harmless and self-documenting.
- `centsFromDecimal`/`unitsFromDecimal` and `formatCents`/`formatUnits` share parallel structure. Two call sites each — not worth a shared helper yet.
- `formatUnits` truncates rather than rounds. Documented and consistent with the engine's floor bias. **Confirm this suits the UI when plan 3 wires it up.**
- `replay.ts` — reversing a reversal voids all three entries, so the original stays voided rather than being restored. Corner case, no comment.
- `replay.ts` — `PoolState` omits `accountId`, which spec §5.1 includes. Fine for a single-account fold; matters under D5 (multi-account).
- `HolderState.splitBps` is no longer read by `fold` after the `splitBpsApplied` fix. Kept because the UI reads current terms, but nothing in `lib/` exercises it.
- `engine.property.test.ts` — the payout/exit `holderId` mapping is uniform now, but two legality guards in `buildLedger` are permanently unreachable given the pre-seeded genesis. Inert, commented.
- `invariants.ts:76-79`'s zero-equity branch is redundant for safety now that `allocateValues` handles the case. Survives as an optimisation.
- `unitsForDeposit` throws `cannot derive NAV against non-positive equity 0` for a deposit into a wiped-out pool. Now that such an account is renderable and exitable, that message reads as corrupt-state when it is really an infinite-NAV refusal. A dedicated message would help.
- `unitsForFee`'s comment attributes its caller to `quote()`; the actual caller is `fold`. Reasoning holds, attribution is loose.

---

## The lesson worth carrying into plans 2–4

This build produced **nine assertions that could not fail**, in five distinct
shapes. Every one was written by the plan author, not the implementers, and
every one read as a safety net while providing nothing.

| Shape | Example | Why it hid |
|---|---|---|
| Floor equals ceil | `unitsForDeposit(100c, 300u, 1000c)` — floor and ceil both `300000000000` | Round numbers divide evenly |
| Division terminates | The `POOL` fixture at NAV exactly $2.00 | $2.00 divides `UNIT_SCALE` evenly, for *every* whole-cent input |
| Tautology | `expect(state.units % 1n).toBe(0n)` | Any bigint mod `1n` is `0n` |
| Reflexivity | `expect(f(x)).toEqual(f(x))` on a pure function | Proves purity; purity is never what the test is named for |
| Shadowed guard | `.toThrow(RangeError)` where a deeper guard throws the same class first | Passes with the guard under test removed |

Plus two structural variants: a property whose skip conditions swallowed
two-thirds of its cases before reaching any assertion, and a property that
inspected only the final state, so a later operation tidied the violation away.

**The generalisation:** readable test data and discriminating test data are
close to opposites. Round numbers are chosen for legibility and are precisely
the inputs where the correct and incorrect implementations agree.

**What actually worked**, and should be standard from plan 2 onward:

1. **Prove the test bites.** Before committing, deliberately break the code the
   test covers and confirm that test — and ideally only that test — fails. Every
   fix round in this build did this, and it caught real gaps each time.
2. **Ratchet coverage.** Where a generator feeds assertions, count what reaches
   them and assert a floor, so silent vacuity becomes a test failure rather than
   a green run.
3. **Pick fixtures with awkward denominators.** Equity 700¢ across 3 units beats
   $1,000 across 500 units, every time.
