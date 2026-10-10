import type { Drift, ResourceRecord } from "../types.js";
import { identity } from "./ledger.js";
import type { Inspection } from "./inspect.js";
import type { RunContext } from "./run-context.js";

/**
 * Scope-wide drift: what the ledger owns that no line declares (orphan), and what exists
 * where lines could own it that no scope manages (unmanaged).
 *
 * `inspected` must contain every line whose desired keys are known; entries of lines that
 * could not be inspected are not judged, so a read error never produces false orphans.
 */
export async function scopeDrift(rc: RunContext, inspected: Inspection[], uninspected: Set<string>): Promise<Drift[]> {
  const desired = new Set<string>();
  for (const i of inspected) for (const k of i.desired) desired.add(identity(i.change.adapter, i.provider, k));
  return [...orphans(rc, desired, uninspected), ...(await unmanaged(rc, inspected, desired))];
}

/** Ledger entries Sponson created that no inspected line declares any more. */
function orphans(rc: RunContext, desired: Set<string>, uninspected: Set<string>): Drift[] {
  return rc.ledger
    .all()
    .filter((e) => e.createdBy === "sponson" && !uninspected.has(e.line) && !desired.has(identity(e.adapter, e.provider, e.key)))
    .map((e) => ({
      kind: "orphan",
      adapter: e.adapter,
      line: e.line,
      resource: { key: e.key, id: e.id, label: e.label },
      message: `${e.label ?? e.key} is no longer declared by any line (last: \`${e.line}\`) but still exists. It is left alone; \`sponson apply --destroy\` removes it.`,
    }));
}

/** What the lines' scope listings show that neither this plan, this ledger nor another scope accounts for. */
async function unmanaged(rc: RunContext, inspected: Inspection[], desired: Set<string>): Promise<Drift[]> {
  const drift: Drift[] = [];
  const seen = new Set<string>();
  for (const i of inspected) {
    for (const r of await listed(rc, i)) {
      const id = identity(i.change.adapter, i.provider, r.key);
      if (seen.has(id)) continue;
      seen.add(id);
      if (desired.has(id) || rc.ledger.get(i.change.adapter, i.provider, r.key) || rc.foreign.has(id)) continue;
      drift.push({
        kind: "unmanaged",
        adapter: i.change.adapter,
        op: i.change.op,
        resource: { key: r.key, id: r.id, label: r.label },
        message: `${r.label ?? r.key} exists but no scope manages it. Sponson will not touch it. Run \`sponson init\` to adopt it.`,
      });
    }
  }
  return drift;
}

/** A line's scope listing; empty when its op cannot list or the listing fails (it must never block plan). */
async function listed(rc: RunContext, i: Inspection): Promise<ResourceRecord[]> {
  if (!i.op.listScope) return [];
  try {
    return await i.op.listScope(rc.adapterContext(i.change.adapter, i.provider), i.resolved.params);
  } catch {
    return [];
  }
}
