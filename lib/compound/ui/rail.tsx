/**
 * The ownership rail. Green means the pool, divided — darkest first.
 *
 * Widths come from allocateShares, which sums to exactly 1,000,000 ppm, so the
 * segments fill the rail exactly. Flooring each share leaves a visible gap: on
 * this project's fixture the floors sum to 999,998.
 *
 * The percentage string is built with integer arithmetic. ppm / 10000 as a
 * float is fine for a CSS length, but there is no reason to introduce one.
 */
import type { RailSegment } from "@/lib/compound/present/rail";
import { formatPpm } from "@/lib/compound/present/format";

function widthPercent(ppm: number): string {
  return `${Math.trunc(ppm / 10_000)}.${(ppm % 10_000).toString().padStart(4, "0")}%`;
}

export function OwnershipRail({ segments }: { segments: RailSegment[] }) {
  if (segments.length === 0) return null;
  return (
    <>
      <div className="rail" role="img" aria-label="Ownership by holder">
        {segments.map((s) => (
          <div
            key={s.holderId}
            className={s.hatched ? "seg hatched" : "seg"}
            style={{ width: widthPercent(s.ppm), background: s.tint }}
          />
        ))}
      </div>
      <ul className="leg" aria-label="Ownership legend">
        {segments.map((s) => (
          <li key={s.holderId}>
            <i style={{ background: s.tint }} aria-hidden="true" />
            {s.label}
            {s.isManager ? " (manager)" : ""} <b>{formatPpm(s.ppm)}</b>
          </li>
        ))}
      </ul>
    </>
  );
}
