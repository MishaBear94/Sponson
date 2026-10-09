import { sha256 } from "../hash.js";
import { isPendingMarker, markerKind, pendingRef } from "../resolve.js";
import type { ApplyResult, DiffSide, LiveState, ResourceAdapter, ResourceRecord, SecretSource } from "../types.js";

/**
 * An in-memory provider for engine tests and property tests.
 *
 * One op, `item`, with params `{ name, value }`:
 *   outputs: id (immediate), secret (immediate, sensitive), url (external: "deploy")
 * Chaos knobs let a test fail the n-th write, make the deploy never happen, etc.
 */
export interface FakeItem {
  id: string;
  name: string;
  value: string;
  createdBy: "seed" | "api";
}

type FailKind = "apply" | "create" | "lost" | "destroy" | "read";

export class FakeCloud {
  items = new Map<string, FakeItem>();
  writes: Array<{ op: "create" | "update" | "delete"; name: string }> = [];
  reads = 0;
  external: "ok" | "never" | "fail" = "ok";
  private failQueue: Array<{ kind: FailKind; match?: string }> = [];
  private seq = 0;

  seed(name: string, value: string): FakeItem {
    const item: FakeItem = { id: `it_${++this.seq}`, name, value, createdBy: "seed" };
    this.items.set(name, item);
    return item;
  }

  /**
   * Fail the next operation of this kind (optionally only for one item name).
   * apply: before any write. create: before a create, after the intent. lost: after the create succeeded.
   */
  failNext(kind: FailKind, match?: string): void {
    this.failQueue.push({ kind, match });
  }

  /** Simulate a console edit. */
  drift(name: string, value: string): void {
    const it = this.items.get(name);
    if (it) it.value = value;
  }

  delete(name: string): void {
    this.items.delete(name);
  }

  reset(): void {
    this.items.clear();
    this.writes = [];
    this.reads = 0;
    this.external = "ok";
    this.failQueue = [];
  }

  private maybeFail(kind: FailKind, name: string): void {
    const i = this.failQueue.findIndex((f) => f.kind === kind && (!f.match || f.match === name));
    if (i >= 0) {
      this.failQueue.splice(i, 1);
      throw new Error(`fake ${kind} failed for ${name} (value was ${this.items.get(name)?.value ?? "n/a"})`);
    }
  }

  adapter(name = "fake"): ResourceAdapter {
    const cloud = this;
    const key = (n: string) => `item:${n}`;
    const record = (it: FakeItem): ResourceRecord => ({ key: key(it.name), id: it.id, hash: sha256(it.value), label: it.name });
    const outputsOf = (it: FakeItem) => ({ id: it.id, secret: `s-${it.name}-${it.value}` });

    return {
      name,
      ops: {
        item: {
          outputs: {
            id: { available: "immediate" },
            secret: { available: "immediate", sensitive: true },
            url: { available: "external", event: "deploy" },
          },
          defaults: (p, ctx) => ({ ...p, name: p.name ?? `item-${ctx.scope}` }),
          writesEnvironment: (p) => (typeof p.target === "string" ? p.target : null),
          async read(_actx, p) {
            cloud.reads++;
            cloud.maybeFail("read", String(p.name));
            const it = cloud.items.get(String(p.name));
            if (!it) return null;
            return { resources: [record(it)], outputs: outputsOf(it) } satisfies LiveState;
          },
          diff(live, p) {
            const n = String(p.name);
            const want = p.value;
            const current = live?.resources.find((r) => r.key === key(n));
            const marker = markerKind(want);
            const after: DiffSide = marker === "pending" || marker === "secret" ? { state: marker, ref: pendingRef(want as string) } : { state: "literal", value: String(want) };
            if (!current) return [{ key: key(n), label: n, kind: "create", after }];
            if (!isPendingMarker(want) && current.hash === sha256(String(want))) return [{ key: key(n), label: n, kind: "unchanged" }];
            return [{ key: key(n), label: n, kind: "update", before: { state: "sensitive" }, after }];
          },
          async apply(_actx, p, live): Promise<ApplyResult> {
            const n = String(p.name);
            if (isPendingMarker(p.value)) throw new Error("apply called with a pending value");
            cloud.maybeFail("apply", n);
            const existing = cloud.items.get(n);
            if (existing) {
              if (existing.value !== String(p.value)) {
                existing.value = String(p.value);
                cloud.writes.push({ op: "update", name: n });
              }
              return { resources: [record(existing)], outputs: outputsOf(existing), created: [] };
            }
            await _actx.intend([key(n)]);
            cloud.maybeFail("create", n);
            const it: FakeItem = { id: `it_${++cloud.seq}`, name: n, value: String(p.value), createdBy: "api" };
            cloud.items.set(n, it);
            cloud.writes.push({ op: "create", name: n });
            cloud.maybeFail("lost", n); // the write happened; the response did not arrive
            void live;
            return { resources: [record(it)], outputs: outputsOf(it), created: [key(n)] };
          },
          async destroy(_actx, resources) {
            for (const r of resources) {
              const n = r.key.slice("item:".length);
              cloud.maybeFail("destroy", n);
              if (cloud.items.delete(n)) cloud.writes.push({ op: "delete", name: n });
            }
          },
          async awaitExternal(_actx, p) {
            if (cloud.external === "fail") throw new Error(`deploy failed for ${String(p.name)}`);
            if (cloud.external === "never") return null;
            return { url: `https://${String(p.name)}.example.test` };
          },
          async listScope() {
            return [...cloud.items.values()].map(record);
          },
        },
      },
    };
  }
}

/** Secrets from a map; fingerprint changes with the value. */
export function fakeSecretSource(values: Record<string, string>, scheme = "fake"): SecretSource {
  return {
    scheme,
    async resolve(ref) {
      const name = ref.slice(`${scheme}://`.length);
      const v = values[name];
      if (v === undefined) throw new Error(`secret ${ref} not found`);
      return v;
    },
  };
}
