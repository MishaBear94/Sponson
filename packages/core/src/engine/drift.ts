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
  const drift: Drift[] = [];
  const desired = new Set<string>();
  for (const i of inspected) for (const k of i.desired) desired.add(identity(i.change.adapter, i.provider, k));

  for (const e of rc.ledger.all()) {
    if (e.createdBy !== "sponson" || uninspected.has(e.line)) continue;
    if (desired.has(identity(e.adapter, e.provider, e.key))) continue;
    drift.push({
      kind: "orphan",
      adapter: e.adapter,
      line: e.line,
      resource: { key: e.key, id: e.id, label: e.label },
      message: `${e.label ?? e.key} is no longer declared by any line (last: \`${e.line}\`) but still exists. It is left alone; \`sponson apply --destroy\` removes it.`,
    });
  }

  const seen = new Set<string>();
  for (const i of inspected) {
    if (!i.op.listScope) continue;
    let listed: ResourceRecord[];
    try {
      listed = await i.op.listScope(rc.adapterContext(i.change.adapter, i.provider), i.resolved.params);
    } catch {
      continue; // listing is best-effort; it must never block plan
    }
    for (const r of listed) {
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
