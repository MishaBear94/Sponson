/**
 * Stack detection and the starter plan composed from it, over in-memory repositories (one fixture per stack).
 * Every composed plan must parse and validate against the JSON Schema, and no value from an `.env` file may
 * appear anywhere in what detection returns.
 */
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { parsePlan } from "@sponson/core";
import { detectStack, scanEnvFile, type RepoReader, type StackDetection } from "./stack.js";
import { composeStarter, credentialsFor } from "./starter.js";

const schema = JSON.parse(await readFile(new URL("../../../schema/release.plan.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
const validate = new Ajv2020({ allErrors: true, strict: true, strictTypes: false }).compile(schema);

function repo(files: Record<string, string | object>): RepoReader {
  return { read: async (p) => (p in files ? (typeof files[p] === "string" ? (files[p] as string) : JSON.stringify(files[p])) : null) };
}

const pkg = (dependencies: Record<string, string>, devDependencies: Record<string, string> = {}) => ({ dependencies, devDependencies });
const ids = (d: StackDetection) => d.found.map((f) => f.id);
const unsupportedIds = (d: StackDetection) => d.unsupported.map((f) => f.id);

/** The composed plan parses, validates against the schema, and has these line ids. */
function expectValidPlan(d: StackDetection, lineIds: string[]): string {
  const { text } = composeStarter(d);
  const { plan } = parsePlan(text);
  expect(plan.changes.map((c) => c.id)).toEqual(lineIds);
  expect(validate(parseYaml(text)), JSON.stringify(validate.errors)).toBe(true);
  return text;
}

const SECRET_PASSWORD = "hunter2-db-password-7f3a";
const SECRET_CLERK = "sk_test_clerk-secret-value-9c1e";

describe("detectStack", () => {
  it("Next.js + Vercel + Neon + Clerk + Prisma: real ids from .vercel/project.json, DATABASE_URL from the Prisma schema", async () => {
    const d = await detectStack(
      repo({
        "package.json": pkg({ next: "15.0.0", "@neondatabase/serverless": "1", "@clerk/nextjs": "6", "@prisma/client": "6" }, { prisma: "6" }),
        ".vercel/project.json": { projectId: "prj_web123", orgId: "team_acme" },
        "prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
        ".env.local": `DATABASE_URL="postgresql://app:${SECRET_PASSWORD}@ep-cool-1.us-east-2.aws.neon.tech/neondb?sslmode=require"\nCLERK_SECRET_KEY=${SECRET_CLERK}\n`,
      }),
    );
    expect(ids(d)).toEqual(["vercel", "neon", "clerk", "next", "prisma"]);
    expect(d.ids).toMatchObject({ vercelProject: "prj_web123", vercelTeam: "team_acme", vercelProjectFrom: ".vercel/project.json" });
    expect(d.ids.neonProject).toBeUndefined();
    expect(d).toMatchObject({ databaseVar: "DATABASE_URL", databaseVarFrom: "prisma/schema.prisma", publicPrefix: "NEXT_PUBLIC_", vercelAutoDeployOff: false });
    expect(d.found.find((f) => f.id === "neon")!.evidence).toContain("DATABASE_URL in .env.local points at *.neon.tech");
    // names and providers only: nothing read from a value comes out, not even the host
    const all = JSON.stringify(d);
    for (const leak of [SECRET_PASSWORD, SECRET_CLERK, "ep-cool-1", "app:"]) expect(all).not.toContain(leak);

    const text = expectValidPlan(d, ["db", "env", "callback"]);
    expect(text).toContain('vercel: { project: "prj_web123", team: "team_acme" }   # from .vercel/project.json');
    expect(text).toMatch(/neon: \{ project: "proj_xxx" \}\s+# TODO: run `neonctl projects list`/);
    expect(text).toContain("DATABASE_URL: { from: db.connection_string }");
    expect(text).toContain("url: { from: env.preview_url }");
    for (const leak of [SECRET_PASSWORD, SECRET_CLERK, "ep-cool-1"]) expect(text).not.toContain(leak);
    expect(composeStarter(d).todos.map((t) => t.path)).toEqual(["providers.neon.project"]);
    expect(credentialsFor(d)).toEqual(["VERCEL_TOKEN", "NEON_API_KEY", "CLERK_SECRET_KEY"]);
  });

  it("Next.js + Vercel + Supabase: Supabase is reported as not supported yet, and the plan has no database line", async () => {
    const d = await detectStack(
      repo({
        "package.json": pkg({ next: "15", "@supabase/supabase-js": "2", "@supabase/ssr": "0" }),
        "vercel.json": { framework: "nextjs" },
        ".env.example": "NEXT_PUBLIC_SUPABASE_URL=\nNEXT_PUBLIC_SUPABASE_ANON_KEY=\nDATABASE_URL=postgresql://postgres:pw@db.abcd.supabase.co:5432/postgres\n",
      }),
    );
    expect(ids(d)).toEqual(["vercel", "next"]);
    expect(unsupportedIds(d)).toEqual(["supabase"]);
    const supa = d.unsupported[0]!;
    expect(supa.evidence).toEqual(expect.arrayContaining(["package.json: @supabase/supabase-js", "DATABASE_URL in .env.example points at *.supabase.co"]));
    expect(supa.pointer).toMatch(/ROADMAP\.md/);
    const text = expectValidPlan(d, ["env"]);
    expect(text).toContain('NEXT_PUBLIC_SPONSON_SCOPE: "${ctx.scope}"');
    expect(text).toMatch(/# Not supported yet, so no line below manages it: Supabase/);
    expect(text).toMatch(/vercel: \{ project: "prj_xxx" \}\s+# TODO: run `vercel link`/);
    expect(text).not.toContain("neon");
  });

  it("a bare repository: nothing detected, the Vercel + Neon template with both ids to fill in", async () => {
    const d = await detectStack(repo({}));
    expect(d.found).toEqual([]);
    expect(d.unsupported).toEqual([]);
    const s = composeStarter(d);
    expect(s.assumed).toBe(true);
    expect(s.todos.map((t) => t.path)).toEqual(["providers.vercel.project", "providers.neon.project"]);
    const text = expectValidPlan(d, ["db", "env"]);
    expect(text).toContain("Nothing Sponson manages (Vercel, Neon, PlanetScale) was detected");
    expect(text).toContain("DATABASE_URL: { from: db.connection_string }");
  });

  it("ids from the process environment win over the files, as init always did; `.neon` holds the Neon project", async () => {
    const r = repo({ ".vercel/project.json": { projectId: "prj_file", orgId: "team_file" }, ".neon": { projectId: "proj_from_context" } });
    expect((await detectStack(r)).ids).toMatchObject({ vercelProject: "prj_file", neonProject: "proj_from_context", neonProjectFrom: ".neon" });
    const d = await detectStack(r, { VERCEL_PROJECT_ID: "prj_env", VERCEL_ORG_ID: "team_env", NEON_PROJECT_ID: "proj_env" });
    expect(d.ids).toEqual({ vercelProject: "prj_env", vercelProjectFrom: "VERCEL_PROJECT_ID", vercelTeam: "team_env", neonProject: "proj_env", neonProjectFrom: "NEON_PROJECT_ID" });
    const s = composeStarter(d);
    expect(s.todos).toEqual([]);
    expect(s.text).toContain('neon: { project: "proj_env" }   # from NEON_PROJECT_ID');
  });

  it("only the process environment: VERCEL_PROJECT_ID and NEON_PROJECT_ID count as detection", async () => {
    const d = await detectStack(repo({}), { VERCEL_PROJECT_ID: "prj_demo", NEON_PROJECT_ID: "proj_demo" });
    expect(ids(d)).toEqual(["vercel", "neon"]);
    expect(composeStarter(d).assumed).toBe(false);
  });

  it("Drizzle with POSTGRES_URL names the variable after the config; SvelteKit uses PUBLIC_", async () => {
    const d = await detectStack(
      repo({
        "package.json": pkg({ "@sveltejs/kit": "2", "drizzle-orm": "0.30", "@neondatabase/serverless": "1" }),
        "drizzle.config.ts": 'export default { dbCredentials: { url: process.env.POSTGRES_URL! } };\n',
      }),
    );
    expect(ids(d)).toEqual(["neon", "sveltekit", "drizzle"]);
    expect(d).toMatchObject({ databaseVar: "POSTGRES_URL", databaseVarFrom: "drizzle.config.ts", publicPrefix: "PUBLIC_" });
    // Neon without Vercel: the database line, and a note that its connection string has nowhere to go yet
    const text = expectValidPlan(d, ["db"]);
    expect(text).toContain("has no deploy target Sponson manages yet");
    expect(credentialsFor(d)).toEqual(["NEON_API_KEY"]);
  });

  it("the database variable falls back to the names in .env files: POSTGRES_URL when there is no DATABASE_URL", async () => {
    const d = await detectStack(repo({ "package.json": pkg({ nuxt: "3" }), ".env.example": "export POSTGRES_URL='postgres://x@ep-a.neon.tech/db'\nNUXT_PUBLIC_SITE=1\n" }));
    expect(ids(d)).toEqual(["neon", "nuxt"]);
    expect(d).toMatchObject({ databaseVar: "POSTGRES_URL", databaseVarFrom: ".env.example", publicPrefix: "NUXT_PUBLIC_" });
  });

  it("vercel.json with automatic deployments off: a deploy line, and the Clerk callback reads the deploy's URL", async () => {
    const d = await detectStack(repo({ "package.json": pkg({ "@remix-run/node": "2", "@clerk/remix": "4" }), "vercel.json": { git: { deploymentEnabled: false } } }));
    expect(ids(d)).toEqual(["vercel", "clerk", "remix"]);
    expect(d.vercelAutoDeployOff).toBe(true);
    const text = expectValidPlan(d, ["env", "deploy", "callback"]);
    expect(text).toContain("url: { from: deploy.preview_url }");
    expect(text).toContain('SPONSON_SCOPE: "${ctx.scope}"');
  });

  it("LaunchDarkly with Vercel: a commented flag line on the preview URL that, filled in and uncommented, validates", async () => {
    const d = await detectStack(repo({ "package.json": pkg({ next: "15", "@launchdarkly/node-server-sdk": "9" }), ".vercel/project.json": { projectId: "prj_web" }, ".env.example": "LAUNCHDARKLY_SDK_KEY=\n" }));
    expect(ids(d)).toEqual(["vercel", "launchdarkly", "next"]);
    expect(d.found.find((f) => f.id === "launchdarkly")!.evidence).toEqual(["package.json: @launchdarkly/node-server-sdk", "LAUNCHDARKLY_SDK_KEY in .env.example"]);
    expect(unsupportedIds(d)).toEqual([]);
    expect(credentialsFor(d)).toEqual(["VERCEL_TOKEN"]); // the flag line is a comment until the user fills it in
    const text = expectValidPlan(d, ["env"]);
    expect(text).toContain("#   key: { from: env.preview_url }");
    expect(text).not.toContain("Not supported yet");
    const filled = uncommentFlagLine(text);
    expect(parsePlan(filled).plan.changes.map((c) => [c.id, c.adapter, c.op])).toEqual([["env", "vercel", "env"], ["flag", "launchdarkly", "flag_target"]]);
    expect(validate(parseYaml(filled)), JSON.stringify(validate.errors)).toBe(true);
  });

  it("LaunchDarkly without Vercel (the template assumes it); with a deploy line, the key reads the deploy's URL", async () => {
    const alone = composeStarter(await detectStack(repo({ "package.json": pkg({ "launchdarkly-js-client-sdk": "3" }) }))).text;
    expect(alone).toContain("#   key: { from: env.preview_url }");
    const deploy = await detectStack(repo({ "package.json": pkg({ "@launchdarkly/react-client-sdk": "3" }), "vercel.json": { git: { deploymentEnabled: false } } }));
    expect(expectValidPlan(deploy, ["env", "deploy"])).toContain("#   key: { from: deploy.preview_url }");
    const neonOnly = await detectStack(repo({ "package.json": pkg({ "@neondatabase/serverless": "1", "@launchdarkly/node-server-sdk": "9" }) }));
    const text = expectValidPlan(neonOnly, ["db"]);
    expect(text).toContain("key: defaults to the scope (pr-42)");
    expect(validate(parseYaml(uncommentFlagLine(text))), JSON.stringify(validate.errors)).toBe(true);
  });

  it("Clerk alone: the template, with the callback line", async () => {
    const d = await detectStack(repo({ ".env.example": "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=\nCLERK_SECRET_KEY=\n" }));
    expect(ids(d)).toEqual(["clerk"]);
    expect(composeStarter(d).assumed).toBe(true);
    expectValidPlan(d, ["db", "env", "callback"]);
  });

  it("Clerk and Neon without Vercel: no callback line, said in a comment", async () => {
    const d = await detectStack(repo({ "package.json": pkg({ "@clerk/clerk-js": "5", "@neondatabase/serverless": "1" }) }));
    const text = expectValidPlan(d, ["db"]);
    expect(text).toContain("Clerk was detected, but a redirect line needs a preview URL");
  });

  it("every unsupported service is reported, never silently ignored", async () => {
    const d = await detectStack(
      repo({
        "package.json": pkg({ "@auth0/nextjs-auth0": "3", "@launchdarkly/node-server-sdk": "9", "posthog-js": "1", stripe: "16", "@sentry/nextjs": "8", firebase: "10", "@libsql/client": "0.6" }, { wrangler: "3" }),
        "netlify.toml": "[build]\n",
        "fly.toml": "app = 'x'\n",
        "railway.json": "{}",
      }),
    );
    expect(unsupportedIds(d)).toEqual(["turso", "auth0", "netlify", "cloudflare", "railway", "fly", "firebase", "posthog", "stripe", "sentry"]);
    for (const u of d.unsupported) expect(u.pointer, u.id).toMatch(/ROADMAP\.md|issues/);
    const text = expectValidPlan(d, ["db", "env"]);
    for (const u of d.unsupported) expect(text).toContain(`# Not supported yet, so no line below manages it: ${u.name}`);
  });

  it("Next.js + Vercel + PlanetScale + Prisma: a branch, a password on it, and DATABASE_URL from its connection string", async () => {
    const d = await detectStack(
      repo({
        "package.json": pkg({ next: "15", "@planetscale/database": "1", "@prisma/client": "6" }),
        ".vercel/project.json": { projectId: "prj_web123" },
        ".env.example": `DATABASE_URL=mysql://u:${SECRET_PASSWORD}@aws.connect.psdb.cloud/db\nPLANETSCALE_SERVICE_TOKEN=\n`,
      }),
    );
    expect(ids(d)).toEqual(["vercel", "planetscale", "next", "prisma"]);
    expect(unsupportedIds(d)).toEqual([]);
    expect(d.found.find((f) => f.id === "planetscale")!.evidence).toEqual([
      "package.json: @planetscale/database",
      "PLANETSCALE_SERVICE_TOKEN in .env.example",
      "DATABASE_URL in .env.example points at *.psdb.cloud",
    ]);
    expect(JSON.stringify(d)).not.toContain(SECRET_PASSWORD);

    const text = expectValidPlan(d, ["db", "dbpw", "env"]);
    expect(text).toMatch(/planetscale: \{ organization: "my-org", database: "my-db" \}\s+# TODO: the name slugs of your organization and database/);
    expect(text).toContain("adapter: planetscale\n    op: branch");
    expect(text).toContain("branch: { from: db.name }");
    expect(text).toContain('connection_params: "sslaccept=strict"');
    expect(text).toContain("DATABASE_URL: { from: dbpw.connection_string }");
    expect(text).not.toMatch(/neon|Not supported yet/);
    expect(composeStarter(d).todos.map((t) => t.path)).toEqual(["providers.planetscale.organization", "providers.planetscale.database"]);
    expect(credentialsFor(d)).toEqual(["VERCEL_TOKEN", "PLANETSCALE_SERVICE_TOKEN_ID", "PLANETSCALE_SERVICE_TOKEN"]);
  });

  it("PlanetScale without Vercel: no connection_params without Prisma, and the missing deploy target said in a comment", async () => {
    const d = await detectStack(repo({ "package.json": pkg({ "@planetscale/database": "1" }) }));
    const text = expectValidPlan(d, ["db", "dbpw"]);
    expect(text).not.toContain("connection_params");
    expect(text).toContain("# The password's connection string (`{ from: dbpw.connection_string }`) has no deploy target");
  });

  it("Neon and PlanetScale both: the database lines use Neon, and PlanetScale is mentioned, not dropped", async () => {
    const d = await detectStack(repo({ "package.json": pkg({ "@neondatabase/serverless": "1", "@planetscale/database": "1" }), "vercel.json": {} }));
    const text = expectValidPlan(d, ["db", "env"]);
    expect(text).toContain("DATABASE_URL: { from: db.connection_string }");
    expect(text).toContain("# PlanetScale was detected too, but the database lines below use Neon");
  });

  it("broken files are no signal rather than a crash", async () => {
    const d = await detectStack(repo({ "package.json": "{ not json", ".vercel/project.json": "[]", "vercel.json": "nope", ".neon": '{"projectId": 3}' }));
    expect(ids(d)).toEqual(["vercel", "neon"]); // the files exist, but hold no ids
    expect(d.ids).toEqual({});
    expect(d.vercelAutoDeployOff).toBe(false);
  });
});

/** The starter's commented LaunchDarkly example, as a user would fill it in: a provider block and the line uncommented. */
function uncommentFlagLine(text: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf("  # - id: flag");
  expect(start).toBeGreaterThan(0);
  for (let i = start; lines[i]!.startsWith("  # "); i++) lines[i] = `  ${lines[i]!.slice(4)}`.replace("<flag key>", "new-checkout");
  const filled = lines.join("\n");
  return filled.includes("providers:\n") ? filled.replace("providers:\n", "providers:\n  launchdarkly: { project: web, environment: preview }\n") : filled.replace("changes:", "providers:\n  launchdarkly: { project: web, environment: preview }\nchanges:");
}

describe("scanEnvFile", () => {
  it("returns names, and for a database URL only the provider its host belongs to", () => {
    const text = [
      "# a comment",
      `DATABASE_URL="postgresql://u:${SECRET_PASSWORD}@ep-x.eu-central-1.aws.neon.tech/neondb"`,
      "export DIRECT_URL='postgres://u:p@db.ref.supabase.co:5432/postgres'",
      "TURSO_DATABASE_URL=libsql://db-org.turso.io",
      "OTHER_URL=postgres://u:p@localhost:5432/db",
      "BROKEN_URL=postgres://[::",
      `CLERK_SECRET_KEY=${SECRET_CLERK}`,
      "not a variable",
    ].join("\n");
    const out = scanEnvFile(text);
    expect(out).toEqual([
      { name: "DATABASE_URL", provider: "neon" },
      { name: "DIRECT_URL", provider: "supabase" },
      { name: "TURSO_DATABASE_URL", provider: "turso" },
      { name: "OTHER_URL" },
      { name: "BROKEN_URL" },
      { name: "CLERK_SECRET_KEY" },
    ]);
    expect(JSON.stringify(out)).not.toContain(SECRET_PASSWORD);
  });
});
