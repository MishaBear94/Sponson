import { SponsonError } from "./errors.js";
import type { OpSpec, ResourceAdapter, SecretSource } from "./types.js";

/** Adapters and secret sources available to a run. The CLI builds one; tests build their own. */
export class Registry {
  private readonly adapters = new Map<string, ResourceAdapter>();
  private readonly secrets = new Map<string, SecretSource>();

  addAdapter(adapter: ResourceAdapter): this {
    this.adapters.set(adapter.name, adapter);
    return this;
  }

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

  adapterNames(): string[] {
    return [...this.adapters.keys()];
  }
}
