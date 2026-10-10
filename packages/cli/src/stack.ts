/**
 * Stack detection for `sponson init`: what a repository uses, read from its files alone. No network, no
 * credentials, no command spawned. Everything here is a pure function over a `RepoReader`, so the unit tests
 * feed it in-memory fixtures.
 *
 * Secret values never leave this module, and most are never even looked at: from `.env*` files only variable
 * names are kept. The one exception is a database URL, whose host is classified against known provider domains
 * (`*.neon.tech`, `*.supabase.co`, …) inside `dbHostProvider`; the URL itself, its credentials and the host are
 * dropped there and only the provider's id comes out. Ids that are not secrets (`.vercel/project.json`, `.neon`,
 * `.netlify/state.json`, `VERCEL_PROJECT_ID` / `VERCEL_ORG_ID` / `NEON_PROJECT_ID` / `NETLIFY_SITE_ID` in the process
 * environment) are read as values.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Reads a file of the repository by relative path; `null` when it does not exist or cannot be read. */
export interface RepoReader {
  read(path: string): Promise<string | null>;
}

/** The real file system under `cwd`. */
export function fsReader(cwd: string): RepoReader {
  return { read: (path) => readFile(join(cwd, path), "utf8").catch(() => null) };
}

export type FindingKind = "provider" | "framework" | "orm" | "service";

/** One thing the repository uses, and why Sponson thinks so (file names, dependency and variable names only). */
export interface Finding {
  id: string;
  name: string;
  kind: FindingKind;
  evidence: string[];
}

/** Something detected that no built-in adapter manages yet, with where to follow or ask for it. */
export interface UnsupportedFinding extends Finding {
  pointer: string;
}

export interface StackDetection {
  /** What Sponson can use, in a fixed order: providers (vercel, neon, clerk, netlify), then frameworks, then ORMs. */
  found: Finding[];
  /** Detected but not managed by any built-in adapter. Never silently dropped. */
  unsupported: UnsupportedFinding[];
  ids: { vercelProject?: string; vercelTeam?: string; vercelProjectFrom?: string; neonProject?: string; neonProjectFrom?: string; netlifySite?: string; netlifySiteFrom?: string };
  /** The variable the app reads its database URL from (DATABASE_URL unless the code says otherwise). */
  databaseVar: string;
  /** Where `databaseVar` came from, for the comment in the plan; undefined for the default. */
  databaseVarFrom?: string;
  /** The framework's prefix for variables the browser may see (`NEXT_PUBLIC_`, `PUBLIC_`, …); "" when none. */
  publicPrefix: string;
  /** `vercel.json` turns off automatic Git deployments, so the plan has to start the deploy itself. */
  vercelAutoDeployOff: boolean;
}

// ---------------------------------------------------------------------------
// Signals: what the files say, before any rule interprets it
// ---------------------------------------------------------------------------

/** `.env*` files whose variable names (never values) are read. Examples first: they list what the app needs. */
export const ENV_FILES = [".env.example", ".env.sample", ".env.template", ".env.local", ".env", ".env.development", ".env.development.local"];

/** Files whose mere presence is a signal. */
const MARKER_FILES = [
  "vercel.json", ".vercel/project.json", ".neon", "supabase/config.toml", "netlify.toml", ".netlify/state.json",
  "wrangler.toml", "wrangler.json", "wrangler.jsonc", "fly.toml", "railway.json", "railway.toml", "firebase.json",
  "sentry.client.config.ts", "sentry.client.config.js", "sentry.server.config.ts", "sentry.server.config.js",
  "prisma/schema.prisma", "schema.prisma", "drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs", "drizzle.config.cjs",
];

interface Signals {
  deps: Set<string>;
  /** Variable name → the files that mention it. */
  envNames: Map<string, string[]>;
  /** Provider id → evidence, from database URL hosts. */
  dbHosts: Map<string, string[]>;
  files: Map<string, string>;
}

async function gatherSignals(reader: RepoReader): Promise<Signals> {
  const files = new Map<string, string>();
  for (const f of [...MARKER_FILES, "package.json"]) {
    const text = await reader.read(f);
    if (text !== null) files.set(f, text);
  }
  const envNames = new Map<string, string[]>();
  const dbHosts = new Map<string, string[]>();
  for (const f of ENV_FILES) {
    const text = await reader.read(f);
    if (text === null) continue;
    for (const { name, provider } of scanEnvFile(text)) {
      envNames.set(name, [...(envNames.get(name) ?? []), f]);
      if (provider) dbHosts.set(provider, [...(dbHosts.get(provider) ?? []), `${name} in ${f} points at ${HOST_RULES.find((h) => h.provider === provider)!.label}`]);
    }
  }
  return { deps: dependencyNames(files.get("package.json")), envNames, dbHosts, files };
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
 * The variables an `.env` file declares: their names, and for a database URL the provider its host belongs to.
 * The value is never returned.
 */
export function scanEnvFile(text: string): Array<{ name: string; provider?: string }> {
  const out: Array<{ name: string; provider?: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    const provider = dbHostProvider(m[2]!);
    out.push(provider ? { name: m[1]!, provider } : { name: m[1]! });
  }
  return out;
}

const HOST_RULES = [
  { provider: "neon", suffix: /\.neon\.tech$/, label: "*.neon.tech" },
  { provider: "supabase", suffix: /\.supabase\.(co|com)$/, label: "*.supabase.co" },
  { provider: "planetscale", suffix: /\.psdb\.cloud$/, label: "*.psdb.cloud" },
  { provider: "turso", suffix: /\.turso\.io$/, label: "*.turso.io" },
];

/** Which provider a database URL's host belongs to. Only the provider id leaves; the URL is dropped here. */
function dbHostProvider(raw: string): string | undefined {
  const value = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
  if (!/^(postgres(ql)?|mysql|libsql):\/\//i.test(value)) return undefined;
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return HOST_RULES.find((h) => h.suffix.test(host))?.provider;
}

// ---------------------------------------------------------------------------
// Rules: one table row per thing Sponson recognises
// ---------------------------------------------------------------------------

const ROADMAP_ADAPTERS = "ROADMAP.md, section 2 (https://github.com/MishaBear94/Sponson/blob/main/ROADMAP.md#2-more-adapters)";
const NEW_ISSUE = "open or upvote an issue: https://github.com/MishaBear94/Sponson/issues";

interface Rule {
  id: string;
  name: string;
  kind: FindingKind;
  /** Dependency names (exact) or prefixes ending in `/`. */
  deps?: string[];
  /** Variable names in `.env*` files. */
  env?: RegExp;
  files?: string[];
  /** For unsupported services: where to follow it. Absent means Sponson supports it. */
  pointer?: string;
}

/** What Sponson manages (or uses to name variables). Order is the order of the summary. */
const SUPPORTED: Rule[] = [
  { id: "vercel", name: "Vercel", kind: "provider", deps: ["vercel", "@vercel/"], env: /^VERCEL_/, files: ["vercel.json", ".vercel/project.json"] },
  { id: "neon", name: "Neon", kind: "provider", deps: ["@neondatabase/", "@prisma/adapter-neon", "neonctl"], env: /^NEON_/, files: [".neon"] },
  { id: "clerk", name: "Clerk", kind: "provider", deps: ["@clerk/"], env: /^(NEXT_PUBLIC_|PUBLIC_|VITE_|NUXT_PUBLIC_)?CLERK_/ },
  { id: "netlify", name: "Netlify", kind: "provider", deps: ["@netlify/", "netlify-cli"], env: /^NETLIFY_/, files: ["netlify.toml", ".netlify/state.json"] },
  { id: "next", name: "Next.js", kind: "framework", deps: ["next"] },
  { id: "remix", name: "Remix", kind: "framework", deps: ["@remix-run/"] },
  { id: "sveltekit", name: "SvelteKit", kind: "framework", deps: ["@sveltejs/kit"] },
  { id: "astro", name: "Astro", kind: "framework", deps: ["astro"] },
  { id: "nuxt", name: "Nuxt", kind: "framework", deps: ["nuxt"] },
  { id: "prisma", name: "Prisma", kind: "orm", deps: ["prisma", "@prisma/client"], files: ["prisma/schema.prisma", "schema.prisma"] },
  { id: "drizzle", name: "Drizzle", kind: "orm", deps: ["drizzle-orm", "drizzle-kit"], files: ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs", "drizzle.config.cjs"] },
];

/** Detected and reported, but not managed yet. Never silently ignored. */
const UNSUPPORTED: Rule[] = [
  { id: "supabase", name: "Supabase", kind: "service", deps: ["@supabase/"], env: /^(NEXT_PUBLIC_|PUBLIC_|VITE_)?SUPABASE_/, files: ["supabase/config.toml"], pointer: `database branches and Auth redirect URLs: ${ROADMAP_ADAPTERS}; issue #16 (https://github.com/MishaBear94/Sponson/issues/16)` },
  { id: "planetscale", name: "PlanetScale", kind: "service", deps: ["@planetscale/"], env: /^PLANETSCALE_/, pointer: `database branches: ${ROADMAP_ADAPTERS}` },
  { id: "turso", name: "Turso", kind: "service", deps: ["@libsql/client"], env: /^TURSO_/, pointer: NEW_ISSUE },
  { id: "auth0", name: "Auth0", kind: "service", deps: ["auth0", "@auth0/"], env: /^AUTH0_/, pointer: "allowed callback URLs: issue #16 (https://github.com/MishaBear94/Sponson/issues/16)" },
  { id: "cloudflare", name: "Cloudflare", kind: "service", deps: ["wrangler", "@cloudflare/"], env: /^(CLOUDFLARE_|CF_)/, files: ["wrangler.toml", "wrangler.json", "wrangler.jsonc"], pointer: NEW_ISSUE },
  { id: "railway", name: "Railway", kind: "service", env: /^RAILWAY_/, files: ["railway.json", "railway.toml"], pointer: `deploy-target env vars: ${ROADMAP_ADAPTERS}` },
  { id: "fly", name: "Fly.io", kind: "service", files: ["fly.toml"], env: /^FLY_/, pointer: `deploy-target env vars: ${ROADMAP_ADAPTERS}` },
  { id: "firebase", name: "Firebase", kind: "service", deps: ["firebase", "firebase-admin"], env: /^(NEXT_PUBLIC_|PUBLIC_|VITE_)?FIREBASE_/, files: ["firebase.json"], pointer: NEW_ISSUE },
  { id: "launchdarkly", name: "LaunchDarkly", kind: "service", deps: ["@launchdarkly/", "launchdarkly-node-server-sdk", "launchdarkly-js-client-sdk", "launchdarkly-react-client-sdk"], env: /^(NEXT_PUBLIC_)?LAUNCHDARKLY_/, pointer: "feature flags: issue #15 (https://github.com/MishaBear94/Sponson/issues/15)" },
  { id: "posthog", name: "PostHog", kind: "service", deps: ["posthog-js", "posthog-node"], env: /^(NEXT_PUBLIC_|PUBLIC_|VITE_)?POSTHOG_/, pointer: `feature flags, a second provider: ${ROADMAP_ADAPTERS}` },
  { id: "stripe", name: "Stripe", kind: "service", deps: ["stripe", "@stripe/"], env: /^(NEXT_PUBLIC_|PUBLIC_|VITE_)?STRIPE_/, pointer: `${NEW_ISSUE} (its keys can already be passed as \`{ secret: "env://STRIPE_SECRET_KEY" }\`)` },
  { id: "sentry", name: "Sentry", kind: "service", deps: ["@sentry/"], env: /^(NEXT_PUBLIC_)?SENTRY_/, files: ["sentry.client.config.ts", "sentry.client.config.js", "sentry.server.config.ts", "sentry.server.config.js"], pointer: `${NEW_ISSUE} (its DSN can already be passed as a Vercel variable)` },
];

function evidenceFor(rule: Rule, s: Signals): string[] {
  const ev: string[] = [];
  for (const d of s.deps) if (rule.deps?.some((p) => (p.endsWith("/") ? d.startsWith(p) : d === p))) ev.push(`package.json: ${d}`);
  for (const f of rule.files ?? []) if (s.files.has(f)) ev.push(f);
  const names = [...s.envNames.keys()].filter((n) => rule.env?.test(n));
  if (names.length > 0) ev.push(`${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""} in ${unique(names.flatMap((n) => s.envNames.get(n)!)).join(", ")}`);
  ev.push(...(s.dbHosts.get(rule.id) ?? []));
  return ev;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** The variables that may carry provider ids into `init` (ids, not secrets). */
export type IdEnv = Partial<Record<"VERCEL_PROJECT_ID" | "VERCEL_ORG_ID" | "NEON_PROJECT_ID" | "NETLIFY_SITE_ID", string>>;

/**
 * Detect the stack of the repository `reader` reads. `env` is the process environment, from which only the
 * provider id variables of `IdEnv` are read (they win over the files, as `init` always did).
 */
export async function detectStack(reader: RepoReader, env: IdEnv = {}): Promise<StackDetection> {
  const s = await gatherSignals(reader);
  const ids = providerIds(s, env);
  const found: Finding[] = [];
  for (const rule of SUPPORTED) {
    const evidence = evidenceFor(rule, s);
    if (rule.id === "vercel" && env.VERCEL_PROJECT_ID) evidence.push("VERCEL_PROJECT_ID in the environment");
    if (rule.id === "neon" && env.NEON_PROJECT_ID) evidence.push("NEON_PROJECT_ID in the environment");
    if (rule.id === "netlify" && env.NETLIFY_SITE_ID) evidence.push("NETLIFY_SITE_ID in the environment");
    if (evidence.length > 0) found.push({ id: rule.id, name: rule.name, kind: rule.kind, evidence });
  }
  const unsupported: UnsupportedFinding[] = [];
  for (const rule of UNSUPPORTED) {
    const evidence = evidenceFor(rule, s);
    if (evidence.length > 0) unsupported.push({ id: rule.id, name: rule.name, kind: rule.kind, evidence, pointer: rule.pointer! });
  }
  const framework = found.find((f) => f.kind === "framework")?.id;
  return {
    found,
    unsupported,
    ids,
    ...databaseVar(s),
    publicPrefix: PUBLIC_PREFIX[framework ?? ""] ?? "",
    vercelAutoDeployOff: autoDeployOff(s.files.get("vercel.json")),
  };
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
  // `netlify link` writes `.netlify/state.json` (`{ "siteId": … }`); NETLIFY_SITE_ID is the same Project ID.
  const netlifySite = env.NETLIFY_SITE_ID ?? str(jsonFile(s.files.get(".netlify/state.json")).siteId);
  if (netlifySite) {
    ids.netlifySite = netlifySite;
    ids.netlifySiteFrom = env.NETLIFY_SITE_ID ? "NETLIFY_SITE_ID" : ".netlify/state.json";
  }
  return ids;
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
  for (const f of ["prisma/schema.prisma", "schema.prisma"]) {
    const m = /\burl\s*=\s*env\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)/.exec(s.files.get(f) ?? "");
    if (m) return { databaseVar: m[1]!, databaseVarFrom: f };
  }
  for (const f of ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs", "drizzle.config.cjs"]) {
    const m = /process\.env\.([A-Z0-9_]*URL[A-Z0-9_]*)/.exec(s.files.get(f) ?? "");
    if (m) return { databaseVar: m[1]!, databaseVarFrom: f };
  }
  for (const name of ["DATABASE_URL", "POSTGRES_URL"]) {
    const files = s.envNames.get(name);
    if (files) return { databaseVar: name, databaseVarFrom: files[0] };
  }
  return { databaseVar: "DATABASE_URL" };
}

/** Whether `id` (vercel, neon, clerk, next, …) was detected. */
export function has(d: StackDetection, id: string): boolean {
  return d.found.some((f) => f.id === id);
}
