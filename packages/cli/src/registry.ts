import type { Registry } from "@sponson/core";

/** The production registry: every adapter and secret source that ships with Sponson. */
export async function defaultRegistry(): Promise<Registry> {
  const adapters = await import("@sponson/adapters");
  return adapters.createRegistry();
}
