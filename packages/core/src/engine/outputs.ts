import type { Literal, OutputSpec } from "../types.js";

/** Outputs fit for receipts and agents: sensitive ones are omitted entirely. */
export function publicOutputs(values: Record<string, unknown>, specs: Record<string, OutputSpec>): Record<string, Literal> {
  const out: Record<string, Literal> = {};
  for (const [k, v] of Object.entries(values)) if (!specs[k]?.sensitive && v !== undefined && v !== null) out[k] = v as Literal;
  return out;
}

/** Outputs for plan JSON: sensitive ones are present but null, so an agent knows they exist. */
export function planOutputs(values: Record<string, unknown>, specs: Record<string, OutputSpec>): Record<string, Literal | null> {
  const out: Record<string, Literal | null> = {};
  for (const [k, v] of Object.entries(values)) out[k] = specs[k]?.sensitive ? null : (v as Literal);
  return out;
}

export function hasExternalOutputs(specs: Record<string, OutputSpec>): boolean {
  return Object.values(specs).some((o) => o.available === "external");
}
