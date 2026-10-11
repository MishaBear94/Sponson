/**
 * docs/providers.md, entirely, and the README's `providers-summary` block: the provider catalog, generated from the
 * coverage matrix (docs/coverage.yaml: categories, providers, what each side effect is), the recipe files
 * (packages/adapters/recipes/*.yaml: ops, credentials, example lines, `detect`) and the adapter registry (first-class
 * ops, their `about`: credential and `detect`). No list of providers is kept anywhere else: a recipe or an adapter
 * appears here once docs/coverage.yaml names it in a row's `covered_by` (scenarios/docs/coverage.test.ts requires
 * that), and `sponson init` detects it once it declares `detect`. Called by scripts/gen-docs.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Document, isScalar, parse, visit } from "yaml";
import { createRegistry, detectableProviders, loadRecipe, loadRecipes, type DetectableProvider, type Recipe } from "../packages/adapters/src/index.js";
import type { ProviderDetect, Registry } from "../packages/core/src/index.js";
import { coverRefs, MANUAL_STEP, type CoverageData, type CoverageRow } from "./coverage-data.js";
import { cell, slug } from "./md.js";
import { aboutCredential, credential, exampleLine, recipeLink } from "./render-recipes.js";

/** One op that manages part of a row: a first-class `adapter.op` or a recipe `provider.op`. */
interface OpRef {
  kind: "adapter" | "recipe";
  provider: string;
  op: string;
}

/** One provider row of the catalog: a coverage row (or a recipe's ops no row names) with the ops covering it. */
interface Entry {
  provider: string;
  manages: string;
  note?: string;
  ops: OpRef[];
}

interface Catalog {
  categories: Array<{ id: string; title: string; entries: Entry[] }>;
  /** Rows of the matrix nothing covers yet. */
  uncovered: CoverageRow[];
}

function opRef(ref: string): OpRef {
  if (ref.startsWith("recipe:")) {
    const [provider, op] = ref.slice("recipe:".length).split(".") as [string, string];
    return { kind: "recipe", provider, op };
  }
  const [provider, op] = ref.split(".") as [string, string];
  return { kind: "adapter", provider, op };
}

/** The catalog: every covered row by category, with the recipe ops no row names attached to their provider's row. */
type Category = { id: string; title: string; entries: Array<Entry & { row?: CoverageRow }> };

/** Attach an op no coverage row names to its provider's entry in its category (made when there is none). */
function attach(categories: Category[], categoryId: string, provider: string, manages: string, ref: OpRef): void {
  let category = categories.find((c) => c.id === categoryId);
  if (!category) {
    category = { id: "other", title: "Other providers", entries: [] };
    if (!categories.some((c) => c.id === "other")) categories.push(category);
    category = categories.find((c) => c.id === "other")!;
  }
  const entry = category.entries.find((e) => e.provider === provider || e.ops.some((o) => o.kind === ref.kind && o.provider === ref.provider));
  if (entry) entry.ops.push(ref);
  else category.entries.push({ provider, manages, ops: [ref] });
}

/**
 * The catalog: every covered row by category, with the ops no row names (a recipe op, a new adapter's op) attached to
 * their provider's entry, so nothing the registry or the recipes provide is left out.
 */
export function catalog(data: CoverageData, recipes: Recipe[] = loadRecipes(), registry: Registry = createRegistry()): Catalog {
  const named = new Set(data.categories.flatMap((c) => c.rows.flatMap((r) => coverRefs(r))));
  const categories: Category[] = data.categories.map((c) => ({
    id: c.id,
    title: c.title,
    entries: c.rows.map((r) => ({ provider: r.provider, manages: r.side_effect, ...(r.note ? { note: r.note } : {}), ops: coverRefs(r).map(opRef), row: r })),
  }));
  for (const recipe of recipes) {
    for (const op of Object.keys(recipe.ops)) {
      if (!named.has(`recipe:${recipe.provider}.${op}`)) attach(categories, recipe.category, recipe.title, recipe.ops[op]!.title, { kind: "recipe", provider: recipe.provider, op });
    }
  }
  // The generic adapter's own ops are every recipe line above, and any API besides: not a provider of their own.
  for (const name of registry.adapterNames().filter((n) => n !== "http")) {
    const about = registry.adapter(name).about;
    for (const op of Object.keys(registry.adapter(name).ops)) {
      if (!named.has(`${name}.${op}`)) attach(categories, about?.category ?? "other", about?.title ?? name, `see \`${name}.${op}\``, { kind: "adapter", provider: name, op });
    }
  }
  const uncovered = categories.flatMap((c) => c.entries.flatMap((e) => (e.ops.length === 0 && e.row && e.row.counted !== false ? [e.row] : [])));
  const names = categories.flatMap((c) => c.entries.filter((e) => e.ops.length > 0).map((e) => e.provider));
  const twice = names.find((x, i) => names.indexOf(x) !== i);
  if (twice) throw new Error(`docs/coverage.yaml: two covered rows are both named \`${twice}\`; name them apart (their catalog sections need distinct anchors)`);
  return {
    categories: categories.map((c) => ({ id: c.id, title: c.title, entries: c.entries.filter((e) => e.ops.length > 0).map(({ row: _row, ...e }) => e) })).filter((c) => c.entries.length > 0),
    uncovered,
  };
}

/** The numbers the README summary and the catalog's own header state. */
export function catalogNumbers(c: Catalog, registry: Registry = createRegistry(), providers: DetectableProvider[] = detectableProviders(registry)) {
  const entries = c.categories.flatMap((k) => k.entries);
  const automated = entries.filter((e) => e.ops.some((o) => `${o.provider}.${o.op}` !== MANUAL_STEP));
  const ops = (kind: OpRef["kind"]) => new Set(automated.flatMap((e) => e.ops.filter((o) => o.kind === kind && `${o.provider}.${o.op}` !== MANUAL_STEP).map((o) => `${o.provider}.${o.op}`))).size;
  return {
    providers: new Set(automated.map((e) => e.provider)).size,
    categories: c.categories.filter((k) => k.entries.some((e) => automated.includes(e))).length,
    adapterOps: ops("adapter"),
    recipeOps: ops("recipe"),
    manual: entries.length - automated.length,
    detected: providers.length,
  };
}

function opLink(o: OpRef): string {
  return o.kind === "recipe" ? `recipe ${recipeLink(o.provider, o.op)}` : `[\`${o.provider}.${o.op}\`](plan-format.md#${slug(`${o.provider}.${o.op}`)})`;
}

/** The credential an op reads, as the docs show it. */
function credentialOf(o: OpRef, registry: Registry): string {
  if (o.kind === "recipe") return credential(loadRecipe(o.provider).api);
  if (`${o.provider}.${o.op}` === MANUAL_STEP) return "none (a person does it)";
  return aboutCredential(registry.adapter(o.provider).about!);
}

/** What `sponson init` detects an op's provider by: its adapter's `about.detect`, or its recipe's `detect`. */
function detectOf(o: OpRef, providers: DetectableProvider[]): ProviderDetect | undefined {
  return providers.find((p) => p.id === o.provider)?.detect;
}

/**
 * Where an op's credential is created, the least it needs, and the request `sponson init --setup` checks it with: an
 * adapter's `about.credentialUrl`/`credentialScope` and `verifyCredential`, a recipe's `credential` block.
 */
function tokenOf(o: OpRef, registry: Registry): string | undefined {
  if (`${o.provider}.${o.op}` === MANUAL_STEP) return undefined;
  const LOGIN = "`sponson init --setup` shows this; there is no token to store.";
  if (o.kind === "recipe") {
    const r = loadRecipe(o.provider);
    const c = r.credential;
    if (!c) return undefined;
    const login = (r.api?.auth as { command?: unknown } | undefined)?.command !== undefined;
    const check = login ? LOGIN : c.verify ? `\`sponson init --setup\` checks it with \`${c.verify.split("?")[0]!}\`.` : "`sponson init --setup` cannot check it (no read-only request every such credential may send).";
    return `[${login ? "set up access" : "create it"}](${c.url}): ${c.scope} ${check}`;
  }
  const a = registry.adapter(o.provider);
  if (!a.about?.credentialUrl) return undefined;
  const login = a.about.credentialCommand !== undefined;
  const check = login ? LOGIN : a.verifyCredential ? "`sponson init --setup` checks it with one read-only request." : "";
  return `[${login ? "set up access" : "create it"}](${a.about.credentialUrl}): ${a.about.credentialScope ?? ""} ${check}`.trim();
}

function detectText(d: ProviderDetect | undefined): string {
  if (!d) return "—";
  const parts = [
    ...(d.deps ?? []).map((x) => `\`${x.endsWith("/") ? `${x}*` : x}\``),
    ...(d.files ?? []).map((x) => `\`${x}\``),
    ...(d.env ?? []).map((x) => `\`${x}\``),
    ...(d.dbHosts ?? []).map((x) => `database URL on \`*${x}\``),
  ];
  return parts.join(", ");
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

// ---------------------------------------------------------------------------------------------------------------
// Example lines

/** The repo's tested plans: examples/*.plan.yaml, then the adapter scenarios' plans. */
function testedPlans(repo: string): Array<{ source: string; plan: Record<string, unknown> }> {
  const out: Array<{ source: string; plan: Record<string, unknown> }> = [];
  for (const f of readdirSync(join(repo, "examples")).filter((f) => f.endsWith(".plan.yaml")).sort()) {
    out.push({ source: `examples/${f}`, plan: parse(readFileSync(join(repo, "examples", f), "utf8")) as Record<string, unknown> });
  }
  for (const f of readdirSync(join(repo, "scenarios/adapters")).filter((f) => f.endsWith(".yaml")).sort()) {
    const doc = parse(readFileSync(join(repo, "scenarios/adapters", f), "utf8")) as { plan?: string };
    if (typeof doc.plan === "string") out.push({ source: `scenarios/adapters/${f}`, plan: parse(doc.plan) as Record<string, unknown> });
  }
  return out;
}

/** A first-class op's example: its first line in a tested plan, with that plan's provider block for its adapter. */
function adapterExample(o: OpRef, plans: ReturnType<typeof testedPlans>): string {
  for (const { source, plan } of plans) {
    // A line that adopts (`{ keep: true }`) shows what init writes when adopting, not a line to start from.
    const line = ((plan.changes as Array<Record<string, unknown>> | undefined) ?? []).find((c) => c.adapter === o.provider && c.op === o.op && !JSON.stringify(c).includes('"keep":true'));
    if (!line) continue;
    const block = (plan.providers as Record<string, unknown> | undefined)?.[o.provider];
    const changes = compactYaml({ changes: [line] });
    const providers = block !== undefined && o.provider !== "manual" ? `${compactYaml({ providers: { [o.provider]: block } })}\n` : "";
    return `# from ${source}\n${providers}${changes}`;
  }
  throw new Error(`no tested plan (examples/*.plan.yaml, scenarios/adapters/*.yaml) has a \`${o.provider}.${o.op}\` line: add one, so the provider catalog can show it`);
}

/** YAML as plans are written: references (`{ from }`, `{ secret }`), flat maps and `environments` on one line. */
function compactYaml(v: unknown): string {
  const doc = new Document(v);
  visit(doc, {
    Map(_, node) {
      const flat = node.items.every((i) => isScalar(i.value));
      const ref = node.items.length === 1 && isScalar(node.items[0]!.key) && ["from", "secret", "keep"].includes(String(node.items[0]!.key.value));
      if (ref || (flat && node.items.length <= 2)) node.flow = true;
    },
    Seq(_, node) {
      if (node.items.every((i) => isScalar(i))) node.flow = true;
    },
  });
  return doc.toString({ lineWidth: 0 }).trimEnd().replace(/\[ ([^[\]\n]*) \]/g, "[$1]");
}

function exampleOf(o: OpRef, plans: ReturnType<typeof testedPlans>): string {
  if (o.kind === "adapter") return adapterExample(o, plans);
  const r = loadRecipe(o.provider);
  return exampleLine(r, o.op, r.ops[o.op]!);
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

function entrySection(e: Entry, registry: Registry, providers: DetectableProvider[], plans: ReturnType<typeof testedPlans>): string[] {
  const credentials = unique(e.ops.map((o) => credentialOf(o, registry)));
  const detect = unique(e.ops.map((o) => detectText(detectOf(o, providers)))).filter((t) => t !== "—");
  const tokens = unique(e.ops.map((o) => tokenOf(o, registry)).filter((t): t is string => t !== undefined));
  return [
    `### ${e.provider}`,
    "",
    `${e.manages}${e.note ? ` (${e.note})` : ""}.`,
    "",
    `- **Ops**: ${e.ops.map(opLink).join(", ")}`,
    `- **Credential**: ${credentials.join("; ")}`,
    ...tokens.map((t) => `- **Token**: ${t}`),
    `- **Detected by \`sponson init\` from**: ${detect.length ? detect.join("; ") : "not detected (write the line yourself)"}`,
    "",
    "```yaml",
    exampleOf(e.ops[0]!, plans),
    "```",
    "",
  ];
}

export function renderProviders(data: CoverageData, repo: string): string {
  const registry = createRegistry();
  const providers = detectableProviders(registry);
  const plans = testedPlans(repo);
  const c = catalog(data, loadRecipes(), registry);
  const n = catalogNumbers(c, registry, providers);
  const index = ["| Category | Providers |", "|---|---|", ...c.categories.map((k) => `| [${cell(k.title)}](#${slug(k.title)}) | ${unique(k.entries.map((e) => `[${cell(e.provider)}](#${slug(e.provider)})`)).join(", ")} |`)];
  const lines = [
    "<!-- Generated by scripts/gen-docs.ts from docs/coverage.yaml, packages/adapters/recipes/*.yaml and the adapter registry. Do not edit: run `pnpm docs:gen`. -->",
    "",
    "# Supported providers",
    "",
    "Every provider whose per-environment state Sponson manages, by category: what it manages, the op or recipe that",
    "does it, the credential it reads from the environment (where to create it, and what to pick: `sponson init --setup` walks",
    "through the same), what `sponson init` detects it by, and a line to start from.",
    "`sponson init` reads dependency names, config files and variable names (never their values) and writes these lines",
    "for every provider it detects: ready to apply when it knows every value, else commented out with a `# TODO:` that",
    "says where to find each missing one.",
    "",
    `${n.providers} providers in ${n.categories} categories: ${n.adapterOps} ops of first-class adapters and ${n.recipeOps} recipe ops, plus ${n.manual} steps no API reaches, tracked as [\`manual.step\`](plan-format.md#manualstep) lines. \`sponson init\` detects ${n.detected} providers.`,
    "",
    "- First-class ops: [the plan format](plan-format.md#built-in-ops). Recipes: [Recipes](recipes.md).",
    "- What is covered and what is not, and why: [Provider coverage](coverage.md).",
    "- A provider that is missing: add a recipe (one YAML file; its `detect` block makes `sponson init` find it), see",
    "  [CONTRIBUTING.md](../CONTRIBUTING.md).",
    "",
    ...index,
    "",
  ];
  for (const k of c.categories) {
    lines.push(`## ${k.title}`, "", "| Provider | What Sponson manages | Ops | Credential |", "|---|---|---|---|");
    for (const e of k.entries) lines.push(`| [${cell(e.provider)}](#${slug(e.provider)}) | ${cell(e.manages)} | ${e.ops.map(opLink).join(", ")} | ${cell(unique(e.ops.map((o) => credentialOf(o, registry))).join("; "))} |`);
    lines.push("", ...k.entries.flatMap((e) => entrySection(e, registry, providers, plans)));
  }
  if (c.uncovered.length) {
    lines.push("## Not covered yet", "", "Rows of [the coverage matrix](coverage.md#coverage-matrix) nothing manages yet:", "", ...c.uncovered.map((r) => `- ${r.provider}: ${r.side_effect}${r.note ? ` (${r.note})` : ""}`), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The README's `providers-summary` block. */
export function renderProvidersSummary(data: CoverageData): string {
  const n = catalogNumbers(catalog(data));
  return [
    `Sponson manages per-environment state at **${n.providers} providers** in ${n.categories} categories, from deploy targets and databases to auth callbacks, feature flags, webhooks and DNS: ${n.adapterOps} first-class ops and ${n.recipeOps} recipe ops. \`sponson init\` detects ${n.detected} of them from a repository's files and writes their lines.`,
    "",
    "[docs/providers.md](docs/providers.md) lists every one: what Sponson manages there, the op or recipe, the credential, what `init` detects it by and a line to start from.",
  ].join("\n");
}
