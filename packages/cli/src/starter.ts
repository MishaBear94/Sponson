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
export const NEON_PROJECT_HINT = "run `neonctl projects list`, or https://console.neon.tech → your project → Settings → General → Project ID";
export const CLOUDFLARE_ACCOUNT_HINT = "run `wrangler whoami`, or Cloudflare dashboard → Workers & Pages → Account ID (or set CLOUDFLARE_ACCOUNT_ID and run `sponson init` again)";
export const CLOUDFLARE_PROJECT_HINT = "run `wrangler pages project list`, or Cloudflare dashboard → Workers & Pages → your Pages project's name";

/** Each provider's credential variable, read when Sponson runs (never written into the plan). */
const CREDENTIALS: Record<string, string> = { vercel: "VERCEL_TOKEN", neon: "NEON_API_KEY", clerk: "CLERK_SECRET_KEY", cloudflare: "CLOUDFLARE_API_TOKEN" };

interface Shape {
  vercel: boolean;
  neon: boolean;
  clerk: boolean;
  cloudflare: boolean;
  deploy: boolean;
  assumed: boolean;
}

function shapeOf(d: StackDetection): Shape {
  const assumed = !has(d, "vercel") && !has(d, "neon") && !has(d, "cloudflare");
  const vercel = has(d, "vercel") || assumed;
  return { vercel, neon: has(d, "neon") || assumed, clerk: has(d, "clerk"), cloudflare: has(d, "cloudflare"), deploy: vercel && d.vercelAutoDeployOff, assumed };
}

/** The adapters the starter's lines use, for the "set these credentials" hint. */
export function credentialsFor(d: StackDetection): string[] {
  const s = shapeOf(d);
  return (["vercel", "neon", "clerk", "cloudflare"] as const).filter((a) => s[a] && (a !== "clerk" || s.vercel)).map((a) => CREDENTIALS[a]!);
}

export function composeStarter(d: StackDetection): Starter {
  const s = shapeOf(d);
  const todos: Todo[] = [];
  const out = [...header(d, s), "version: 1", "environments: [preview, production]", ...providers(d, s, todos), "", "changes:"];
  // Never empty: without Vercel or Neon the template assumes both.
  out.push(...dbLine(s), ...envLine(d, s), ...deployLine(s), ...clerkLine(s), ...pagesLine(d, s), ...orphanNotes(s));
  const text = out.join("\n").replace(/\n+$/, "") + "\n";
  return { text, todos, assumed: s.assumed };
}

function header(d: StackDetection, s: Shape): string[] {
  const out = [SCHEMA_LINE, "#", "# release.plan.yaml — everything that ships beside the code. Written by `sponson init`;", "# reference: https://github.com/MishaBear94/Sponson/blob/main/docs/plan-format.md"];
  if (s.assumed) {
    out.push(
      "#",
      "# Nothing Sponson manages (Vercel, Neon) was detected in this repository's files, so this is the template",
      "# for the most common stack: a Vercel app with a Neon database. Fill in the TODOs, or delete what you do not use.",
    );
  }
  if (d.found.length > 0) out.push("#", `# Detected: ${names(d.found)}.`);
  for (const u of d.unsupported) out.push(`# Not supported yet, so no line below manages it: ${u.name} — ${u.pointer}.`);
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
  if (s.neon) {
    const project = d.ids.neonProject ?? "proj_xxx";
    const note = d.ids.neonProjectFrom ? `# from ${d.ids.neonProjectFrom}` : todo(todos, "providers.neon.project", project, NEON_PROJECT_HINT);
    out.push(`  neon: { project: ${q(project)} }   ${note}`);
  }
  if (s.cloudflare) out.push(...cloudflareProvider(d, todos));
  return out.length > 0 ? ["providers:", ...out] : [];
}

function cloudflareProvider(d: StackDetection, todos: Todo[]): string[] {
  const account = d.ids.cloudflareAccount ?? "your-account-id";
  const project = d.ids.cloudflareProject ?? "your-pages-project";
  const notes = [
    d.ids.cloudflareAccountFrom ? `account from ${d.ids.cloudflareAccountFrom}` : todo(todos, "providers.cloudflare.account", account, CLOUDFLARE_ACCOUNT_HINT).slice(2),
    d.ids.cloudflareProjectFrom ? `project from ${d.ids.cloudflareProjectFrom}` : todo(todos, "providers.cloudflare.project", project, CLOUDFLARE_PROJECT_HINT).slice(2),
  ];
  return [`  cloudflare: { account: ${q(account)}, project: ${q(project)} }   # ${notes.join("; ")}`];
}

function todo(todos: Todo[], path: string, placeholder: string, hint: string): string {
  todos.push({ path, placeholder, hint });
  return `# TODO: ${hint}`;
}

function dbLine(s: Shape): string[] {
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

function envLine(d: StackDetection, s: Shape): string[] {
  if (!s.vercel) return [];
  const value = s.neon
    ? `      ${d.databaseVar}: { from: db.connection_string }   # ${d.databaseVarFrom ? `the name ${d.databaseVarFrom} uses; ` : ""}a reference, never a value`
    : `      ${d.publicPrefix}SPONSON_SCOPE: "\${ctx.scope}"   # an example (pr-42, main, …): replace with the variables your previews need`;
  return [
    "  # Preview variables for the current git branch only, so two pull requests never see each other's values.",
    "  - id: env",
    "    adapter: vercel",
    "    op: env",
    "    target: preview",
    "    values:",
    value,
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
  if (!s.clerk || !s.vercel) return [];
  const from = s.deploy ? "deploy.preview_url" : "env.preview_url";
  const note = s.deploy ? "known once the deploy line has finished" : "exists once Vercel has deployed this commit; the next `apply` finishes the line";
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

/** Detected providers that have nothing to connect to, said in the plan instead of silently dropped. */
function orphanNotes(s: Shape): string[] {
  const out: string[] = [];
  if (s.neon && !s.vercel && s.cloudflare) {
    out.push(
      "  # The branch's connection string (`{ from: db.connection_string }`) differs per pull request, and Pages preview",
      "  # variables are shared by every preview, so it cannot go there; pass it to your previews another way.",
    );
  } else if (s.neon && !s.vercel) {
    out.push("  # The branch's connection string (`{ from: db.connection_string }`) has no deploy target Sponson manages yet;", "  # pass it to yours by hand, or follow ROADMAP.md section 2 for Netlify, Railway and Fly.io.");
  }
  if (s.clerk && !s.vercel) out.push("  # Clerk was detected, but a redirect line needs a preview URL from a deploy target Sponson manages (Vercel).");
  return out;
}

function q(s: string): string {
  return JSON.stringify(s);
}
