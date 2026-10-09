import { SponsonError } from "./errors.js";
import { dependenciesOf, walkParams } from "./plan.js";
import { isFromRef, type Change } from "./types.js";

/**
 * Order the lines that apply to this environment so every line comes after the lines it reads from.
 * Throws REF_CYCLE on cycles and REF_FILTERED when a line references one that the environment filter removed.
 */
export function orderChanges(active: Change[], all: Change[]): Change[] {
  const activeIds = new Set(active.map((c) => c.id));
  const allIds = new Set(all.map((c) => c.id));

  for (const c of active) {
    for (const dep of dependenciesOf(c)) {
      if (!activeIds.has(dep)) {
        const exists = allIds.has(dep);
        const target = all.find((x) => x.id === dep);
        throw new SponsonError(
          exists ? "REF_FILTERED" : "REF_UNKNOWN",
          exists
            ? `Line \`${c.id}\` references \`${dep}\`, but \`${dep}\` is filtered out of this environment (environments: [${target?.environments?.join(", ")}]). Add this environment to \`${dep}\` or filter \`${c.id}\` the same way.`
            : `Line \`${c.id}\` references unknown id \`${dep}\``,
          { id: c.id, ref: dep },
        );
      }
    }
  }

  const byId = new Map(active.map((c) => [c.id, c]));
  const state = new Map<string, "visiting" | "done">();
  const out: Change[] = [];

  const visit = (id: string, stack: string[]) => {
    const s = state.get(id);
    if (s === "done") return;
    if (s === "visiting") {
      const cycle = [...stack.slice(stack.indexOf(id)), id].join(" → ");
      throw new SponsonError("REF_CYCLE", `Reference cycle: ${cycle}`, { cycle });
    }
    state.set(id, "visiting");
    const change = byId.get(id)!;
    for (const dep of dependenciesOf(change).sort()) visit(dep, [...stack, id]);
    state.set(id, "done");
    out.push(change);
  };

  for (const c of active) visit(c.id, []);
  return out;
}

/** Every `from:` reference in a change, as `{ line, output }`. */
export function outputRefs(change: Change): Array<{ line: string; output: string; path: string }> {
  const refs: Array<{ line: string; output: string; path: string }> = [];
  walkParams(change.params, [], (path, v) => {
    if (isFromRef(v)) {
      const [line, ...rest] = v.from.split(".");
      refs.push({ line: line!, output: rest.join("."), path: path.join(".") });
    }
  });
  return refs;
}

/** Transitive dependents of `id` within `ordered`. */
export function dependentsOf(id: string, ordered: Change[]): Set<string> {
  const result = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of ordered) {
      if (result.has(c.id)) continue;
      const deps = dependenciesOf(c);
      if (deps.includes(id) || deps.some((d) => result.has(d))) {
        result.add(c.id);
        grew = true;
      }
    }
  }
  return result;
}
