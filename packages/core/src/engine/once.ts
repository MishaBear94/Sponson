import type { LineOutputs, ResolveResult } from "../resolve.js";
import type { ApplyResult, LedgerEntry, Literal, OpSpec } from "../types.js";

/**
 * Once-only outputs (ADR 0018): a value only the create response carries. The ledger never holds the value, only
 * keyed fingerprints of it: on the producer, the one its create returned (`onceFingerprints`); on each dependent, the
 * one it was last written with (`onceInputs`). Equal fingerprints mean the dependent still holds the current value,
 * so a later run that cannot know the value may leave it alone (`{ keep: true }`); anything else is refused.
 */

/** Keyed fingerprint of a value: never reversible, keyed per scope like every hash in the ledger. */
export type Fingerprint = (value: Literal) => string;

/**
 * The producer's fingerprints after a write: those of the once outputs `result` returned, over the previous
 * resource's unless the write created something (a create starts a new value).
 */
export function producedFingerprints(op: OpSpec, result: ApplyResult, before: LedgerEntry[], fp: Fingerprint): Record<string, string> {
  const out: Record<string, string> = result.created.length ? {} : { ...before.find((e) => e.onceFingerprints)?.onceFingerprints };
  for (const [name, spec] of Object.entries(op.outputs)) {
    const v = result.outputs[name];
    if (spec.once && v !== undefined) out[name] = fp(v);
  }
  return out;
}

/**
 * A dependent's fingerprints after a write: the once values it was resolved with in this run, and, for references
 * that stood as `{ keep: true }`, the fingerprints it already had.
 */
export function consumedFingerprints(resolved: ResolveResult, before: LedgerEntry[], outputs: Map<string, LineOutputs>, fp: Fingerprint): Record<string, string> {
  const out: Record<string, string> = {};
  const had = before.find((e) => e.onceInputs)?.onceInputs ?? {};
  for (const s of resolved.spent) {
    const was = had[s.ref];
    if (s.kept && was) out[s.ref] = was;
  }
  for (const input of Object.values(resolved.inputs)) {
    if (input.state !== "resolved" || !input.dependsOn || !input.ref) continue;
    const lo = outputs.get(input.dependsOn);
    const output = input.ref.slice(input.dependsOn.length + 1);
    const value = lo?.values[output];
    if (lo?.specs[output]?.once && value !== undefined) out[input.ref] = fp(value);
  }
  return out;
}

/**
 * True when every resource of line `lineId` was last written with the once value `line.output` that the producer's
 * current resource returned. False for a dependent added later, an adopted producer (no fingerprint), or a dependent
 * that never held it.
 */
export function holdsCurrentValue(ledger: LedgerEntry[], lineId: string, ref: string, line: string, output: string): boolean {
  const entries = ledger.filter((e) => e.createdBy !== "intent");
  const current = entries.find((e) => e.line === line && e.onceFingerprints?.[output])?.onceFingerprints?.[output];
  const mine = entries.filter((e) => e.line === lineId);
  return current !== undefined && mine.length > 0 && mine.every((e) => e.onceInputs?.[ref] === current);
}
