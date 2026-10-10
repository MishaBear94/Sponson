import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SponsonError } from "@sponson/core";
import { afterEach, describe, expect, it } from "vitest";
import { HTTP_ERROR_BODY_LIMIT, apiClient, backoffMs, classifyStatus, isProviderError, listAll, obj, records, retryAfterMs, type ApiClient } from "./http.js";

type Handler = (req: IncomingMessage, res: ServerResponse, n: number) => void;

let server: Server | undefined;
let seen: Array<{ method: string; url: string }> = [];
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
  }
  server = undefined;
  seen = [];
});

async function serve(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "" });
    req.resume();
    req.on("end", () => handler(req, res, seen.length));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const reply = (res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body);
};

const FAST = { SPONSON_HTTP_RETRY_BASE_MS: "1", SPONSON_HTTP_RETRIES: "3", SPONSON_HTTP_TIMEOUT_MS: "2000" };

function client(baseUrl: string, env: NodeJS.ProcessEnv = FAST, redact = (t: string) => t): ApiClient {
  return apiClient({ adapter: "acme", baseUrl, token: "t", redact, env });
}

async function failure(p: Promise<unknown>): Promise<SponsonError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  if (!(e instanceof SponsonError)) throw new Error(`expected a SponsonError, got ${String(e)}`);
  return e;
}

describe("classification", () => {
  it("maps statuses to PROVIDER_* codes", () => {
    expect(classifyStatus(401, "")).toBe("PROVIDER_AUTH");
    expect(classifyStatus(403, "")).toBe("PROVIDER_AUTH");
    expect(classifyStatus(404, "")).toBe("PROVIDER_NOT_FOUND");
    expect(classifyStatus(409, "")).toBe("PROVIDER_CONFLICT");
    expect(classifyStatus(422, '{"errors":[{"message":"redirect url already exists"}]}')).toBe("PROVIDER_CONFLICT");
    expect(classifyStatus(400, '{"error":{"code":"ENV_CONFLICT"}}')).toBe("PROVIDER_CONFLICT");
    expect(classifyStatus(422, '{"errors":[{"message":"url is invalid"}]}')).toBe("PROVIDER_INVALID");
    expect(classifyStatus(400, "bad")).toBe("PROVIDER_INVALID");
    expect(classifyStatus(429, "")).toBe("PROVIDER_TRANSIENT");
    expect(classifyStatus(423, "")).toBe("PROVIDER_TRANSIENT");
    expect(classifyStatus(500, "")).toBe("PROVIDER_TRANSIENT");
  });

  it("every failure is a SponsonError with adapter, method, path and status; never the request body", async () => {
    for (const [status, code] of [
      [401, "PROVIDER_AUTH"],
      [404, "PROVIDER_NOT_FOUND"],
      [409, "PROVIDER_CONFLICT"],
      [400, "PROVIDER_INVALID"],
    ] as const) {
      const url = await serve((_q, res) => reply(res, status, '{"message":"nope"}'));
      const e = await failure(client(url).post("/things", { value: "request-secret" }));
      expect(e.code).toBe(code);
      expect(e.details).toEqual({ adapter: "acme", method: "POST", path: "/things", status });
      expect(e.message).toMatch(new RegExp(`^acme: POST /things → ${status}: \\{"message":"nope"\\}$`));
      expect(JSON.stringify(e)).not.toContain("request-secret");
      server!.closeAllConnections();
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
  });
});

describe("error excerpts", () => {
  it("truncates a huge error page so it cannot end up in a receipt", async () => {
    const url = await serve((_q, res) => reply(res, 400, "<html>" + "x".repeat(1024 * 1024) + "</html>", { "content-type": "text/html" }));
    const e = await failure(client(url).post("/env", { value: "request-secret" }));
    expect(e.message.length).toBeLessThan(HTTP_ERROR_BODY_LIMIT + 100);
    expect(e.message).toMatch(/^acme: POST \/env → 400: <html>x+… \(\d+ chars\)$/);
  });

  it("redacts before truncating: a secret straddling the 500-char boundary leaves no prefix behind", async () => {
    const secret = "S3CRET-" + "abcdefghij".repeat(5);
    const body = "y".repeat(HTTP_ERROR_BODY_LIMIT - 10) + secret + "tail";
    const url = await serve((_q, res) => reply(res, 400, body));
    const redact = (t: string) => t.split(secret).join("[REDACTED]");
    const e = await failure(client(url, FAST, redact).post("/env", {}));
    expect(e.message).not.toContain("S3CRET");
    expect(e.message).toContain("[RED"); // the mask itself may be cut, the secret may not
  });

  it("names the endpoint when a 2xx response is not JSON or not the expected shape", async () => {
    let url = await serve((_q, res) => reply(res, 200, "<html>login</html>", { "content-type": "text/html" }));
    let e = await failure(client(url).get("/x"));
    expect(e.code).toBe("PROVIDER_RESPONSE");
    expect(e.message).toMatch(/^acme: GET \/x → 200: response is not JSON: <html>login<\/html>$/);
    server!.close();
    url = await serve((_q, res) => reply(res, 200, '{"items":"nope"}'));
    e = await failure(client(url).get("/x", (b) => records(obj(b, "the list").items, "`items`", ["id"])));
    expect(e.code).toBe("PROVIDER_RESPONSE");
    expect(e.message).toBe("acme: GET /x → 200: expected `items` to be an array, got string");
  });
});

describe("retries", () => {
  it("retries a GET on 502/503 and succeeds", async () => {
    const url = await serve((_q, res, n) => (n < 3 ? reply(res, n === 1 ? 502 : 503, "<html>down</html>") : reply(res, 200, '{"ok":true}')));
    expect(await client(url).get("/x")).toEqual({ ok: true });
    expect(seen).toHaveLength(3);
  });

  it("never repeats a POST on 5xx (it may have happened), but does on 429 and 423", async () => {
    let url = await serve((_q, res) => reply(res, 503, "{}"));
    const e = await failure(client(url).post("/x", {}));
    expect(e.code).toBe("PROVIDER_TRANSIENT");
    expect(seen).toHaveLength(1);
    server!.close();
    seen = [];
    url = await serve((_q, res, n) => (n === 1 ? reply(res, 429, "{}", { "retry-after": "0" }) : n === 2 ? reply(res, 423, "{}") : reply(res, 201, '{"id":1}')));
    expect(await client(url).post("/x", {})).toEqual({ id: 1 });
    expect(seen.map((s) => s.method)).toEqual(["POST", "POST", "POST"]);
  });

  it("repeats a PATCH on 5xx only when the adapter says it is idempotent; a PUT always", async () => {
    let url = await serve((_q, res) => reply(res, 503, "{}"));
    expect((await failure(client(url).patch("/x", { list: [] }))).code).toBe("PROVIDER_TRANSIENT");
    expect(seen.map((s) => s.method)).toEqual(["PATCH"]);
    server!.close();
    for (const send of [(c: ApiClient) => c.patch("/x", { list: [] }, undefined, { idempotent: true }), (c: ApiClient) => c.put("/x", { list: [] })]) {
      seen = [];
      url = await serve((_q, res, n) => (n === 1 ? reply(res, 503, "{}") : reply(res, 200, '{"ok":true}')));
      expect(await send(client(url))).toEqual({ ok: true });
      expect(seen).toHaveLength(2);
      server!.close();
    }
  });

  it("sends a custom Content-Type for a write that asks for one, JSON-encoding the body either way", async () => {
    const got: Array<{ type: string | undefined; auth: string | undefined; body: string }> = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        got.push({ type: req.headers["content-type"], auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
        reply(res, 200, "{}");
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const raw = apiClient({ adapter: "acme", baseUrl: url, token: "api-123", authHeader: "header:authorization", redact: (t) => t, env: FAST });
    const semantic = "application/json; domain-model=launchdarkly.semanticpatch";
    await raw.patch("/x", { instructions: [] }, undefined, { contentType: semantic });
    await raw.post("/x", { a: 1 }, undefined, { contentType: semantic });
    await raw.patch("/x", { a: 1 });
    expect(got).toEqual([
      { type: semantic, auth: "api-123", body: '{"instructions":[]}' },
      { type: semantic, auth: "api-123", body: '{"a":1}' },
      { type: "application/json", auth: "api-123", body: '{"a":1}' },
    ]);
  });

  it("gives up after SPONSON_HTTP_RETRIES with PROVIDER_TRANSIENT and the attempt count", async () => {
    const url = await serve((_q, res) => reply(res, 504, "{}"));
    const e = await failure(client(url, { ...FAST, SPONSON_HTTP_RETRIES: "2" }).delete("/x"));
    expect(e.code).toBe("PROVIDER_TRANSIENT");
    expect(e.details).toMatchObject({ status: 504, attempts: 3 });
    expect(seen).toHaveLength(3);
  });

  it("honours Retry-After", async () => {
    const url = await serve((_q, res, n) => (n === 1 ? reply(res, 429, "{}", { "retry-after": "0.3" }) : reply(res, 200, "{}")));
    const t = Date.now();
    await client(url).get("/x");
    expect(Date.now() - t).toBeGreaterThanOrEqual(280);
  });

  it("parses Retry-After as seconds or an HTTP date, and backs off exponentially with jitter", () => {
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(retryAfterMs("soon")).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
    expect([1, 2, 3].map((a) => backoffMs(a, 100, () => 0))).toEqual([50, 100, 200]);
    expect([1, 2, 3].map((a) => backoffMs(a, 100, () => 0.999))).toEqual([expect.closeTo(100, 0), expect.closeTo(200, 0), expect.closeTo(400, 0)]);
    expect(backoffMs(30, 500, () => 1)).toBe(30_000);
  });

  it("retries a GET whose connection fails, and names the endpoint", async () => {
    const e = await failure(client("http://127.0.0.1:1", { ...FAST, SPONSON_HTTP_RETRIES: "1" }).get("/x"));
    expect(e.code).toBe("PROVIDER_TRANSIENT");
    expect(e.message).toMatch(/GET \/x .*http:\/\/127\.0\.0\.1:1\/x: /);
  });
});

describe("timeout", () => {
  it("a request that never gets an answer fails with PROVIDER_TIMEOUT after SPONSON_HTTP_TIMEOUT_MS, once", async () => {
    const url = await serve(() => {
      /* never answer */
    });
    const t = Date.now();
    const e = await failure(client(url, { ...FAST, SPONSON_HTTP_TIMEOUT_MS: "150" }).get("/hang"));
    expect(e.code).toBe("PROVIDER_TIMEOUT");
    expect(e.message).toMatch(/SPONSON_HTTP_TIMEOUT_MS/);
    expect(Date.now() - t).toBeLessThan(1500);
    expect(seen).toHaveLength(1);
  });
});

describe("listAll", () => {
  it("follows cursors and stops on a repeated one", async () => {
    const url = await serve((q, res) => {
      const c = new URL(q.url!, "http://x").searchParams.get("c");
      if (!c) return reply(res, 200, JSON.stringify({ items: [1, 2], next: "a" }));
      if (c === "a") return reply(res, 200, JSON.stringify({ items: [3], next: "b" }));
      return reply(res, 200, JSON.stringify({ items: [4], next: "b" })); // repeats its cursor forever
    });
    const all = await listAll(client(url), "/list?x=1", (b) => {
      const o = b as { items: number[]; next: string | null };
      return { items: o.items, next: o.next ? { c: o.next } : null };
    });
    expect(all).toEqual([1, 2, 3, 4]);
    expect(seen.map((s) => s.url)).toEqual(["/list?x=1", "/list?x=1&c=a", "/list?x=1&c=b"]);
  });
});

it("isProviderError filters by code", () => {
  const e = new SponsonError("PROVIDER_NOT_FOUND", "x");
  expect(isProviderError(e)).toBe(true);
  expect(isProviderError(e, "PROVIDER_NOT_FOUND")).toBe(true);
  expect(isProviderError(e, ["PROVIDER_AUTH"])).toBe(false);
  expect(isProviderError(new SponsonError("PLAN_INVALID", "x"))).toBe(false);
});
