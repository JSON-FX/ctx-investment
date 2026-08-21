/**
 * Table state carried in the URL.
 *
 * These pages have no client JavaScript, so every control is a link and every
 * piece of table state is a search parameter. Two consequences shape this
 * module.
 *
 * First, a search parameter is UNTRUSTED INPUT. Nothing here trusts a value:
 * the sort key must be in the table's allowlist, the page size must be in a
 * fixed set, the page number must be a positive integer below a ceiling, and
 * free text is length-capped. An unrecognised value falls back to the default
 * rather than propagating.
 *
 * That includes the SHAPE of a value, not only its content. Next.js's own
 * searchParams type is `string | string[] | undefined` — a repeated key
 * (`?t.q=a&t.q=b`) arrives as an array. Every read in this module therefore
 * checks `typeof value === "string"` before using it, and treats anything
 * else as absent. Without that check, an array survives `?? ""` (an array is
 * not `undefined`) and `.slice()` (arrays have one too), so a malformed
 * `search` value would not fail until a later `.toLowerCase()` call in
 * trade-filters.ts or order-filters.ts throws a TypeError — the rejection
 * needs to happen at the boundary, not wherever the value is first used.
 *
 * Second, three tables share one URL, so each one gets a prefix — t.page,
 * o.sort, p.size — and hrefWith preserves every parameter it is not changing.
 * Without that, sorting the orders table would reset the trades table.
 */
export interface TableState {
  /** 1-based. */
  page: number;
  size: number;
  /** One of spec.sorts. */
  sort: string;
  search: string;
  filters: Readonly<Record<string, string>>;
}

export interface TableSpec {
  readonly sorts: readonly string[];
  readonly defaultSort: string;
  readonly filterKeys: readonly string[];
  readonly sizes?: readonly number[];
}

export const DEFAULT_SIZES = [25, 50, 100] as const;
const MAX_PAGE = 10_000;
const MAX_TEXT = 64;

export type Params = Readonly<Record<string, string | undefined>>;

/**
 * Next.js hands searchParams as string | string[] | undefined, because a
 * parameter can repeat. Every control here writes a parameter once, so a
 * repeat is either a hand-edited URL or an attack; taking the FIRST value is
 * the choice that cannot be surprised by an appended duplicate.
 */
export function flattenParams(
  sp: Readonly<Record<string, string | string[] | undefined>>,
): Params {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && typeof v[0] === "string") out[k] = v[0];
  }
  return out;
}

function key(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name;
}

/**
 * Reads one parameter and rejects anything that is not actually a string —
 * `undefined` (absent), and also an array or any other shape a caller's
 * `Params` type promises never to hand us but a raw searchParams object
 * might anyway. See the module comment: this is the one place that decision
 * is made, so every caller below it can trust `string | undefined`.
 */
function get(params: Params, prefix: string, name: string): string | undefined {
  const v: unknown = params[key(prefix, name)];
  return typeof v === "string" ? v : undefined;
}

export function parseTableState(params: Params, spec: TableSpec, prefix = ""): TableState {
  const read = (name: string): string | undefined => get(params, prefix, name);

  const sizes = spec.sizes ?? DEFAULT_SIZES;
  const rawSize = Number.parseInt(read("size") ?? "", 10);
  const size = sizes.includes(rawSize) ? rawSize : sizes[0]!;

  const rawPage = Number.parseInt(read("page") ?? "", 10);
  const page =
    Number.isInteger(rawPage) && rawPage >= 1 ? Math.min(rawPage, MAX_PAGE) : 1;

  const rawSort = read("sort") ?? "";
  const sort = spec.sorts.includes(rawSort) ? rawSort : spec.defaultSort;

  const search = (read("q") ?? "").slice(0, MAX_TEXT);

  const filters: Record<string, string> = {};
  for (const name of spec.filterKeys) {
    const v = read(name);
    if (v !== undefined && v !== "") filters[name] = v.slice(0, MAX_TEXT);
  }

  return { page, size, sort, search, filters };
}

/**
 * A href with `patch` merged over the current parameters. A null or empty
 * patch value removes the parameter, which is how "clear this filter" works.
 * Keys are emitted in sorted order so a href is a deterministic string and a
 * test can assert it.
 *
 * `allParams` is typed as `Params` (string | undefined per value) but is
 * guarded the same way `get` is above: a caller passing a raw searchParams
 * object through unnormalised must not be able to smuggle an array into a
 * generated link.
 */
export function hrefWith(
  basePath: string,
  allParams: Params,
  patch: Readonly<Record<string, string | null>>,
): string {
  const merged = new Map<string, string>();
  for (const [k, v] of Object.entries(allParams)) {
    if (typeof v === "string" && v !== "") merged.set(k, v);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === "") merged.delete(k);
    else merged.set(k, v);
  }
  const qs = [...merged.keys()]
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(merged.get(k)!)}`)
    .join("&");
  return qs === "" ? basePath : `${basePath}?${qs}`;
}

/** Clicking a column header: same column flips direction, new column starts descending. */
export function toggleSort(current: string, column: string): string {
  return current === `${column}_desc` ? `${column}_asc` : `${column}_desc`;
}

/** Splits "profit_desc" into ["profit", "desc"]. */
export function splitSort(sort: string): [string, "asc" | "desc"] {
  const at = sort.lastIndexOf("_");
  const column = at === -1 ? sort : sort.slice(0, at);
  const dir = sort.slice(at + 1) === "asc" ? "asc" : "desc";
  return [column, dir];
}

export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageCount: number;
}

/** Clamps the page to the available range, so a stale link cannot show nothing. */
export function paginate<T>(rows: readonly T[], state: TableState): Paged<T> {
  const total = rows.length;
  const pageCount = total === 0 ? 1 : Math.ceil(total / state.size);
  const page = Math.min(state.page, pageCount);
  const start = (page - 1) * state.size;
  return { rows: rows.slice(start, start + state.size), total, page, pageCount };
}
