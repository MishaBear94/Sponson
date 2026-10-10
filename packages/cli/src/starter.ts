/**
 * The plan `sponson init` writes when there is none, composed from what `detectStack` found: a line only for
 * what the repository uses, real ids where the files hold them, and a TODO with the exact place to look where
 * they do not. Pure: text in, text out.
 */
import { has, type Finding, type StackDetection, type UnsupportedFinding } from "./stack.js";

/** A placeholder left in the plan for the user to fill in. */
export interface Todo {
  /** Dotted path in the plan, e.g. `providers.neon.project`. */
  path: string;
  placeholder: string;
  /** Where to find the real value. */
  hint: string;
}

export interface Starter {
  text: string;
  todos: Todo[];
  /** Nothing Sponson manages was detected: the plan is the Vercel + Neon template. */
  assumed: boolean;
}

const SCHEMA_LINE = "# yaml-language-server: $schema=https://raw.githubusercontent.com/MishaBear94/Sponson/main/schema/release.plan.schema.json";

export const VERCEL_PROJECT_HINT =
  "run `vercel link` (it writes .vercel/project.json; then delete this file and run `sponson init` again), or Vercel dashboard → your project → Settings → General → Project ID";
export const NETLIFY_SITE_HINT =
  "run `netlify link` (it writes .netlify/state.json; then delete this file and run `sponson init` again), or Netlify UI → your project → Project configuration → General → Project ID";
export const NEON_PROJECT_HINT = "run `neonctl projects list`, or https://console.neon.tech → your project → Settings → General → Project ID";
export const PLANETSCALE_IDS_HINT = "the name slugs of your organization and database: run `pscale org list` and `pscale database list`, or see the URL https://app.planetscale.com/<organization>/<database>";
export const SUPABASE_PROJECT_HINT =
  "run `supabase link` (it writes supabase/.temp/project-ref), or `supabase projects list` (REFERENCE ID), or Supabase dashboard → Project Settings → General → Project ID";
export const CLOUDFLARE_ACCOUNT_HINT = "run `wrangler whoami`, or Cloudflare dashboard → Workers & Pages → Account ID (or set CLOUDFLARE_ACCOUNT_ID and run `sponson init` again)";
export const CLOUDFLARE_PROJECT_HINT = "run `wrangler pages project list`, or Cloudflare dashboard → Workers & Pages → your Pages project's name";

/** Each provider's credential variables, read when Sponson runs (never written into the plan). */
const CREDENTIALS: Record<string, string[]> = {
  vercel: ["VERCEL_TOKEN"],
  netlify: ["NETLIFY_AUTH_TOKEN"],
  neon: ["NEON_API_KEY"],
  planetscale: ["PLANETSCALE_SERVICE_TOKEN_ID", "PLANETSCALE_SERVICE_TOKEN"],
  clerk: ["CLERK_SECRET_KEY"],
  supabase: ["SUPABASE_ACCESS_TOKEN"],
  cloudflare: ["CLOUDFLARE_API_TOKEN"],
};

interface Shape {
  vercel: boolean;
  netlify: boolean;
  /** Cloudflare Pages: a third deploy target, whose preview variables are shared by every preview. */
  cloudflare: boolean;
  neon: boolean;
  /** The database lines use PlanetScale: detected, and Neon (which wins when both are) was not. */
  planetscale: boolean;
  clerk: boolean;
  launchdarkly: boolean;
  /** A Supabase preview branch is the database line (Supabase detected, neither Neon nor PlanetScale). */
  supabaseDb: boolean;
  /** The preview URL goes on a Supabase Auth allow-list (Supabase detected, and a preview URL from Vercel or Netlify). */
  supabaseAuth: boolean;
  /** Any line uses the supabase adapter. */
  supabase: boolean;
  deploy: boolean;
  assumed: boolean;
  prisma: boolean;
}

function shapeOf(d: StackDetection): Shape {
  // Database precedence when several are detected: Neon > PlanetScale > Supabase (one `db` line). A Supabase
  // auth_redirect line is still written whenever Supabase is present and there is a preview URL.
  // Netlify is a deploy target next to Vercel: its line takes the same database value.
  const netlify = has(d, "netlify");
  // Cloudflare Pages is a third deploy target, but its preview variables are shared by every preview, so per-PR
  // values (a database branch's connection string) are never wired into it.
  const cloudflare = has(d, "cloudflare");
  const assumed = !has(d, "vercel") && !netlify && !cloudflare && !has(d, "neon") && !has(d, "planetscale") && !has(d, "supabase");
  const vercel = has(d, "vercel") || assumed;
  const neon = has(d, "neon") || assumed;
  const planetscale = has(d, "planetscale") && !neon;
  const supabaseDb = has(d, "supabase") && !neon && !planetscale;
  const supabaseAuth = has(d, "supabase") && (vercel || netlify);
  return { vercel, netlify, cloudflare, neon, planetscale, clerk: has(d, "clerk"), launchdarkly: has(d, "launchdarkly"), supabaseDb, supabaseAuth, supabase: supabaseDb || supabaseAuth, deploy: vercel && d.vercelAutoDeployOff, assumed, prisma: has(d, "prisma") };
}

/** The adapters the starter's lines use, for the "set these credentials" hint. */
export function credentialsFor(d: StackDetection): string[] {
  const s = shapeOf(d);
  return (["vercel", "netlify", "cloudflare", "neon", "planetscale", "clerk", "supabase"] as const).filter((a) => s[a] && (a !== "clerk" || s.vercel || s.netlify)).flatMap((a) => CREDENTIALS[a]!);
}

export function composeStarter(d: StackDetection): Starter {
  const s = shapeOf(d);
  const todos: Todo[] = [];
  const out = [...header(d, s), "version: 1", "environments: [preview, production]", ...providers(d, s, todos), "", "changes:"];
  // Never empty: without Vercel, Netlify, Cloudflare Pages, Neon, PlanetScale or Supabase the template assumes Vercel and Neon.
  out.push(...dbLine(s), ...supabaseBranchLine(s), ...envLine(d, s), ...netlifyEnvLine(d, s), ...pagesLine(d, s), ...deployLine(s), ...clerkLine(s), ...supabaseAuthLine(s), ...flagLine(s), ...orphanNotes(s));
  const text = out.join("\n").replace(/\n+$/, "") + "\n";
  return { text, todos, assumed: s.assumed };
}

function header(d: StackDetection, s: Shape): string[] {
  const out = [SCHEMA_LINE, "#", "# release.plan.yaml — everything that ships beside the code. Written by `sponson init`;", "# reference: https://github.com/MishaBear94/Sponson/blob/main/docs/plan-format.md"];
  if (s.assumed) {
    out.push(
      "#",
      "# Nothing Sponson manages (Vercel, Netlify, Cloudflare Pages, Neon, PlanetScale) was detected in this repository's files, so this is the template",
      "# for the most common stack: a Vercel app with a Neon database. Fill in the TODOs, or delete what you do not use.",
    );
  }
  if (d.found.length > 0) out.push("#", `# Detected: ${names(d.found)}.`);
  for (const u of d.unsupported) out.push(`# Not supported yet, so no line below manages it: ${u.name} — ${u.pointer}.`);
  if (s.neon && has(d, "planetscale")) {
    out.push("# PlanetScale was detected too, but the database lines below use Neon; for PlanetScale, see the `planetscale.branch` section of the reference.");
  }
  out.push("#", "# Credentials are never written here: Sponson reads them from the environment when it runs.");
  return out;
}

export function names(fs: Finding[] | UnsupportedFinding[]): string {
  return fs.map((f) => f.name).join(", ");
}

function providers(d: StackDetection, s: Shape, todos: Todo[]): string[] {
  const out: string[] = [];
  if (s.vercel) {
    const project = d.ids.vercelProject ?? "prj_xxx";
    const team = d.ids.vercelTeam ? `, team: ${q(d.ids.vercelTeam)}` : "";
    const note = d.ids.vercelProjectFrom ? `# from ${d.ids.vercelProjectFrom}` : todo(todos, "providers.vercel.project", project, VERCEL_PROJECT_HINT);
    out.push(`  vercel: { project: ${q(project)}${team} }   ${note}`);
  }
  if (s.netlify) out.push(netlifyProvider(d, todos));
  if (s.cloudflare) out.push(cloudflareProvider(d, todos));
  if (s.neon) {
    const project = d.ids.neonProject ?? "proj_xxx";
    const note = d.ids.neonProjectFrom ? `# from ${d.ids.neonProjectFrom}` : todo(todos, "providers.neon.project", project, NEON_PROJECT_HINT);
    out.push(`  neon: { project: ${q(project)} }   ${note}`);
  }
  if (s.planetscale) {
    const note = todo(todos, "providers.planetscale.organization", "my-org", PLANETSCALE_IDS_HINT);
    todos.push({ path: "providers.planetscale.database", placeholder: "my-db", hint: PLANETSCALE_IDS_HINT });
    out.push(`  planetscale: { organization: "my-org", database: "my-db" }   ${note}`);
  }
  if (s.supabase) {
    const project = d.ids.supabaseProject ?? "abcdefghijklmnopqrst";
    const note = d.ids.supabaseProjectFrom ? `# from ${d.ids.supabaseProjectFrom}` : todo(todos, "providers.supabase.project", project, SUPABASE_PROJECT_HINT);
    out.push(`  supabase: { project: ${q(project)} }   ${note}`);
  }
  return out.length > 0 ? ["providers:", ...out] : [];
}

function netlifyProvider(d: StackDetection, todos: Todo[]): string {
  const site = d.ids.netlifySite ?? "your-site-id";
  const note = d.ids.netlifySiteFrom ? `# from ${d.ids.netlifySiteFrom}` : todo(todos, "providers.netlify.site", site, NETLIFY_SITE_HINT);
  return `  netlify: { site: ${q(site)} }   ${note}`;
}

function cloudflareProvider(d: StackDetection, todos: Todo[]): string {
  const account = d.ids.cloudflareAccount ?? "your-account-id";
  const project = d.ids.cloudflareProject ?? "your-pages-project";
  const notes = [
    d.ids.cloudflareAccountFrom ? `account from ${d.ids.cloudflareAccountFrom}` : todo(todos, "providers.cloudflare.account", account, CLOUDFLARE_ACCOUNT_HINT).slice(2),
    d.ids.cloudflareProjectFrom ? `project from ${d.ids.cloudflareProjectFrom}` : todo(todos, "providers.cloudflare.project", project, CLOUDFLARE_PROJECT_HINT).slice(2),
  ];
  return `  cloudflare: { account: ${q(account)}, project: ${q(project)} }   # ${notes.join("; ")}`;
}

function todo(todos: Todo[], path: string, placeholder: string, hint: string): string {
  todos.push({ path, placeholder, hint });
  return `# TODO: ${hint}`;
}

function dbLine(s: Shape): string[] {
  if (s.planetscale) return planetscaleLines(s);
  if (!s.neon) return [];
  return [
    "  # One Neon branch per pull request (sponson/preview/pr-<n>), forked from `main`; deleted by `apply --destroy`.",
    "  - id: db",
    "    adapter: neon",
    "    op: branch",
    "    parent: main",
    "    environments: [preview]",
    "",
  ];
}

function planetscaleLines(s: Shape): string[] {
  return [
    "  # One PlanetScale development branch per pull request (sponson-preview-pr-<n>), from `main`; deleted by `apply --destroy`.",
    "  - id: db",
    "    adapter: planetscale",
    "    op: branch",
    "    parent: main",
    "    environments: [preview]",
    "",
    "  # A password on that branch. PlanetScale shows its plaintext only when it is created, so the lines that use",
    "  # `dbpw.connection_string` must stay in this plan: later runs keep what they received and never rotate it.",
    "  - id: dbpw",
    "    adapter: planetscale",
    "    op: password",
    "    branch: { from: db.name }",
    ...(s.prisma ? ['    connection_params: "sslaccept=strict"   # the TLS parameter Prisma reads'] : []),
    "    environments: [preview]",
    "",
  ];
}

function supabaseBranchLine(s: Shape): string[] {
  if (!s.supabaseDb) return [];
  return [
    "  # One Supabase preview branch per pull request (sponson-preview-pr-<n>; branching must be enabled on the project),",
    "  # waited for until it is up; deleted by `apply --destroy`.",
    "  - id: db",
    "    adapter: supabase",
    "    op: branch",
    "    environments: [preview]",
    "",
  ];
}

/** The preview variables both deploy targets get: the database's connection string by reference, or an example. */
function previewValues(d: StackDetection, s: Shape): string[] {
  const why = `# ${d.databaseVarFrom ? `the name ${d.databaseVarFrom} uses; ` : ""}a reference, never a value`;
  const values = [s.planetscale
    ? `      ${d.databaseVar}: { from: dbpw.connection_string }   ${why}`
    : s.neon || s.supabaseDb
      ? `      ${d.databaseVar}: { from: db.connection_string }   ${why}`
      : `      ${d.publicPrefix}SPONSON_SCOPE: "\${ctx.scope}"   # an example (pr-42, main, …): replace with the variables your previews need`];
  // The branch's API keys are not an output yet: its anon/publishable key still has to be set by hand.
  if (s.supabaseDb) values.push(`      ${d.publicPrefix}SUPABASE_URL: { from: db.api_url }   # the branch's own API URL; set its API key by hand for now`);
  return values;
}

/** The Netlify line's id: `env`, unless a Vercel line already has it. */
function netlifyId(s: Shape): string {
  return s.vercel ? "netlify-env" : "env";
}

function netlifyEnvLine(d: StackDetection, s: Shape): string[] {
  if (!s.netlify) return [];
  return [
    "  # Values for the current git branch, which Netlify uses for its Deploy Previews: two pull requests never see each other's values.",
    `  - id: ${netlifyId(s)}`,
    "    adapter: netlify",
    "    op: env",
    "    values:",
    ...previewValues(d, s),
    "    environments: [preview]",
    "",
  ];
}

/**
 * Cloudflare Pages preview variables. Pages has one set for every preview deployment, so only values that are the
 * same for every pull request go here; a per-PR database is said in a comment instead (see `orphanNotes`).
 */
function pagesLine(d: StackDetection, s: Shape): string[] {
  if (!s.cloudflare) return [];
  const worker = d.cloudflareNotPages
    ? ["  # The Wrangler configuration has no `pages_build_output_dir`: if it describes a Worker, not a Pages project, delete", "  # this line (Workers variables are not managed yet)."]
    : [];
  return [
    "  # Cloudflare Pages preview variables. Pages has ONE set of preview variables, shared by every preview deployment",
    "  # (there are no per-branch values): only values that are the same for every pull request belong here; a second",
    "  # pull request that sets another value is refused. Secrets go under `secrets:` as `{ secret: \"env://NAME\" }`.",
    ...worker,
    "  - id: pages-env",
    "    adapter: cloudflare",
    "    op: pages_env",
    "    target: preview",
    "    vars:",
    `      ${d.publicPrefix}SPONSON_ENV: "\${ctx.env}"   # an example: replace with the variables your previews need`,
    "    environments: [preview]",
    "",
  ];
}

/** Where a preview URL comes from: Vercel's deploy or env line, else Netlify's Deploy Preview. */
function previewUrlFrom(s: Shape): [string, string] {
  if (!s.vercel) return [`${netlifyId(s)}.deploy_preview_url`, "exists once Netlify has built this commit's Deploy Preview; the next `apply` finishes the line"];
  return s.deploy ? ["deploy.preview_url", "known once the deploy line has finished"] : ["env.preview_url", "exists once Vercel has deployed this commit; the next `apply` finishes the line"];
}

function envLine(d: StackDetection, s: Shape): string[] {
  if (!s.vercel) return [];
  const values = previewValues(d, s);
  return [
    "  # Preview variables for the current git branch only, so two pull requests never see each other's values.",
    "  - id: env",
    "    adapter: vercel",
    "    op: env",
    "    target: preview",
    "    values:",
    ...values,
    "    environments: [preview]",
    "",
  ];
}

function deployLine(s: Shape): string[] {
  if (!s.deploy) return [];
  return [
    "  # vercel.json turns off automatic Git deployments, so Sponson starts the preview deployment itself, after the variables.",
    "  - id: deploy",
    "    adapter: vercel",
    "    op: deploy",
    "    depends_on: [env]",
    "    environments: [preview]",
    "",
  ];
}

function clerkLine(s: Shape): string[] {
  if (!s.clerk || (!s.vercel && !s.netlify)) return [];
  const [from, note] = previewUrlFrom(s);
  return [
    "  # The preview's URL on the Clerk instance's redirect allow-list (the instance of CLERK_SECRET_KEY: use a development one).",
    "  - id: callback",
    "    adapter: clerk",
    "    op: redirect_allow",
    `    url: { from: ${from} }   # ${note}`,
    "    environments: [preview]",
    "",
  ];
}

function supabaseAuthLine(s: Shape): string[] {
  if (!s.supabaseAuth) return [];
  const [from, note] = previewUrlFrom(s);
  const whose = s.supabaseDb ? "the preview's own branch (a branch has its own Auth config)" : "the project";
  return [
    `  # The preview's URL on the Auth redirect allow-list (Authentication → URL Configuration) of ${whose}.`,
    "  - id: auth_redirect",
    "    adapter: supabase",
    "    op: auth_redirect",
    ...(s.supabaseDb ? ["    project: { from: db.project_ref }"] : []),
    `    url: { from: ${from} }   # ${note}`,
    "    environments: [preview]",
    "",
  ];
}

/**
 * LaunchDarkly: a commented example, because nothing in the repository names the flag, the project or the
 * environment, and a guessed flag key would fail every plan.
 */
function flagLine(s: Shape): string[] {
  if (!s.launchdarkly) return [];
  const from = s.deploy ? "deploy.preview_url" : "env.preview_url";
  const key = s.vercel ? [`  #   context_kind: url              # the context kind your app evaluates the preview URL as`, `  #   key: { from: ${from} }`] : [`  #   # key: defaults to the scope (pr-42); context_kind to user`];
  return [
    "  # LaunchDarkly was detected. To turn a flag on for each preview, add under `providers:`",
    "  #   launchdarkly: { project: <project key>, environment: <environment key> }   # a preview or test environment",
    "  # (LAUNCHDARKLY_ACCESS_TOKEN is read from the environment) and uncomment this line:",
    "  # - id: flag",
    "  #   adapter: launchdarkly",
    "  #   op: flag_target",
    "  #   flag: <flag key>",
    ...key,
    "  #   variation: true",
    "  #   environments: [preview]",
    "",
  ];
}

/** Detected providers that have nothing to connect to, said in the plan instead of silently dropped. */
function orphanNotes(s: Shape): string[] {
  const out: string[] = [];
  if (s.vercel || s.netlify) return out;
  if (s.cloudflare && (s.neon || s.planetscale || s.supabaseDb)) {
    out.push(
      "  # The database branch's connection string differs per pull request, and Cloudflare Pages preview variables are",
      "  # shared by every preview, so it cannot go there; pass it to your previews another way.",
    );
  } else out.push(...databaseOrphanNotes(s));
  if (s.clerk) out.push("  # Clerk was detected, but a redirect line needs a preview URL from a deploy target Sponson manages (Vercel, Netlify).");
  return out;
}

/** A database line's outputs when no deploy target Sponson manages can take them. */
function databaseOrphanNotes(s: Shape): string[] {
  const out: string[] = [];
  if (s.supabaseDb) {
    out.push("  # The branch's outputs (`{ from: db.connection_string }`, `db.api_url`) have no deploy target Sponson manages yet;", "  # pass them to yours by hand, or follow ROADMAP.md section 2 for Railway and Fly.io.");
  }
  if (s.neon) {
    out.push("  # The branch's connection string (`{ from: db.connection_string }`) has no deploy target Sponson manages yet;", "  # pass it to yours by hand, or follow ROADMAP.md section 2 for Railway and Fly.io.");
  }
  if (s.planetscale) {
    out.push(
      "  # The password's connection string (`{ from: dbpw.connection_string }`) has no deploy target Sponson manages yet,",
      "  # and PlanetScale shows it only once: follow ROADMAP.md section 2 for Railway and Fly.io.",
    );
  }
  return out;
}

function q(s: string): string {
  return JSON.stringify(s);
}
