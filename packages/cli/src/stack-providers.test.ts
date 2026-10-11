/**
 * Providers detected from data: first-class adapters' `about.detect` and recipes' `detect` blocks. Every provider
 * that declares one is found from its first signal alone and gets a line that validates once its TODOs are filled
 * in; a recipe added with a `detect` block is detected with no change to the CLI; and detection never reads a value.
 */
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { parsePlan, type ProviderDetect } from "@sponson/core";
import { createRegistry, detectableProviders, expandRecipe, loadRecipe, loadRecipes, type Recipe } from "@sponson/adapters";
import { builtinProviders, detectStack, envMatches, UNSUPPORTED, type RepoReader, type StackDetection } from "./stack.js";
import { composeStarter, credentialsFor, planTodos } from "./starter.js";

const schema = JSON.parse(await readFile(new URL("../../../schema/release.plan.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
const validate = new Ajv2020({ allErrors: true, strict: true, strictTypes: false }).compile(schema);

function repo(files: Record<string, string | object>): RepoReader {
  return { read: async (p) => (p in files ? (typeof files[p] === "string" ? (files[p] as string) : JSON.stringify(files[p])) : null) };
}

const pkg = (dependencies: Record<string, string>) => ({ dependencies });
const ids = (d: StackDetection) => d.found.map((f) => f.id);

const SECRET_PASSWORD = "hunter2-db-password-7f3a";
const SECRET_STRIPE = "sk_test_stripe-secret-value-4b2d";
const SECRET_AUTH0 = "auth0-client-secret-value-8e7f";

/** The composed plan parses, validates against the schema, and has these (uncommented) line ids. */
function expectValidPlan(d: StackDetection, lineIds: string[]): string {
  const { text } = composeStarter(d);
  expect(parsePlan(text).plan.changes.map((c) => c.id)).toEqual(lineIds);
  expect(validate(parseYaml(text)), JSON.stringify(validate.errors)).toBe(true);
  return text;
}

/** A commented line of the starter, uncommented; undefined for a line that is not part of a commented plan line. */
function uncommented(line: string, previous: string | undefined): string | undefined {
  const m = /^ {2}# ( {0,2}(- id: |[a-z_]+: ).*)$/.exec(line);
  if (!m) return undefined;
  const inLine = previous !== undefined && (previous.startsWith("  - id: ") || previous.startsWith("    "));
  return m[1]!.startsWith("- id: ") || inLine ? `  ${m[1]!}` : undefined;
}

/** A `"<param>"` placeholder replaced by the recipe's example for that param. */
function filled(line: string, recipe: Recipe | undefined): string {
  const ph = /^( {4}([a-z_]+): )"<[a-z_]+>"/.exec(line);
  if (!ph || !recipe) return line;
  const op = Object.values(recipe.ops).find((o) => o.params[ph[2]!]?.example !== undefined)!;
  return `${ph[1]}${JSON.stringify(op.params[ph[2]!]!.example)}`;
}

/**
 * The starter as a user finishes it: every commented recipe line uncommented, each `"<param>"` placeholder replaced
 * by the recipe's example for that param, and each per-account provider block added under `providers:`.
 */
function finishRecipeLines(text: string): string {
  const blocks: string[] = [];
  const out: string[] = [];
  let recipe: Recipe | undefined;
  for (const line of text.replace(/^changes: \[\].*$/m, "changes:").split("\n")) {
    const block = /^ {2}# {3}http: \{ ([a-z0-9_]+): \{ recipe: [a-z0-9_]+, base_url: "<base_url>" \} \}/.exec(line);
    if (block) blocks.push(`    ${block[1]}: { recipe: ${block[1]}, base_url: ${JSON.stringify(loadRecipe(block[1]!).base_url_example)} }`);
    const body = uncommented(line, out.at(-1));
    if (body === undefined) {
      out.push(line);
      continue;
    }
    const ref = /^ {4}recipe: ([a-z0-9_]+)\.[a-z0-9_]+$/.exec(body);
    if (ref) recipe = loadRecipe(ref[1]!);
    out.push(filled(body, recipe));
  }
  const text2 = out.join("\n");
  if (blocks.length === 0) return text2;
  const http = `  http:\n${blocks.join("\n")}\n`;
  return text2.includes("\nproviders:\n") ? text2.replace("\nproviders:\n", `\nproviders:\n${http}`) : text2.replace("\nchanges:", `\nproviders:\n${http}changes:`);
}

/** Every recipe line of a plan expands against its recipe (params known, typed, matching their patterns); how many. */
function expectRecipeLinesExpand(text: string): number {
  const { plan } = parsePlan(text);
  expect(validate(parseYaml(text)), JSON.stringify(validate.errors)).toBe(true);
  let n = 0;
  for (const c of plan.changes) {
    if (c.params.recipe === undefined) continue;
    expect(() => expandRecipe(c.params, c.op as "resource"), c.id).not.toThrow();
    n++;
  }
  return n;
}

/** A repository whose only signal of a provider is the first one its `detect` declares, beside a linked Vercel project. */
function oneSignalRepo(detect: ProviderDetect): Record<string, string | object> {
  const files: Record<string, string | object> = { ".vercel/project.json": { projectId: "prj_web" } };
  if (detect.deps?.length) files["package.json"] = pkg({ [detect.deps[0]!.replace(/\/$/, "/sdk")]: "1" });
  else if (detect.files?.length) files[detect.files[0]!] = "{}";
  else if (detect.env?.length) files[".env.example"] = `${detect.env[0]!.replace(/\*$/, "ANYTHING")}=\n`;
  else files[".env.local"] = `DATABASE_URL=postgres://u:p@db${detect.dbHosts![0]}/app\n`;
  return files;
}

describe("detection from data", () => {
  it("every provider that declares `detect` is found from its first signal alone, and init writes a line for it that validates once filled in", async () => {
    const providers = await builtinProviders();
    expect(providers.filter((p) => p.via === "recipe").length).toBeGreaterThan(30);
    for (const p of providers) {
      const d = await detectStack(repo(oneSignalRepo(p.detect)), {}, providers);
      expect(d.found.find((f) => f.kind === "provider" && f.id === p.id), p.id).toMatchObject({ name: p.title, via: p.via });
      const { text } = composeStarter(d);
      expect(validate(parseYaml(text)), `${p.id}: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect(() => parsePlan(text), p.id).not.toThrow();
      if (p.via !== "recipe") continue;
      const starters = p.recipe!.detect!.starter ?? [{ op: Object.keys(p.recipe!.ops)[0]! }];
      for (const st of starters) expect(text, p.id).toMatch(new RegExp(`^ {2}(# )?- id: ${p.id}_${st.op}$`, "m"));
      expect(expectRecipeLinesExpand(finishRecipeLines(text)), p.id).toBe(starters.length);
      expect(credentialsFor(d), p.id).toEqual(expect.arrayContaining(p.credentials));
    }
  });

  it("Next.js + Vercel + Neon + Stripe + Inngest + Auth0: ready recipe lines on the preview URL, commented Auth0 lines with their TODOs", async () => {
    const d = await detectStack(
      repo({
        "package.json": pkg({ next: "15", "@neondatabase/serverless": "1", stripe: "16", "@stripe/stripe-js": "4", inngest: "3", "@auth0/nextjs-auth0": "3" }),
        ".vercel/project.json": { projectId: "prj_web" },
        ".neon": { projectId: "proj_web" },
        ".env.local": `STRIPE_SECRET_KEY=${SECRET_STRIPE}\nAUTH0_CLIENT_SECRET=${SECRET_AUTH0}\nAUTH0_DOMAIN=acme.eu.auth0.com\n`,
      }),
    );
    expect(ids(d)).toEqual(["vercel", "neon", "auth0", "stripe", "inngest", "next"]);
    expect(d.found.find((f) => f.id === "stripe")!.evidence).toEqual(["package.json: stripe", "package.json: @stripe/stripe-js", "STRIPE_SECRET_KEY in .env.local"]);
    expect(JSON.stringify(d.found)).not.toContain(SECRET_STRIPE);
    const text = expectValidPlan(d, ["db", "env", "stripe_webhook_endpoint", "inngest_sync"]);
    expect(text).toContain('  - id: stripe_webhook_endpoint\n    adapter: http\n    op: resource\n    recipe: stripe.webhook_endpoint\n    name: "preview-${ctx.scope}"\n    url: { from: env.preview_url }');
    expect(text).toContain("    recipe: inngest.sync\n    url: { from: env.preview_url }");
    expect(text).toContain('    revision: "${ctx.git.sha}"');
    expect(text).toMatch(/# {3}http: \{ auth0: \{ recipe: auth0, base_url: "<base_url>" \} \} {3}# TODO: `https:\/\/<tenant>/);
    expect(text).toContain('  #   client_id: "<client_id>"   # TODO: Auth0 Dashboard → Applications');
    expect(text).toContain("  #   url: { from: env.preview_url }"); // the logout URL
    expect(text.match(/http: \{ auth0:/g)).toHaveLength(1);
    expect(expectRecipeLinesExpand(text)).toBe(2);
    for (const leak of [SECRET_STRIPE, SECRET_AUTH0, "acme.eu.auth0.com"]) expect(text).not.toContain(leak);
    expect(composeStarter(d).todos.map((t) => t.path)).toEqual(["changes.auth0_callback_url.client_id", "changes.auth0_callback_url.url", "providers.http.auth0.base_url", "changes.auth0_logout_url.client_id", "changes.stripe_webhook_endpoint.path"]);
    expect(credentialsFor(d)).toEqual(["VERCEL_TOKEN", "NEON_API_KEY", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "STRIPE_SECRET_KEY"]);
    expect(expectRecipeLinesExpand(finishRecipeLines(text))).toBe(4);
  });

  it("Netlify + PostHog + Resend + Sentry: ready lines from `${ctx.*}` values, the rest commented", async () => {
    const d = await detectStack(repo({ "package.json": pkg({ "posthog-js": "1", resend: "4", "@sentry/sveltekit": "8", "@sveltejs/kit": "2" }), "netlify.toml": "[build]\n", "sentry.properties": "defaults.org=acme\n" }));
    expect(ids(d)).toEqual(["netlify", "posthog", "resend", "sentry", "sveltekit"]);
    expect(composeStarter(d).assumed).toBe(false);
    const text = expectValidPlan(d, ["env", "resend_api_key"]);
    expect(text).toContain('    recipe: resend.api_key\n    name: "sponson-${ctx.env}-${ctx.scope}"');
    expect(text).toContain('  #   property: "$host"');
    expect(text).toContain('  #   version: "app@${ctx.git.sha}"');
    expect(text).not.toContain("acme"); // a value of sentry.properties is never read
    expect(expectRecipeLinesExpand(finishRecipeLines(text))).toBe(3);
  });

  it("a recipe provider with a preview URL param and no deploy target Sponson manages: commented, the TODO says why", async () => {
    const d = await detectStack(repo({ "package.json": pkg({ stripe: "16" }), "fly.toml": "app = 'web'\n" }));
    expect(ids(d)).toEqual(["fly", "stripe"]);
    const { text, todos } = composeStarter(d);
    expect(text).toMatch(/^changes: \[\]/m);
    expect(text).toContain("  #   url: \"<url>\"   # TODO: the preview's URL (no deploy target Sponson manages was detected to take it from)");
    expect(todos.map((t) => t.path)).toEqual(["changes.fly_secret.app", "changes.fly_secret.name", "changes.fly_secret.value", "changes.stripe_webhook_endpoint.url", "changes.stripe_webhook_endpoint.path"]);
    expect(expectRecipeLinesExpand(finishRecipeLines(text))).toBe(2);
    // No deploy target to take the endpoint's secret: no variables line, whatever the .env files name.
    expect(text).not.toContain("STRIPE_WEBHOOK_SECRET");
  });

  it("planTodos: what a plan still has, read back from its `# TODO` comments (a value counts as filled in once its comment is gone)", async () => {
    const d = await detectStack(repo({ "package.json": pkg({ "@neondatabase/serverless": "1", stripe: "16" }), ".vercel/project.json": { projectId: "prj_web" }, "fly.toml": "app = 'web'\n" }));
    const { text, todos } = composeStarter(d);
    // The starter's own text has exactly its TODOs, with their paths, including two sharing a placeholder line by line.
    expect(planTodos(text, todos)).toEqual(todos);
    // Filled in: the value replaced and its comment deleted.
    const filled = text.replace(/"proj_xxx" \}\s+# TODO:.*$/m, '"proj_real" }');
    expect(planTodos(filled, todos).map((t) => t.path)).not.toContain("providers.neon.project");
    // A value replaced but its comment kept still counts: the comment is what says it was checked.
    const half = text.replace('"proj_xxx"', '"proj_real"');
    expect(planTodos(half, todos)).toContainEqual(expect.objectContaining({ path: "line " + String(half.split("\n").findIndex((l) => l.includes("proj_real")) + 1) }));
    // A TODO the starter did not write is reported by its line and comment.
    expect(planTodos("version: 1\nchanges: []   # TODO: add a line\n", [])).toEqual([{ path: "line 2", placeholder: "", hint: "add a line" }]);
    expect(planTodos("version: 1\n# Fill in the TODOs, then uncomment:\n", [])).toEqual([]);
  });

  it("Stripe: the webhook path written with a TODO to check it, and the endpoint's secret wired to STRIPE_WEBHOOK_SECRET when .env* names it", async () => {
    const files = {
      "package.json": pkg({ next: "15", "@neondatabase/serverless": "1", stripe: "16" }),
      ".vercel/project.json": { projectId: "prj_web" },
      ".neon": { projectId: "proj_web" },
      ".env.example": `STRIPE_SECRET_KEY=${SECRET_STRIPE}\nSTRIPE_WEBHOOK_SECRET=whsec_from-a-file\n`,
    };
    const d = await detectStack(repo(files));
    const text = expectValidPlan(d, ["db", "env", "stripe_webhook_endpoint", "stripe_webhook_endpoint_env"]);
    // The whole URL the endpoint gets is in the line: the recipe's documented default path, marked to check.
    expect(text).toMatch(/^ {4}path: "\/api\/webhooks\/stripe" {3}# TODO: The path of the app's webhook handler/m);
    expect(composeStarter(d).todos).toContainEqual(expect.objectContaining({ path: "changes.stripe_webhook_endpoint.path", placeholder: "/api/webhooks/stripe" }));
    // The once-only signing secret reaches the app in the same run, by reference, under the name its .env file uses.
    expect(text).toContain(
      "  - id: stripe_webhook_endpoint_env\n    adapter: vercel\n    op: env\n    target: preview\n    values:\n      STRIPE_WEBHOOK_SECRET: { from: stripe_webhook_endpoint.secret }\n    environments: [preview]",
    );
    expect(text).toContain("(the name .env.example uses)");
    for (const leak of [SECRET_STRIPE, "whsec_from-a-file"]) expect(text).not.toContain(leak);
    expect(JSON.stringify(d)).not.toContain("whsec_from-a-file");
    // It plans: the reference resolves to a declared output, with no cycle through the preview URL.
    const { plan } = parsePlan(text);
    expect(plan.changes.find((c) => c.id === "stripe_webhook_endpoint_env")!.adapter).toBe("vercel");

    // Netlify: the same line on its variables (which have no `target`).
    const { ".vercel/project.json": _vercel, ...rest } = files;
    const netlify = await detectStack(repo({ ...rest, "netlify.toml": "[build]\n" }));
    const ntext = expectValidPlan(netlify, ["db", "env", "stripe_webhook_endpoint", "stripe_webhook_endpoint_env"]);
    expect(ntext).toContain("  - id: stripe_webhook_endpoint_env\n    adapter: netlify\n    op: env\n    values:\n      STRIPE_WEBHOOK_SECRET: { from: stripe_webhook_endpoint.secret }");

    // Without the name in any .env file, no variables line: nothing says the app reads one.
    const unnamed = await detectStack(repo({ ...files, ".env.example": `STRIPE_SECRET_KEY=${SECRET_STRIPE}\n` }));
    expectValidPlan(unnamed, ["db", "env", "stripe_webhook_endpoint"]);
  });

  it("a first-class adapter without a composed line (Algolia, Xata, DigitalOcean) gets a pointer to its ops, never silence", async () => {
    const d = await detectStack(repo({ "package.json": pkg({ algoliasearch: "5", "@xata.io/client": "0.30" }), ".do/app.yaml": "name: web\n", ".vercel/project.json": { projectId: "prj_web" } }));
    expect(ids(d)).toEqual(["vercel", "digitalocean", "xata", "algolia"]);
    const text = expectValidPlan(d, ["env"]);
    expect(text).toContain("  # Algolia was detected: its ops are in https://github.com/MishaBear94/Sponson/blob/main/docs/providers.md (ALGOLIA_API_KEY is read from the environment).");
    expect(text).toContain("  # Xata was detected");
    expect(text).toContain("  # DigitalOcean App Platform was detected");
  });

  it("a recipe that declares `detect` is detected with no change to the CLI", async () => {
    const recipe: Recipe = {
      ...loadRecipe("svix"),
      provider: "acmehooks",
      title: "Acme Hooks",
      detect: { env: ["ACME_HOOKS_*"], db_hosts: [".acmehooks.dev"], starter: [{ op: "endpoint", preview_url: "url", values: { uid: "x-${ctx.scope}", app_id: "app_1" } }] },
    };
    const providers = detectableProviders(createRegistry(), [...loadRecipes(), recipe]);
    const d = await detectStack(repo({ ".env.example": "NEXT_PUBLIC_ACME_HOOKS_KEY=\n", ".env.local": "DIRECT_URL=postgres://u:secret-pw@x.acmehooks.dev/db\n", "vercel.json": {} }), {}, providers);
    expect(d.found.find((f) => f.id === "acmehooks")).toEqual({ id: "acmehooks", name: "Acme Hooks", kind: "provider", via: "recipe", evidence: ["NEXT_PUBLIC_ACME_HOOKS_KEY in .env.example", "DIRECT_URL in .env.local points at *.acmehooks.dev"] });
    expect(JSON.stringify(d.found)).not.toContain("secret-pw");
    const { text } = composeStarter(d);
    expect(text).toContain('  - id: acmehooks_endpoint\n    adapter: http\n    op: resource\n    recipe: acmehooks.endpoint\n    app_id: "app_1"\n    uid: "x-${ctx.scope}"\n    url: { from: env.preview_url }');
  });

  it("detection reads names and files only: a provider's variable values and config file contents never come out", async () => {
    const files = {
      "package.json": pkg({ "@upstash/redis": "1", "@libsql/client": "0.6" }),
      ".env.local": `UPSTASH_REDIS_REST_TOKEN=${SECRET_STRIPE}\nTURSO_DATABASE_URL=libsql://app-acme.turso.io\nTURSO_AUTH_TOKEN=${SECRET_AUTH0}\nMONGO=mongodb+srv://u:${SECRET_PASSWORD}@cluster0.abc12.mongodb.net/app\n`,
      "fly.toml": "app = 'secret-app-name'\n",
    };
    const d = await detectStack(repo(files));
    expect(ids(d)).toEqual(["fly", "mongodb_atlas", "turso", "upstash"]);
    expect(d.found.find((f) => f.id === "mongodb_atlas")!.evidence).toEqual(["MONGO in .env.local points at *.mongodb.net"]);
    const all = JSON.stringify(d.found) + JSON.stringify(d.ids) + composeStarter(d).text;
    for (const leak of [SECRET_STRIPE, SECRET_AUTH0, SECRET_PASSWORD, "app-acme", "cluster0", "secret-app-name"]) expect(all).not.toContain(leak);
  });

  it("env patterns: exact or prefix, behind a framework's public prefix too", () => {
    expect(envMatches("STRIPE_SECRET_KEY", ["STRIPE_*"])).toBe(true);
    expect(envMatches("NEXT_PUBLIC_STRIPE_KEY", ["STRIPE_*"])).toBe(true);
    expect(envMatches("VITE_POSTHOG_KEY", ["POSTHOG_*"])).toBe(true);
    expect(envMatches("MY_STRIPE_KEY", ["STRIPE_*"])).toBe(false);
    expect(envMatches("GITHUB_WEBHOOK_SECRET", ["GITHUB_WEBHOOK_SECRET"])).toBe(true);
    expect(envMatches("GITHUB_TOKEN", ["GITHUB_WEBHOOK_SECRET"])).toBe(false);
  });

  it("no service is both supported and listed as not supported, and no two providers share an id", async () => {
    const providers = await builtinProviders();
    const provided = new Set(providers.map((p) => p.id));
    expect(provided.size).toBe(providers.length);
    for (const u of UNSUPPORTED) expect(provided.has(u.id), u.id).toBe(false);
    for (const u of UNSUPPORTED) expect(providers.map((p) => p.title.toLowerCase()), u.id).not.toContain(u.name.toLowerCase());
  });
});
