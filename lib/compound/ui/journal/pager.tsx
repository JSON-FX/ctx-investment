/**
 * Page navigation for a table paginated by Task 8's `paginate()`.
 *
 * `paginate()` already clamps an out-of-range page back to the last real one
 * for the request path a person actually drives — see table-state.test.ts's
 * "clamps a page beyond the end back to the last page". This component adds
 * its own clamp on top of that, so that "a pager must not be able to emit an
 * out-of-range page" is a property of the component itself, not merely a
 * property of every future caller remembering to run `paginate()` first.
 * `safePage` is what every link, the disabled state and the "page X of Y"
 * label are all built from, so the label can never claim a page the controls
 * disagree with.
 */
import { hrefWith, type Params } from "@/lib/compound/journal/table-state";

export function Pager({
  page,
  pageCount,
  total,
  prefix,
  basePath,
  params,
  noun,
}: {
  page: number;
  pageCount: number;
  total: number;
  prefix: string;
  basePath: string;
  params: Params;
  noun: string;
}) {
  const safeCount = Math.max(pageCount, 1);
  const safePage = Math.min(Math.max(page, 1), safeCount);
  const to = (p: number) => hrefWith(basePath, params, { [`${prefix}.page`]: String(p) });
  return (
    <nav className="filters-pager" aria-label={`${noun} pagination`}>
      <span className="num">
        {total} {noun}
        {total === 1 ? "" : "s"} · page {safePage} of {safeCount}
      </span>
      {safePage > 1 ? (
        <a className="btn" href={to(safePage - 1)} rel="prev">
          Previous
        </a>
      ) : (
        <span className="btn" aria-disabled="true">
          Previous
        </span>
      )}
      {safePage < safeCount ? (
        <a className="btn" href={to(safePage + 1)} rel="next">
          Next
        </a>
      ) : (
        <span className="btn" aria-disabled="true">
          Next
        </span>
      )}
    </nav>
  );
}
