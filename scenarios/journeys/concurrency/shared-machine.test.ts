/**
 * One laptop, several actors: the developer runs `sponson apply` in a terminal while their coding agent drives
 * `sponson mcp`, both pointed at the team's receipts remote. Neither passes a workdir, so each process makes its
 * own working clone under the same OS temp dir: what they share is the machine, the remote and the fake cloud.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startSim, type SimHandle } from "@sponson/sim";
import { bareRemote, checkout, ctxArgs, MCP_COMMAND, neonBranches, remoteFile, spawnCli, tmp, waitFor } from "./helpers.js";
import { cliEnv } from "../../support.js";

let sim: SimHandle;
afterEach(async () => sim?.close());

async function mcpAgent(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<Client> {
  const transport = new StdioClientTransport({ command: MCP_COMMAND.command, args: [...MCP_COMMAND.args, ...args], cwd, env: env as Record<string, string>, stderr: "ignore" });
  const client = new Client({ name: "agent", version: "0" });
  await client.connect(transport);
  return client;
}

function toolJson(r: unknown): Record<string, any> {
  const text = (r as { content: Array<{ text: string }> }).content[0]!.text;
  return JSON.parse(text.split("\n")[0]!);
}

/** The receipts store's push budget for these runs; the test timeout is derived from it. */
const STORE_BUDGET_MS = 60_000;

describe("developer terminal + agent on one machine", () => {
  it("different scopes (dev on PR 51, agent on PR 52) via the git-branch store with the default working clone: both succeed and both receipts land", async () => {
    // Expected: scopes are independent, each with its own lock and receipt. Sharing a laptop must not make two unrelated PRs collide.
    sim = await startSim();
    sim.state.applyChaos({ latency_ms: 15 });
    const remote = await bareRemote();
    const sharedTmp = await tmp("laptop"); // same TMPDIR = same machine
    const failures: string[] = [];
    for (let round = 0; round < 3; round++) {
      const devPr = 51 + round * 2;
      const agentPr = devPr + 1;
      const env = cliEnv(sim, { TMPDIR: sharedTmp, SPONSON_STORE_BUDGET_MS: String(STORE_BUDGET_MS) });
      const agent = await mcpAgent(await checkout(), env, ["--receipts", "git-branch", "--receipts-remote", remote, ...ctxArgs(agentPr)]);
      try {
        const [dev, viaMcp] = await Promise.all([
          spawnCli(["apply", "--json", "--receipts", "git-branch", "--receipts-remote", remote, ...ctxArgs(devPr)], await checkout(), env).done,
          agent.callTool({ name: "sponson_apply", arguments: {} }),
        ]);
        if (dev.code !== 0) failures.push(`round ${round} dev pr-${devPr}: exit ${dev.code} ${dev.json?.error?.code ?? ""} ${(dev.json?.error?.message ?? dev.stderr).slice(0, 200)}`);
        const a = toolJson(viaMcp);
        if ((viaMcp as { isError?: boolean }).isError || a.receipt?.status !== "complete") failures.push(`round ${round} agent pr-${agentPr}: ${JSON.stringify(a.error ?? a.receipt?.status).slice(0, 200)}`);
        for (const pr of [devPr, agentPr]) if (!(await remoteFile(remote, `preview/pr-${pr}/latest.json`))) failures.push(`round ${round}: no receipt for pr-${pr}`);
      } finally {
        await agent.close();
      }
    }
    expect(failures).toEqual([]);
  }, 3 * STORE_BUDGET_MS + 60_000); // three rounds; only the product's own budget may give up first

  it("same scope: the agent's sponson_apply and the developer's apply race on PR 60 (local store): one applies, the other gets LOCK_HELD, one branch", async () => {
    sim = await startSim();
    // Make the overlap certain rather than likely: whoever takes the lock first is parked at its first provider
    // write until the other has run to completion, so the other always meets a held lock.
    sim.state.applyChaos({ hold_next: 1 });
    const cwd = await checkout();
    const receipts = join(cwd, ".sponson/receipts");
    const args = ["--receipts", "local", "--receipts-dir", receipts, ...ctxArgs(60)];
    const env = cliEnv(sim);
    const agent = await mcpAgent(cwd, env, args);
    try {
      const devRun = spawnCli(["apply", "--json", ...args], cwd, env).done;
      const mcpRun = agent.callTool({ name: "sponson_apply", arguments: {} });
      await Promise.race([devRun, mcpRun]);
      await waitFor(() => sim.state.heldCount === 1, 15_000, "the lock holder to reach its first write");
      sim.state.release();
      const [dev, viaMcp] = await Promise.all([devRun, mcpRun]);
      const a = toolJson(viaMcp);
      const outcomes = [dev.code === 0 ? "applied" : dev.json?.error?.code, (viaMcp as { isError?: boolean }).isError ? a.error?.code : a.receipt?.status === "complete" ? "applied" : a.receipt?.status].sort();
      expect(outcomes).toEqual(["LOCK_HELD", "applied"]);
      expect(neonBranches(sim).filter((n) => n === "sponson/preview/pr-60")).toHaveLength(1);
    } finally {
      await agent.close();
    }
  });
});
