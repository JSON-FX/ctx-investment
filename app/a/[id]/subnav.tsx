"use client";

/**
 * The sub-nav. A client component because a layout is not told which child
 * route rendered, and usePathname is the only way to know which tab is
 * current.
 *
 * It takes two numbers. Nothing money-shaped crosses this boundary — see the
 * global constraint on bigint. The logic worth testing lives in
 * activeNavKey(), which is pure and tested in lib/compound/ui/routes.test.ts;
 * what remains here is a map over a constant.
 */
import { usePathname } from "next/navigation";
import { SUBNAV, activeNavKey } from "@/lib/compound/ui/routes";

export function SubNav({
  accountId, pendingCount,
}: { accountId: number; pendingCount: number }) {
  const active = activeNavKey(usePathname() ?? "", accountId);
  return (
    <nav className="subnav" aria-label="Account sections">
      {SUBNAV.map((n) => (
        <a
          key={n.key}
          href={n.href(accountId)}
          aria-current={n.key === active ? "page" : undefined}
        >
          {n.label}
          {n.badge === "pending" && pendingCount > 0 ? (
            <span className="chip is-fee" aria-label={`${pendingCount} awaiting review`}>
              {pendingCount}
            </span>
          ) : null}
        </a>
      ))}
    </nav>
  );
}
