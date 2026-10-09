/**
 * Secret sources (env, doppler, op via fake executables on PATH) and awkward secret values.
 *
 * Promises: README "Secrets are references ... redacted from every byte of output. A literal that looks like a
 * secret is rejected at parse time"; README "Every command takes --json"; SKILL.md rule 3 and rule 6
 * ("Secrets and sensitive outputs are never in the receipt"); and when a secret changes between plan and
 * apply, the fingerprints differ and apply warns and uses the new value.
 */
import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PLAN_ENV, World } from "./helpers.js";

const worlds: World[] = [];
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.close();
});
async function world(plan: string, opts: Parameters<typeof World.create>[1] = {}) {
  const w = await World.create(plan, opts);
  worlds.push(w);
  return w;
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("secret sources via fake CLIs on PATH", () => {
  it("control: doppler:// and op:// values (incl. a multi-line op value) are written to the provider and never printed", async () => {
    const dop = "dp_value_Q7w8e9r0t1y2";
    const opv = "line-one-of-op-secret\nline-two-of-op-secret";
    const w = await world(PLAN_ENV(`      STRIPE_KEY: { secret: "doppler://shop/prd/STRIPE_KEY" }\n      SIGNING_KEY: { secret: "op://vault/item/field" }`), {
      env: { DOPPLER_TOKEN: "dp.st.fake_doppler_token_123" },
    });
    await w.fakeBin("doppler", `#!/bin/sh\n[ "$1 $2 $3" = "secrets get STRIPE_KEY" ] || { echo "bad args: $*" >&2; exit 2; }\nprintf '%s\\n' '${dop}'\n`);
    await w.fakeBin("op", `#!/bin/sh\n[ "$1" = "read" ] || exit 2\nprintf 'line-one-of-op-secret\\nline-two-of-op-secret'\n`);
    const r = await w.cli("apply --json");
    const t = await w.cli("plan");
    expect(r.json?.receipt?.lines?.env?.status, r.stdout + r.stderr).toBe("applied");
    const envs = w.sim.state.vercel.projects.prj_demo!.envs;
    expect(envs.find((e) => e.key === "STRIPE_KEY")?.value).toBe(dop);
    expect(envs.find((e) => e.key === "SIGNING_KEY")?.value).toBe(opv);
    const all = r.stdout + r.stderr + t.stdout + t.stderr + (await w.receiptsText());
    expect(all).not.toContain(dop);
    expect(all).not.toContain("line-one-of-op-secret");
    expect(t.stdout).toMatch(/STRIPE_KEY.*unchanged|= env/);
  });

  it("D9: a secret that rotates between resolve() and fingerprint() records a fingerprint for a value that was never written; plan then claims `unchanged`", async () => {
    const w = await world(PLAN_ENV(`      STRIPE_KEY: { secret: "doppler://shop/prd/STRIPE_KEY" }`));
    const counter = `${w.cwd}/.doppler-calls`;
    // First call returns the old value, every later call the rotated one (rotation lands mid-run).
    await w.fakeBin(
      "doppler",
      `#!/bin/sh\nn=$(cat '${counter}' 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > '${counter}'\nif [ $n -le 1 ]; then echo sk_old_rotating_00000; else echo sk_new_rotating_11111; fi\n`,
    );
    const r = await w.cli("apply --json");
    expect(r.json?.receipt?.lines?.env?.status).toBe("applied");
    const live = w.sim.state.vercel.projects.prj_demo!.envs.find((e) => e.key === "STRIPE_KEY")!.value;
    expect(live).toBe("sk_old_rotating_00000");
    // The receipt must fingerprint what was actually written.
    const fp = r.json.receipt.lines.env.secretFingerprints["doppler://shop/prd/STRIPE_KEY"];
    // v0.2 (types.ts Receipt.hashKey): fingerprints are HMAC(hashKey, sha256(value)), not a bare sha256 prefix.
    const keyed = (v: string) => createHmac("sha256", r.json.receipt.hashKey).update(sha256(v)).digest("hex");
    expect.soft(fp, "fingerprint is of a value Sponson never wrote").toBe(keyed("sk_old_rotating_00000"));
    // And plan must not call the stale live value up to date.
    const p = await w.cli("plan --json");
    expect(p.json.lines.find((l: any) => l.id === "env").status, "live holds the old value, the source the new one").not.toBe("unchanged");
  });
});

describe("awkward secret values", () => {
  it("D10: a secret shorter than 4 chars is silently not redacted (undocumented) and leaks through a provider echo", async () => {
    const pin = "917";
    const w = await world(PLAN_ENV(`      DOOR_PIN_SECRET: { secret: "env://DOOR_PIN_SECRET" }`), {
      env: { DOOR_PIN_SECRET: pin },
      rules: [{ method: "POST", path: /\/vercel\/v10\/projects\/[^/]+\/env$/, respond: ({ body }) => ({ status: 400, body: `rejected value '${(JSON.parse(body) as Array<{ value: string }>)[0]!.value}': too short`, type: "text/plain" }) }],
    });
    const r = await w.cli("apply --json");
    expect(r.json?.receipt?.lines?.env?.status).toBe("failed");
    const leaked = r.json.receipt.lines.env.error.includes(`'${pin}'`) || (await w.receiptsText()).includes(`'${pin}'`);
    const warned = (r.json.warnings as string[]).some((x) => /short|cannot be (masked|redacted)|not redact/i.test(x));
    // Either mask it, or at least tell the user it cannot be masked. Doing neither is a silent leak.
    expect(leaked && !warned, `3-char secret echoed unmasked with no warning: ${r.json.receipt.lines.env.error}`).toBe(false);
  });

  it("D11: a secret equal to a common token (`true`, `applied`) is redacted out of the JSON structure: --json breaks or lies", async () => {
    for (const value of ["true", "applied"]) {
      const w = await world(PLAN_ENV(`      FEATURE_SECRET: { secret: "env://FEATURE_SECRET" }`), { env: { FEATURE_SECRET: value } });
      const r = await w.cli("apply --json");
      expect.soft(r.json, `secret=${value}: --json stdout is not JSON:\n${r.stdout.slice(0, 200)}`).toBeTruthy();
      expect.soft(r.json?.ok, `secret=${value}`).toBe(true);
      expect.soft(r.json?.receipt?.lines?.env?.status, `secret=${value}`).toBe("applied");
    }
  });

  it("D12: a secret-named key with a numeric literal is accepted (SECRET_LITERAL only checks strings) and printed by plan", async () => {
    const w = await world(PLAN_ENV(`      ADMIN_PASSWORD: 84736291`));
    const r = await w.cli("plan --json");
    expect(r.code, `plan accepted a literal password:\n${r.stdout.slice(0, 400)}`).toBe(2);
    expect(r.json?.error?.code).toBe("SECRET_LITERAL");
    expect(r.stdout).not.toContain("84736291");
  });

  it("D13: the receipt stores an unsalted SHA-256 of each secret, so a dictionary-word secret is recoverable from the receipts branch", async () => {
    const secret = "correcthorsebatterystaple";
    const w = await world(PLAN_ENV(`      APP_SECRET: { secret: "env://APP_SECRET" }`), { env: { APP_SECRET: secret } });
    const r = await w.cli("apply --json");
    const p = await w.cli("plan");
    expect(r.json?.receipt?.lines?.env?.status).toBe("applied");
    const all = r.stdout + p.stdout + (await w.receiptsText());
    const h = sha256(secret);
    expect(all.includes(h) || all.includes(h.slice(0, 16)), "sha256(secret) is a dictionary lookup away from the secret").toBe(false);
  });
});
