/**
 * Simulated Algolia Search API: indices of one application, copied by asynchronous tasks.
 *
 * Assumptions about the real API this fake encodes (verified against the official reference, generated from
 * https://github.com/algolia/api-clients-automation/tree/main/specs/search, unless marked unverified). The
 * critical ones are pinned in scenarios/contract.test.ts (`assumption AL…`).
 *   AL1. An index is named by the client; the name is its identity within the application. (verified:
 *        https://www.algolia.com/doc/rest-api/search/)
 *   AL2. The API is served at `https://<application id>.algolia.net`, authenticated by the headers
 *        `X-Algolia-Application-Id` and `X-Algolia-API-Key`; the official CLI reads the key from `ALGOLIA_API_KEY`.
 *        (verified: spec.yml; https://www.algolia.com/doc/tools/cli/authentication)
 *   AL3. `POST /1/indexes/{source}/operation` with `{ operation: "copy", destination, scope? }` answers
 *        `{ taskID, updatedAt }` and queues the copy. Without `scope` it copies records, settings, synonyms and
 *        rules; with one, only those. An existing destination is overwritten (except its analytics); copying a
 *        source that does not exist makes an empty destination. (verified: operationIndex.yml, and
 *        https://www.algolia.com/doc/guides/sending-and-managing-data/manage-indices-and-apps/manage-indices/how-to/copy-indices)
 *   AL4. `GET /1/indexes/{name}/settings` answers 404 when the index does not exist. (verified: settings.yml)
 *   AL5. `GET /1/indexes/{name}/task/{taskID}` answers `{ status: "published" | "notPublished" }`; the copy is done
 *        when it is published. (verified: getTask.yml) Until then the destination may not exist yet
 *        (unverified: the sim makes it appear only when the task is published, the stricter case).
 *   AL6. `DELETE /1/indexes/{name}` answers `{ taskID, deletedAt }`; deleting an index that does not exist is
 *        ignored without error. (verified: "the operation is ignored without warning")
 *   AL7. `GET /1/indexes` with no `page` lists every index, unpaginated, as `{ items: [{ name, entries, … }] }`.
 *        (verified: listIndices.yml)
 *   AL8. A copy task is published within minutes, usually seconds (unverified: the adapter waits up to
 *        SPONSON_ALGOLIA_TASK_TIMEOUT_MS, five minutes by default).
 */
import type { IncomingHttpHeaders } from "node:http";
import { Reply, route, router, type CreatedBy, type ProviderSim, type SimCore } from "../provider.js";

/** An index as the simulated Algolia stores it. */
export interface AlgoliaIndex {
  /** Number of records. */
  entries: number;
  settings: Record<string, unknown>;
  createdBy: CreatedBy;
}

/** A queued task: the copy it performs when published, and how many polls answer `notPublished` first. */
interface AlgoliaTask {
  index: string;
  copy?: { from: string; scope?: string[] };
  pending: number;
}

/** The simulated Algolia's state: one application's indices and its tasks. */
export interface AlgoliaState {
  indices: Record<string, AlgoliaIndex>;
  tasks: Record<string, AlgoliaTask>;
  /** How many polls of a new task answer `notPublished` before it is published (default 1). */
  taskPolls: number;
}

/** What a scenario or test seeds the simulated Algolia with (`seed: { algolia: … }`). */
export interface AlgoliaSeed {
  /** Indices that exist already (created "by a human", so unmanaged). */
  indices?: Record<string, { entries?: number; settings?: Record<string, unknown> }>;
  /** Polls of a new task that answer `notPublished` before it is published. */
  taskPolls?: number;
}

/** The simulated Algolia API, registered in `PROVIDERS` (packages/sim/src/state.ts) and served under `/algolia`. */
export const algoliaSim: ProviderSim<AlgoliaState, AlgoliaSeed> = {
  env: { token: "ALGOLIA_API_KEY", url: "ALGOLIA_API_URL", testToken: "tok_algolia" },
  defaultSeed: { indices: { products: { entries: 3, settings: { searchableAttributes: ["name"] } } } },

  reset(_core, seed) {
    const indices: AlgoliaState["indices"] = {};
    for (const [name, i] of Object.entries(seed?.indices ?? {})) indices[name] = { entries: i.entries ?? 0, settings: structuredClone(i.settings ?? {}), createdBy: "sim" };
    return { indices, tasks: {}, taskPolls: seed?.taskPolls ?? 1 };
  },

  /** `index.<name>`: "delete" — what a human in the Algolia dashboard would do. */
  drift(_core, state, { key, rest, value, only }) {
    if (only !== undefined || !rest.startsWith("index.")) return false;
    const name = rest.slice("index.".length);
    if (!state.indices[name]) throw new Error(`drift ${key}: no index ${name}`);
    if (value !== "delete") throw new Error(`drift ${key}: only "delete" is supported`);
    delete state.indices[name];
    return true;
  },

  /** AL2: both headers, the key non-empty. */
  authorized(headers: IncomingHttpHeaders) {
    const key = headers["x-algolia-api-key"];
    const app = headers["x-algolia-application-id"];
    return typeof key === "string" && key !== "" && typeof app === "string" && app !== "";
  },

  routes(core, state, req) {
    return routes(core, state, req);
  },
};

function task(core: SimCore, state: AlgoliaState, t: Omit<AlgoliaTask, "pending">): number {
  const id = Number(core.nextId("").replace(/\D/g, "")) + 1000;
  state.tasks[String(id)] = { ...t, pending: state.taskPolls };
  return id;
}

/** The copy a task performs when it is published (AL3, AL5). */
function publish(state: AlgoliaState, t: AlgoliaTask): void {
  if (!t.copy) return;
  const from = state.indices[t.copy.from];
  const before = state.indices[t.index];
  const all = t.copy.scope === undefined;
  state.indices[t.index] = {
    entries: all ? (from?.entries ?? 0) : (before?.entries ?? 0),
    settings: all || t.copy.scope!.includes("settings") ? structuredClone(from?.settings ?? {}) : (before?.settings ?? {}),
    createdBy: "api",
  };
  delete t.copy;
}

const routes = router<AlgoliaState>(
  [
    route("GET", "/1/indexes", ({ state }) => new Reply(200, { items: Object.entries(state.indices).map(([name, i]) => ({ name, entries: i.entries })), nbPages: 1 })),

    route("POST", "/1/indexes/:name/operation", ({ core, state, params, body }) => {
      const b = (body ?? {}) as { operation?: unknown; destination?: unknown; scope?: unknown };
      if (b.operation !== "copy" || typeof b.destination !== "string" || b.destination === "") return new Reply(400, { message: "operation must be copy with a destination" });
      const scope = Array.isArray(b.scope) ? (b.scope as string[]) : undefined;
      const id = task(core, state, { index: b.destination, copy: { from: params.name, ...(scope ? { scope } : {}) } });
      return new Reply(200, { taskID: id, updatedAt: new Date().toISOString() });
    }),

    route("GET", "/1/indexes/:name/task/:task", ({ state, params }) => {
      const t = state.tasks[params.task];
      if (!t || t.index !== params.name) return new Reply(404, { message: "Task does not exist" });
      if (t.pending > 0) {
        t.pending--;
        return new Reply(200, { status: "notPublished" });
      }
      publish(state, t);
      return new Reply(200, { status: "published" });
    }),

    route("GET", "/1/indexes/:name/settings", ({ state, params }) => {
      const i = state.indices[params.name];
      return i ? new Reply(200, i.settings) : new Reply(404, { message: "Index does not exist", status: 404 });
    }),

    route("DELETE", "/1/indexes/:name", ({ core, state, params }) => {
      delete state.indices[params.name];
      return new Reply(200, { taskID: task(core, state, { index: params.name }), deletedAt: new Date().toISOString() });
    }),
  ],
  () => new Reply(404, { message: "not found" }),
);
