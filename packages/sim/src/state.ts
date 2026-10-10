/**
 * In-memory state for the fake cloud: the core (chaos, write log, ids) plus one state object per registered
 * provider, reachable as `state.<provider>` (e.g. `state.vercel.projects`).
 */
import { CHAOS_KEYS, chaosFor, defaultChaos, type ChaosAction, type ChaosConfig, type ChaosRequest } from "./chaos.js";
import type { ProviderSim, SimCore } from "./provider.js";
import { clerkSim } from "./routes/clerk.js";
import { neonSim } from "./routes/neon.js";
import { vercelSim } from "./routes/vercel.js";
import { launchdarklySim } from "./routes/launchdarkly.js";

/**
 * Every simulated provider, by URL prefix (`/<name>/…`), drift prefix (`<name>.…`), seed key and state key.
 * Order matters only for determinism: resets seed providers (and so allocate ids) in this order.
 */
export const PROVIDERS = { vercel: vercelSim, neon: neonSim, clerk: clerkSim, launchdarkly: launchdarklySim };

type Providers = typeof PROVIDERS;
/** A simulated provider's name: its URL prefix, seed key and state key. */
export type ProviderName = keyof Providers;
type StateOf<P> = P extends ProviderSim<infer S, infer _D> ? S : never;
type SeedOf<P> = P extends ProviderSim<infer _S, infer D> ? D : never;

/** The state object of every provider, by name (`state.vercel`, `state.neon`, ...). */
export type ProviderStates = { [K in ProviderName]: StateOf<Providers[K]> };

/**
 * Initial state for a sim (or a reset): per-provider seeds and optional chaos. Providers it does not name keep
 * their defaults.
 */
export type SimSeed = {
  /** Chaos applied right after the seed, e.g. `{ page_size: 2 }`. */
  chaos?: Partial<ChaosConfig>;
} & { [K in ProviderName]?: SeedOf<Providers[K]> };

/** The demo projects every provider starts with when a seed does not name it. */
export const DEFAULT_SEED: SimSeed = Object.fromEntries(Object.entries(PROVIDERS).map(([name, p]) => [name, p.defaultSeed])) as SimSeed;

/**
 * One write the sim received, for assertions such as "the second apply wrote nothing". Bodies are hashed, never
 * stored.
 */
export interface WriteLogEntry {
  at: string;
  method: string;
  path: string;
  bodyHash: string;
  /** The write changed nothing: failed by chaos, or refused by the provider (4xx/5xx). */
  failed?: true;
}

/** The registry as the core sees it: names and type-erased providers. */
export function providerEntries(): Array<[ProviderName, ProviderSim<unknown, unknown>]> {
  return Object.entries(PROVIDERS) as Array<[ProviderName, ProviderSim<unknown, unknown>]>;
}

/**
 * The whole fake cloud in memory: chaos, the write log, and each provider's state as `state.<provider>`. Tests
 * seed and inspect it directly. The per-provider fields are declared by this interface and assigned in `reset`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging
export interface SimState extends ProviderStates {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class SimState implements SimCore {
  chaos: ChaosConfig = defaultChaos();
  writes: WriteLogEntry[] = [];
  private seq = 0;
  private held: Array<() => void> = [];

  constructor(seed?: Partial<SimSeed>) {
    this.reset(seed);
  }

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  /** The state object of one provider. */
  provider(name: ProviderName): unknown {
    return (this as unknown as Record<ProviderName, unknown>)[name];
  }

  /**
   * Clear everything (state, chaos, writes) and apply a seed. A partial seed replaces only the providers it names;
   * the others keep their defaults, so `{ clerk: {...} }` still has the demo Vercel and Neon projects.
   */
  reset(seed?: Partial<SimSeed> | null): void {
    const s = seed ?? {};
    this.release();
    this.chaos = defaultChaos();
    this.writes = [];
    this.seq = 0;
    const states = this as unknown as Record<ProviderName, unknown>;
    for (const [name, p] of providerEntries()) states[name] = p.reset(this, name in s ? s[name] : p.defaultSeed);
    if (s.chaos) this.applyChaos(s.chaos);
  }

  /** Merge a chaos request; drift is applied to state right away and not kept. */
  applyChaos(req: ChaosRequest): ChaosConfig {
    const { drift, ...rest } = req;
    // The request arrives as JSON over HTTP: its keys are checked here, not by the type.
    const entries: Array<[string, unknown]> = Object.entries(rest);
    for (const [k, v] of entries) {
      // A misspelt key would silently leave the test running without its chaos.
      if (!CHAOS_KEYS.has(k)) throw new Error(`unknown chaos key: ${k} (known: ${[...CHAOS_KEYS].join(", ")}, drift)`);
      if (v !== undefined) Object.assign(this.chaos, { [k]: v });
    }
    if (drift) for (const [key, value] of Object.entries(drift)) this.applyDrift(key, value);
    return this.chaos;
  }

  /**
   * Drift: change provider state behind the client's back, like a human in a console. The key is
   * `<provider>.<rest>`, or `<provider>:<project>.<rest>` to limit it to one project; each provider documents
   * the `<rest>` forms it accepts in its `drift`. Values are a new value, "delete", or "recreate" (delete and
   * re-create with the same name and a new id).
   */
  applyDrift(key: string, value: string): void {
    const m = key.match(/^([a-z][a-z0-9_-]*)(?::([^.]+))?\.(.+)$/);
    const entry = m ? providerEntries().find(([name]) => name === m[1]) : undefined;
    if (!m || !entry) throw new Error(`unknown drift key: ${key}`);
    const [name, p] = entry;
    if (!p.drift(this, this.provider(name), { key, rest: m[3]!, value, ...(m[2] !== undefined ? { only: m[2] } : {}) })) throw new Error(`unknown drift key: ${key}`);
  }

  /** Requests currently held by chaos `hold_next`. */
  get heldCount(): number {
    return this.held.length;
  }

  /** Park the calling request until `release()`. */
  hold(): Promise<void> {
    return new Promise((resolve) => this.held.push(resolve));
  }

  /** Let every held request proceed; returns how many there were. */
  release(): number {
    const held = this.held;
    this.held = [];
    for (const go of held) go();
    return held.length;
  }

  /** Decide what chaos does to this request, consuming one count when it does something. */
  chaosFor(method: string, path: string): ChaosAction | null {
    return chaosFor(this.chaos, method, path);
  }

  snapshot(): unknown {
    return { ...Object.fromEntries(providerEntries().map(([name]) => [name, this.provider(name)])), chaos: this.chaos };
  }
}
