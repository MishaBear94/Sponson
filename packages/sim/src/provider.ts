/**
 * The contract between the sim core (chaos, write log, ids, control endpoints) and one simulated provider.
 * A provider lives in one `routes/<name>.ts` file: its state, its seed, its drift keys and its HTTP routes.
 * Adding a provider = writing that file and registering it in `PROVIDERS` (state.ts).
 */
import type { IncomingHttpHeaders } from "node:http";
import type { ChaosConfig } from "./chaos.js";

/** Who made a record: the sim itself (seed, drift, a "human in the console") or a client through the API. */
export type CreatedBy = "sim" | "api";

/** What a provider needs from the core. */
export interface SimCore {
  chaos: ChaosConfig;
  /** Ids are unique across providers and deterministic after a reset. */
  nextId(prefix: string): string;
}

/** A route's answer: status, JSON body and extra headers. Routes return one instead of writing to the socket. */
export class Reply {
  constructor(
    public status: number,
    public body: unknown,
    public headers: Record<string, string> = {},
  ) {}
}

/** One request as a provider's routes see it, after auth and chaos. */
export interface RouteRequest {
  method: string;
  url: URL;
  /** The path with the provider prefix stripped, e.g. `/v10/projects/prj_demo/env`. */
  path: string;
  body: unknown;
  /** Request headers, lower-cased names (Node's `IncomingMessage.headers`, multi-valued ones joined). */
  headers?: Record<string, string>;
}

/** One `<provider>.<rest>` drift key, as `ProviderSim.drift` receives it: a change "a human made in the console". */
export interface DriftRequest {
  /** The whole drift key, for error messages. */
  key: string;
  /** The key after `<provider>.` or `<provider>:<project>.`, e.g. `env.preview.API_URL`. */
  rest: string;
  value: string;
  /** `<project>` from a `<provider>:<project>.` key: only that project is affected. */
  only?: string;
}

/**
 * One simulated provider: its state, seed, drift keys and HTTP routes. Implement it in `routes/<name>.ts` and
 * register it in `PROVIDERS` to simulate a new provider.
 *
 * Members are methods (not function-valued properties) so a `ProviderSim<VercelState, …>` is usable where the
 * registry only knows `ProviderSim<unknown, unknown>`.
 */
export interface ProviderSim<S, Seed> {
  /**
   * Env var names the adapter reads its credential and base URL from, and the token the sim hands out; `more`:
   * further credential variables and their placeholder values, for a credential made of two parts.
   */
  env: { token: string; url: string; testToken: string; more?: Record<string, string> };
  /** Seed used when a reset does not name this provider. */
  defaultSeed: Seed;
  /** Fresh state from a seed (`undefined`: empty). Called on every reset, in registry order. */
  reset(core: SimCore, seed: Seed | undefined): S;
  /** Apply one drift key to the state; false when the key is not one this provider knows. */
  drift(core: SimCore, state: S, d: DriftRequest): boolean;
  /**
   * Whether a request's headers carry a credential this provider accepts. Absent: any non-empty bearer token. Like
   * the default, accept any non-empty value: the point is that a missing credential surfaces as 401.
   */
  authorized?(headers: IncomingHttpHeaders): boolean;
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

/** The `:name` segments of a route path, e.g. `"project" | "id"` for `/v9/projects/:project/env/:id`. */
type ParamNames<P extends string> = P extends `${string}:${infer N}/${infer Rest}` ? N | ParamNames<`/${Rest}`> : P extends `${string}:${infer N}` ? N : P extends `${string}*${infer N}` ? N : never;

/** The decoded `:name` segments of a matched path, typed from the route's path literal. */
export type PathParams<P extends string> = { [K in ParamNames<P>]: string };

/** What a route's handler receives. */
export interface RouteContext<S, Params = Record<string, string>> {
  core: SimCore;
  state: S;
  params: Params;
  url: URL;
  body: unknown;
  /** Request headers, lower-cased names; empty when the caller passed none. */
  headers: Record<string, string>;
}

/** One route of a simulated provider. Build it with `route`; serve a list of them with `router`. */
export interface Route<S> {
  method: string;
  path: string;
  handle(ctx: RouteContext<S>): Reply;
}

/**
 * A route: an HTTP method, a path whose `:name` segments match one non-empty path segment each (and whose last
 * segment may be `*name`, matching the rest of the path, slashes included, undecoded), and the handler that
 * answers it. `params` is typed from the path: `route("GET", "/projects/:project", ({ params }) => …)` gets
 * `params.project: string`.
 */
export function route<S, P extends string>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: P, handle: (ctx: RouteContext<S, PathParams<P>>) => Reply): Route<S> {
  // `router` only calls a handler with the params its own path declares.
  return { method, path, handle: handle as Route<S>["handle"] };
}

/**
 * A provider's `routes`: the first route whose method and path match answers; when none does, `fallback` (the
 * provider's own "not found" body). Path patterns are compiled once, here.
 */
export function router<S>(routes: Array<Route<S>>, fallback: () => Reply): (core: SimCore, state: S, req: RouteRequest) => Reply {
  const compiled = routes.map((r) => {
    const names: string[] = [];
    const source = r.path
      .split("/")
      .map((seg) => {
        if (seg.startsWith("*")) {
          names.push(seg.slice(1));
          return "(.+)";
        }
        if (!seg.startsWith(":")) return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        names.push(seg.slice(1));
        return "([^/]+)";
      })
      .join("/");
    return { route: r, pattern: new RegExp(`^${source}$`), names, rest: r.path.split("/").some((s) => s.startsWith("*")) };
  });
  return (core, state, req) => {
    for (const { route: r, pattern, names, rest } of compiled) {
      if (r.method !== req.method) continue;
      const m = pattern.exec(req.path);
      if (!m) continue;
      // A `*name` segment (always the last) is passed as matched: its own segments decode separately.
      const params = Object.fromEntries(names.map((n, i) => [n, rest && i === names.length - 1 ? m[i + 1]! : decodeURIComponent(m[i + 1]!)]));
      return r.handle({ core, state, params, url: req.url, body: req.body, headers: req.headers ?? {} });
    }
    return fallback();
  };
}
