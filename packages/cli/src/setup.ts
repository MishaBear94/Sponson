/**
 * `sponson init --setup`: from a plan to a first real apply in one guided run on the user's own machine. For every
 * provider the plan uses it shows where the token is created and the least it needs, reads the token from the
 * environment or asks for it (hidden input, a terminal only), checks it with one read-only request, then offers to
 * store it as a GitHub Actions secret with the user's own `gh` and to write the workflow that uses it.
 *
 * A token is registered with the command's redactor the moment it is read, before any request carries it, so it is
 * masked in every byte printed, in the JSON report and in gh's error text. It is never written to a file, never put
 * in argv or a child's environment, and only ever leaves this process on the stdin of `gh secret set`, after an
 * explicit yes (or `--yes`).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { GitBranchReceiptStore, SponsonError, isSecretRef, loadPlan, walkParams, type AdapterContext, type CredentialCheck, type Ctx, type Plan, type Redactor, type Registry } from "@sponson/core";
import type * as AdaptersModule from "@sponson/adapters";
import type { DetectableProvider, Recipe } from "@sponson/adapters";
import type { IO } from "./context.js";
import { childEnv, ghSecretSet, githubRepoOf } from "./gh.js";
import type { Terminal } from "./terminal.js";
import { VERSION } from "./version.js";
import { WORKFLOW_PATH, releaseTag, renderWorkflow, resolveTagCommit } from "./workflow.js";
import { todoLines, type Todo } from "./starter.js";

/** How one credential stands after setup. */
export type CredentialStatus =
  /** Checked: the provider accepted it (and it reaches the project the plan names, when it names one). */
  | "ok"
  /** Accepted as a credential, but without the permission or the project the plan needs (403, or 404 on the project). */
  | "wrong_scope"
  /** Rejected (401): mistyped, revoked or expired. */
  | "unauthorized"
  /** The check could not tell (the provider unreachable, the plan incomplete): see `message`. */
  | "error"
  /** No value: not in the environment, and nobody typed one. */
  | "missing"
  /** A value, but no read-only request to check it with (a recipe without one, a value the plan references). */
  | "unchecked"
  /** Authenticates with a CLI's own login (`gcloud auth print-access-token`): nothing to type or store. */
  | "login";

export interface SetupCredential {
  /** The adapter or recipe provider (`vercel`, `stripe`), or `plan` for the values the plan references with `env://`. */
  provider: string;
  title: string;
  /** Each variable and where its value came from. Never the value. */
  variables: Array<{ name: string; from: "environment" | "prompt" | "missing" }>;
  /** Where the credential is created, and the least it needs; null when the provider declares neither. */
  url: string | null;
  scope: string | null;
  status: CredentialStatus;
  /** The read-only request that checked it (`GET /v2/user`), and what it proved the credential reaches. */
  checked: string | null;
  reaches: string | null;
  message: string | null;
}

export interface SetupSecret {
  name: string;
  /** stored; declined (answered no); skipped (not checked ok, or no value); not-asked (no terminal and no --yes); no-repo; gh-missing; failed. */
  result: "stored" | "declined" | "skipped" | "not-asked" | "no-repo" | "gh-missing" | "failed";
  message: string | null;
}

export interface SetupReport {
  /** `owner/repo` of the GitHub origin the secrets go to; null when origin is not on GitHub. */
  repo: string | null;
  credentials: SetupCredential[];
  secrets: SetupSecret[];
  /** `todo`: not offered, because the plan still has TODOs (a workflow would run a plan that cannot work). */
  workflow: { path: string; result: "written" | "exists" | "declined" | "not-asked" | "todo"; tag: string; commit: string | null };
  /** The plan has no TODO left, and every credential is ok, unchecked or a login (none missing): the plan can run. */
  ready: boolean;
  /** What to do next, with the command: `sponson plan` when ready, otherwise what to fix first. */
  next: string;
}

export interface SetupOpts {
  /** Accept every offer (store each secret, write the workflow) without asking: for scripted use. */
  yes?: boolean;
  json?: boolean;
}

/** One credential the plan needs: whose, its variables, where to make it, and how to check it. */
interface Need {
  provider: string;
  title: string;
  variables: string[];
  command?: readonly string[];
  url?: string;
  scope?: string;
  /** The read-only check, given an adapter context whose `env` carries the values. */
  verify?: (actx: AdapterContext) => Promise<CredentialCheck>;
}

/** What setup runs with. */
export interface SetupContext {
  io: IO;
  redactor: Redactor;
  terminal: Terminal;
  opts: SetupOpts;
  planPath: string;
  /** Providers detected by a starter written in this run, whose lines may still be commented out. */
  detected?: Array<{ id: string; via?: "adapter" | "recipe" }>;
  /** The TODOs the plan still has (`planTodos`): listed first, and no workflow is offered while there are any. */
  todos?: Todo[];
}

/** Where setup's progress goes: each argument one line. */
export type Say = (...lines: string[]) => void;

/** The variable names an environment variable may have; anything else (`none (…)`, a plan path) is not one. */
const VAR_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** The command that starts the zero-account demo (README "Try it in 60 seconds"; scenarios/docs keeps the two equal). */
export const DEMO_COMMAND = "npx --yes @sponson/sim --demo sponson-demo";

/** Run setup: collect, check, store, write. Human progress goes to `say`. */
export async function runSetup(c: SetupContext, say: Say): Promise<SetupReport> {
  const registry = await c.io.createRegistry();
  const plan = relative(c.io.cwd, c.planPath) || c.planPath;
  const todos = c.todos ?? [];
  // What the plan still needs from a person comes first: a credential checked against a placeholder proves nothing.
  if (todos.length) say(`To fill in first (${todos.length} TODO${todos.length === 1 ? "" : "s"} in ${plan}):`, ...todoLines(todos), "");
  const needs = await gatherNeeds(c.planPath, registry, c.detected ?? []);
  say(needs.length ? `Credentials for ${plan}:` : "This plan needs no credentials.");
  const values = new Map<string, string>();
  const credentials: SetupCredential[] = [];
  for (const need of needs) credentials.push(await setUpOne(c, need, values, say));
  const repo = githubRepoOf(await GitBranchReceiptStore.originOf(c.io.cwd));
  const secrets = await storeSecrets(c, credentials, values, repo, say);
  const workflow = await writeWorkflow(c, needs, todos.length, plan, say);
  const credentialsOk = credentials.every((x) => ["ok", "unchecked", "login"].includes(x.status));
  const ready = credentialsOk && todos.length === 0;
  const next = nextStep(todos.length, credentialsOk, plan);
  say("", ready ? `Ready: ${next}` : `Not ready yet: ${next}`);
  if (!ready) say(`To try Sponson first without any account, against a local fake cloud: \`${DEMO_COMMAND}\``);
  return { repo, credentials, secrets, workflow, ready, next };
}

/** What to do next, in order: the TODOs, then the credentials, then the first plan. */
function nextStep(todos: number, credentialsOk: boolean, plan: string): string {
  const fix = [todos ? `fill in the TODO${todos === 1 ? "" : "s"} in ${plan} (and delete each \`# TODO\` comment)` : "", credentialsOk ? "" : "fix the credentials above"].filter(Boolean);
  if (fix.length === 0) return "run `sponson plan`.";
  return `${fix.join(", and ")}, then run \`sponson init --setup\` again and \`sponson plan\`.`;
}

// ---------------------------------------------------------------------------
// What the plan needs
// ---------------------------------------------------------------------------

/** A Ctx for checks: they read only, and touch nothing a scope owns. */
const SETUP_CTX: Ctx = { env: "preview", git: { branch: "setup", sha: "0".repeat(40), short_sha: "0000000" }, pr: { number: null }, scope: "setup" };

/**
 * Every credential the plan needs, in the order its lines name them: each adapter's, each recipe API's, and the values
 * the plan references with `env://`; then the providers a starter just detected whose lines wait on TODOs.
 */
export async function gatherNeeds(planPath: string, registry: Registry, detected: Array<{ id: string; via?: "adapter" | "recipe" }>): Promise<Need[]> {
  const adapters = await import("@sponson/adapters");
  const text = await readFile(planPath, "utf8");
  const { plan } = await loadPlan(planPath);
  const blocks = providerBlocks(plan, text);
  const needs = new Map<string, Need>();
  const add = (n: Need | undefined) => {
    if (n && !needs.has(n.provider)) needs.set(n.provider, n);
  };
  for (const change of plan.changes) {
    if (change.adapter === "http") add(httpNeed(adapters, change.params, blocks.http ?? {}));
    else add(adapterNeed(registry, change.adapter, blocks[change.adapter] ?? {}));
  }
  const providers = adapters.detectableProviders(registry);
  for (const d of detected) add(detectedNeed(adapters, registry, providers.find((p) => p.id === d.id), blocks));
  add(planSecretsNeed(plan, [...needs.values()].flatMap((n) => n.variables)));
  return [...needs.values()];
}

/** The plan's provider blocks, without the placeholders a starter left (`proj_xxx` on a line marked `# TODO`). */
function providerBlocks(plan: Plan, text: string): Record<string, Record<string, unknown>> {
  const todo = text.split(/\r?\n/).filter((l) => l.includes("# TODO"));
  const placeholder = (v: unknown) => typeof v === "string" && (/^<.*>$/.test(v) || todo.some((l) => l.includes(v)));
  const clean = (block: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(block).filter(([, v]) => !placeholder(v)).map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) ? clean(v as Record<string, unknown>) : v]));
  return Object.fromEntries(Object.entries(plan.providers).map(([k, v]) => [k, clean(v)]));
}

type Adapters = typeof AdaptersModule;

/** A first-class adapter's credential, from its `about` and `verifyCredential`; none for an adapter without one. */
function adapterNeed(registry: Registry, name: string, block: Record<string, unknown>): Need | undefined {
  if (!registry.adapterNames().includes(name)) return undefined;
  const adapter = registry.adapter(name);
  const about = adapter.about;
  if (!about) return undefined;
  const variables = [...(about.extraCredentialEnv ?? []), ...(about.credentialCommand ? [] : [about.credentialEnv])].filter((v) => VAR_NAME.test(v));
  if (variables.length === 0 && !about.credentialCommand) return undefined;
  const verify = adapter.verifyCredential?.bind(adapter);
  return {
    provider: name,
    title: about.title ?? name,
    variables,
    ...(about.credentialCommand ? { command: about.credentialCommand } : {}),
    ...(about.credentialUrl ? { url: about.credentialUrl } : {}),
    ...(about.credentialScope ? { scope: about.credentialScope } : {}),
    ...(verify ? { verify: (actx: AdapterContext) => verify({ ...actx, provider: block }) } : {}),
  };
}

/** An `http` line's API credential: its recipe's, or a hand-written block's variables (unchecked). */
function httpNeed(adapters: Adapters, params: Record<string, unknown>, http: Record<string, unknown>): Need | undefined {
  const lineRecipe = typeof params.recipe === "string" ? params.recipe.split(".")[0]! : undefined;
  const api = typeof params.api === "string" ? params.api : lineRecipe;
  if (api === undefined) return undefined;
  const block = (http[api] ?? {}) as Record<string, unknown>;
  const provider = typeof block.recipe === "string" ? block.recipe : lineRecipe;
  if (provider !== undefined && adapters.recipeNames().includes(provider)) return recipeNeed(adapters, adapters.loadRecipe(provider), api, block);
  const variables = adapters.recipeCredentialEnv({ api: block });
  return variables.length ? { provider: `http.${api}`, title: `API \`${api}\``, variables } : undefined;
}

/** A recipe provider's credential: the variables its (resolved) API block names, its `credential` block. */
function recipeNeed(adapters: Adapters, recipe: Recipe, api: string, block: Record<string, unknown>): Need | undefined {
  const resolved = { ...(recipe.api ?? {}), ...block };
  const variables = adapters.recipeCredentialEnv({ api: resolved });
  const auth = resolved.auth as Record<string, unknown> | undefined;
  const command = Array.isArray(auth?.command) ? (auth.command as string[]) : undefined;
  if (variables.length === 0 && !command) return undefined;
  const cred = recipe.credential;
  return {
    provider: recipe.provider,
    title: recipe.title,
    variables,
    ...(command ? { command } : {}),
    ...(cred ? { url: cred.url, scope: cred.scope } : {}),
    ...(cred?.verify && !command ? { verify: (actx: AdapterContext) => adapters.verifyRecipeCredential(recipe, api, block, actx) } : {}),
  };
}

/** A provider a starter detected (its lines may be commented out until their TODOs are filled in). */
function detectedNeed(adapters: Adapters, registry: Registry, p: DetectableProvider | undefined, blocks: Record<string, Record<string, unknown>>): Need | undefined {
  if (!p) return undefined;
  if (p.via === "adapter") return adapterNeed(registry, p.id, blocks[p.id] ?? {});
  return p.recipe ? recipeNeed(adapters, p.recipe, p.recipe.provider, ((blocks.http ?? {})[p.recipe.provider] ?? {}) as Record<string, unknown>) : undefined;
}

/** The values the plan references with `{ secret: "env://NAME" }` that are not a provider's credential. */
function planSecretsNeed(plan: Plan, taken: string[]): Need | undefined {
  const names = new Set<string>();
  for (const change of plan.changes) {
    walkParams(change.params, [], (_p, v) => {
      if (!isSecretRef(v) || !v.secret.startsWith("env://")) return;
      const name = v.secret.slice("env://".length);
      if (VAR_NAME.test(name) && !taken.includes(name)) names.add(name);
    });
  }
  return names.size ? { provider: "plan", title: "Values the plan references (`env://`)", variables: [...names] } : undefined;
}

// ---------------------------------------------------------------------------
// One credential: show, read, check
// ---------------------------------------------------------------------------

async function setUpOne(c: SetupContext, need: Need, values: Map<string, string>, say: Say): Promise<SetupCredential> {
  say("", `${need.title}${need.variables.length ? `  ${need.variables.join(", ")}` : ""}`);
  if (need.url) say(`  create it: ${need.url}`);
  if (need.scope) say(`  pick:      ${need.scope}`);
  const base = { provider: need.provider, title: need.title, url: need.url ?? null, scope: need.scope ?? null, checked: null, reaches: null };
  if (need.command) {
    say(`  uses \`${need.command.join(" ")}\`: sign in with that CLI; nothing to store`);
    return { ...base, variables: [], status: "login", message: `authenticates with \`${need.command.join(" ")}\`` };
  }
  const variables: SetupCredential["variables"] = [];
  for (const name of need.variables) variables.push({ name, from: await readValue(c, name, values, say) });
  if (variables.some((v) => v.from === "missing")) {
    const missing = variables.filter((v) => v.from === "missing").map((v) => v.name);
    say(`  missing: ${missing.join(", ")}${c.terminal.interactive ? "" : " (export it, or run `sponson init --setup` in a terminal to type it)"}`);
    return { ...base, variables, status: "missing", message: `no value for ${missing.join(", ")}` };
  }
  const result = await check(c, need, values);
  say(`  ${statusLine(result)}`);
  return { ...base, variables, ...result };
}

/** The value of `name`: the environment's, else typed (hidden) at a terminal. Registered for masking at once. */
async function readValue(c: SetupContext, name: string, values: Map<string, string>, say: Say): Promise<"environment" | "prompt" | "missing"> {
  const fromEnv = c.io.env[name];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    c.redactor.register(fromEnv);
    values.set(name, fromEnv);
    say(`  ${name}: from the environment`);
    return "environment";
  }
  if (!c.terminal.interactive) return "missing";
  const typed = (await c.terminal.secret(`  ${name} (input hidden, Enter to skip): `)).trim();
  if (typed === "") return "missing";
  c.redactor.register(typed);
  values.set(name, typed);
  return "prompt";
}

type CheckResult = Pick<SetupCredential, "status" | "checked" | "reaches" | "message">;

/** The need's read-only check, with the collected values in the context's environment. */
async function check(c: SetupContext, need: Need, values: Map<string, string>): Promise<CheckResult> {
  if (!need.verify) return { status: "unchecked", checked: null, reaches: null, message: "no read-only request to check it with" };
  const env: NodeJS.ProcessEnv = { SPONSON_HTTP_RETRIES: "1", ...c.io.env, ...Object.fromEntries(need.variables.map((n) => [n, values.get(n)!])) };
  const actx: AdapterContext = {
    ctx: SETUP_CTX,
    provider: {},
    env,
    log: () => {},
    intend: () => Promise.reject(new SponsonError("INTERNAL", "a credential check must not create anything")),
    redact: (t) => c.redactor.redact(t),
    secret: (v) => c.redactor.register(v),
  };
  try {
    const r = await need.verify(actx);
    return { status: "ok", checked: r.request, reaches: r.reaches, message: null };
  } catch (e) {
    return classify(e);
  }
}

/** A failed check, by what the HTTP client classified: 401 rejected, 403 or a 404 on the project out of scope. */
export function classify(e: unknown): CheckResult {
  const err = e instanceof SponsonError ? e : new SponsonError("INTERNAL", e instanceof Error ? e.message : String(e));
  const d = err.details as { method?: unknown; path?: unknown; status?: unknown };
  const checked = typeof d.method === "string" && typeof d.path === "string" ? `${d.method} ${d.path.split("?")[0]!}` : null;
  const base = { checked, reaches: null, message: err.message };
  if (err.code === "PROVIDER_AUTH" && d.status === 403) return { ...base, status: "wrong_scope" };
  if (err.code === "PROVIDER_AUTH") return { ...base, status: "unauthorized" };
  if (err.code === "PROVIDER_NOT_FOUND") return { ...base, status: "wrong_scope", message: `${err.message} (the credential does not reach it: another account or team, or a narrower scope)` };
  return { ...base, status: "error" };
}

/** How each check result reads, after two spaces of indentation. */
const STATUS_TEXT: Record<CredentialStatus, (r: CheckResult) => string> = {
  ok: (r) => `ok: ${r.checked!} (reaches ${r.reaches!})`,
  unchecked: () => "not checked: no read-only request to check it with",
  wrong_scope: (r) => `wrong scope: ${r.message!}`,
  unauthorized: (r) => `unauthorized: ${r.message!}`,
  error: (r) => `could not check: ${r.message!}`,
  missing: (r) => `missing: ${r.message!}`,
  login: (r) => r.message!,
};

function statusLine(r: CheckResult): string {
  return STATUS_TEXT[r.status](r);
}

// ---------------------------------------------------------------------------
// GitHub: secrets and the workflow
// ---------------------------------------------------------------------------

/** Whether to do something: `--yes` accepts, a terminal asks, otherwise nobody can say yes. */
async function consent(c: SetupContext, question: string): Promise<"yes" | "no" | "not-asked"> {
  if (c.opts.yes) return "yes";
  if (!c.terminal.interactive) return "not-asked";
  return (await c.terminal.confirm(question)) ? "yes" : "no";
}

/** Offer each checked value as an Actions secret of the origin repository; store it with `gh` on a yes. */
async function storeSecrets(c: SetupContext, credentials: SetupCredential[], values: Map<string, string>, repo: string | null, say: Say): Promise<SetupSecret[]> {
  const names = credentials.flatMap((x) => x.variables.map((v) => ({ name: v.name, offer: ["ok", "unchecked"].includes(x.status) && values.has(v.name) })));
  if (names.length === 0) return [];
  if (repo === null) {
    say("", "GitHub Actions secrets: skipped, origin is not a GitHub repository. Store them in your CI's secret settings.");
    return names.map((n) => ({ name: n.name, result: "no-repo", message: "origin is not a GitHub repository" }));
  }
  say("", `GitHub Actions secrets of ${repo} (with your \`gh\`; the value goes to its stdin only):`);
  const env = childEnv(c.io.env, values.keys());
  const out: SetupSecret[] = [];
  let ghMissing: string | null = null;
  for (const { name, offer } of names) {
    if (!offer) {
      say(`  ${name}: not offered (no value, or it did not check ok)`);
      out.push({ name, result: "skipped", message: "not offered: it has no value or did not check ok" });
      continue;
    }
    if (ghMissing) {
      out.push({ name, result: "gh-missing", message: ghMissing });
      continue;
    }
    out.push(await storeOne(c, name, values.get(name)!, repo, env, say));
    if (out.at(-1)!.result === "gh-missing") ghMissing = out.at(-1)!.message;
  }
  return out;
}

async function storeOne(c: SetupContext, name: string, value: string, repo: string, env: NodeJS.ProcessEnv, say: Say): Promise<SetupSecret> {
  const answer = await consent(c, `  Store ${name} as an Actions secret of ${repo} (replaces one of that name)?`);
  if (answer !== "yes") {
    say(`  ${name}: ${answer === "no" ? "not stored" : "not stored (no terminal to ask; pass --yes to store)"}`);
    return { name, result: answer === "no" ? "declined" : "not-asked", message: null };
  }
  const r = await ghSecretSet(name, value, repo, env, c.io.cwd);
  if (r.ok) {
    say(`  ${name}: stored`);
    return { name, result: "stored", message: null };
  }
  const message = c.redactor.redact(r.message);
  say(`  ${name}: not stored: ${message}${r.reason === "gh-missing" ? ` (or run \`gh secret set ${name} --repo ${repo}\` yourself)` : ""}`);
  return { name, result: r.reason, message };
}

/**
 * Offer `.github/workflows/sponson.yml`, pinned to the commit of the installed version's tag; never overwrite one, and
 * never offer it while the plan has TODOs: the workflow would run on every pull request against a plan that fails.
 */
async function writeWorkflow(c: SetupContext, needs: Need[], todos: number, plan: string, say: Say): Promise<SetupReport["workflow"]> {
  const path = join(c.io.cwd, WORKFLOW_PATH);
  const tag = releaseTag(VERSION);
  const exists = await readFile(path, "utf8").then(() => true, () => false);
  if (exists) {
    say("", `Workflow: ${WORKFLOW_PATH} exists; left as it is.`);
    return { path: WORKFLOW_PATH, result: "exists", tag, commit: null };
  }
  if (todos) {
    say("", `Workflow: not offered while ${plan} has TODOs (listed at the top): it would run a plan that cannot work yet. Fill them in, then run \`sponson init --setup\` again to write it.`);
    return { path: WORKFLOW_PATH, result: "todo", tag, commit: null };
  }
  const answer = await consent(c, `\n  Write ${WORKFLOW_PATH} (the action pinned to the commit of ${tag})?`);
  if (answer !== "yes") {
    say("", `Workflow: ${WORKFLOW_PATH} not written${answer === "not-asked" ? " (no terminal to ask; pass --yes to write it)" : ""}.`);
    return { path: WORKFLOW_PATH, result: answer === "no" ? "declined" : "not-asked", tag, commit: null };
  }
  const commit = await resolveTagCommit(tag, c.io.env, c.io.cwd);
  const variables = [...new Set(needs.flatMap((n) => n.variables))];
  const commandNotes = needs.filter((n) => n.command).map((n) => `${n.title} authenticates with \`${n.command!.join(" ")}\`: add a login step for it (see docs/providers.md).`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderWorkflow({ variables, commit, tag, commandNotes }), { encoding: "utf8", flag: "wx" });
  say("", `Workflow: wrote ${WORKFLOW_PATH}${commit ? ` (action pinned to ${commit.slice(0, 12)}, ${tag})` : ` with a TODO: the commit of ${tag} could not be read; fill it in`}.`);
  return { path: WORKFLOW_PATH, result: "written", tag, commit };
}
