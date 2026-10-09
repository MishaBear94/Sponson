/**
 * Providers that echo request data in error bodies.
 *
 * Promise under test (README "What it does"; SKILL.md rule 3): secret values and sensitive outputs are
 * "redacted from every byte of output" — stdout, stderr, --json, receipts — including when an adapter throws
 * an error whose message contains a connection string.
 *
 * A proxy sits in front of the sim and overrides a single route to answer with an error that echoes data.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PLAN_DB_ENV, PLAN_ENV, World, partialLeaks, type Rule } from "./helpers.js";

const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.close();
});
async function world(plan: string, opts: Parameters<typeof World.create>[1] = {}) {
  const w = await World.create(plan, { ...opts, env: { SPONSON_DEBUG: "1", ...(opts.env ?? {}) } });
  worlds.push(w);
  return w;
}

/** Vercel bulk-upsert answers 400 and echoes the request body inside its JSON error, like many APIs' validation errors. */
const echoEnvPost = (shape: (body: string) => unknown): Rule => ({
  method: "POST",
  path: /\/vercel\/v10\/projects\/[^/]+\/env$/,
  respond: ({ body }) => ({ status: 400, body: JSON.stringify(shape(body)) }),
});

async function everything(w: World, ...runs: Array<{ stdout: string; stderr: string }>) {
  return runs.map((r) => r.stdout + "\n" + r.stderr).join("\n") + (await w.receiptsText());
}

describe("provider error bodies that echo request data", () => {
  it("control: a plain single-line secret echoed verbatim is masked in stdout, stderr, --json and the receipt", async () => {
    const secret = "fake_lv_51HxQpL2eZvKYlo2C0aBcDeFg";
    const w = await world(PLAN_ENV(`      STRIPE_KEY: { secret: "env://STRIPE_KEY" }`), {
      env: { STRIPE_KEY: secret },
      rules: [{ method: "POST", path: /\/vercel\/v10\/projects\/[^/]+\/env$/, respond: ({ body }) => ({ status: 422, body: `invalid request: ${body}`, type: "text/plain" }) }],
    });
    const json = await w.cli("apply --json");
    const text = await w.cli("apply");
    expect(json.json?.receipt?.lines?.env?.status).toBe("failed");
    expect(json.json.receipt.lines.env.error).toContain("[REDACTED]");
    expect(await everything(w, json, text)).not.toContain(secret);
  });

  it("D1: a multi-line PEM secret echoed by the provider is not masked (whitespace flattening / JSON \\n escaping)", async () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
      "MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu",
      "NMoSfm76oqFvAp8Gy0iz5sxjZmSnXyCdPEovGhLa0VzMaQ8s+CLOyS56YyCFGeJZ",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    // Provider 1 echoes JSON (newlines become the two characters `\n`); provider 2 echoes plain text.
    for (const mode of ["json", "text"] as const) {
      const w = await world(PLAN_ENV(`      TLS_PRIVATE_KEY: { secret: "env://TLS_PRIVATE_KEY" }`), {
        env: { TLS_PRIVATE_KEY: pem },
        rules: [
          {
            method: "POST",
            path: /\/vercel\/v10\/projects\/[^/]+\/env$/,
            respond: ({ body }) => {
              const sent = JSON.parse(body) as Array<{ key: string; value: string }>;
              return mode === "json"
                ? { status: 400, body: JSON.stringify({ error: { code: "bad_value", value: sent[0]!.value } }) }
                : { status: 400, body: `bad value for ${sent[0]!.key}:\n${sent[0]!.value}`, type: "text/plain" };
            },
          },
        ],
      });
      const r = await w.cli("apply --json");
      expect(r.json?.receipt?.lines?.env?.status, mode).toBe("failed");
      const all = await everything(w, r);
      // Any one line of key material is a leak.
      for (const keyLine of pem.split("\n").slice(1, 4)) expect(all, `${mode}: PEM body line leaked`).not.toContain(keyLine);
    }
  });

  it("D2: JSON-escaped, URL-encoded and base64 forms of an echoed secret slip past the redactor (it masks one byte form only)", async () => {
    const secret = 'Zq9"Top/Secret+Middle=Part&\\Tail 0042';
    const w = await world(PLAN_ENV(`      API_SECRET: { secret: "env://API_SECRET" }`), {
      env: { API_SECRET: secret },
      rules: [
        echoEnvPost((body) => {
          const v = (JSON.parse(body) as Array<{ value: string }>)[0]!.value;
          // A validation error that echoes the request (JSON-escaped), a signed query string, and a Basic auth header.
          return { error: { message: "rejected", value: v, canonical: `X-Amz-Credential=${encodeURIComponent(v)}`, basic: `Basic ${Buffer.from(`user:${v}`).toString("base64")}` } };
        }),
      ],
    });
    const r = await w.cli("apply --json");
    expect(r.json?.receipt?.lines?.env?.status).toBe("failed");
    const all = await everything(w, r);
    expect.soft(r.json.receipt.lines.env.error, "JSON-escaped secret leaked").not.toContain(JSON.stringify(secret).slice(1, -1));
    expect.soft(partialLeaks(all, secret, 12), "a 12+ char run of the secret survived").toEqual([]);
    expect.soft(all, "url-encoded secret leaked").not.toContain(encodeURIComponent(secret));
    expect.soft(all, "base64 secret leaked").not.toContain(Buffer.from(`user:${secret}`).toString("base64"));
  });

  it("D4: an echoed secret that straddles the 500-char error excerpt boundary leaks its prefix", async () => {
    // No digit run: "0123456789" is a prefix of the fixture SHA, so it would "leak" via the receipt's ctx.git.sha.
    const secret = "fake_lv_PREFIXLEAKSqwrtzpvmnk_SUFFIXisCUT";
    const w = await world(PLAN_ENV(`      STRIPE_KEY: { secret: "env://STRIPE_KEY" }`), {
      env: { STRIPE_KEY: secret },
      rules: [
        {
          method: "POST",
          path: /\/vercel\/v10\/projects\/[^/]+\/env$/,
          respond: ({ body }) => {
            const v = (JSON.parse(body) as Array<{ value: string }>)[0]!.value;
            const pad = "x".repeat(480);
            return { status: 400, body: `${pad} value=${v} end`, type: "text/plain" };
          },
        },
      ],
    });
    const r = await w.cli("apply --json");
    expect(r.json?.receipt?.lines?.env?.status).toBe("failed");
    const all = await everything(w, r);
    expect(partialLeaks(all, secret, 10), "a prefix of the secret survived truncation").toEqual([]);
  });

  it("D5: the password inside a sensitive connection string leaks when a downstream provider echoes it in another form", async () => {
    const w = await world(PLAN_DB_ENV(), {
      rules: [
        echoEnvPost((body) => {
          const v = (JSON.parse(body) as Array<{ key: string; value: string }>).find((x) => x.key === "DATABASE_URL")!.value;
          const u = new URL(v);
          // libpq-style DSN echo: same credentials, different shape.
          return { error: { message: `invalid DATABASE_URL: host=${u.hostname} user=${u.username} password=${u.password} dbname=${u.pathname.slice(1)}` } };
        }),
      ],
    });
    const r = await w.cli("apply --json");
    expect(r.json?.receipt?.lines?.env?.status).toBe("failed");
    expect(r.json.receipt.lines.db.status).toBe("rolled_back");
    // Recover the password the sim minted (the branch is rolled back, so look it up from the write log / state).
    const passwords = [...JSON.stringify(r.json).matchAll(/password=(\S+?)[ "]/g)].map((m) => m[1]!);
    const all = await everything(w, r);
    expect(passwords.filter((p) => p !== "[REDACTED]"), `connection-string password leaked: ${all.match(/password=\S+/)?.[0]}`).toEqual([]);
  });

  it("D6: --destroy redacts nothing: a provider that echoes the env var on a failed DELETE leaks the secret into the receipt", async () => {
    const secret = "whsec_destroyPathSecret_77aa";
    const w = await world(PLAN_ENV(`      WEBHOOK_SECRET: { secret: "env://WEBHOOK_SECRET" }`), { env: { WEBHOOK_SECRET: secret } });
    const ok = await w.cli("apply --json");
    expect(ok.json?.receipt?.lines?.env?.status).toBe("applied");
    // Swap in an echoing proxy for the destroy run: DELETE answers 409 with the env object, value included.
    const { startEchoProxy } = await import("./helpers.js");
    const proxy = await startEchoProxy(w.sim.url, [
      {
        method: "DELETE",
        path: /\/vercel\/v9\/projects\/[^/]+\/env\/[^/]+$/,
        respond: () => ({ status: 409, body: JSON.stringify({ error: { message: "env is referenced by a protected deployment", env: w.sim.state.vercel.projects.prj_demo!.envs[0] } }) }),
      },
    ]);
    try {
      const r = await w.cli("apply --destroy --json", { env: { VERCEL_API_URL: `${proxy.url}/vercel` } });
      expect(r.json?.receipt?.lines?.env?.status).toBe("destroy_failed");
      expect(await everything(w, r)).not.toContain(secret);
    } finally {
      await proxy.close();
    }
  });

  it("D7: plan never resolves secrets, so a read error that echoes live values leaks an env:// secret into plan output", async () => {
    const secret = "fake_lv_planPathLeak_31337abc";
    const w = await world(PLAN_DB_ENV(`      STRIPE_KEY: { secret: "env://STRIPE_KEY" }\n`), { env: { STRIPE_KEY: secret } });
    const ok = await w.cli("apply --json");
    expect(["complete", "partial"]).toContain(ok.json?.receipt?.status);
    const { startEchoProxy } = await import("./helpers.js");
    const proxy = await startEchoProxy(w.sim.url, [
      {
        method: "GET",
        path: /\/vercel\/v9\/projects\/[^/]+\/env$/,
        // A gateway error that dumps the (decrypted) upstream payload, truncated by the adapter to 500 chars.
        respond: () => ({ status: 502, body: JSON.stringify({ error: "upstream decode failed", partial: w.sim.state.vercel.projects.prj_demo!.envs.map((e) => ({ k: e.key, v: e.value })) }) }),
      },
    ]);
    try {
      const env = { VERCEL_API_URL: `${proxy.url}/vercel` };
      const json = await w.cli("plan --json", { env });
      const text = await w.cli("plan", { env });
      expect(json.json?.lines?.find((l: any) => l.id === "env")?.status).toBe("error");
      const all = json.stdout + json.stderr + text.stdout + text.stderr;
      const connStr = w.sim.state.vercel.projects.prj_demo!.envs.find((e) => e.key === "DATABASE_URL")!.value;
      expect(all, "sensitive output (connection string) is masked").not.toContain(connStr);
      expect(all, "env:// secret leaked by plan").not.toContain(secret);
    } finally {
      await proxy.close();
    }
  });

  it("D8: a provider 401 that echoes the credential leaks VERCEL_TOKEN into the receipt and output", async () => {
    const w = await world(PLAN_ENV(`      FEATURE_FLAG: "on"`));
    const token = w.env.VERCEL_TOKEN!;
    const { startEchoProxy } = await import("./helpers.js");
    const proxy = await startEchoProxy(w.sim.url, [
      { method: "GET", path: /\/vercel\//, respond: ({ headers }) => ({ status: 401, body: JSON.stringify({ error: { code: "forbidden", message: `Not authorized: ${headers.authorization}` } }) }) },
    ]);
    try {
      const r = await w.cli("apply --json", { env: { VERCEL_API_URL: `${proxy.url}/vercel` } });
      const p = await w.cli("plan", { env: { VERCEL_API_URL: `${proxy.url}/vercel` } });
      expect(r.json?.receipt?.lines?.env?.status).toBe("failed");
      expect(await everything(w, r, p)).not.toContain(token);
    } finally {
      await proxy.close();
    }
  });

  it("control: overlapping secrets and regex/JSON/YAML metacharacters are masked whole, longest first", async () => {
    const short = "a.b*c+d?(e)";
    const long = "a.b*c+d?(e)[f]$^|x: {y}";
    const w = await world(PLAN_ENV(`      ONE_KEY: { secret: "env://ONE_KEY" }\n      TWO_KEY: { secret: "env://TWO_KEY" }`), {
      env: { ONE_KEY: short, TWO_KEY: long },
      rules: [{ method: "POST", path: /\/vercel\/v10\/projects\/[^/]+\/env$/, respond: ({ body }) => ({ status: 400, body: (JSON.parse(body) as Array<{ value: string }>).map((x) => `<${x.value}>`).join(" "), type: "text/plain" }) }],
    });
    const r = await w.cli("apply");
    const all = await everything(w, r);
    expect(all).not.toContain(short);
    expect(all).toContain("<[REDACTED]> <[REDACTED]>");
    expect(all).not.toContain("[REDACTED][f]");
  });
});
