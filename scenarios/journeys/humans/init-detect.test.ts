/**
 * `sponson init` on representative repositories: it detects the stack from the files, writes a plan that matches
 * it (real ids where the files hold them, a TODO with where to look where they do not), says what it found and
 * what it does not support, and never reads a secret value into the plan or the output.
 *
 * Every plan written here must parse and validate against schema/release.plan.schema.json.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { parsePlan } from "@sponson/core";
import { startSim, type SimHandle } from "@sponson/sim";
import { cliEnv, runCli, SHA, workspace, type Workspace } from "../../support.js";

const schema = JSON.parse(await readFile(new URL("../../../schema/release.plan.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
const validate = new Ajv2020({ allErrors: true, strict: true, strictTypes: false }).compile(schema);

const SECRET_PASSWORD = "n30n-pa55word-do-not-leak";
const SECRET_CLERK = "sk_test_clerk-value-do-not-leak";
const SECRET_SUPABASE = "supabase-service-role-do-not-leak";

type Files = Record<string, string | object>;

/** Next.js on Vercel (linked), Neon, Clerk and Prisma; real secrets in .env.local. */
const NEXT_VERCEL_NEON_CLERK: Files = {
  "package.json": { dependencies: { next: "15.1.0", "@neondatabase/serverless": "^1.0.0", "@clerk/nextjs": "^6.0.0", "@prisma/client": "^6.0.0" }, devDependencies: { prisma: "^6.0.0" } },
  ".vercel/project.json": { projectId: "prj_demo", orgId: "team_demo" },
  "prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n',
  ".env.example": "DATABASE_URL=\nNEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=\nCLERK_SECRET_KEY=\n",
  ".env.local": `DATABASE_URL="postgresql://neondb_owner:${SECRET_PASSWORD}@ep-quiet-sky-a1b2c3.us-east-2.aws.neon.tech/neondb?sslmode=require"\nCLERK_SECRET_KEY=${SECRET_CLERK}\nNEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_public\n`,
};

/** Next.js on Vercel with Supabase: Vercel is managed, Supabase is reported as not supported yet. */
const NEXT_VERCEL_SUPABASE: Files = {
  "package.json": { dependencies: { next: "15.1.0", "@supabase/supabase-js": "^2.45.0", "@supabase/ssr": "^0.5.0" } },
  "vercel.json": { framework: "nextjs" },
  "supabase/config.toml": 'project_id = "demo"\n',
  ".env.local": `NEXT_PUBLIC_SUPABASE_URL=https://abcd.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=${SECRET_SUPABASE}\n`,
};

/** SvelteKit + Drizzle on Neon (context file from `neonctl set-context`), deployed somewhere Sponson does not manage. */
const SVELTEKIT_NEON_NETLIFY: Files = {
  "package.json": { dependencies: { "@sveltejs/kit": "^2.0.0", "drizzle-orm": "^0.36.0", "@neondatabase/serverless": "^1.0.0" } },
  ".neon": { projectId: "proj_demo" },
  "drizzle.config.ts": "export default { dialect: 'postgresql', dbCredentials: { url: process.env.POSTGRES_URL! } };\n",
  "netlify.toml": "[build]\n  command = \"vite build\"\n",
};

let ws: Workspace | undefined;
let sim: SimHandle | undefined;
afterEach(async () => {
  await ws?.cleanup();
  await sim?.close();
  ws = sim = undefined;
});

async function repoWith(files: Files): Promise<string> {
  ws = await workspace("init-detect");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(ws.dir, path)), { recursive: true });
    await writeFile(join(ws.dir, path), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return ws.dir;
}

/** `init` with no provider ids in the environment, as on a laptop. */
async function init(cwd: string, ...args: string[]) {
  return runCli(["init", ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1" }, cwd });
}

async function writtenPlan(cwd: string): Promise<{ text: string; ids: string[] }> {
  const text = await readFile(join(cwd, "release.plan.yaml"), "utf8");
  const { plan } = parsePlan(text);
  expect(validate(parseYaml(text)), JSON.stringify(validate.errors)).toBe(true);
  return { text, ids: plan.changes.map((c) => c.id) };
}

describe("sponson init detects the stack", () => {
  it("Next.js + Vercel + Neon + Clerk: db → env by reference → Clerk callback, the Vercel ids filled in, the Neon id a TODO", async () => {
    const cwd = await repoWith(NEXT_VERCEL_NEON_CLERK);
    const r = await init(cwd);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^Detected: Vercel \(\.vercel\/project\.json\), Neon \(package\.json: @neondatabase\/serverless\), Clerk \(package\.json: @clerk\/nextjs\), Next\.js \(package\.json: next\), Prisma/m);
    expect(r.stdout).toMatch(/To fill in:\n {2}providers\.neon\.project \(now "proj_xxx"\): run `neonctl projects list`/);
    expect(r.stdout).toContain("Next: set VERCEL_TOKEN, NEON_API_KEY, CLERK_SECRET_KEY in your environment, then run `sponson plan`");
    expect(r.stdout).not.toContain("Not supported yet");
    const { text, ids } = await writtenPlan(cwd);
    expect(ids).toEqual(["db", "env", "callback"]);
    expect(text).toContain('vercel: { project: "prj_demo", team: "team_demo" }   # from .vercel/project.json');
    expect(text).toContain("DATABASE_URL: { from: db.connection_string }");
    expect(text).toContain("url: { from: env.preview_url }");

    // Once the TODO is filled in, the plan plans against the (fake) cloud: db to create, env and callback pending.
    sim = await startSim();
    await writeFile(join(cwd, "release.plan.yaml"), text.replace('"proj_xxx"', '"proj_demo"') + "receipts: local\n");
    const p = await runCli(["plan", "--json", "--branch", "feat/x", "--sha", SHA, "--pr", "42"], { env: cliEnv(sim), cwd });
    expect(p.code, p.stdout + p.stderr).toBe(0);
    expect(p.json.lines.map((l: any) => [l.id, l.status])).toEqual([["db", "create"], ["env", "pending"], ["callback", "pending"]]);
  });

  it("Next.js + Vercel + Supabase: Supabase reported as not supported yet with a pointer, never silently ignored", async () => {
    const cwd = await repoWith(NEXT_VERCEL_SUPABASE);
    const r = await init(cwd, "--json");
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.detected.found.map((f: any) => f.id)).toEqual(["vercel", "next"]);
    expect(r.json.detected.unsupported).toEqual([
      expect.objectContaining({ id: "supabase", name: "Supabase", kind: "service", pointer: expect.stringMatching(/ROADMAP\.md/), evidence: expect.arrayContaining(["package.json: @supabase/supabase-js", "supabase/config.toml"]) }),
    ]);
    expect(r.json.detected.todo).toEqual([expect.objectContaining({ path: "providers.vercel.project", placeholder: "prj_xxx", hint: expect.stringMatching(/vercel link/) })]);
    const { text, ids } = await writtenPlan(cwd);
    expect(ids).toEqual(["env"]);
    expect(text).toContain("# Not supported yet, so no line below manages it: Supabase");
    expect(text).not.toMatch(/neon/);

    // and the human summary says the same
    await rm(join(cwd, "release.plan.yaml"));
    const human = await init(cwd);
    expect(human.stdout).toMatch(/Not supported yet \(no line manages them\):\n {2}Supabase \(package\.json: @supabase\/supabase-js\): database branches/);
  });

  it("SvelteKit + Drizzle + Neon on Netlify: the Neon id from `.neon`, the variable Drizzle reads, Netlify not supported", async () => {
    const cwd = await repoWith(SVELTEKIT_NEON_NETLIFY);
    const r = await init(cwd, "--json");
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.detected).toMatchObject({ assumed: false, todo: [] });
    expect(r.json.detected.found.map((f: any) => f.id)).toEqual(["neon", "sveltekit", "drizzle"]);
    expect(r.json.detected.unsupported.map((f: any) => f.id)).toEqual(["netlify"]);
    const { text, ids } = await writtenPlan(cwd);
    expect(ids).toEqual(["db"]);
    expect(text).toContain('neon: { project: "proj_demo" }   # from .neon');
    expect(text).toContain("has no deploy target Sponson manages yet");
  });

  it("a bare repository: the Vercel + Neon template, explained, with both ids to fill in", async () => {
    const cwd = await repoWith({});
    const r = await init(cwd);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Detected: nothing Sponson manages; wrote the Vercel + Neon template");
    expect(r.stdout).toMatch(/To fill in:\n {2}providers\.vercel\.project .*\n {2}providers\.neon\.project /);
    const { text, ids } = await writtenPlan(cwd);
    expect(ids).toEqual(["db", "env"]);
    expect(text).toContain("so this is the template");
    await rm(join(cwd, "release.plan.yaml"));
    const j = await init(cwd, "--json");
    expect(j.json.detected).toEqual({ found: [], unsupported: [], todo: [expect.objectContaining({ path: "providers.vercel.project" }), expect.objectContaining({ path: "providers.neon.project" })], assumed: true });
  });

  it("a secret value in .env.local never appears in the written plan or in any output", async () => {
    for (const files of [NEXT_VERCEL_NEON_CLERK, NEXT_VERCEL_SUPABASE]) {
      for (const args of [[], ["--json"]]) {
        const cwd = await repoWith(files);
        const r = await init(cwd, ...args);
        expect(r.code).toBe(0);
        const plan = await readFile(join(cwd, "release.plan.yaml"), "utf8");
        for (const secret of [SECRET_PASSWORD, SECRET_CLERK, SECRET_SUPABASE, "neondb_owner", "ep-quiet-sky"]) {
          expect(plan, `${secret} leaked into the plan`).not.toContain(secret);
          expect(r.stdout + r.stderr, `${secret} leaked into the output`).not.toContain(secret);
        }
        await ws!.cleanup();
      }
    }
  });

  it("an existing plan is never rewritten by detection: `detected` is null", async () => {
    const cwd = await repoWith(NEXT_VERCEL_NEON_CLERK);
    await init(cwd);
    const before = (await readFile(join(cwd, "release.plan.yaml"), "utf8")).replace('"proj_xxx"', '"proj_demo"');
    await writeFile(join(cwd, "release.plan.yaml"), before);
    sim = await startSim();
    const r = await runCli(["init", "--json", "--branch", "feat/x", "--sha", SHA, "--pr", "42", "--receipts", "local"], { env: cliEnv(sim), cwd });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json).toMatchObject({ created: false, detected: null });
    expect(await readFile(join(cwd, "release.plan.yaml"), "utf8")).toBe(before);
  });
});
