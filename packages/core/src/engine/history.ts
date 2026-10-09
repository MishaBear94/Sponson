import type { Receipt } from "../types.js";

/** Answers whether `older` is an ancestor of `newer`; null when it cannot tell (shallow clone, unknown commit). */
export type AncestryCheck = (older: string, newer: string) => Promise<boolean | null>;

export interface Staleness {
  stale: boolean;
  /** The last commit applied to this scope, when the run is stale. */
  last?: string;
  reason?: "superseded" | "ancestor";
}

/**
 * A run must not roll a scope back to an older commit (a late deployment event, a re-run job).
 * Older means: applied before and superseded since, or — when git can tell — an ancestor of the
 * last applied commit even though it was never applied itself.
 */
export async function staleness(history: Receipt["history"], sha: string, isAncestor?: AncestryCheck): Promise<Staleness> {
  const last = history[history.length - 1]?.sha;
  if (!last || last === sha) return { stale: false };
  const at = history.findIndex((h) => h.sha === sha);
  if (at >= 0) return { stale: true, last, reason: "superseded" };
  if (isAncestor && (await isAncestor(sha, last).catch(() => null)) === true) return { stale: true, last, reason: "ancestor" };
  return { stale: false };
}
