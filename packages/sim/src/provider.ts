/**
 * The contract between the sim core (chaos, write log, ids, control endpoints) and one simulated provider.
 * A provider lives in one `routes/<name>.ts` file: its state, its seed, its drift keys and its HTTP routes.
 * Adding a provider = writing that file and registering it in `PROVIDERS` (state.ts).
 */
import type { ChaosConfig } from "./chaos.js";

/** Who made a record: the sim itself (seed, drift, a "human in the console") or a client through the API. */
export type CreatedBy = "sim" | "api";

/** What a provider needs from the core. */
export interface SimCore {
  chaos: ChaosConfig;
  /** Ids are unique across providers and deterministic after a reset. */
  nextId(prefix: string): string;
}

export class Reply {
  constructor(
    public status: number,
    public body: unknown,
    public headers: Record<string, string> = {},
  ) {}
}

export interface RouteRequest {
  method: string;
  url: URL;
  /** The path with the provider prefix stripped, e.g. `/v9/projects/prj_demo/env`. */
  path: string;
  body: unknown;
}

export interface DriftRequest {
  /** The whole drift key, for error messages. */
  key: string;
  /** The key after `<provider>.` or `<provider>:<project>.`, e.g. `env.preview.API_URL`. */
  rest: string;
  value: string;
  /** `<project>` from a `<provider>:<project>.` key: only that project is affected. */
  only?: string;
}

// Methods (not function-valued properties) so a ProviderSim<VercelState, …> is usable where the
// registry only knows ProviderSim<unknown, unknown>.
export interface ProviderSim<S, Seed> {
  /** Env var names the adapter reads its credential and base URL from, and the token the sim hands out. */
  env: { token: string; url: string; testToken: string };
  /** Seed used when a reset does not name this provider. */
  defaultSeed: Seed;
  /** Fresh state from a seed (`undefined`: empty). Called on every reset, in registry order. */
  reset(core: SimCore, seed: Seed | undefined): S;
  /** Apply one drift key to the state; false when the key is not one this provider knows. */
  drift(core: SimCore, state: S, d: DriftRequest): boolean;
  /** Answer one authenticated, chaos-checked request under `/<name>/`. */
  routes(core: SimCore, state: S, req: RouteRequest): Reply;
}

/** One page of `list` under chaos `page_size`, starting at the opaque numeric cursor. */
export function page<T>(core: SimCore, list: T[], cursor: string | null, limit?: number): { items: T[]; next: number | null } {
  // Unpaginated (the default): everything, whatever cursor the client sends.
  if (core.chaos.page_size <= 0 && limit === undefined) return { items: list, next: null };
  const size = core.chaos.page_size > 0 ? Math.min(core.chaos.page_size, limit ?? Infinity) : (limit ?? list.length);
  const start = cursor !== null && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  const items = list.slice(start, start + size);
  return { items, next: start + size < list.length ? start + size : null };
}
