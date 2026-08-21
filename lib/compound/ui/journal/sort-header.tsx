/**
 * A sortable column header. A link, not a button — there is no client
 * JavaScript on these pages, so the sort is a navigation.
 *
 * aria-sort is set on the th so a screen reader announces the current sort;
 * spec section 8.4 forbids colour or a glyph being the sole carrier.
 *
 * This component does not own or see a table's sort allowlist — Task 8's
 * parseTableState does, per table, via TableSpec.sorts. What it guarantees
 * is the other half of that contract: toggleSort always emits `${column}_
 * asc` or `${column}_desc`, the exact shape parseTableState's allowlist
 * entries are written in, so a column name that is actually listed in a
 * table's spec (in both directions, as every spec in this codebase declares
 * it) round-trips through parseTableState unchanged. A column passed here
 * that the caller forgot to add to the spec does not round-trip — that is
 * a wiring bug in the page, not in this component, and no component at
 * this layer can catch it since the spec does not exist yet where this
 * component is defined.
 */
import { hrefWith, splitSort, toggleSort, type Params } from "@/lib/compound/journal/table-state";

export function SortHeader({
  label,
  column,
  sort,
  prefix,
  basePath,
  params,
  numeric = false,
}: {
  label: string;
  column: string;
  sort: string;
  prefix: string;
  basePath: string;
  params: Params;
  numeric?: boolean;
}) {
  const [active, dir] = splitSort(sort);
  const isActive = active === column;
  const next = toggleSort(sort, column);
  const href = hrefWith(basePath, params, {
    [`${prefix}.sort`]: next,
    // Any change to the ordering invalidates the page number.
    [`${prefix}.page`]: null,
  });
  const ariaSort = isActive ? (dir === "asc" ? "ascending" : "descending") : "none";
  return (
    <th scope="col" aria-sort={ariaSort} style={numeric ? undefined : { textAlign: "left" }}>
      <a href={href} className="sortlink">
        {label}
        <span aria-hidden="true">{isActive ? (dir === "asc" ? " ↑" : " ↓") : ""}</span>
      </a>
    </th>
  );
}
