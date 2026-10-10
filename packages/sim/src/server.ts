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
import { Reply, type RouteRequest } from "./provider.js";
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
  let body: unknown = undefined;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "invalid json" });
    }
  }

  if (url.pathname.startsWith("/_")) {
    const r = control(state, method, url, body);
    return send(res, r.status, r.body);
  }

  // Any non-empty bearer token is accepted; missing-token bugs must surface as 401.
  const auth = req.headers.authorization ?? "";
  if (!/^Bearer\s+\S+$/.test(auth)) return send(res, 401, { error: "unauthorized" });

  if (state.chaos.latency_ms > 0) await sleep(state.chaos.latency_ms);

  const isWrite = WRITE_METHODS.has(method);
  const action = state.chaosFor(method, url.pathname);
  // Held: performed (and logged) only once released, like a request stuck in the provider's queue.
  if (action?.kind === "hold") await state.hold();
  const entry = { at: new Date().toISOString(), method, path: url.pathname, bodyHash: sha256(raw) };
  if (action?.kind === "hang") {
    // Accepted, never performed, never answered. sim.close() tears the socket down.
    if (isWrite) state.writes.push({ ...entry, failed: true });
    return;
  }
  if (action?.kind === "fail") {
    if (isWrite) state.writes.push({ ...entry, failed: true });
    return send(res, action.status, { error: "chaos" }, action.headers);
  }
  const logged: WriteLogEntry = { ...entry };
  if (isWrite) state.writes.push(logged);

  const prefix = url.pathname.match(/^\/[^/]+(?=\/)/)?.[0];
  const route = prefix !== undefined ? ROUTES[prefix] : undefined;
  const r = route ? route(state, { method, url, path: url.pathname.slice(prefix!.length), body }) : new Reply(404, { error: "not found" });
  // A refused write (409, 423, 404, …) did not change anything.
  if (r.status >= 400) logged.failed = true;
  if (action?.kind === "drop") {
    // The request was performed; the client never hears about it.
    req.socket.destroy();
    return;
  }
  send(res, r.status, r.body, r.headers);
}

function control(state: SimState, method: string, url: URL, body: unknown): Reply {
  const path = url.pathname;
  if (method === "POST" && path === "/_chaos") {
    try {
      return new Reply(200, state.applyChaos((body ?? {}) as Json));
    } catch (e) {
      return new Reply(400, { error: (e as Error).message });
    }
  }
  if (method === "GET" && path === "/_state") return new Reply(200, state.snapshot());
  if (method === "GET" && path === "/_writes") {
    const since = Number(url.searchParams.get("since") ?? 0);
    return new Reply(200, state.writes.slice(Number.isFinite(since) ? since : 0));
  }
  if (method === "POST" && path === "/_release") return new Reply(200, { released: state.release() });
  if (method === "POST" && path === "/_reset") {
    state.reset(body as Partial<SimSeed> | undefined);
    return new Reply(200, { ok: true });
  }
  return new Reply(404, { error: "not found" });
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

