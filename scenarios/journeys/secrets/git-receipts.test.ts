/**
 * The git-branch receipt store end to end: what lands in the orphan branch history, and whether a token
 * carried in the remote URL can reach any output.
 *
 * Promises: README "Receipts ... Secrets and sensitive outputs are never in the receipt" (SKILL.md rule 6);
 * 实现记录.md "确保远端 URL 中的 token 不进入任何错误信息"; action.yml passes
 * SPONSON_RECEIPTS_REMOTE=https://x-access-token:<token>@github.com/... and `cat`s the CLI JSON into the job log.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLAN_DB_ENV, World, exec } from "./helpers.js";

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  // The store shells out to git with the process env; never prompt, never touch the user's keychain helper.
  for (const [k, v] of Object.entries({ GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GCM_INTERACTIVE: "never" })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
});

describe("git-branch receipts", () => {
  it("control: every commit of sponson/receipts is free of secrets, connection strings and their passwords across fail → rollback → apply → destroy", async () => {
    const stripe = "fake_lv_gitHistoryCheck_ZZ9";
    const w = await World.create(PLAN_DB_ENV(`      STRIPE_KEY: { secret: "env://STRIPE_KEY" }\n`), { env: { STRIPE_KEY: stripe } });
    const bare = await mkdtemp(join(tmpdir(), "sponson-bare-"));
    try {
      await exec("git", ["init", "-q", "--bare", bare]);
      const opts = { receipts: "git-branch" as const, remote: bare };
      const outs: string[] = [];
      const passwords = new Set<string>();
      const conns = new Set<string>();
      const capture = () => {
        for (const p of Object.values(w.sim.state.neon.projects)) for (const b of p.branches) if (b.name !== "main") conns.add(w.sim.state.connectionUri(b));
      };

      await w.sim.state.applyChaos({ fail_on: "POST /vercel/*", fail_next: 1, status: 500 } as never);
      const r1 = await w.cli("apply --json", opts);
      outs.push(r1.stdout, r1.stderr);
      expect(r1.json?.receipt?.lines?.db?.status).toBe("rolled_back");
      const r2 = await w.cli("apply --json", opts);
      outs.push(r2.stdout, r2.stderr);
      capture();
      expect(["complete", "partial"]).toContain(r2.json?.receipt?.status);
      const p = await w.cli("plan", opts);
      outs.push(p.stdout, p.stderr);
      const d = await w.cli("apply --destroy --json", opts);
      outs.push(d.stdout, d.stderr);
      expect(d.json?.receipt?.status).toBe("complete");

      for (const c of conns) passwords.add(new URL(c).password);
      const { stdout: history } = await exec("git", ["--git-dir", bare, "log", "-p", "--all", "--format=%H %s%n%b"], { maxBuffer: 64 * 1024 * 1024 });
      expect(history).toContain("receipt preview/pr-42");
      const corpus = history + outs.join("\n");
      expect(corpus).not.toContain(stripe);
      for (const c of conns) expect(corpus).not.toContain(c);
      // Any connection string at all (including the rolled-back branch's) is a leak.
      expect(corpus).not.toMatch(/postgres(ql)?:\/\/[^\s"]*:[^\s"@]+@/);
      for (const pw of passwords) expect(history).not.toContain(`:${pw}@`);
    } finally {
      await rm(bare, { recursive: true, force: true });
      await w.close();
    }
  });

  it("control: a token embedded in the receipts remote URL never reaches stdout, stderr, --json or a SPONSON_DEBUG stack", async () => {
    const token = "ghs_FAKEtokenInRemoteUrl0123456789abcd";
    const modes = [403, 404, 500] as const;
    const server = createServer((req, res) => {
      const m = Number((req.url ?? "").split("/")[1]);
      res.writeHead(m || 500, { "content-type": "text/plain" });
      res.end(`denied for ${req.headers.authorization ?? "anon"}`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const w = await World.create(PLAN_DB_ENV(), { env: { SPONSON_DEBUG: "1" } });
    try {
      const remotes = [...modes.map((m) => `http://x-access-token:${token}@127.0.0.1:${port}/${m}/acme/app.git`), `http://x-access-token:${token}@127.0.0.1:1/acme/app.git`];
      for (const remote of remotes) {
        for (const cmd of ["apply --json", "apply", "plan --json", "apply --destroy"]) {
          const r = await w.cli(cmd, { receipts: "git-branch", remote });
          expect(r.stdout + r.stderr, `${cmd} via ${remote.replace(token, "TOKEN")}`).not.toContain(token);
        }
      }
    } finally {
      server.closeAllConnections();
      server.close();
      await w.close();
    }
  });

  it("D14: a receipts remote answering 404 (GitHub's answer for a token without access to a private repo) is read as 'no receipts yet': plan exits 0 and drift detection silently turns off", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Repository not found.");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const w = await World.create(PLAN_DB_ENV());
    try {
      const remote = `http://x-access-token:ghs_noaccess@127.0.0.1:${port}/acme/private.git`;
      const r = await w.cli("plan --json", { receipts: "git-branch", remote });
      expect(r.code, `plan pretended the receipts branch is empty:\n${r.stdout.slice(0, 300)}`).not.toBe(0);
      expect(r.json?.error?.code).toBe("STORE_PERMISSION");
    } finally {
      server.closeAllConnections();
      server.close();
      await w.close();
    }
  });
});
