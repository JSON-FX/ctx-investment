/**
 * Filter chips and a search box. Every control is a link or a GET form, so
 * the whole table state stays in the URL and the page never hydrates.
 *
 * Hidden inputs carry every other parameter through the form, which is what
 * stops searching the trades table from resetting the orders table.
 *
 * Chip VALUES are supplied by the caller (Task 10/11's page code) via
 * `groups`, not chosen here. This component's contract is that whatever
 * value a caller lists, it round-trips through hrefWith unchanged; whether
 * that value is also one trade-filters.ts/order-filters.ts recognise is a
 * page-wiring concern outside Task 9 — see order-filters.ts's own comment on
 * why an unrecognised filter value fails open to unfiltered rather than
 * throwing or emptying the table.
 */
import { hrefWith, type Params } from "@/lib/compound/journal/table-state";

export interface ChipGroup {
  /** The parameter name, without the prefix. */
  name: string;
  label: string;
  options: readonly { value: string; label: string }[];
}

export function FilterBar({
  groups,
  active,
  search,
  prefix,
  basePath,
  params,
}: {
  groups: readonly ChipGroup[];
  active: Readonly<Record<string, string>>;
  search: string;
  prefix: string;
  basePath: string;
  params: Params;
}) {
  const key = (name: string) => `${prefix}.${name}`;
  const anyActive = Object.keys(active).length > 0 || search !== "";
  const clearPatch: Record<string, string | null> = { [`${prefix}.page`]: null, [`${prefix}.q`]: null };
  for (const g of groups) clearPatch[key(g.name)] = null;

  return (
    <div className="filters">
      {groups.map((g) => (
        <div className="filters-group" key={g.name} role="group" aria-label={g.label}>
          <span className="filters-label">{g.label}</span>
          {g.options.map((o) => {
            const on = active[g.name] === o.value;
            const href = hrefWith(basePath, params, {
              [key(g.name)]: on ? null : o.value,
              [`${prefix}.page`]: null,
            });
            return (
              <a
                key={o.value}
                className={`chip${on ? " chip-on" : ""}`}
                href={href}
                aria-pressed={on}
              >
                {o.label}
              </a>
            );
          })}
        </div>
      ))}

      <form className="filters-search" method="get" action={basePath}>
        {Object.entries(params)
          .filter(([k, v]) => v !== undefined && v !== "" && k !== `${prefix}.q` && k !== `${prefix}.page`)
          .map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
        <label className="filters-label" htmlFor={`${prefix}-q`}>
          Search
        </label>
        <input
          id={`${prefix}-q`}
          className="field"
          type="search"
          name={`${prefix}.q`}
          defaultValue={search}
          placeholder="Symbol or ticket"
        />
        <button className="btn" type="submit">
          Apply
        </button>
      </form>

      {anyActive ? (
        <a className="btn" href={hrefWith(basePath, params, clearPatch)}>
          Clear
        </a>
      ) : null}
    </div>
  );
}
