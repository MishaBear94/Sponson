/**
 * Stack detection for `sponson init`: what a repository uses, read from its files alone. No network, no
 * credentials, no command spawned. Everything here is a pure function over a `RepoReader` and the list of
 * detectable providers, so the unit tests feed it in-memory fixtures.
 *
 * Which providers exist and what they are detected by is data, not code here: every first-class adapter declares
 * it in its `about.detect`, every recipe in its file's `detect` block (`detectableProviders` in @sponson/adapters).
 * Adding either makes `init` detect the provider with no change to this file. Frameworks and ORMs, which name
 * variables rather than being managed, are the only rules kept here.
 *
 * Secret values never leave this module, and most are never even looked at: from `.env*` files only variable
 * names are kept. The one exception is a database URL, whose host is classified against the providers' declared
 * host suffixes (`.neon.tech`, `.supabase.co`, …) inside `dbHostProvider`; the URL itself, its credentials and the
 * host are dropped there and only the provider's id comes out. Ids that are not secrets (`.vercel/project.json`,
 * `.neon`, `supabase/.temp/project-ref`, `.netlify/state.json`, the `name` and `account_id` of a Wrangler
 * configuration, `VERCEL_PROJECT_ID` / `VERCEL_ORG_ID` / `NEON_PROJECT_ID` / `NETLIFY_SITE_ID` / `CLOUDFLARE_ACCOUNT_ID`
 * in the process environment) are read as values.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DetectableProvider, Recipe } from "@sponson/adapters";
import type { ProviderDetect } from "@sponson/core";

/** Reads a file of the repository by relative path; `null` when it does not exist or cannot be read. */
export interface RepoReader {
  read(path: string): Promise<string | null>;
}

/** The real file system under `cwd`. */
export function fsReader(cwd: string): RepoReader {
  return { read: (path) => readFile(join(cwd, path), "utf8").catch(() => null) };
}

/** Every built-in adapter and shipped recipe that declares how to detect its provider. */
export async function builtinProviders(): Promise<DetectableProvider[]> {
  const adapters = await import("@sponson/adapters");
  return adapters.detectableProviders(adapters.createRegistry());
}

export type FindingKind = "provider" | "framework" | "orm" | "service";

/** One thing the repository uses, and why Sponson thinks so (file names, dependency and variable names only). */
export interface Finding {
  id: string;
  name: string;
  kind: FindingKind;
  evidence: string[];
  /** For a provider: managed by a first-class adapter (`adapter`) or by recipes of the http adapter (`recipe`). */
  via?: "adapter" | "recipe";
}

/** Something detected that no built-in adapter manages yet, with where to follow or ask for it. */
export interface UnsupportedFinding extends Finding {
  pointer: string;
}

export interface StackDetection {
  /**
   * What Sponson can use, in a fixed order: providers by category (deploy targets, databases, auth, flags, …), then
   * frameworks, then ORMs.
   */
  found: Finding[];
  /** Detected but not managed by any built-in adapter or recipe. Never silently dropped. */
  unsupported: UnsupportedFinding[];
  /** The recipes of the providers found `via: "recipe"`, in the order of `found`. */
  recipes: Recipe[];
  /** Each provider found: the variables its credential is read from when Sponson runs. */
  credentials: Record<string, string[]>;
  /** Each provider found that takes a CLI's token instead: the command that prints it. */
  credentialCommands?: Record<string, readonly string[]>;
  ids: {
    vercelProject?: string;
    vercelTeam?: string;
    vercelProjectFrom?: string;
    neonProject?: string;
    neonProjectFrom?: string;
    supabaseProject?: string;
    supabaseProjectFrom?: string;
    netlifySite?: string;
    netlifySiteFrom?: string;
    /** The Pages project name: the Wrangler configuration's `name`. */
    cloudflareProject?: string;
    cloudflareProjectFrom?: string;
    cloudflareAccount?: string;
    cloudflareAccountFrom?: string;
  };
  /**
   * A Wrangler configuration was found and it has no `pages_build_output_dir`: it may describe a Worker rather than
   * a Pages project. Undefined when there is no Wrangler configuration.
   */
  cloudflareNotPages?: boolean;
  /** The variable the app reads its database URL from (DATABASE_URL unless the code says otherwise). */
  databaseVar: string;
  /** Where `databaseVar` came from, for the comment in the plan; undefined for the default. */
  databaseVarFrom?: string;
  /** The framework's prefix for variables the browser may see (`NEXT_PUBLIC_`, `PUBLIC_`, …); "" when none. */
  publicPrefix: string;
  /** `vercel.json` turns off automatic Git deployments, so the plan has to start the deploy itself. */
  vercelAutoDeployOff: boolean;
  /** Each variable *name* the `.env*` files declare, with the files that declare it. Never a value. */
  envNames?: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Signals: what the files say, before any rule interprets it
// ---------------------------------------------------------------------------

/** `.env*` files whose variable names (never values) are read. Examples first: they list what the app needs. */
export const ENV_FILES = [".env.example", ".env.sample", ".env.template", ".env.local", ".env", ".env.development", ".env.development.local"];

/** Wrangler's configuration files, in the order Wrangler prefers them. */
const WRANGLER_FILES = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"];
const PRISMA_SCHEMAS = ["prisma/schema.prisma", "schema.prisma"];
const DRIZZLE_CONFIGS = ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs", "drizzle.config.cjs"];

/** Files read for their content (ids, the database variable), besides the ones providers name as signals. */
const ID_FILES = ["package.json", "vercel.json", ".vercel/project.json", ".neon", "supabase/.temp/project-ref", ".netlify/state.json", ...WRANGLER_FILES, ...PRISMA_SCHEMAS, ...DRIZZLE_CONFIGS];

/** A database URL host suffix and the provider it belongs to. */
export interface HostRule {
  provider: string;
  suffix: string;
}

/** The database URL hosts the providers declare (`detect.dbHosts`). */
export function hostRules(providers: DetectableProvider[]): HostRule[] {
  return providers.flatMap((p) => (p.detect.dbHosts ?? []).map((suffix) => ({ provider: p.id, suffix })));
}

interface Signals {
  deps: Set<string>;
  /** Variable name → the files that mention it. */
  envNames: Map<string, string[]>;
  /** Provider id → evidence, from database URL hosts. */
  dbHosts: Map<string, string[]>;
  files: Map<string, string>;
}

async function gatherSignals(reader: RepoReader, providers: DetectableProvider[]): Promise<Signals> {
  const files = new Map<string, string>();
  const markers = new Set([...ID_FILES, ...providers.flatMap((p) => p.detect.files ?? []), ...UNSUPPORTED.flatMap((r) => r.files ?? [])]);
  for (const f of markers) {
    const text = await reader.read(f);
    if (text !== null) files.set(f, text);
  }
  const hosts = hostRules(providers);
  const envNames = new Map<string, string[]>();
  const dbHosts = new Map<string, string[]>();
  for (const f of ENV_FILES) {
    const text = await reader.read(f);
    if (text === null) continue;
    for (const { name, provider } of scanEnvFile(text, hosts)) {
      envNames.set(name, [...(envNames.get(name) ?? []), f]);
      if (provider) dbHosts.set(provider, [...(dbHosts.get(provider) ?? []), `${name} in ${f} points at ${hostLabel(hosts, provider)}`]);
    }
  }
  return { deps: dependencyNames(files.get("package.json")), envNames, dbHosts, files };
}

/** `*.neon.tech`: the provider's first declared host suffix. */
function hostLabel(hosts: HostRule[], provider: string): string {
  return `*${hosts.find((h) => h.provider === provider)!.suffix}`;
}

function dependencyNames(pkg: string | undefined): Set<string> {
  if (pkg === undefined) return new Set();
  try {
    const json = JSON.parse(pkg) as Record<string, unknown>;
    const names = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) => {
      const deps = json[k];
      return deps && typeof deps === "object" ? Object.keys(deps) : [];
    });
    return new Set(names);
  } catch {
    return new Set();
  }
}

/**
 * The variables an `.env` file declares: their names, and for a database URL the provider its host belongs to
 * (by `hosts`). The value is never returned.
 */
export function scanEnvFile(text: string, hosts: HostRule[]): Array<{ name: string; provider?: string }> {
  const out: Array<{ name: string; provider?: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    const provider = dbHostProvider(m[2]!, hosts);
    out.push(provider ? { name: m[1]!, provider } : { name: m[1]! });
  }
  return out;
}

/** Which provider a database URL's host belongs to. Only the provider id leaves; the URL is dropped here. */
function dbHostProvider(raw: string, hosts: HostRule[]): string | undefined {
  const value = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
  if (!/^(postgres(ql)?|mysql|libsql|mongodb(\+srv)?|prisma\+postgres):\/\//i.test(value)) return undefined;
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return hosts.find((h) => host.endsWith(h.suffix))?.provider;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const NEW_ISSUE = "open or upvote an issue: https://github.com/MishaBear94/Sponson/issues";

/** A framework, an ORM or an unsupported service: the rules that are not providers' own `detect`. */
interface Rule extends ProviderDetect {
  id: string;
  name: string;
  kind: FindingKind;
  /** For unsupported services: where to follow it. */
  pointer?: string;
}

/** Frameworks (the public variable prefix) and ORMs (the database variable). Order is the order of the summary. */
const STACK_RULES: Rule[] = [
  { id: "next", name: "Next.js", kind: "framework", deps: ["next"] },
  { id: "remix", name: "Remix", kind: "framework", deps: ["@remix-run/"] },
  { id: "sveltekit", name: "SvelteKit", kind: "framework", deps: ["@sveltejs/kit"] },
  { id: "astro", name: "Astro", kind: "framework", deps: ["astro"] },
  { id: "nuxt", name: "Nuxt", kind: "framework", deps: ["nuxt"] },
  { id: "prisma", name: "Prisma", kind: "orm", deps: ["prisma", "@prisma/client"], files: PRISMA_SCHEMAS },
  { id: "drizzle", name: "Drizzle", kind: "orm", deps: ["drizzle-orm", "drizzle-kit"], files: DRIZZLE_CONFIGS },
];

/**
 * Services with per-environment state that no adapter or recipe manages yet: detected and reported, never silently
 * ignored. A service gets support by a recipe or an adapter that declares `detect`; then it leaves this list (a test
 * fails while it is in both).
 */
export const UNSUPPORTED: Rule[] = [
  { id: "mailgun", name: "Mailgun", kind: "service", deps: ["mailgun.js", "mailgun-js"], env: ["MAILGUN_*"], pointer: NEW_ISSUE },
  { id: "twilio", name: "Twilio", kind: "service", deps: ["twilio"], env: ["TWILIO_*"], pointer: NEW_ISSUE },
];

/** The order providers are summarised in, by category; categories not listed come after, in detection order. */
const CATEGORY_ORDER = ["deploy", "databases", "auth", "flags", "webhooks", "email", "observability", "dns", "cors", "queues", "search-payments", "cms", "backend"];

/** Prefixes frameworks put in front of a variable the browser may see; a provider's names match behind them. */
const PUBLIC_PREFIXES = ["NEXT_PUBLIC_", "NUXT_PUBLIC_", "EXPO_PUBLIC_", "PUBLIC_", "VITE_", "REACT_APP_", "GATSBY_"];

/** Whether a variable name matches a `detect.env` entry: exact, or a prefix ending in `*`, behind a public prefix or not. */
export function envMatches(name: string, patterns: readonly string[]): boolean {
  const bare = [name, ...PUBLIC_PREFIXES.filter((p) => name.startsWith(p)).map((p) => name.slice(p.length))];
  return patterns.some((pat) => bare.some((n) => (pat.endsWith("*") ? n.startsWith(pat.slice(0, -1)) : n === pat)));
}

function depMatches(dep: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => (p.endsWith("/") ? dep.startsWith(p) : dep === p));
}

function evidenceFor(id: string, rule: ProviderDetect, s: Signals): string[] {
  const ev: string[] = [];
  for (const d of s.deps) if (depMatches(d, rule.deps ?? [])) ev.push(`package.json: ${d}`);
  for (const f of rule.files ?? []) if (s.files.has(f)) ev.push(f);
  const names = [...s.envNames.keys()].filter((n) => envMatches(n, rule.env ?? []));
  if (names.length > 0) ev.push(`${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""} in ${unique(names.flatMap((n) => s.envNames.get(n)!)).join(", ")}`);
  ev.push(...(s.dbHosts.get(id) ?? []));
  return ev;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function categoryRank(category: string): number {
  const i = CATEGORY_ORDER.indexOf(category);
  return i < 0 ? CATEGORY_ORDER.length : i;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** The variables that may carry provider ids into `init` (ids, not secrets). */
export type IdEnv = Partial<Record<"VERCEL_PROJECT_ID" | "VERCEL_ORG_ID" | "NEON_PROJECT_ID" | "NETLIFY_SITE_ID" | "CLOUDFLARE_ACCOUNT_ID", string>>;

/**
 * Detect the stack of the repository `reader` reads. `env` is the process environment, from which only the
 * provider id variables of `IdEnv` are read (they win over the files, as `init` always did). `providers` is what
 * can be detected (default: every built-in adapter and shipped recipe that declares `detect`).
 */
export async function detectStack(reader: RepoReader, env: IdEnv = {}, providers?: DetectableProvider[]): Promise<StackDetection> {
  const known = providers ?? (await builtinProviders());
  const s = await gatherSignals(reader, known);
  const wrangler = wranglerConfig(s);
  const ids = { ...providerIds(s, env), ...cloudflareIds(wrangler, env) };
  const detected = known
    .map((p, i) => ({ p, i, evidence: [...evidenceFor(p.id, p.detect, s), ...idEnvEvidence(p.id, env)] }))
    .filter((x) => x.evidence.length > 0)
    .sort((a, b) => categoryRank(a.p.category) - categoryRank(b.p.category) || a.i - b.i);
  const found: Finding[] = detected.map(({ p, evidence }) => ({ id: p.id, name: p.title, kind: "provider", evidence, via: p.via }));
  for (const rule of STACK_RULES) {
    const evidence = evidenceFor(rule.id, rule, s);
    if (evidence.length > 0) found.push({ id: rule.id, name: rule.name, kind: rule.kind, evidence });
  }
  const unsupported: UnsupportedFinding[] = [];
  for (const rule of UNSUPPORTED) {
    const evidence = evidenceFor(rule.id, rule, s);
    if (evidence.length > 0) unsupported.push({ id: rule.id, name: rule.name, kind: rule.kind, evidence, pointer: rule.pointer! });
  }
  const framework = found.find((f) => f.kind === "framework")?.id;
  return {
    found,
    unsupported,
    recipes: detected.flatMap(({ p }) => (p.recipe ? [p.recipe] : [])),
    credentials: Object.fromEntries(detected.map(({ p }) => [p.id, p.credentials])),
    credentialCommands: Object.fromEntries(detected.flatMap(({ p }) => (p.credentialCommand ? [[p.id, p.credentialCommand]] : []))),
    ids,
    ...databaseVar(s),
    publicPrefix: PUBLIC_PREFIX[framework ?? ""] ?? "",
    vercelAutoDeployOff: autoDeployOff(s.files.get("vercel.json")),
    envNames: Object.fromEntries(s.envNames),
    ...(wrangler ? { cloudflareNotPages: wrangler.pagesOutputDir === undefined } : {}),
  };
}

/** The provider id variable in the environment that is evidence for a provider (it names a project or site). */
const ID_ENV_EVIDENCE: Record<string, keyof IdEnv> = { vercel: "VERCEL_PROJECT_ID", neon: "NEON_PROJECT_ID", netlify: "NETLIFY_SITE_ID" };

function idEnvEvidence(id: string, env: IdEnv): string[] {
  const name = ID_ENV_EVIDENCE[id];
  return name && env[name] ? [`${name} in the environment`] : [];
}

/** The top-level keys of a Wrangler configuration that `init` uses: ids and the Pages marker, never secrets. */
interface WranglerConfig {
  file: string;
  name?: string;
  accountId?: string;
  pagesOutputDir?: string;
}

/** The first Wrangler configuration file present, read for `name`, `account_id` and `pages_build_output_dir`. */
function wranglerConfig(s: Signals): WranglerConfig | undefined {
  const file = WRANGLER_FILES.find((f) => s.files.has(f));
  if (file === undefined) return undefined;
  const text = s.files.get(file)!;
  const top = file.endsWith(".toml") ? tomlTopLevel(text) : jsonFile(stripJsonComments(text));
  const name = str(top.name);
  const accountId = str(top.account_id);
  const pagesOutputDir = str(top.pages_build_output_dir);
  return { file, ...(name ? { name } : {}), ...(accountId ? { accountId } : {}), ...(pagesOutputDir ? { pagesOutputDir } : {}) };
}

/** `key = "string"` pairs before the first `[table]` of a TOML file: enough for Wrangler's top-level ids. */
function tomlTopLevel(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
    if (m) out[m[1]!] = m[2] ?? m[3]!;
  }
  return out;
}

/** JSONC to JSON: line and block comments outside strings, and trailing commas, removed. */
function stripJsonComments(text: string): string {
  const noComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? "");
  return noComments.replace(/,(\s*[}\]])/g, "$1");
}

function cloudflareIds(w: WranglerConfig | undefined, env: IdEnv): Partial<StackDetection["ids"]> {
  const ids: Partial<StackDetection["ids"]> = {};
  if (w?.name) {
    ids.cloudflareProject = w.name;
    ids.cloudflareProjectFrom = w.file;
  }
  const account = str(env.CLOUDFLARE_ACCOUNT_ID) ?? w?.accountId;
  if (account) {
    ids.cloudflareAccount = account;
    ids.cloudflareAccountFrom = str(env.CLOUDFLARE_ACCOUNT_ID) ? "CLOUDFLARE_ACCOUNT_ID" : w!.file;
  }
  return ids;
}

const PUBLIC_PREFIX: Record<string, string> = { next: "NEXT_PUBLIC_", sveltekit: "PUBLIC_", astro: "PUBLIC_", nuxt: "NUXT_PUBLIC_", remix: "" };

function providerIds(s: Signals, env: IdEnv): StackDetection["ids"] {
  const ids: StackDetection["ids"] = {};
  const vercel = jsonFile(s.files.get(".vercel/project.json"));
  const vercelProject = env.VERCEL_PROJECT_ID ?? str(vercel.projectId);
  if (vercelProject) {
    ids.vercelProject = vercelProject;
    ids.vercelProjectFrom = env.VERCEL_PROJECT_ID ? "VERCEL_PROJECT_ID" : ".vercel/project.json";
  }
  const team = env.VERCEL_ORG_ID ?? str(vercel.orgId);
  if (team) ids.vercelTeam = team;
  // `neonctl set-context` writes `.neon` (`{ "projectId": … }`) in the working directory.
  const neonProject = env.NEON_PROJECT_ID ?? str(jsonFile(s.files.get(".neon")).projectId);
  if (neonProject) {
    ids.neonProject = neonProject;
    ids.neonProjectFrom = env.NEON_PROJECT_ID ? "NEON_PROJECT_ID" : ".neon";
  }
  // `supabase link` writes the linked project's ref to `supabase/.temp/project-ref`. (`project_id` in
  // `supabase/config.toml` names the local stack, not the remote project, so it is not used.)
  const supabaseRef = str(s.files.get("supabase/.temp/project-ref"));
  if (supabaseRef && /^[a-z]{20}$/.test(supabaseRef)) {
    ids.supabaseProject = supabaseRef;
    ids.supabaseProjectFrom = "supabase/.temp/project-ref";
  }
  return { ...ids, ...netlifyIds(s, env) };
}

/** `netlify link` writes `.netlify/state.json` (`{ "siteId": … }`); NETLIFY_SITE_ID is the same Project ID and wins. */
function netlifyIds(s: Signals, env: IdEnv): Pick<StackDetection["ids"], "netlifySite" | "netlifySiteFrom"> {
  const site = env.NETLIFY_SITE_ID ?? str(jsonFile(s.files.get(".netlify/state.json")).siteId);
  if (!site) return {};
  return { netlifySite: site, netlifySiteFrom: env.NETLIFY_SITE_ID ? "NETLIFY_SITE_ID" : ".netlify/state.json" };
}

function jsonFile(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** `vercel.json` with `git.deploymentEnabled: false` (all branches) means previews are not deployed automatically. */
function autoDeployOff(text: string | undefined): boolean {
  const git = jsonFile(text).git;
  return Boolean(git && typeof git === "object" && (git as Record<string, unknown>).deploymentEnabled === false);
}

/**
 * The database URL variable the app reads: the ORM's configuration first (Prisma's `url = env("…")`, the
 * `process.env.…_URL` in a Drizzle config), then the names in `.env*` files, then DATABASE_URL.
 */
function databaseVar(s: Signals): { databaseVar: string; databaseVarFrom?: string } {
  for (const f of PRISMA_SCHEMAS) {
    const m = /\burl\s*=\s*env\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)/.exec(s.files.get(f) ?? "");
    if (m) return { databaseVar: m[1]!, databaseVarFrom: f };
  }
  for (const f of DRIZZLE_CONFIGS) {
    const m = /process\.env\.([A-Z0-9_]*URL[A-Z0-9_]*)/.exec(s.files.get(f) ?? "");
    if (m) return { databaseVar: m[1]!, databaseVarFrom: f };
  }
  for (const name of ["DATABASE_URL", "POSTGRES_URL"]) {
    const files = s.envNames.get(name);
    if (files) return { databaseVar: name, databaseVarFrom: files[0] };
  }
  return { databaseVar: "DATABASE_URL" };
}

/**
 * Whether `id` (vercel, neon, clerk, next, …) was detected, as a thing of `kind` when given (the Prisma ORM and the
 * Prisma Postgres recipe share the id `prisma`).
 */
export function has(d: StackDetection, id: string, kind?: FindingKind): boolean {
  return d.found.some((f) => f.id === id && (kind === undefined || f.kind === kind));
}
