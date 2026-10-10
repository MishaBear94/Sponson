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
export const PLANETSCALE_IDS_HINT = "the name slugs of your organization and database: run `pscale org list` and `pscale database list`, or see the URL https://app.planetscale.com/<organization>/<database>";

/** Each provider's credential variables, read when Sponson runs (never written into the plan). */
const CREDENTIALS: Record<string, string[]> = {
  vercel: ["VERCEL_TOKEN"],
  neon: ["NEON_API_KEY"],
  planetscale: ["PLANETSCALE_SERVICE_TOKEN_ID", "PLANETSCALE_SERVICE_TOKEN"],
  clerk: ["CLERK_SECRET_KEY"],
};

interface Shape {
  vercel: boolean;
  neon: boolean;
  /** The database lines use PlanetScale: detected, and Neon (which wins when both are) was not. */
  planetscale: boolean;
  clerk: boolean;
  deploy: boolean;
  assumed: boolean;
  prisma: boolean;
}

function shapeOf(d: StackDetection): Shape {
  const assumed = !has(d, "vercel") && !has(d, "neon") && !has(d, "planetscale");
  const vercel = has(d, "vercel") || assumed;
  const neon = has(d, "neon") || assumed;
  return { vercel, neon, planetscale: has(d, "planetscale") && !neon, clerk: has(d, "clerk"), deploy: vercel && d.vercelAutoDeployOff, assumed, prisma: has(d, "prisma") };
}

/** The adapters the starter's lines use, for the "set these credentials" hint. */
export function credentialsFor(d: StackDetection): string[] {
  const s = shapeOf(d);
  return (["vercel", "neon", "planetscale", "clerk"] as const).filter((a) => s[a] && (a !== "clerk" || s.vercel)).flatMap((a) => CREDENTIALS[a]!);
}

export function composeStarter(d: StackDetection): Starter {
  const s = shapeOf(d);
  const todos: Todo[] = [];
  const out = [...header(d, s), "version: 1", "environments: [preview, production]", ...providers(d, s, todos), "", "changes:"];
  // Never empty: without Vercel or Neon the template assumes both.
  out.push(...dbLine(s), ...envLine(d, s), ...deployLine(s), ...clerkLine(s), ...orphanNotes(s));
  const text = out.join("\n").replace(/\n+$/, "") + "\n";
  return { text, todos, assumed: s.assumed };
}

function header(d: StackDetection, s: Shape): string[] {
  const out = [SCHEMA_LINE, "#", "# release.plan.yaml — everything that ships beside the code. Written by `sponson init`;", "# reference: https://github.com/MishaBear94/Sponson/blob/main/docs/plan-format.md"];
  if (s.assumed) {
    out.push(
      "#",
      "# Nothing Sponson manages (Vercel, Neon, PlanetScale) was detected in this repository's files, so this is the template",
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
  return out.length > 0 ? ["providers:", ...out] : [];
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

function envLine(d: StackDetection, s: Shape): string[] {
  if (!s.vercel) return [];
  const why = `# ${d.databaseVarFrom ? `the name ${d.databaseVarFrom} uses; ` : ""}a reference, never a value`;
  const value = s.planetscale
    ? `      ${d.databaseVar}: { from: dbpw.connection_string }   ${why}`
    : s.neon
      ? `      ${d.databaseVar}: { from: db.connection_string }   ${why}`
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

/** Detected providers that have nothing to connect to, said in the plan instead of silently dropped. */
function orphanNotes(s: Shape): string[] {
  const out: string[] = [];
  if (s.neon && !s.vercel) {
    out.push("  # The branch's connection string (`{ from: db.connection_string }`) has no deploy target Sponson manages yet;", "  # pass it to yours by hand, or follow ROADMAP.md section 2 for Netlify, Railway and Fly.io.");
  }
  if (s.planetscale && !s.vercel) {
    out.push(
      "  # The password's connection string (`{ from: dbpw.connection_string }`) has no deploy target Sponson manages yet,",
      "  # and PlanetScale shows it only once: follow ROADMAP.md section 2 for Netlify, Railway and Fly.io.",
    );
  }
  if (s.clerk && !s.vercel) out.push("  # Clerk was detected, but a redirect line needs a preview URL from a deploy target Sponson manages (Vercel).");
  return out;
}

function q(s: string): string {
  return JSON.stringify(s);
}
