import { SponsonError } from "../errors.js";
import { setTimeout as sleep } from "node:timers/promises";
import { sha256 } from "../hash.js";
import { isPendingMarker, markerKind, pendingRef } from "../resolve.js";
import type { ApplyResult, DiffSide, LiveState, OpSpec, ResourceAdapter, ResourceRecord, SecretSource } from "../types.js";

/**
 * An in-memory provider for engine tests and property tests.
 *
 * `item`, with params `{ name, value }`:
 *   outputs: id (immediate), secret (immediate, sensitive), url (external: "deploy"),
 *            token (sensitive, once: only in the apply that creates the item)
 *   A `{ keep: true }` value is unchanged when the item exists and PARAM_INVALID when it does not.
 * `member`, with params `{ list, value }`: one entry of a list stored on a shared parent object, written by
 *   read-modify-write with a pause in between (`listLatencyMs`), like an Auth0 application's callback URLs.
 *   `lockOn` names the list (ADR 0019) unless `lockLists` is false, which reproduces the lost update.
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
  /** Lists on shared parent objects, by list name. */
  lists = new Map<string, string[]>();
  /** Pause between reading a list and writing it back: the window in which a concurrent writer loses an update. */
  listLatencyMs = 0;
  /** Whether `member` declares its parent object (`lockOn`). */
  lockLists = true;
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
    this.lists.clear();
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
            token: { available: "immediate", sensitive: true, once: true },
          },
          defaults: (p, ctx) => ({ ...p, name: p.name ?? `item-${ctx.scope}` }),
          // From the line (`target`), or from the provider block (`providers.fake.production: true`).
          writesEnvironment: (p, _ctx, provider) => (typeof p.target === "string" ? p.target : provider?.production === true ? "production" : null),
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
            if (marker === "keep") {
              if (current) return [{ key: key(n), label: n, kind: "unchanged" }];
              throw new SponsonError("PARAM_INVALID", `${n} is declared \`{ keep: true }\` but does not exist`, { key: key(n) });
            }
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
              if (markerKind(p.value) !== "keep" && existing.value !== String(p.value)) {
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
            return { resources: [record(it)], outputs: { ...outputsOf(it), token: `t-${it.id}-${it.name}` }, created: [key(n)] };
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
        member: this.memberOp(),
      },
    };
  }

  /** One value in a list held by a shared parent object, written by read-modify-write of the whole list. */
  private memberOp(): OpSpec {
    const cloud = this;
    const key = (list: string, v: string) => `member:${list}:${v}`;
    const record = (list: string, v: string): ResourceRecord => ({ key: key(list, v), id: `${list}/${v}`, hash: sha256(v), label: `${v} in ${list}` });
    /** Read the list, pause, write the list back changed: the lost-update window of every list-on-parent API. */
    const rewrite = async (list: string, change: (values: string[]) => string[]) => {
      const before = [...(cloud.lists.get(list) ?? [])];
      if (cloud.listLatencyMs) await sleep(Math.random() * cloud.listLatencyMs);
      cloud.lists.set(list, change(before));
    };
    return {
      outputs: {},
      lockOn: (p) => (cloud.lockLists ? `fake:list:${String(p.list)}` : null),
      async read(_actx, p) {
        cloud.reads++;
        const list = String(p.list);
        const v = String(p.value);
        return cloud.lists.get(list)?.includes(v) ? { resources: [record(list, v)], outputs: {} } : null;
      },
      diff(live, p) {
        const v = String(p.value);
        const exists = live?.resources.some((r) => r.key === key(String(p.list), v));
        return [{ key: key(String(p.list), v), label: `${v} in ${String(p.list)}`, kind: exists ? "unchanged" : "create", ...(exists ? {} : { after: { state: "literal" as const, value: v } }) }];
      },
      async apply(actx, p, live) {
        const list = String(p.list);
        const v = String(p.value);
        if (live) return { resources: [record(list, v)], outputs: {}, created: [] };
        await actx.intend([key(list, v)]);
        cloud.maybeFail("create", v);
        await rewrite(list, (values) => (values.includes(v) ? values : [...values, v]));
        cloud.writes.push({ op: "create", name: `${list}/${v}` });
        cloud.maybeFail("lost", v); // the write happened; the response did not arrive
        return { resources: [record(list, v)], outputs: {}, created: [key(list, v)] };
      },
      async destroy(_actx, resources) {
        for (const r of resources) {
          const at = r.id.indexOf("/");
          const [list, v] = [r.id.slice(0, at), r.id.slice(at + 1)];
          cloud.maybeFail("destroy", v);
          await rewrite(list, (values) => values.filter((x) => x !== v));
          cloud.writes.push({ op: "delete", name: r.id });
        }
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
