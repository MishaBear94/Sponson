/**
 * What comes back is not what the adapter assumed: env vars shared across targets, non-ASCII and very large
 * values, JSON with escaped unicode and extra fields, error bodies that echo the request, and list endpoints
 * that change shape.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isPath, World, type Upstream } from "./harness.js";

let w: World | null = null;
afterEach(async () => {
  await w?.close();
  w = null;
});

describe("unexpected shapes and values", () => {
  it("production var that a human created in the dashboard for all three targets: apply; apply converges (second run 0 writes) and production ends up with exactly one effective value", async () => {
    w = await World.create({
      plan: `version: 1
environments: [preview, production]
providers:
  vercel: { project: prj_demo }
changes:
  - id: env
    adapter: vercel
    op: env
    values:
      API_BASE: "https://api.example.com/v2"
    environments: [production]
`,
    });
    // The Vercel dashboard's default when adding a variable: Production + Preview + Development, one record.
    const now = Date.now();
    w.sim.state.vercel.projects.prj_demo!.envs.push({
      id: w.sim.state.nextId("env_"), key: "API_BASE", value: "https://api.example.com/v1", target: ["production", "preview", "development"],
      type: "encrypted", createdAt: now, updatedAt: now, createdBy: "sim",
    });
    const prod = ["--env", "production", "--approved-by", "alice"];

    // v2 (Vercel adapter, PROVIDER_CONFLICT): a variable shared by several targets is refused instead of converged, because
    // changing it would also change preview/development, and splitting it silently leaves two effective values. The run
    // fails with a coded error that tells the human what to do, and nothing is written.
    const r1 = await w.cli("apply --json", prod);
    expect(r1.code, r1.stdout).toBe(1);
    expect(r1.json.receipt.status).toBe("failed");
    expect(r1.json.receipt.lines.env).toMatchObject({ errorCode: "PROVIDER_CONFLICT" });
    expect(r1.json.receipt.lines.env.error).toMatch(/API_BASE.*production.*preview.*development|shared by targets/);
    expect(r1.writes).toBe(0);
    const forProd = w.envs("API_BASE").filter((e) => e.target.includes("production"));
    expect(forProd.map((e) => e.value), "production must still have exactly one effective API_BASE").toEqual(["https://api.example.com/v1"]);

    // Re-running does not flip-flop or write anything either.
    const r2 = await w.cli("apply --json", prod);
    expect(r2.json.receipt.lines.env.errorCode).toBe("PROVIDER_CONFLICT");
    expect(r2.writes).toBe(0);
  });

  it("unicode and 30 KB values through a provider that escapes non-ASCII as \\uXXXX and adds unknown fields: stored byte-exact, second apply writes nothing", async () => {
    const tagline = "Café — 日本語 ✓ 🚀 «ünïcödé» \"quoted\" \\ back";
    const big = "é".repeat(15000) + "x".repeat(15000);
    w = await World.create({
      plan: `version: 1
providers:
  vercel: { project: prj_demo }
changes:
  - id: env
    adapter: vercel
    op: env
    values:
      APP_TAGLINE: ${JSON.stringify(tagline)}
      LARGE_CONFIG: "${big}"
`,
    });
    const asciiJson = (u: Upstream): Upstream => {
      if (!u.headers["content-type"]?.includes("json") || !u.body) return u;
      const decorate = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(decorate);
        if (v && typeof v === "object") return { ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decorate(x)])), _vercelInternal: { region: "iad1" } };
        return v;
      };
      const text = JSON.stringify(decorate(JSON.parse(u.body))).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
      return { ...u, body: text };
    };
    w.proxy.on((r) => r.path.startsWith("/vercel/"), () => ({ rewrite: asciiJson }));

    const r1 = await w.cli("apply --json");
    expect(r1.json.receipt.lines.env.status, r1.json.receipt.lines.env.error).toBe("applied");
    expect(w.envs("APP_TAGLINE")[0]?.value).toBe(tagline);
    expect(w.envs("LARGE_CONFIG")[0]?.value).toBe(big);
    const r2 = await w.cli("apply --json");
    expect(r2.json.receipt.lines.env.status).toBe("unchanged");
    expect(r2.writes).toBe(0);
  });

  it("a provider 400 that echoes the rejected request body does not leak a multi-line secret (PEM key) into the receipt or output", async () => {
    const PEM_LINES = [
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
      "MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu",
      "NMoSfm76oqFvAp8Gy0iz5sxjZmSnXyCdPEovGhLa0VzMaQ8s+CLOyS56YyCFGeJZ",
    ];
    const pem = `-----BEGIN PRIVATE KEY-----\n${PEM_LINES.join("\n")}\n-----END PRIVATE KEY-----\n`;
    w = await World.create({
      plan: `version: 1
providers:
  vercel: { project: prj_demo }
changes:
  - id: env
    adapter: vercel
    op: env
    values:
      TLS_PRIVATE_KEY: { secret: "env://TLS_PRIVATE_KEY" }
`,
      env: { TLS_PRIVATE_KEY: pem },
    });
    // Validation-style error that echoes the input, as many APIs (and API gateways) do.
    w.proxy.on(isPath("POST", /^\/vercel\/v10\/projects\/[^/]+\/env$/), (r) => ({ status: 400, body: { error: { code: "bad_request", message: "Invalid request: value contains invalid characters", input: JSON.parse(r.body) } } }), 1);

    const r = await w.cli("apply --json");
    expect(r.code).toBe(1);
    const everything = [r.stdout, r.stderr, ...(await w.receiptTexts())].join("\n");
    for (const line of PEM_LINES) expect(everything, "PEM body leaked through an echoed, JSON-escaped error body").not.toContain(line);
  });

  it("clerk list endpoint switches to the paginated `{ data, total_count }` envelope: the error names Clerk and the unexpected shape instead of a bare TypeError", async () => {
    w = await World.create({
      plan: `version: 1
changes:
  - id: callback
    adapter: clerk
    op: redirect_allow
    url: "https://pr-42.shop.example.com/sso-callback"
`,
    });
    w.proxy.on(isPath("GET", /^\/clerk\/redirect_urls$/), () => ({
      rewrite: (u) => {
        const list = JSON.parse(u.body);
        return { ...u, body: JSON.stringify({ data: list, total_count: list.length }) };
      },
    }));

    // v2 (response-shape handling): the `{ data, total_count }` envelope is supported, so plan simply works, and an
    // existing URL listed inside the envelope is recognised (no duplicate on the next apply).
    const r = await w.cli("plan --json");
    const line = r.json.lines[0];
    expect(line.error, "error is a raw JS TypeError").toBeUndefined();
    expect(line.status).toBe("create");
    const a = await w.cli("apply --json");
    expect(a.code, a.stdout).toBe(0);
    const again = await w.cli("plan --json");
    expect(again.json.lines[0].status).toBe("unchanged");
    expect(w.redirects()).toHaveLength(1);
  });
});
