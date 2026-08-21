/**
 * NOT what requireAccount's notFound() renders — see app/a/not-found.tsx's
 * module doc for why, verified by probe. requireAccount is called from THIS
 * segment's own layout.tsx, and a segment's not-found boundary wraps its
 * `children` slot, not its layout's own execution, so that throw is caught
 * one level up, at app/a/not-found.tsx, not here.
 *
 * Kept anyway, re-exporting the same component, for the case this file's
 * plan draft actually names in its own file list: a FUTURE notFound() thrown
 * by a page BELOW this layout (app/a/[id]/holders/[hid]/page.tsx for an
 * unknown holder id, say) — that throw originates inside `children`, where
 * this segment's own boundary does apply. Nothing in this plan's Task 7
 * throws that way yet; this is a real, reachable boundary for later tasks,
 * not dead code kept out of caution.
 */
export { default } from "../not-found";
