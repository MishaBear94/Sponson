/**
 * HTTP front of the fake cloud. The core here does what is common to every provider: control endpoints (`/_…`),
 * bearer-token check, latency, chaos (hang / drop / fail) and the write log. Everything under `/<provider>/` is
 * answered by that provider's `routes/<provider>.ts`; each of those files lists the assumptions about the real
 * API it encodes. The one cross-provider assumption:
 *   S1. 429s carry `Retry-After` in seconds (chaos `retry_after`).
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { Reply, route, router, type RouteRequest } from "./provider.js";
import { providerEntries, type SimSeed, type SimState, type WriteLogEntry } from "./state.js";

type Json = Record<string, unknown>;
type Handler = (state: SimState, req: RouteRequest) => Reply;

/** `/<provider>` → its routes, one entry per registered provider. */
const ROUTES: Record<string, Handler> = Object.fromEntries(
  providerEntries().map(([name, p]): [string, Handler] => [`/${name}`, (state, req) => p.routes(state, state.provider(name), req)]),
);

const WRITE_METHODS = new Set(["POST", "PATCH", "DELETE", "PUT"]);

/** The sim's HTTP server over `state`, not yet listening. Most callers want `startSim`. */
export function createSimServer(state: SimState): Server {
  return createServer((req, res) => {
    handle(state, req, res).catch((e: unknown) => {
      send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });
}

async function handle(state: SimState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://sim.local");
  const raw = await readBody(req);
  const parsed = parseJson(raw);
  if (!parsed) return send(res, 400, { error: "invalid json" });
  const { body } = parsed;

  if (url.pathname.startsWith("/_")) {
    const r = control(state, state, { method, url, path: url.pathname, body });
    return send(res, r.status, r.body);
  }

  // Any non-empty token in the provider's form is accepted; missing-token bugs must surface as 401.
  if (!authorised(req.headers.authorization ?? "", AUTH[url.pathname.match(/^\/[^/]+/)?.[0] ?? ""] ?? "bearer")) return send(res, 401, { error: "unauthorized" });
  await serveProvider(state, req, res, { method, url, raw, body });
}

/** `/<provider>` → how that provider expects its token. */
const AUTH: Record<string, "bearer" | "raw"> = Object.fromEntries(providerEntries().map(([name, p]) => [`/${name}`, p.auth ?? "bearer"]));

/** `Bearer <token>`, or for a `raw` provider the token alone (and not a bearer header). */
function authorised(header: string, scheme: "bearer" | "raw"): boolean {
  if (scheme === "bearer") return /^Bearer\s+\S+$/.test(header);
  return /^\S+$/.test(header) && !/^Bearer$/i.test(header);
}

/** An authenticated provider request: latency, chaos, the write log, then the provider's routes. */
async function serveProvider(state: SimState, req: IncomingMessage, res: ServerResponse, { method, url, raw, body }: { method: string; url: URL; raw: string; body: unknown }): Promise<void> {
  if (state.chaos.latency_ms > 0) await sleep(state.chaos.latency_ms);

  const isWrite = WRITE_METHODS.has(method);
  const action = state.chaosFor(method, url.pathname);
  // Held: performed (and logged) only once released, like a request stuck in the provider's queue.
  if (action?.kind === "hold") await state.hold();
  const entry = { at: new Date().toISOString(), method, path: url.pathname, bodyHash: sha256(raw) };
  if (action?.kind === "hang" || action?.kind === "fail") {
    // Never performed. A hang is accepted and never answered (sim.close() tears the socket down).
    if (isWrite) state.writes.push({ ...entry, failed: true });
    if (action.kind === "fail") send(res, action.status, { error: "chaos" }, action.headers);
    return;
  }
  const logged: WriteLogEntry = { ...entry };
  if (isWrite) state.writes.push(logged);

  const r = dispatch(state, method, url, body, headersOf(req));
  // A refused write (409, 423, 404, …) did not change anything.
  if (r.status >= 400) logged.failed = true;
  if (action?.kind === "drop") {
    // The request was performed; the client never hears about it.
    req.socket.destroy();
    return;
  }
  send(res, r.status, r.body, r.headers);
}

/** `/<provider>/…` → that provider's routes, with the prefix stripped from the path. */
function dispatch(state: SimState, method: string, url: URL, body: unknown, headers: Record<string, string>): Reply {
  const prefix = url.pathname.match(/^\/[^/]+(?=\/)/)?.[0];
  const routes = prefix === undefined ? undefined : ROUTES[prefix];
  if (prefix === undefined || !routes) return new Reply(404, { error: "not found" });
  return routes(state, { method, url, path: url.pathname.slice(prefix.length), body, headers });
}

/** The control endpoints tests and scenarios drive the sim with. */
const control = router<SimState>(
  [
    route("POST", "/_chaos", ({ state, body }) => {
      try {
        return new Reply(200, state.applyChaos((body ?? {}) as Json));
      } catch (e) {
        return new Reply(400, { error: (e as Error).message });
      }
    }),
    route("GET", "/_state", ({ state }) => new Reply(200, state.snapshot())),
    route("GET", "/_writes", ({ state, url }) => {
      const since = Number(url.searchParams.get("since") ?? 0);
      return new Reply(200, state.writes.slice(Number.isFinite(since) ? since : 0));
    }),
    route("POST", "/_release", ({ state }) => new Reply(200, { released: state.release() })),
    route("POST", "/_reset", ({ state, body }) => {
      state.reset(body as Partial<SimSeed> | undefined);
      return new Reply(200, { ok: true });
    }),
  ],
  () => new Reply(404, { error: "not found" }),
);

/** The request's headers as strings (multi-valued ones joined with `, `). */
function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
  return out;
}

/** A request body: empty is `undefined`; null when it is not JSON. */
function parseJson(raw: string): { body: unknown } | null {
  if (raw.length === 0) return { body: undefined };
  try {
    return { body: JSON.parse(raw) as unknown };
  } catch {
    return null;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

