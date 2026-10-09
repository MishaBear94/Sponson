import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HTTP_ERROR_BODY_LIMIT, type HttpError, apiClient, isHttpError } from "./http.js";

describe("apiClient errors", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function serve(status: number, body: string, type = "text/html"): Promise<string> {
    server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("truncates a huge error page so it cannot end up in a receipt, and never includes the request body", async () => {
    const page = "<html>" + "x".repeat(1024 * 1024) + "</html>";
    const api = apiClient({ baseUrl: await serve(502, page), token: "t" });
    const err = await api.post("/env", { value: "request-secret" }).catch((e: unknown) => e);
    expect(isHttpError(err, 502)).toBe(true);
    const e = err as HttpError;
    expect(e.message.length).toBeLessThan(HTTP_ERROR_BODY_LIMIT + 100);
    expect(e.body.length).toBeLessThan(HTTP_ERROR_BODY_LIMIT + 50);
    expect(e.message).toMatch(/^POST \/env → 502: <html>x+… \(\d+ chars\)$/);
    expect(e.message).not.toContain("request-secret");
  });

  it("names the endpoint when the response is not JSON", async () => {
    const api = apiClient({ baseUrl: await serve(200, "<html>login</html>"), token: "t" });
    await expect(api.get("/x")).rejects.toThrow(/GET \/x → 200: response is not JSON: <html>login<\/html>/);
  });

  it("names the endpoint when the connection fails", async () => {
    const api = apiClient({ baseUrl: "http://127.0.0.1:1", token: "t" });
    await expect(api.get("/x")).rejects.toThrow(/GET http:\/\/127\.0\.0\.1:1\/x: /);
  });
});
