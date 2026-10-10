import { SponsonError } from "./errors.js";
import type { OpSpec, ResourceAdapter, SecretSource } from "./types.js";

/**
 * Adapters and secret sources available to a run. The CLI builds one from `createRegistry()` in
 * `@sponson/adapters` plus `$SPONSON_PLUGINS`; embedders and tests build their own.
 *
 * @example
 * ```ts
 * const registry = new Registry().addAdapter(myAdapter).addSecretSource(envSecretSource);
 * registry.op("my-adapter", "thing"); // the OpSpec, or ADAPTER_UNKNOWN / OP_UNKNOWN naming what exists
 * ```
 */
export class Registry {
  private readonly adapters = new Map<string, ResourceAdapter>();
  private readonly secrets = new Map<string, SecretSource>();

  /** Add (or replace, by name) an adapter. Chainable. */
  addAdapter(adapter: ResourceAdapter): this {
    this.adapters.set(adapter.name, adapter);
    return this;
  }

  /** Add (or replace, by scheme) a secret source. Chainable. */
  addSecretSource(source: SecretSource): this {
    this.secrets.set(source.scheme, source);
    return this;
  }

  adapter(name: string): ResourceAdapter {
    const a = this.adapters.get(name);
    if (!a) {
      throw new SponsonError("ADAPTER_UNKNOWN", `Unknown adapter \`${name}\`. Known: ${[...this.adapters.keys()].join(", ") || "(none)"}`, { adapter: name });
    }
    return a;
  }

  op(adapterName: string, opName: string): OpSpec {
    const a = this.adapter(adapterName);
    const op = a.ops[opName];
    if (!op) {
      throw new SponsonError("OP_UNKNOWN", `Adapter \`${adapterName}\` has no op \`${opName}\`. Known: ${Object.keys(a.ops).join(", ")}`, {
        adapter: adapterName,
        op: opName,
      });
    }
    return op;
  }

  secretSource(ref: string): SecretSource {
    const scheme = ref.split("://")[0] ?? "";
    const s = this.secrets.get(scheme);
    if (!s) {
      throw new SponsonError("SECRET_UNRESOLVED", `No secret source for \`${scheme}://\`. Known: ${[...this.secrets.keys()].map((k) => k + "://").join(", ") || "(none)"}`, {
        ref,
        scheme,
      });
    }
    return s;
  }

  /** Names of the registered adapters, in registration order (the CLI's `Known:` lists, docs:gen). */
  adapterNames(): string[] {
    return [...this.adapters.keys()];
  }

  /** Schemes of the registered secret sources (`env`, not `env://`), in registration order. */
  secretSchemes(): string[] {
    return [...this.secrets.keys()];
  }
}
