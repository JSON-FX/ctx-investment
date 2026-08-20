# Compound Accounting Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pure, exhaustively tested accounting engine that derives every holder figure — units, cost basis, NAV, value, accrued fee — by replaying an append-only ledger, with no database and no UI.

**Architecture:** Five modules under `lib/compound/engine/`, each with one responsibility, none performing I/O. Money is integer cents as `bigint`; units are `bigint` scaled 1e-10; NAV is never materialised but computed from an `(equityCents, units)` pair at the point of use. A `fold()` function reduces an ordered ledger to a `PoolState`, which is the single input to every screen built in later plans.

**Tech Stack:** TypeScript 5 (strict), Jest 29 + ts-jest, fast-check 3 for property-based testing, pnpm 10, Node 23.

**Spec:** [`docs/superpowers/specs/2026-08-21-compound-investor-desk-design.md`](../specs/2026-08-21-compound-investor-desk-design.md)

## Global Constraints

- **No floating point anywhere in `lib/compound/engine/`.** No `number` arithmetic on money or units. `number` is permitted only for basis points and array indices.
- **`engine/` must never import from `db/`, `next`, `react`, or any I/O module.** Enforced by a test in Task 1.
- Money: integer minor units (cents) as `bigint`. Units: `bigint` scaled by `UNIT_SCALE = 10_000_000_000n` (1e-10 precision).
- Splits: basis points as integer. 40% is `4000`. Valid range `0..10000`.
- Rounding on value-moving operations: **floor on issuance, ceil on redemption, floor on fee.** The residual accrues to the pool.
- Rounding on valuation for reporting: **largest-remainder allocation**, so holder values sum to equity exactly.
- TypeScript `strict: true`, `target: "ES2022"` (BigInt literals require ES2020+).
- Repository is public. No real account numbers, broker names, balances, or holder names in any file. Fixtures use fictional values.
- Gates: `pnpm typecheck` (`tsc --noEmit`) and `pnpm test`. Do **not** add `eslint-config-next`; it is broken against ESLint 9 in the sibling project.

---

### Task 1: Project scaffold and verification gates

Creates the repository skeleton and proves both gates run. Everything else depends on this.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `jest.config.mjs`
- Create: `.env.example`
- Create: `lib/compound/engine/purity.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: working `pnpm typecheck` and `pnpm test` commands; the `@/` path alias resolving to the repo root

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "ctx-investment",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@10.12.4",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "jest",
    "test:watch": "jest --watch"
  },
  "devDependencies": {
    "@types/jest": "^29.5.14",
    "@types/node": "^20",
    "fast-check": "^3.23.2",
    "jest": "^29.7.0",
    "ts-jest": "^29.4.9",
    "typescript": "^5"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

`target: ES2022` is required — BigInt literals like `100n` are a syntax error below ES2020.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "types": ["node", "jest"],
    "baseUrl": ".",
    "paths": { "@/*": ["./*"] }
  },
  "include": ["lib/**/*.ts", "*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `jest.config.mjs`**

```javascript
/** @type {import('jest').Config} */
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/lib"],
  moduleNameMapper: { "^@/(.*)$": "<rootDir>/$1" },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { target: "ES2022", module: "CommonJS" } }],
  },
};
```

- [ ] **Step 4: Create `.env.example`**

Empty values only. The repository is public — no project ref, no keys.

```bash
# Supabase — fill locally, never commit real values.
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

- [ ] **Step 5: Write the purity guard test**

This is a real test, not a placeholder. It fails the build if anyone makes `engine/` impure.

Create `lib/compound/engine/purity.test.ts`:

```typescript
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ENGINE_DIR = join(__dirname);
const FORBIDDEN = [
  /from\s+["']@\/lib\/compound\/db/,
  /from\s+["']next/,
  /from\s+["']react/,
  /from\s+["']@supabase/,
  /require\(["']node:fs["']\)/,
];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".test.ts"))
    .map((f) => join(dir, f));
}

describe("engine purity", () => {
  it("has at least one source file to check", () => {
    expect(sourceFiles(ENGINE_DIR).length).toBeGreaterThan(0);
  });

  it("never imports I/O modules", () => {
    for (const file of sourceFiles(ENGINE_DIR)) {
      const src = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        expect({ file, matched: pattern.test(src) }).toEqual({ file, matched: false });
      }
    }
  });
});
```

- [ ] **Step 6: Install and confirm the test fails for the right reason**

```bash
pnpm install
pnpm test
```

Expected: FAIL on `"has at least one source file to check"` — there are no non-test `.ts` files in `engine/` yet. This confirms the guard is actually looking at something.

- [ ] **Step 7: Create a placeholder source file so the guard has a subject**

Create `lib/compound/engine/index.ts`:

```typescript
export const ENGINE_VERSION = "0.1.0";
```

- [ ] **Step 8: Run both gates**

```bash
pnpm typecheck && pnpm test
```

Expected: typecheck clean, both purity tests PASS.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json jest.config.mjs .env.example lib/compound/engine/
git commit -m "chore: scaffold engine package with typecheck, jest, and a purity guard"
```

---

### Task 2: `money.ts` — integer money and scaled units

The arithmetic floor everything else stands on. No other module may perform division on money or units directly.

**Files:**
- Create: `lib/compound/engine/money.ts`
- Test: `lib/compound/engine/money.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `UNIT_SCALE: bigint` (= `10_000_000_000n`)
  - `type Cents = bigint`, `type Units = bigint`
  - `mulDivFloor(a: bigint, b: bigint, d: bigint): bigint`
  - `mulDivCeil(a: bigint, b: bigint, d: bigint): bigint`
  - `centsFromDecimal(input: string): Cents`
  - `formatCents(c: Cents): string`
  - `unitsFromDecimal(input: string): Units`
  - `formatUnits(u: Units, dp?: number): string`

- [ ] **Step 1: Write the failing tests**

Create `lib/compound/engine/money.test.ts`:

```typescript
import {
  UNIT_SCALE, mulDivFloor, mulDivCeil,
  centsFromDecimal, formatCents, unitsFromDecimal, formatUnits,
} from "./money";

describe("mulDivFloor", () => {
  it("computes a*b/d truncating toward zero", () => {
    expect(mulDivFloor(7n, 3n, 2n)).toBe(10n);      // 21/2 = 10.5 -> 10
    expect(mulDivFloor(100n, 1n, 3n)).toBe(33n);
  });
  it("is exact when the division terminates", () => {
    expect(mulDivFloor(100n, 4n, 8n)).toBe(50n);
  });
  it("rejects a zero divisor", () => {
    expect(() => mulDivFloor(1n, 1n, 0n)).toThrow(RangeError);
  });
  it("rejects negative operands", () => {
    expect(() => mulDivFloor(-1n, 1n, 2n)).toThrow(RangeError);
  });
});

describe("mulDivCeil", () => {
  it("rounds up when the division does not terminate", () => {
    expect(mulDivCeil(7n, 3n, 2n)).toBe(11n);       // 21/2 = 10.5 -> 11
    expect(mulDivCeil(100n, 1n, 3n)).toBe(34n);
  });
  it("does not round up when exact", () => {
    expect(mulDivCeil(100n, 4n, 8n)).toBe(50n);
  });
  it("returns zero for a zero numerator", () => {
    expect(mulDivCeil(0n, 5n, 3n)).toBe(0n);
  });
});

describe("centsFromDecimal", () => {
  it("parses whole and fractional amounts", () => {
    expect(centsFromDecimal("309.41")).toBe(30941n);
    expect(centsFromDecimal("1000")).toBe(100000n);
    expect(centsFromDecimal("0.07")).toBe(7n);
    expect(centsFromDecimal("12.5")).toBe(1250n);
  });
  it("parses negatives", () => {
    expect(centsFromDecimal("-43.06")).toBe(-4306n);
  });
  it("rejects more than two decimal places", () => {
    expect(() => centsFromDecimal("1.234")).toThrow(RangeError);
  });
  it("rejects non-numeric input", () => {
    expect(() => centsFromDecimal("abc")).toThrow(RangeError);
  });
});

describe("formatCents", () => {
  it("always renders two decimal places", () => {
    expect(formatCents(30941n)).toBe("309.41");
    expect(formatCents(7n)).toBe("0.07");
    expect(formatCents(100000n)).toBe("1000.00");
  });
  it("renders negatives with a leading sign", () => {
    expect(formatCents(-4306n)).toBe("-43.06");
  });
  it("round-trips with centsFromDecimal", () => {
    for (const s of ["0.00", "0.01", "309.41", "-43.06", "999999.99"]) {
      expect(formatCents(centsFromDecimal(s))).toBe(s);
    }
  });
});

describe("unitsFromDecimal", () => {
  it("scales by UNIT_SCALE", () => {
    expect(unitsFromDecimal("1")).toBe(UNIT_SCALE);
    expect(unitsFromDecimal("309.41")).toBe(3094100000000n);
    expect(unitsFromDecimal("0.0000000001")).toBe(1n);
  });
  it("rejects more than ten decimal places", () => {
    expect(() => unitsFromDecimal("1.00000000001")).toThrow(RangeError);
  });
});

describe("formatUnits", () => {
  it("truncates to the requested precision", () => {
    expect(formatUnits(3094100000000n, 2)).toBe("309.41");
    expect(formatUnits(3094199999999n, 2)).toBe("309.41");
    expect(formatUnits(UNIT_SCALE, 0)).toBe("1");
  });
  it("defaults to two decimal places", () => {
    expect(formatUnits(3094100000000n)).toBe("309.41");
  });
  it("rejects an out-of-range precision", () => {
    expect(() => formatUnits(UNIT_SCALE, 11)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test -- money.test.ts
```

Expected: FAIL — `Cannot find module './money'`.

- [ ] **Step 3: Write the implementation**

Create `lib/compound/engine/money.ts`:

```typescript
/**
 * Integer money and scaled units. No floating point.
 *
 * Money is minor units (cents) as bigint. Units are bigint scaled by
 * UNIT_SCALE, giving 1e-10 precision — rounding units at 2dp accumulates
 * visible drift against the "holder units sum to units issued" invariant.
 */

/** Units carry ten decimal places. */
export const UNIT_SCALE = 10_000_000_000n;

/** Minor units of account currency. */
export type Cents = bigint;

/** Pool units, scaled by UNIT_SCALE. */
export type Units = bigint;

const MONEY_RE = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;
const UNITS_RE = /^(-)?(\d+)(?:\.(\d{1,10}))?$/;

function assertOperands(a: bigint, b: bigint, d: bigint): void {
  if (d === 0n) throw new RangeError("division by zero");
  if (a < 0n || b < 0n || d < 0n) {
    throw new RangeError(`expects non-negative operands, got (${a}, ${b}, ${d})`);
  }
}

/** floor(a * b / d) for non-negative operands. Exact — no intermediate rounding. */
export function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  assertOperands(a, b, d);
  return (a * b) / d;
}

/** ceil(a * b / d) for non-negative operands. */
export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  assertOperands(a, b, d);
  const n = a * b;
  return n === 0n ? 0n : (n + d - 1n) / d;
}

export function centsFromDecimal(input: string): Cents {
  const m = MONEY_RE.exec(input.trim());
  if (!m) throw new RangeError(`not a money string: ${JSON.stringify(input)}`);
  const sign = m[1];
  const whole = m[2] as string;
  const frac = m[3] ?? "";
  const cents = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
  return sign ? -cents : cents;
}

export function formatCents(c: Cents): string {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function unitsFromDecimal(input: string): Units {
  const m = UNITS_RE.exec(input.trim());
  if (!m) throw new RangeError(`not a unit string: ${JSON.stringify(input)}`);
  const sign = m[1];
  const whole = m[2] as string;
  const frac = m[3] ?? "";
  const u = BigInt(whole) * UNIT_SCALE + BigInt(frac.padEnd(10, "0"));
  return sign ? -u : u;
}

/** Truncates rather than rounds — display only, never used for arithmetic. */
export function formatUnits(u: Units, dp = 2): string {
  if (!Number.isInteger(dp) || dp < 0 || dp > 10) {
    throw new RangeError(`dp must be an integer 0..10, got ${dp}`);
  }
  const neg = u < 0n;
  const abs = neg ? -u : u;
  const whole = abs / UNIT_SCALE;
  const fracAll = (abs % UNIT_SCALE).toString().padStart(10, "0");
  const frac = dp === 0 ? "" : `.${fracAll.slice(0, dp)}`;
  return `${neg ? "-" : ""}${whole}${frac}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test -- money.test.ts && pnpm typecheck
```

Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add lib/compound/engine/money.ts lib/compound/engine/money.test.ts
git commit -m "feat(engine): integer money and 1e-10 scaled units"
```

---

### Task 3: `nav.ts` — unit issuance, redemption, and valuation

NAV is never stored. Every function here takes the `(equityCents, units)` pair and derives what it needs.

**Files:**
- Create: `lib/compound/engine/nav.ts`
- Test: `lib/compound/engine/nav.test.ts`

**Interfaces:**
- Consumes: `UNIT_SCALE`, `mulDivFloor`, `mulDivCeil`, `Cents`, `Units` from `./money`
- Produces:
  - `interface PoolTotals { equityCents: Cents; units: Units }`
  - `isGenesis(t: PoolTotals): boolean`
  - `unitsForDeposit(t: PoolTotals, amountCents: Cents): Units` — **floor**
  - `valueOfUnits(t: PoolTotals, holderUnits: Units): Cents` — **floor**
  - `unitsToRedeem(t: PoolTotals, grossCents: Cents): Units` — **ceil**
  - `unitsForFee(t: PoolTotals, feeCents: Cents): Units` — **floor**
  - `navTimes1e4(t: PoolTotals): bigint` — display only

- [ ] **Step 1: Write the failing tests**

Create `lib/compound/engine/nav.test.ts`:

```typescript
import { UNIT_SCALE, centsFromDecimal, unitsFromDecimal } from "./money";
import {
  isGenesis, unitsForDeposit, valueOfUnits, unitsToRedeem, unitsForFee,
  navTimes1e4, type PoolTotals,
} from "./nav";

const EMPTY: PoolTotals = { equityCents: 0n, units: 0n };

describe("isGenesis", () => {
  it("is true only when no units have been issued", () => {
    expect(isGenesis(EMPTY)).toBe(true);
    expect(isGenesis({ equityCents: 100n, units: UNIT_SCALE })).toBe(false);
  });
});

describe("unitsForDeposit", () => {
  it("issues one unit per dollar at genesis", () => {
    expect(unitsForDeposit(EMPTY, centsFromDecimal("309.41")))
      .toBe(unitsFromDecimal("309.41"));
  });

  it("issues at the prevailing NAV once units exist", () => {
    // equity $1,000, 500 units -> NAV 2.00. A $250 deposit buys 125 units.
    const t: PoolTotals = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("500") };
    expect(unitsForDeposit(t, centsFromDecimal("250"))).toBe(unitsFromDecimal("125"));
  });

  it("floors, so the depositor never receives more units than paid for", () => {
    // equity $1,000, 300 units -> NAV 3.3333...; $100 buys 30 units exactly.
    const t: PoolTotals = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("300") };
    const issued = unitsForDeposit(t, centsFromDecimal("100"));
    expect(issued).toBe(30n * UNIT_SCALE);
    // The exact figure is 30 units; confirm we never exceed the entitlement.
    expect(issued * t.equityCents <= centsFromDecimal("100") * t.units).toBe(true);
  });

  it("rejects a non-positive deposit", () => {
    expect(() => unitsForDeposit(EMPTY, 0n)).toThrow(RangeError);
    expect(() => unitsForDeposit(EMPTY, -1n)).toThrow(RangeError);
  });

  it("rejects equity present with no units — a corrupt state", () => {
    expect(() => unitsForDeposit({ equityCents: 500n, units: 0n }, 100n)).toThrow(RangeError);
  });
});

describe("valueOfUnits", () => {
  it("is units times NAV", () => {
    const t: PoolTotals = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("500") };
    expect(valueOfUnits(t, unitsFromDecimal("125"))).toBe(centsFromDecimal("250"));
  });
  it("is zero for an empty pool", () => {
    expect(valueOfUnits(EMPTY, 0n)).toBe(0n);
  });
  it("floors, never overstating a holder's entitlement", () => {
    const t: PoolTotals = { equityCents: 1000n, units: unitsFromDecimal("3") };
    const v = valueOfUnits(t, unitsFromDecimal("1"));
    expect(v).toBe(333n);
  });
});

describe("unitsToRedeem", () => {
  it("is the inverse of valueOfUnits when exact", () => {
    const t: PoolTotals = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("500") };
    expect(unitsToRedeem(t, centsFromDecimal("250"))).toBe(unitsFromDecimal("125"));
  });
  it("ceils, so a holder never keeps units they were paid for", () => {
    const t: PoolTotals = { equityCents: 1000n, units: unitsFromDecimal("3") };
    // $3.33 of a $10 pool with 3 units -> 0.999 units, must round up.
    const redeemed = unitsToRedeem(t, 333n);
    expect(redeemed * t.equityCents >= 333n * t.units).toBe(true);
  });
  it("redeems nothing for a zero payout", () => {
    const t: PoolTotals = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("500") };
    expect(unitsToRedeem(t, 0n)).toBe(0n);
  });
});

describe("unitsForFee", () => {
  it("floors, so the manager receives no rounding advantage", () => {
    const t: PoolTotals = { equityCents: 1000n, units: unitsFromDecimal("3") };
    const fu = unitsForFee(t, 333n);
    expect(fu * t.equityCents <= 333n * t.units).toBe(true);
  });
});

describe("navTimes1e4", () => {
  it("reports 1.0000 at genesis", () => {
    expect(navTimes1e4(EMPTY)).toBe(10_000n);
  });
  it("reports NAV to four decimal places", () => {
    const t: PoolTotals = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("500") };
    expect(navTimes1e4(t)).toBe(20_000n); // 2.0000
  });
  it("truncates rather than rounding", () => {
    const t: PoolTotals = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("300") };
    expect(navTimes1e4(t)).toBe(33_333n); // 3.3333
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test -- nav.test.ts
```

Expected: FAIL — `Cannot find module './nav'`.

- [ ] **Step 3: Write the implementation**

Create `lib/compound/engine/nav.ts`:

```typescript
/**
 * NAV-derived quantities. NAV per unit is equity / units issued, and is never
 * stored — it is a division that rarely terminates. Every function here takes
 * the (equityCents, units) pair and derives what it needs in exact integer
 * arithmetic.
 *
 * Rounding principle: round in the direction that never lets a holder extract
 * more value than they are entitled to. The residual is sub-cent and accrues to
 * the pool, so it is shared pro-rata by everyone.
 */
import { UNIT_SCALE, mulDivFloor, mulDivCeil, type Cents, type Units } from "./money";

export interface PoolTotals {
  equityCents: Cents;
  units: Units;
}

/** Genesis: no units issued yet, so NAV is defined as 1.00. */
export function isGenesis(t: PoolTotals): boolean {
  return t.units === 0n;
}

function assertSolvent(t: PoolTotals): void {
  if (t.equityCents <= 0n) {
    throw new RangeError(`cannot derive NAV against non-positive equity ${t.equityCents}`);
  }
}

/** Units issued for a deposit. FLOOR — never issue more units than were paid for. */
export function unitsForDeposit(t: PoolTotals, amountCents: Cents): Units {
  if (amountCents <= 0n) throw new RangeError(`deposit must be positive, got ${amountCents}`);
  if (isGenesis(t)) {
    if (t.equityCents !== 0n) {
      throw new RangeError(
        `equity ${t.equityCents} with zero units — corrupt state, needs an adjustment entry`,
      );
    }
    return mulDivFloor(amountCents, UNIT_SCALE, 100n); // NAV := 1.00
  }
  assertSolvent(t);
  return mulDivFloor(amountCents, t.units, t.equityCents);
}

/** A holder's value. FLOOR — never overstate an entitlement. */
export function valueOfUnits(t: PoolTotals, holderUnits: Units): Cents {
  if (holderUnits < 0n) throw new RangeError(`negative units ${holderUnits}`);
  if (isGenesis(t)) return 0n;
  assertSolvent(t);
  return mulDivFloor(holderUnits, t.equityCents, t.units);
}

/** Units surrendered for a cash payout. CEIL — never let a holder keep units they were paid for. */
export function unitsToRedeem(t: PoolTotals, grossCents: Cents): Units {
  if (grossCents < 0n) throw new RangeError(`negative gross ${grossCents}`);
  if (isGenesis(t) || grossCents === 0n) return 0n;
  assertSolvent(t);
  return mulDivCeil(grossCents, t.units, t.equityCents);
}

/** Units issued to the manager when a fee is retained. FLOOR — no rounding advantage. */
export function unitsForFee(t: PoolTotals, feeCents: Cents): Units {
  if (feeCents < 0n) throw new RangeError(`negative fee ${feeCents}`);
  if (isGenesis(t) || feeCents === 0n) return 0n;
  assertSolvent(t);
  return mulDivFloor(feeCents, t.units, t.equityCents);
}

/**
 * NAV × 10^4, truncated. Display only — never feed this back into arithmetic.
 * NAV = (equityCents / 100) / (units / UNIT_SCALE).
 */
export function navTimes1e4(t: PoolTotals): bigint {
  if (isGenesis(t)) return 10_000n;
  assertSolvent(t);
  return mulDivFloor(t.equityCents * UNIT_SCALE, 10_000n, t.units * 100n);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test -- nav.test.ts && pnpm typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/compound/engine/nav.ts lib/compound/engine/nav.test.ts
git commit -m "feat(engine): NAV-derived unit issuance, redemption, and valuation"
```

---

### Task 4: `allocateValues` — exact value allocation

Flooring each holder's value independently loses up to one cent per holder, which would make invariant 2 approximate. Largest-remainder allocation makes it exact.

**Files:**
- Modify: `lib/compound/engine/nav.ts` (append)
- Modify: `lib/compound/engine/nav.test.ts` (append)

**Interfaces:**
- Consumes: `PoolTotals`, `mulDivFloor` from Task 3
- Produces: `allocateValues(t: PoolTotals, holderUnits: readonly Units[]): Cents[]`

- [ ] **Step 1: Write the failing tests**

Append to `lib/compound/engine/nav.test.ts`:

```typescript
import { allocateValues } from "./nav";

describe("allocateValues", () => {
  it("returns an empty array for no holders", () => {
    expect(allocateValues(EMPTY, [])).toEqual([]);
  });

  it("gives one holder the whole equity", () => {
    const t: PoolTotals = { equityCents: 100_000n, units: unitsFromDecimal("500") };
    expect(allocateValues(t, [unitsFromDecimal("500")])).toEqual([100_000n]);
  });

  it("sums to equity exactly when floors would lose cents", () => {
    // $10.00 across three equal holders: floor gives 333 each, losing 1 cent.
    const t: PoolTotals = { equityCents: 1000n, units: unitsFromDecimal("3") };
    const out = allocateValues(t, [
      unitsFromDecimal("1"), unitsFromDecimal("1"), unitsFromDecimal("1"),
    ]);
    expect(out.reduce((s, c) => s + c, 0n)).toBe(1000n);
    expect(out).toEqual([334n, 333n, 333n]);
  });

  it("awards the odd cent to the largest remainder, not the first holder", () => {
    // equity $1.00, holder A has 1 unit, holder B has 2 units.
    // Exact: A 33.33c, B 66.67c. Floors 33 + 66 = 99, one cent short.
    // B has the larger remainder, so B gets it.
    const t: PoolTotals = { equityCents: 100n, units: unitsFromDecimal("3") };
    const out = allocateValues(t, [unitsFromDecimal("1"), unitsFromDecimal("2")]);
    expect(out).toEqual([33n, 67n]);
    expect(out[0]! + out[1]!).toBe(100n);
  });

  it("is deterministic when remainders tie", () => {
    const t: PoolTotals = { equityCents: 1000n, units: unitsFromDecimal("3") };
    const a = allocateValues(t, [unitsFromDecimal("1"), unitsFromDecimal("1"), unitsFromDecimal("1")]);
    const b = allocateValues(t, [unitsFromDecimal("1"), unitsFromDecimal("1"), unitsFromDecimal("1")]);
    expect(a).toEqual(b);
  });

  it("returns zeros for an empty pool", () => {
    expect(allocateValues(EMPTY, [0n, 0n])).toEqual([0n, 0n]);
  });

  it("rejects holder units that do not sum to pool units", () => {
    const t: PoolTotals = { equityCents: 1000n, units: unitsFromDecimal("3") };
    expect(() => allocateValues(t, [unitsFromDecimal("1")])).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test -- nav.test.ts -t allocateValues
```

Expected: FAIL — `allocateValues is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `lib/compound/engine/nav.ts`:

```typescript
/**
 * Split equity across holders so the parts sum to the whole exactly.
 *
 * Flooring each holder independently loses up to one cent per holder, which
 * would make "Σ holder value = equity" approximate. Largest-remainder
 * allocation distributes the shortfall to the holders with the largest
 * fractional entitlement, which is both exact and the fairest tie-break.
 *
 * This is REPORTING only. It never moves value, so the conservative
 * floor/ceil rule that governs issuance and redemption does not apply here.
 */
export function allocateValues(t: PoolTotals, holderUnits: readonly Units[]): Cents[] {
  if (holderUnits.length === 0) return [];

  const total = holderUnits.reduce((s, u) => s + u, 0n);
  if (total !== t.units) {
    throw new RangeError(`holder units ${total} do not sum to pool units ${t.units}`);
  }
  if (isGenesis(t)) return holderUnits.map(() => 0n);
  assertSolvent(t);

  const floors = holderUnits.map((u) => mulDivFloor(u, t.equityCents, t.units));
  // Remainder numerator: (u * equity) mod units, kept exact as a bigint.
  const remainders = holderUnits.map((u, i) => u * t.equityCents - floors[i]! * t.units);

  let short = t.equityCents - floors.reduce((s, c) => s + c, 0n);

  const order = remainders
    .map((r, i) => [r, i] as const)
    .sort((a, b) => (a[0] !== b[0] ? (a[0] > b[0] ? -1 : 1) : a[1] - b[1]));

  const out = [...floors];
  for (let k = 0; short > 0n && k < order.length; k += 1, short -= 1n) {
    const idx = order[k]![1];
    out[idx] = out[idx]! + 1n;
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test -- nav.test.ts && pnpm typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/compound/engine/nav.ts lib/compound/engine/nav.test.ts
git commit -m "feat(engine): largest-remainder value allocation so holder values sum to equity exactly"
```

---

### Task 5: `quote.ts` — payout arithmetic

Computes a payout in full without committing it. This is what the receipt modal renders and what `fold()` applies.

**Files:**
- Create: `lib/compound/engine/quote.ts`
- Test: `lib/compound/engine/quote.test.ts`

**Interfaces:**
- Consumes: `mulDivFloor`, `Cents`, `Units` from `./money`; `PoolTotals`, `valueOfUnits`, `unitsToRedeem` from `./nav`
- Produces:
  - `type PayoutMode = "profit" | "exit"`
  - `interface QuoteInput { totals; holderUnits; basisCents; splitBps; isManager; mode }`
  - `interface Quote { valueCents; profitCents; grossCents; feeCents; toHolderCents; unitsRedeemed; belowHighWaterMark; splitBpsApplied }`
  - `quote(input: QuoteInput): Quote`

- [ ] **Step 1: Write the failing tests**

Create `lib/compound/engine/quote.test.ts`:

```typescript
import { centsFromDecimal, unitsFromDecimal } from "./money";
import type { PoolTotals } from "./nav";
import { quote, type QuoteInput } from "./quote";

// A pool worth $1,000 across 500 units — NAV 2.00.
const POOL: PoolTotals = {
  equityCents: centsFromDecimal("1000"),
  units: unitsFromDecimal("500"),
};

function input(over: Partial<QuoteInput> = {}): QuoteInput {
  return {
    totals: POOL,
    holderUnits: unitsFromDecimal("125"),   // $250 at NAV 2.00
    basisCents: centsFromDecimal("100"),
    splitBps: 4000,
    isManager: false,
    mode: "profit",
    ...over,
  };
}

describe("quote — profit mode above the high-water mark", () => {
  it("values the holding at the prevailing NAV", () => {
    expect(quote(input()).valueCents).toBe(centsFromDecimal("250"));
  });

  it("measures profit against cost basis", () => {
    expect(quote(input()).profitCents).toBe(centsFromDecimal("150"));
  });

  it("splits profit by basis points, flooring the fee", () => {
    const q = quote(input());
    expect(q.feeCents).toBe(centsFromDecimal("60"));       // 150.00 * 40%
    expect(q.toHolderCents).toBe(centsFromDecimal("90"));  // 150.00 - 60.00
  });

  it("floors a fee that does not divide evenly, favouring the holder", () => {
    // profit $218.47 at 40% is $87.388 -> fee $87.38, holder keeps $131.09
    const q = quote(input({
      holderUnits: unitsFromDecimal("264.235"),   // $528.47 at NAV 2.00
      basisCents: centsFromDecimal("310.00"),
    }));
    expect(q.profitCents).toBe(centsFromDecimal("218.47"));
    expect(q.feeCents).toBe(centsFromDecimal("87.38"));
    expect(q.toHolderCents).toBe(centsFromDecimal("131.09"));
    expect(q.feeCents + q.toHolderCents).toBe(q.profitCents);
  });

  it("redeems only the units the profit is worth", () => {
    const q = quote(input());
    expect(q.unitsRedeemed).toBe(unitsFromDecimal("75")); // $150 at NAV 2.00
  });

  it("is not below the high-water mark", () => {
    expect(quote(input()).belowHighWaterMark).toBe(false);
  });
});

describe("quote — below the high-water mark", () => {
  const under = input({ basisCents: centsFromDecimal("400") }); // value $250 < basis $400

  it("reports negative profit", () => {
    expect(quote(under).profitCents).toBe(centsFromDecimal("-150"));
  });

  it("charges no fee", () => {
    expect(quote(under).feeCents).toBe(0n);
  });

  it("pays out nothing in profit mode", () => {
    const q = quote(under);
    expect(q.grossCents).toBe(0n);
    expect(q.toHolderCents).toBe(0n);
    expect(q.unitsRedeemed).toBe(0n);
  });

  it("flags the high-water mark", () => {
    expect(quote(under).belowHighWaterMark).toBe(true);
  });

  it("returns full value with no fee on exit", () => {
    const q = quote({ ...under, mode: "exit" });
    expect(q.feeCents).toBe(0n);
    expect(q.toHolderCents).toBe(centsFromDecimal("250"));
  });
});

describe("quote — exit mode above the mark", () => {
  it("returns value less the fee", () => {
    const q = quote(input({ mode: "exit" }));
    expect(q.grossCents).toBe(centsFromDecimal("250"));
    expect(q.feeCents).toBe(centsFromDecimal("60"));
    expect(q.toHolderCents).toBe(centsFromDecimal("190"));
  });
});

describe("quote — the manager", () => {
  it("never charges themselves a fee", () => {
    const q = quote(input({ isManager: true }));
    expect(q.feeCents).toBe(0n);
    expect(q.splitBpsApplied).toBe(0);
    expect(q.toHolderCents).toBe(centsFromDecimal("150"));
  });
});

describe("quote — validation", () => {
  it("rejects basis points outside 0..10000", () => {
    expect(() => quote(input({ splitBps: -1 }))).toThrow(RangeError);
    expect(() => quote(input({ splitBps: 10_001 }))).toThrow(RangeError);
  });
  it("accepts the boundaries", () => {
    expect(quote(input({ splitBps: 0 })).feeCents).toBe(0n);
    expect(quote(input({ splitBps: 10_000 })).feeCents).toBe(centsFromDecimal("150"));
  });
  it("never produces a negative fee", () => {
    for (const basis of ["0", "100", "250", "400", "10000"]) {
      expect(quote(input({ basisCents: centsFromDecimal(basis) })).feeCents >= 0n).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test -- quote.test.ts
```

Expected: FAIL — `Cannot find module './quote'`.

- [ ] **Step 3: Write the implementation**

Create `lib/compound/engine/quote.ts`:

```typescript
/**
 * Payout arithmetic. Computes the whole of a payout without committing it, so
 * the receipt modal and fold() apply identical numbers.
 *
 *   fee            = max(0, profit) × manager_split
 *   holder_gets    = (mode = exit) ? value − fee : max(0, profit) − fee
 *   units_redeemed = ((mode = exit) ? value : max(0, profit)) / NAV
 *
 * The performance fee crystallises only on withdrawal, never on a paper gain.
 * Because profit is measured against cost basis, a losing stretch must be
 * recovered before a fee applies again — the high-water mark falls out of the
 * arithmetic rather than being maintained separately.
 */
import { mulDivFloor, type Cents, type Units } from "./money";
import { valueOfUnits, unitsToRedeem, type PoolTotals } from "./nav";

export type PayoutMode = "profit" | "exit";

export interface QuoteInput {
  totals: PoolTotals;
  holderUnits: Units;
  basisCents: Cents;
  /** Manager's share of this holder's profit, in basis points. Ignored for the manager. */
  splitBps: number;
  isManager: boolean;
  mode: PayoutMode;
}

export interface Quote {
  valueCents: Cents;
  /** Signed. Negative means below the high-water mark. */
  profitCents: Cents;
  grossCents: Cents;
  feeCents: Cents;
  toHolderCents: Cents;
  unitsRedeemed: Units;
  belowHighWaterMark: boolean;
  splitBpsApplied: number;
}

export function quote(input: QuoteInput): Quote {
  const { totals, holderUnits, basisCents, isManager, mode } = input;

  if (!Number.isInteger(input.splitBps) || input.splitBps < 0 || input.splitBps > 10_000) {
    throw new RangeError(`splitBps must be an integer 0..10000, got ${input.splitBps}`);
  }
  const splitBpsApplied = isManager ? 0 : input.splitBps;

  const valueCents = valueOfUnits(totals, holderUnits);
  const profitCents = valueCents - basisCents;
  const feeableCents = profitCents > 0n ? profitCents : 0n;

  const feeCents = mulDivFloor(feeableCents, BigInt(splitBpsApplied), 10_000n);
  const grossCents = mode === "exit" ? valueCents : feeableCents;
  const toHolderCents = grossCents - feeCents;
  const unitsRedeemed = unitsToRedeem(totals, grossCents);

  return {
    valueCents,
    profitCents,
    grossCents,
    feeCents,
    toHolderCents,
    unitsRedeemed,
    belowHighWaterMark: profitCents <= 0n,
    splitBpsApplied,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test -- quote.test.ts && pnpm typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/compound/engine/quote.ts lib/compound/engine/quote.test.ts
git commit -m "feat(engine): payout arithmetic with high-water mark and floored fee"
```

---

### Task 6: `replay.ts` — types and fold for readings, deposits, adjustments

The reducer that turns a ledger into state. This task covers the entries that do not involve a payout.

**Files:**
- Create: `lib/compound/engine/replay.ts`
- Test: `lib/compound/engine/replay.test.ts`

**Interfaces:**
- Consumes: `Cents`, `Units` from `./money`; `PoolTotals`, `unitsForDeposit` from `./nav`
- Produces:
  - `type LedgerEntryType = "deposit" | "payout" | "exit" | "equity_reading" | "adjustment"`
  - `interface LedgerEntry { id; seq; holderId; occurredOn; type; amountCents; feeSettlement; splitBpsApplied; reversesId }`
  - `interface HolderSeed { holderId; isManager; splitBps }`
  - `interface HolderState { holderId; isManager; splitBps; units; basisCents; status }`
  - `interface PoolState { equityCents; units; holders; lastReadingOn; seq }`
  - `fold(entries: readonly LedgerEntry[], seeds: readonly HolderSeed[]): PoolState`
  - `totalsOf(state: PoolState): PoolTotals`

- [ ] **Step 1: Write the failing tests**

Create `lib/compound/engine/replay.test.ts`:

```typescript
import { centsFromDecimal, unitsFromDecimal } from "./money";
import { navTimes1e4 } from "./nav";
import {
  fold, totalsOf,
  type HolderSeed, type LedgerEntry, type LedgerEntryType,
} from "./replay";

const MANAGER: HolderSeed = { holderId: 1, isManager: true, splitBps: 0 };
const INVESTOR: HolderSeed = { holderId: 2, isManager: false, splitBps: 4000 };

let nextSeq = 0;
beforeEach(() => { nextSeq = 0; });

function entry(
  type: LedgerEntryType,
  amount: string,
  over: Partial<LedgerEntry> = {},
): LedgerEntry {
  nextSeq += 1;
  return {
    id: nextSeq,
    seq: nextSeq,
    holderId: null,
    occurredOn: "2026-01-01",
    type,
    amountCents: centsFromDecimal(amount),
    feeSettlement: null,
    splitBpsApplied: null,
    reversesId: null,
    ...over,
  };
}

describe("fold — empty ledger", () => {
  it("returns a zeroed pool with the seeded holders", () => {
    const s = fold([], [MANAGER, INVESTOR]);
    expect(s.equityCents).toBe(0n);
    expect(s.units).toBe(0n);
    expect(s.lastReadingOn).toBeNull();
    expect(s.holders).toHaveLength(2);
    expect(s.holders.every((h) => h.units === 0n && h.basisCents === 0n)).toBe(true);
  });
});

describe("fold — deposits", () => {
  it("issues one unit per dollar for the founding deposit", () => {
    const s = fold([entry("deposit", "300", { holderId: 1 })], [MANAGER]);
    expect(s.units).toBe(unitsFromDecimal("300"));
    expect(s.equityCents).toBe(centsFromDecimal("300"));
    expect(s.holders[0]!.units).toBe(unitsFromDecimal("300"));
    expect(s.holders[0]!.basisCents).toBe(centsFromDecimal("300"));
  });

  it("leaves NAV unchanged when a second holder deposits", () => {
    const ledger = [
      entry("deposit", "300", { holderId: 1 }),
      entry("equity_reading", "600"),          // NAV doubles to 2.0000
      entry("deposit", "300", { holderId: 2 }),
    ];
    const before = fold(ledger.slice(0, 2), [MANAGER, INVESTOR]);
    const after = fold(ledger, [MANAGER, INVESTOR]);
    expect(navTimes1e4(totalsOf(before))).toBe(20_000n);
    expect(navTimes1e4(totalsOf(after))).toBe(20_000n);
  });

  it("issues the later depositor units at the prevailing NAV", () => {
    const s = fold([
      entry("deposit", "300", { holderId: 1 }),
      entry("equity_reading", "600"),
      entry("deposit", "300", { holderId: 2 }),
    ], [MANAGER, INVESTOR]);
    // $300 at NAV 2.00 buys 150 units.
    expect(s.holders.find((h) => h.holderId === 2)!.units).toBe(unitsFromDecimal("150"));
    expect(s.units).toBe(unitsFromDecimal("450"));
    expect(s.equityCents).toBe(centsFromDecimal("900"));
  });

  it("accumulates cost basis across repeat deposits", () => {
    const s = fold([
      entry("deposit", "300", { holderId: 1 }),
      entry("deposit", "200", { holderId: 1 }),
    ], [MANAGER]);
    expect(s.holders[0]!.basisCents).toBe(centsFromDecimal("500"));
  });

  it("reactivates a closed holder", () => {
    const s = fold([
      entry("deposit", "300", { holderId: 1 }),
      entry("deposit", "100", { holderId: 2 }),
    ], [MANAGER, { ...INVESTOR }]);
    expect(s.holders.find((h) => h.holderId === 2)!.status).toBe("active");
  });
});

describe("fold — equity readings", () => {
  it("replaces equity and records the reading date", () => {
    const s = fold([
      entry("deposit", "300", { holderId: 1 }),
      entry("equity_reading", "412.55", { occurredOn: "2026-03-04" }),
    ], [MANAGER]);
    expect(s.equityCents).toBe(centsFromDecimal("412.55"));
    expect(s.lastReadingOn).toBe("2026-03-04");
  });

  it("does not change units", () => {
    const s = fold([
      entry("deposit", "300", { holderId: 1 }),
      entry("equity_reading", "900"),
    ], [MANAGER]);
    expect(s.units).toBe(unitsFromDecimal("300"));
  });
});

describe("fold — adjustments", () => {
  it("moves equity without issuing units", () => {
    const s = fold([
      entry("deposit", "300", { holderId: 1 }),
      entry("adjustment", "-12.50"),
    ], [MANAGER]);
    expect(s.equityCents).toBe(centsFromDecimal("287.50"));
    expect(s.units).toBe(unitsFromDecimal("300"));
  });
});

describe("fold — ordering and reversals", () => {
  it("applies entries in seq order regardless of array order", () => {
    const a = entry("deposit", "300", { holderId: 1 });
    const b = entry("equity_reading", "600");
    const forward = fold([a, b], [MANAGER]);
    const shuffled = fold([b, a], [MANAGER]);
    expect(shuffled).toEqual(forward);
  });

  it("orders same-date entries by seq, so deposit-then-reading is deterministic", () => {
    const s = fold([
      entry("deposit", "300", { holderId: 1, occurredOn: "2026-05-02" }),
      entry("equity_reading", "600", { occurredOn: "2026-05-02" }),
    ], [MANAGER]);
    expect(s.equityCents).toBe(centsFromDecimal("600"));
    expect(s.units).toBe(unitsFromDecimal("300"));
  });

  it("skips both a reversed entry and its reversing entry", () => {
    const dep = entry("deposit", "300", { holderId: 1 });
    const bad = entry("deposit", "999", { holderId: 2 });
    const rev = entry("deposit", "-999", { holderId: 2, reversesId: bad.id });
    const s = fold([dep, bad, rev], [MANAGER, INVESTOR]);
    expect(s.equityCents).toBe(centsFromDecimal("300"));
    expect(s.units).toBe(unitsFromDecimal("300"));
    expect(s.holders.find((h) => h.holderId === 2)!.units).toBe(0n);
  });
});

describe("fold — validation", () => {
  it("rejects an entry naming an unknown holder", () => {
    expect(() => fold([entry("deposit", "100", { holderId: 99 })], [MANAGER]))
      .toThrow(/unknown holderId 99/);
  });
  it("rejects a deposit with no holder", () => {
    expect(() => fold([entry("deposit", "100")], [MANAGER]))
      .toThrow(/requires a holderId/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test -- replay.test.ts
```

Expected: FAIL — `Cannot find module './replay'`.

- [ ] **Step 3: Write the implementation**

Create `lib/compound/engine/replay.ts`. Payout and exit throw for now — Task 7 fills them in.

```typescript
/**
 * The ledger reducer. compound_ledger_entry is the only truth; units, cost
 * basis, NAV and every holder figure are derived by replaying it.
 *
 * The ledger stores INPUTS, not outputs. There is no units_delta and no
 * nav_at_entry, because storing a derived value creates a second truth that can
 * disagree with this function. splitBpsApplied is the exception: the terms in
 * force at the moment of a payout are an input, since a holder's split may
 * change afterwards.
 *
 * seq, not occurredOn, defines replay order. Two events on the same date still
 * have a definite order, which is what makes same-day deposit-then-reading
 * deterministic.
 */
import type { Cents, Units } from "./money";
import { unitsForDeposit, type PoolTotals } from "./nav";

export type LedgerEntryType =
  | "deposit"
  | "payout"
  | "exit"
  | "equity_reading"
  | "adjustment";

export interface LedgerEntry {
  id: number;
  /** Monotonic per account. Defines replay order. */
  seq: number;
  /** Null only for equity_reading and adjustment. */
  holderId: number | null;
  /** Broker-server date, YYYY-MM-DD. */
  occurredOn: string;
  type: LedgerEntryType;
  /** Signed for adjustment; positive otherwise. */
  amountCents: Cents;
  feeSettlement: "units" | "cash" | null;
  splitBpsApplied: number | null;
  reversesId: number | null;
}

export interface HolderSeed {
  holderId: number;
  isManager: boolean;
  splitBps: number;
}

export interface HolderState {
  holderId: number;
  isManager: boolean;
  splitBps: number;
  units: Units;
  basisCents: Cents;
  status: "active" | "closed";
}

export interface PoolState {
  equityCents: Cents;
  units: Units;
  holders: HolderState[];
  lastReadingOn: string | null;
  /** seq of the last entry considered. */
  seq: number;
}

export function totalsOf(state: PoolState): PoolTotals {
  return { equityCents: state.equityCents, units: state.units };
}

export function fold(
  entries: readonly LedgerEntry[],
  seeds: readonly HolderSeed[],
): PoolState {
  const holders = new Map<number, HolderState>(
    seeds.map((s) => [
      s.holderId,
      {
        holderId: s.holderId,
        isManager: s.isManager,
        splitBps: s.splitBps,
        units: 0n,
        basisCents: 0n,
        status: "active" as const,
      },
    ]),
  );

  // A reversal voids both the original entry and the reversing entry.
  const voided = new Set<number>();
  for (const e of entries) {
    if (e.reversesId !== null) {
      voided.add(e.reversesId);
      voided.add(e.id);
    }
  }

  const ordered = [...entries].sort((a, b) => a.seq - b.seq);

  let equityCents: Cents = 0n;
  let units: Units = 0n;
  let lastReadingOn: string | null = null;
  let seq = 0;

  const holderOf = (id: number | null): HolderState => {
    if (id === null) throw new Error("entry requires a holderId");
    const h = holders.get(id);
    if (!h) throw new Error(`unknown holderId ${id}`);
    return h;
  };

  for (const e of ordered) {
    seq = e.seq;
    if (voided.has(e.id)) continue;

    switch (e.type) {
      case "equity_reading": {
        equityCents = e.amountCents;
        lastReadingOn = e.occurredOn;
        break;
      }
      case "adjustment": {
        equityCents += e.amountCents;
        break;
      }
      case "deposit": {
        const h = holderOf(e.holderId);
        const issued = unitsForDeposit({ equityCents, units }, e.amountCents);
        h.units += issued;
        h.basisCents += e.amountCents;
        h.status = "active";
        units += issued;
        equityCents += e.amountCents;
        break;
      }
      case "payout":
      case "exit": {
        throw new Error(`${e.type} entries are not applied yet — see Task 7`);
      }
    }
  }

  return { equityCents, units, holders: [...holders.values()], lastReadingOn, seq };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test -- replay.test.ts && pnpm typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/compound/engine/replay.ts lib/compound/engine/replay.test.ts
git commit -m "feat(engine): ledger fold for readings, deposits, and adjustments"
```

---

### Task 7: `replay.ts` — payouts, exits, and fee settlement

Completes `fold()`. Fee units are issued at the **pre-payout** NAV, which is what keeps NAV constant across a payout.

**Files:**
- Modify: `lib/compound/engine/replay.ts` (replace the `payout`/`exit` case)
- Modify: `lib/compound/engine/replay.test.ts` (append)

**Interfaces:**
- Consumes: `quote` from `./quote`; `unitsForFee` from `./nav`
- Produces: no new exports — `fold()` gains payout and exit handling

- [ ] **Step 1: Write the failing tests**

Append to `lib/compound/engine/replay.test.ts`:

```typescript
import { checkNavUnchanged } from "./replay";

describe("fold — profit payout, fee retained as units", () => {
  // Manager founds with $300. Equity doubles to $600 -> NAV 2.0000.
  // Investor deposits $300 -> 150 units. Equity $900, 450 units, NAV 2.0000.
  // Equity read at $1,800 -> NAV 4.0000.
  // Investor value 150 * 4 = $600, basis $300, profit $300.
  // Fee 40% = $120. Investor receives $180. Units redeemed 300/4 = 75.
  // Fee units 120/4 = 30 to the manager.
  function ledger() {
    return [
      entry("deposit", "300", { holderId: 1 }),
      entry("equity_reading", "600"),
      entry("deposit", "300", { holderId: 2 }),
      entry("equity_reading", "1800"),
      entry("payout", "0", { holderId: 2, feeSettlement: "units", splitBpsApplied: 4000 }),
    ];
  }

  it("pays the holder their share of profit", () => {
    const before = fold(ledger().slice(0, 4), [MANAGER, INVESTOR]);
    const after = fold(ledger(), [MANAGER, INVESTOR]);
    expect(before.equityCents - after.equityCents).toBe(centsFromDecimal("180"));
  });

  it("redeems only the units the profit was worth", () => {
    const s = fold(ledger(), [MANAGER, INVESTOR]);
    expect(s.holders.find((h) => h.holderId === 2)!.units).toBe(unitsFromDecimal("75"));
  });

  it("issues the fee to the manager as units at the pre-payout NAV", () => {
    const s = fold(ledger(), [MANAGER, INVESTOR]);
    const mgr = s.holders.find((h) => h.holderId === 1)!;
    expect(mgr.units).toBe(unitsFromDecimal("330"));               // 300 + 30
    expect(mgr.basisCents).toBe(centsFromDecimal("420"));          // 300 + 120
  });

  it("leaves NAV unchanged", () => {
    const before = fold(ledger().slice(0, 4), [MANAGER, INVESTOR]);
    const after = fold(ledger(), [MANAGER, INVESTOR]);
    expect(navTimes1e4(totalsOf(after))).toBe(navTimes1e4(totalsOf(before)));
    expect(navTimes1e4(totalsOf(after))).toBe(40_000n);
  });

  it("leaves the holder's cost basis untouched", () => {
    const s = fold(ledger(), [MANAGER, INVESTOR]);
    expect(s.holders.find((h) => h.holderId === 2)!.basisCents).toBe(centsFromDecimal("300"));
  });
});

describe("fold — profit payout, fee taken as cash", () => {
  function ledger() {
    return [
      entry("deposit", "300", { holderId: 1 }),
      entry("equity_reading", "600"),
      entry("deposit", "300", { holderId: 2 }),
      entry("equity_reading", "1800"),
      entry("payout", "0", { holderId: 2, feeSettlement: "cash", splitBpsApplied: 4000 }),
    ];
  }

  it("removes the fee from equity and issues no units", () => {
    const s = fold(ledger(), [MANAGER, INVESTOR]);
    expect(s.equityCents).toBe(centsFromDecimal("1500")); // 1800 - 180 - 120
    expect(s.holders.find((h) => h.holderId === 1)!.units).toBe(unitsFromDecimal("300"));
  });

  it("leaves NAV unchanged", () => {
    const s = fold(ledger(), [MANAGER, INVESTOR]);
    expect(navTimes1e4(totalsOf(s))).toBe(40_000n);
  });
});

describe("fold — exit", () => {
  function ledger(settlement: "units" | "cash") {
    return [
      entry("deposit", "300", { holderId: 1 }),
      entry("equity_reading", "600"),
      entry("deposit", "300", { holderId: 2 }),
      entry("equity_reading", "1800"),
      entry("exit", "0", { holderId: 2, feeSettlement: settlement, splitBpsApplied: 4000 }),
    ];
  }

  it("redeems every unit the holder owns", () => {
    const s = fold(ledger("cash"), [MANAGER, INVESTOR]);
    expect(s.holders.find((h) => h.holderId === 2)!.units).toBe(0n);
  });

  it("closes the holder and clears their basis", () => {
    const h = fold(ledger("cash"), [MANAGER, INVESTOR]).holders.find((x) => x.holderId === 2)!;
    expect(h.status).toBe("closed");
    expect(h.basisCents).toBe(0n);
  });

  it("returns value less fee", () => {
    // value $600, profit $300, fee $120, holder receives $480
    const before = fold(ledger("cash").slice(0, 4), [MANAGER, INVESTOR]);
    const after = fold(ledger("cash"), [MANAGER, INVESTOR]);
    expect(before.equityCents - after.equityCents).toBe(centsFromDecimal("600"));
  });

  it("leaves NAV unchanged", () => {
    expect(navTimes1e4(totalsOf(fold(ledger("units"), [MANAGER, INVESTOR])))).toBe(40_000n);
    expect(navTimes1e4(totalsOf(fold(ledger("cash"), [MANAGER, INVESTOR])))).toBe(40_000n);
  });
});

describe("fold — payout below the high-water mark", () => {
  function ledger() {
    return [
      entry("deposit", "300", { holderId: 1 }),
      entry("deposit", "300", { holderId: 2 }),
      entry("equity_reading", "300"),   // halved; investor value $150 < basis $300
      entry("payout", "0", { holderId: 2, feeSettlement: "units", splitBpsApplied: 4000 }),
    ];
  }

  it("is a no-op in profit mode", () => {
    const before = fold(ledger().slice(0, 3), [MANAGER, INVESTOR]);
    const after = fold(ledger(), [MANAGER, INVESTOR]);
    expect(after.equityCents).toBe(before.equityCents);
    expect(after.units).toBe(before.units);
  });

  it("charges no fee on exit and returns current value", () => {
    const l = ledger();
    l[3] = entry("exit", "0", { holderId: 2, feeSettlement: "cash", splitBpsApplied: 4000 });
    const before = fold(l.slice(0, 3), [MANAGER, INVESTOR]);
    const after = fold(l, [MANAGER, INVESTOR]);
    expect(before.equityCents - after.equityCents).toBe(centsFromDecimal("150"));
    expect(after.holders.find((h) => h.holderId === 1)!.basisCents).toBe(centsFromDecimal("300"));
  });
});

describe("checkNavUnchanged", () => {
  it("passes when NAV is preserved", () => {
    const t = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("500") };
    expect(checkNavUnchanged(t, t)).toBe(true);
  });
  it("fails when NAV moves", () => {
    const a = { equityCents: centsFromDecimal("1000"), units: unitsFromDecimal("500") };
    const b = { equityCents: centsFromDecimal("2000"), units: unitsFromDecimal("500") };
    expect(checkNavUnchanged(a, b)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test -- replay.test.ts
```

Expected: FAIL — `payout entries are not applied yet — see Task 7`, plus `checkNavUnchanged is not a function`.

- [ ] **Step 3: Replace the payout/exit case in `lib/compound/engine/replay.ts`**

Add these imports at the top:

```typescript
import { unitsForDeposit, unitsForFee, navTimes1e4, type PoolTotals } from "./nav";
import { quote } from "./quote";
```

Replace the `case "payout": case "exit":` block with:

```typescript
      case "payout":
      case "exit": {
        const h = holderOf(e.holderId);
        // Every figure is taken against the PRE-payout totals. That is what
        // keeps NAV constant across the operation.
        const totals: PoolTotals = { equityCents, units };
        const q = quote({
          totals,
          holderUnits: h.units,
          basisCents: h.basisCents,
          splitBps: e.splitBpsApplied ?? h.splitBps,
          isManager: h.isManager,
          mode: e.type === "exit" ? "exit" : "profit",
        });

        // On exit the holder surrenders everything, so redeem their exact
        // balance rather than a ceil()-derived figure that could leave dust.
        const redeemed = e.type === "exit" ? h.units : q.unitsRedeemed;

        h.units -= redeemed;
        units -= redeemed;
        equityCents -= q.toHolderCents;

        if (q.feeCents > 0n) {
          const manager = [...holders.values()].find((x) => x.isManager);
          if (!manager) throw new Error("a fee crystallised but no manager holder was seeded");
          if (e.feeSettlement === "cash") {
            equityCents -= q.feeCents;
          } else {
            const feeUnits = unitsForFee(totals, q.feeCents);
            manager.units += feeUnits;
            units += feeUnits;
            manager.basisCents += q.feeCents;
          }
        }

        if (e.type === "exit") {
          h.basisCents = 0n;
          h.status = "closed";
        }
        break;
      }
```

- [ ] **Step 4: Add the NAV comparison helper**

Append to `lib/compound/engine/replay.ts`:

```typescript
/**
 * True when two sets of totals report the same NAV to four decimal places.
 * Deposits, payouts and fee settlements must all satisfy this; only an equity
 * reading may move NAV.
 */
export function checkNavUnchanged(before: PoolTotals, after: PoolTotals): boolean {
  return navTimes1e4(before) === navTimes1e4(after);
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm test -- replay.test.ts && pnpm typecheck
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/compound/engine/replay.ts lib/compound/engine/replay.test.ts
git commit -m "feat(engine): payouts, exits, and fee settlement at constant NAV"
```

---

### Task 8: `invariants.ts` — the five assertions

Turns the spec's invariants into a function the property suite and a nightly job both call.

**Files:**
- Create: `lib/compound/engine/invariants.ts`
- Test: `lib/compound/engine/invariants.test.ts`

**Interfaces:**
- Consumes: `PoolState` from `./replay`; `allocateValues` from `./nav`
- Produces:
  - `interface InvariantViolation { code: string; detail: string }`
  - `checkInvariants(state: PoolState): InvariantViolation[]`
  - `assertInvariants(state: PoolState): void` — throws on any violation

- [ ] **Step 1: Write the failing tests**

Create `lib/compound/engine/invariants.test.ts`:

```typescript
import { centsFromDecimal, unitsFromDecimal } from "./money";
import { checkInvariants, assertInvariants } from "./invariants";
import type { PoolState, HolderState } from "./replay";

function holder(over: Partial<HolderState> = {}): HolderState {
  return {
    holderId: 1, isManager: false, splitBps: 4000,
    units: unitsFromDecimal("100"), basisCents: centsFromDecimal("100"),
    status: "active", ...over,
  };
}

function state(over: Partial<PoolState> = {}): PoolState {
  return {
    equityCents: centsFromDecimal("200"),
    units: unitsFromDecimal("200"),
    holders: [holder({ holderId: 1 }), holder({ holderId: 2 })],
    lastReadingOn: "2026-01-01",
    seq: 3,
    ...over,
  };
}

describe("checkInvariants — a healthy pool", () => {
  it("reports no violations", () => {
    expect(checkInvariants(state())).toEqual([]);
  });
  it("reports no violations for an empty pool", () => {
    expect(checkInvariants(state({ equityCents: 0n, units: 0n, holders: [] }))).toEqual([]);
  });
});

describe("I1 — holder units sum to units issued", () => {
  it("catches a shortfall", () => {
    const v = checkInvariants(state({ units: unitsFromDecimal("300") }));
    expect(v.map((x) => x.code)).toContain("I1_UNITS_SUM");
  });
  it("names both figures in the detail", () => {
    const v = checkInvariants(state({ units: unitsFromDecimal("300") }));
    expect(v.find((x) => x.code === "I1_UNITS_SUM")!.detail).toMatch(/\d+/);
  });
});

describe("I2 — holder values sum to equity", () => {
  it("holds exactly when equity does not divide evenly", () => {
    // $10.00 across three equal holders — largest-remainder must close the gap.
    const s = state({
      equityCents: 1000n,
      units: unitsFromDecimal("3"),
      holders: [
        holder({ holderId: 1, units: unitsFromDecimal("1") }),
        holder({ holderId: 2, units: unitsFromDecimal("1") }),
        holder({ holderId: 3, units: unitsFromDecimal("1") }),
      ],
    });
    expect(checkInvariants(s).filter((v) => v.code === "I2_VALUE_SUM")).toEqual([]);
  });

  it("catches equity present with no units", () => {
    const v = checkInvariants(state({ equityCents: 500n, units: 0n, holders: [] }));
    expect(v.map((x) => x.code)).toContain("I2_ORPHAN_EQUITY");
  });

  it("does not run the value check when I1 already failed", () => {
    const v = checkInvariants(state({ units: unitsFromDecimal("300") }));
    expect(v.map((x) => x.code)).not.toContain("I2_VALUE_SUM");
  });
});

describe("I4 — no negative quantities", () => {
  it("catches negative units", () => {
    const s = state({
      units: unitsFromDecimal("0"),
      holders: [holder({ holderId: 1, units: -1n }), holder({ holderId: 2, units: 1n })],
    });
    expect(checkInvariants(s).map((x) => x.code)).toContain("I4_NEGATIVE_UNITS");
  });
  it("catches a negative cost basis", () => {
    const s = state({ holders: [
      holder({ holderId: 1, basisCents: -1n }),
      holder({ holderId: 2 }),
    ] });
    expect(checkInvariants(s).map((x) => x.code)).toContain("I4_NEGATIVE_BASIS");
  });
});

describe("assertInvariants", () => {
  it("is silent on a healthy pool", () => {
    expect(() => assertInvariants(state())).not.toThrow();
  });
  it("throws listing every violation", () => {
    expect(() => assertInvariants(state({ units: unitsFromDecimal("300") })))
      .toThrow(/I1_UNITS_SUM/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test -- invariants.test.ts
```

Expected: FAIL — `Cannot find module './invariants'`.

- [ ] **Step 3: Write the implementation**

Create `lib/compound/engine/invariants.ts`:

```typescript
/**
 * The invariants from the design spec, §3.5. These must hold after every
 * operation. The property suite asserts them across randomised sequences, and a
 * nightly job asserts them against live state.
 *
 * Invariants 1 and 2 hold EXACTLY, not within a tolerance — a direct
 * consequence of deriving balances instead of materialising them. Units are
 * integers that sum exactly, and value is a pure function of units.
 *
 * Invariant 3 (NAV unchanged by anything but a reading) is a property of
 * transitions rather than of a single state, so it is asserted in the property
 * suite via checkNavUnchanged rather than here.
 *
 * Invariant 5 (append-only) is enforced in the database by withholding UPDATE
 * and DELETE grants, not in application code.
 */
import { allocateValues } from "./nav";
import type { PoolState } from "./replay";

export interface InvariantViolation {
  code: string;
  detail: string;
}

export function checkInvariants(state: PoolState): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  // I4 first — negative quantities would make the sums below meaningless.
  for (const h of state.holders) {
    if (h.units < 0n) {
      violations.push({
        code: "I4_NEGATIVE_UNITS",
        detail: `holder ${h.holderId} holds ${h.units} units`,
      });
    }
    if (h.basisCents < 0n) {
      violations.push({
        code: "I4_NEGATIVE_BASIS",
        detail: `holder ${h.holderId} has cost basis ${h.basisCents}`,
      });
    }
  }

  // I1 — Σ holder units = units issued.
  const sumUnits = state.holders.reduce((s, h) => s + h.units, 0n);
  const unitsBalance = sumUnits === state.units;
  if (!unitsBalance) {
    violations.push({
      code: "I1_UNITS_SUM",
      detail: `Σ holder units ${sumUnits} ≠ units issued ${state.units}`,
    });
  }

  // I2 — Σ holder value = equity. Only meaningful once I1 holds.
  if (state.units === 0n) {
    if (state.equityCents !== 0n) {
      violations.push({
        code: "I2_ORPHAN_EQUITY",
        detail: `equity ${state.equityCents} with zero units issued`,
      });
    }
  } else if (unitsBalance && violations.length === 0) {
    const values = allocateValues(
      { equityCents: state.equityCents, units: state.units },
      state.holders.map((h) => h.units),
    );
    const sumValue = values.reduce((s, c) => s + c, 0n);
    if (sumValue !== state.equityCents) {
      violations.push({
        code: "I2_VALUE_SUM",
        detail: `Σ holder value ${sumValue} ≠ equity ${state.equityCents}`,
      });
    }
  }

  return violations;
}

export function assertInvariants(state: PoolState): void {
  const violations = checkInvariants(state);
  if (violations.length > 0) {
    const lines = violations.map((v) => `  ${v.code}: ${v.detail}`).join("\n");
    throw new Error(`accounting invariants violated:\n${lines}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test -- invariants.test.ts && pnpm typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/compound/engine/invariants.ts lib/compound/engine/invariants.test.ts
git commit -m "feat(engine): invariant checks with exact unit and value sums"
```

---

### Task 9: Property-based suite

The highest-value test in the product. Generates randomised sequences of real operations and asserts the invariants hold after every single one.

**Files:**
- Create: `lib/compound/engine/engine.property.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–8
- Produces: no exports — a test suite

- [ ] **Step 1: Write the property suite**

Create `lib/compound/engine/engine.property.test.ts`:

```typescript
import fc from "fast-check";
import { UNIT_SCALE } from "./money";
import { navTimes1e4 } from "./nav";
import { fold, totalsOf, type HolderSeed, type LedgerEntry, type PoolState } from "./replay";
import { checkInvariants } from "./invariants";

const MANAGER: HolderSeed = { holderId: 0, isManager: true, splitBps: 0 };

/** A generated operation, before it is turned into a ledger entry. */
type Op =
  | { kind: "deposit"; holderId: number; amountCents: bigint }
  | { kind: "reading"; equityCents: bigint }
  | { kind: "payout"; holderId: number; feeCash: boolean }
  | { kind: "exit"; holderId: number; feeCash: boolean };

const HOLDER_COUNT = 4; // manager (0) plus three investors

function seeds(): HolderSeed[] {
  return [
    MANAGER,
    { holderId: 1, isManager: false, splitBps: 4000 },
    { holderId: 2, isManager: false, splitBps: 3500 },
    { holderId: 3, isManager: false, splitBps: 5000 },
  ];
}

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("deposit" as const),
    holderId: fc.integer({ min: 0, max: HOLDER_COUNT - 1 }),
    amountCents: fc.bigInt({ min: 100n, max: 100_000_00n }),
  }),
  fc.record({
    kind: fc.constant("reading" as const),
    equityCents: fc.bigInt({ min: 1n, max: 500_000_00n }),
  }),
  fc.record({
    kind: fc.constant("payout" as const),
    holderId: fc.integer({ min: 1, max: HOLDER_COUNT - 1 }),
    feeCash: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("exit" as const),
    holderId: fc.integer({ min: 1, max: HOLDER_COUNT - 1 }),
    feeCash: fc.boolean(),
  }),
);

/**
 * Turn generated ops into a ledger, dropping any that cannot legally apply at
 * that point (a payout before the holder exists, a reading before genesis).
 * Replaying the prefix is what tells us whether an op is legal.
 */
function buildLedger(ops: readonly Op[]): LedgerEntry[] {
  const ledger: LedgerEntry[] = [];
  let seq = 0;

  for (const op of ops) {
    const state = fold(ledger, seeds());
    const holders = new Map(state.holders.map((h) => [h.holderId, h]));

    const push = (e: Omit<LedgerEntry, "id" | "seq">) => {
      seq += 1;
      ledger.push({ id: seq, seq, ...e });
    };
    const base = {
      occurredOn: "2026-01-01",
      feeSettlement: null,
      splitBpsApplied: null,
      reversesId: null,
    };

    switch (op.kind) {
      case "deposit": {
        // The founding deposit must come from the manager.
        if (state.units === 0n && op.holderId !== 0) continue;
        push({ ...base, holderId: op.holderId, type: "deposit", amountCents: op.amountCents });
        break;
      }
      case "reading": {
        if (state.units === 0n) continue;         // NAV is undefined before genesis
        push({ ...base, holderId: null, type: "equity_reading", amountCents: op.equityCents });
        break;
      }
      case "payout":
      case "exit": {
        const h = holders.get(op.holderId);
        if (!h || h.units === 0n || state.equityCents <= 0n) continue;
        push({
          ...base,
          holderId: op.holderId,
          type: op.kind,
          amountCents: 0n,
          feeSettlement: op.feeCash ? "cash" : "units",
          splitBpsApplied: h.splitBps,
        });
        break;
      }
    }
  }
  return ledger;
}

describe("engine properties", () => {
  it("invariants hold after every operation in any legal sequence", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 25 }), (ops) => {
        const ledger = buildLedger(ops);
        for (let i = 1; i <= ledger.length; i += 1) {
          const state = fold(ledger.slice(0, i), seeds());
          const violations = checkInvariants(state);
          if (violations.length > 0) {
            throw new Error(
              `after entry ${i} (${ledger[i - 1]!.type}): ` +
                violations.map((v) => `${v.code} ${v.detail}`).join("; "),
            );
          }
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("NAV moves only on an equity reading", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 25 }), (ops) => {
        const ledger = buildLedger(ops);
        for (let i = 1; i <= ledger.length; i += 1) {
          const before = fold(ledger.slice(0, i - 1), seeds());
          const after = fold(ledger.slice(0, i), seeds());
          const entry = ledger[i - 1]!;

          if (entry.type === "equity_reading") continue;
          if (before.units === 0n || after.units === 0n) continue; // NAV undefined either side

          const navBefore = navTimes1e4(totalsOf(before));
          const navAfter = navTimes1e4(totalsOf(after));
          if (navBefore !== navAfter) {
            throw new Error(
              `${entry.type} at seq ${entry.seq} moved NAV ${navBefore} -> ${navAfter}`,
            );
          }
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("replay is deterministic — the same ledger always yields the same state", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 20 }), (ops) => {
        const ledger = buildLedger(ops);
        const a = fold(ledger, seeds());
        const b = fold([...ledger].reverse(), seeds()); // seq ordering must win
        expect(b).toEqual(a);
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("a holder's cost basis never goes negative and never exceeds lifetime deposits", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 25 }), (ops) => {
        const ledger = buildLedger(ops);
        const state = fold(ledger, seeds());
        const deposited = new Map<number, bigint>();
        for (const e of ledger) {
          if (e.type === "deposit" && e.holderId !== null) {
            deposited.set(e.holderId, (deposited.get(e.holderId) ?? 0n) + e.amountCents);
          }
        }
        for (const h of state.holders) {
          if (h.isManager) continue; // the manager's basis also grows from retained fees
          expect(h.basisCents >= 0n).toBe(true);
          expect(h.basisCents <= (deposited.get(h.holderId) ?? 0n)).toBe(true);
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("an exited holder holds no units and no basis", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 25 }), (ops) => {
        const state: PoolState = fold(buildLedger(ops), seeds());
        for (const h of state.holders) {
          if (h.status === "closed") {
            expect(h.units).toBe(0n);
            expect(h.basisCents).toBe(0n);
          }
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("units are never fractional below the scale floor", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 20 }), (ops) => {
        const state = fold(buildLedger(ops), seeds());
        expect(state.units >= 0n).toBe(true);
        expect(state.units % 1n).toBe(0n);
        expect(UNIT_SCALE).toBe(10_000_000_000n);
        return true;
      }),
      { numRuns: 100 },
    );
  });
});
```

- [ ] **Step 2: Run the suite**

```bash
pnpm test -- engine.property.test.ts
```

Expected: PASS. If fast-check reports a counterexample, it prints the exact operation sequence that broke an invariant — fix the engine, never the assertion.

- [ ] **Step 3: Run every gate together**

```bash
pnpm typecheck && pnpm test
```

Expected: typecheck clean; all suites PASS, including the purity guard from Task 1.

- [ ] **Step 4: Commit**

```bash
git add lib/compound/engine/engine.property.test.ts
git commit -m "test(engine): property-based suite asserting invariants across random sequences"
```

- [ ] **Step 5: Push**

```bash
git push origin main
```

---

## Plan self-review

**Spec coverage.** Every clause of spec §3 (domain model), §3.5 (invariants) and §4 (numeric representation) maps to a task:

| Spec | Task |
|---|---|
| §3.1 units, genesis NAV | 3 |
| §3.2 cost basis, high-water mark | 5, 7 |
| §3.3 the split | 5 |
| §3.4 fee settlement, NAV proof | 7 |
| §3.5 invariants 1, 2, 4 | 8 |
| §3.5 invariant 3 (NAV unchanged) | 7, 9 |
| §3.5 invariant 5 (append-only) | database grants — plan 2, not application code |
| §4 money, units, splits, NAV | 2, 3 |
| §4 rounding policy | 3, 4, 5 |
| §5.1 module boundaries, `engine/` purity | 1 |
| §11 property-based testing | 9 |

Not covered here by design, and carried into later plans: schema and RLS (§6), the reconciler and safety interlock (§5.2, §5.3, §6.3), all surfaces (§7), the design system (§8), auth (§9), deployment (§10).

**Type consistency.** `PoolTotals`, `PoolState`, `HolderState`, `HolderSeed`, `LedgerEntry` and `Quote` are defined once and referenced by the same names throughout. `unitsForDeposit`, `valueOfUnits`, `unitsToRedeem`, `unitsForFee`, `navTimes1e4`, `allocateValues`, `quote`, `fold`, `totalsOf`, `checkNavUnchanged`, `checkInvariants` and `assertInvariants` are each defined in exactly one task and used consistently after it.

**Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Every code step contains the code.

---

## Deviations from the spec, for the record

Three refinements surfaced while writing this plan. Each is a change to the spec, not just to the plan.

1. **Valuation uses largest-remainder allocation (Task 4).** Spec §4 gave only floor and ceil rules, which would leave "Σ holder value = equity" short by up to one cent per holder. Since §3.5 claims invariant 2 holds *exactly*, valuation needs an exact allocator. The conservative floor/ceil rule still governs every operation that moves value; largest-remainder applies to reporting only.

2. **The `fee` ledger type is dropped.** Spec §6 lists it in the type constraint, but a fee is always settled inside its payout entry, and a separate applied `fee` entry would double-count. `feeSettlement` on the payout entry carries the choice.

3. **`payout_mode` is dropped.** Spec §6 carries both `type` and `payout_mode`, which is redundant — `type` is already `payout` or `exit`. Mode is derived from type.

Fold these into the spec before starting plan 2.
