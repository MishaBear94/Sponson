import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitBranchReceiptStore, planRun, type Drift, type Redactor } from "@sponson/core";
import { isSeq, parseDocument } from "yaml";
import { buildRunContext, planPathFor, toRunOptions, type GlobalOpts, type IO } from "../context.js";

export interface InitOpts extends GlobalOpts {
  /** Adopt only the unmanaged resource whose key, id or label matches. */
  adopt?: string;
}

/**
 * `init` always makes the plan catch up with reality: it writes a starter plan when there is none,
 * and adopts unmanaged resources into an existing one. It never writes values, only references.
 */
export async function initCommand(opts: InitOpts, io: IO, redactor: Redactor): Promise<number> {
  const planPath = planPathFor(opts, io);
  const existing = await readFile(planPath, "utf8").catch(() => null);
  const added: string[] = [];

  if (existing === null) {
    await writeFile(planPath, await starterPlan(io), "utf8");
    io.stdout.write(`Wrote ${planPath}\n`);
  } else {
    const rc = await buildRunContext(opts, io, redactor);
    const result = await planRun(toRunOptions(rc, io));
    let unmanaged = result.drift.filter((d) => d.kind === "unmanaged");
    if (opts.adopt) {
      const wanted = opts.adopt;
      unmanaged = unmanaged.filter((d) => [d.resource.key, d.resource.id, d.resource.label].includes(wanted));
      if (unmanaged.length === 0) {
        io.stderr.write(`Nothing to adopt: no unmanaged resource matches \`${wanted}\`.\n`);
        return 1;
      }
    }
    const changes = adoptChanges(unmanaged, rc.ctx.env, rc.plan.changes.map((c) => c.id), rc.plan.changes);
    if (changes.length > 0) {
      await writeFile(planPath, appendChanges(existing, changes), "utf8");
      for (const c of changes) added.push(c.id);
    }
    if (added.length === 0) io.stdout.write(`${planPath} already covers everything in ${rc.ctx.env}. Nothing to adopt.\n`);
    else io.stdout.write(`Added ${added.length} line${added.length === 1 ? "" : "s"} to ${planPath}: ${added.join(", ")}\n` + "Secret-looking values were written as `{ secret: \"env://KEY\" }` references; set those variables before apply.\n");
  }

  if (await ensureGitignore(io.cwd)) io.stdout.write("Added .sponson/ to .gitignore\n");

  const origin = await GitBranchReceiptStore.originOf(io.cwd);
  if (origin) {
    io.stdout.write(
      "\nReceipts will live on the orphan branch `sponson/receipts` of this repository. Every `sponson apply` pushes a small JSON file there recording what it did and the hashes of what it wrote, so the next run (on any machine, including CI) can detect drift and know what to destroy. The branch shares no history with your code, is never merged, and uses the same credentials you already push with.\n",
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Starter plan
// ---------------------------------------------------------------------------

async function starterPlan(io: IO): Promise<string> {
  let project = io.env.VERCEL_PROJECT_ID;
  let team = io.env.VERCEL_ORG_ID;
  try {
    const vercel = JSON.parse(await readFile(join(io.cwd, ".vercel", "project.json"), "utf8")) as { projectId?: string; orgId?: string };
    project ??= vercel.projectId;
    team ??= vercel.orgId;
  } catch {
    /* no linked Vercel project */
  }
  const neon = io.env.NEON_PROJECT_ID ?? "proj_xxx";
  const vercelLine = team ? `{ project: ${q(project ?? "prj_xxx")}, team: ${q(team)} }` : `{ project: ${q(project ?? "prj_xxx")} }`;
  return `# release.plan.yaml — everything that ships beside the code. See https://github.com/sponson/sponson
version: 1
environments: [preview, production]
providers:
  vercel: ${vercelLine}
  neon: { project: ${q(neon)} }

changes:
  - id: db
    adapter: neon
    op: branch
    parent: main
    environments: [preview]

  - id: env
    adapter: vercel
    op: env
    target: preview
    values:
      DATABASE_URL: { from: db.connection_string }
    environments: [preview]
`;
}

function q(s: string): string {
  return JSON.stringify(s);
}

async function ensureGitignore(cwd: string): Promise<boolean> {
  const path = join(cwd, ".gitignore");
  const text = await readFile(path, "utf8").catch(() => "");
  if (text.split(/\r?\n/).some((l) => l.trim() === ".sponson/" || l.trim() === ".sponson")) return false;
  await writeFile(path, text === "" || text.endsWith("\n") ? `${text}.sponson/\n` : `${text}\n.sponson/\n`, "utf8");
  return true;
}

// ---------------------------------------------------------------------------
// Adoption
// ---------------------------------------------------------------------------

type ChangeDoc = Record<string, unknown> & { id: string };

/** Resource keys are `kind:name` (neon `branch:x`, clerk `redirect:url`) or `env:target:NAME` for vercel. */
function parseKey(d: Drift): { kind: string; target?: string; name: string } {
  const key = d.resource.key;
  const i = key.indexOf(":");
  if (i < 0) return { kind: "", name: d.resource.label ?? key };
  const kind = key.slice(0, i);
  const rest = key.slice(i + 1);
  if (kind === "env") {
    const j = rest.indexOf(":");
    if (j >= 0) return { kind, target: rest.slice(0, j), name: rest.slice(j + 1) };
  }
  return { kind, name: rest };
}

/** Group unmanaged drift into plan lines. Values are never written: vercel vars become `env://` references. */
export function adoptChanges(unmanaged: Drift[], env: string, takenIds: string[], existing: Array<{ id: string; adapter: string; op: string; params: Record<string, unknown> }>): ChangeDoc[] {
  const ids = new Set(takenIds);
  const uniqueId = (base: string) => {
    let id = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "") || "adopted";
    let n = 2;
    const root = id;
    while (ids.has(id)) id = `${root}-${n++}`;
    ids.add(id);
    return id;
  };
  const out: ChangeDoc[] = [];
  const vercelByTarget = new Map<string, string[]>();

  for (const d of unmanaged) {
    const { target, name } = parseKey(d);
    switch (d.adapter) {
      case "vercel": {
        const t = target ?? "preview";
        vercelByTarget.set(t, [...(vercelByTarget.get(t) ?? []), name]);
        break;
      }
      case "neon":
        out.push({ id: uniqueId(`db-${name}`), adapter: "neon", op: "branch", name, environments: [env] });
        break;
      case "clerk":
        out.push({ id: uniqueId("callback"), adapter: "clerk", op: "redirect_allow", url: name, environments: [env] });
        break;
      default: {
        const like = existing.find((c) => c.adapter === d.adapter);
        out.push({ id: uniqueId(`${d.adapter}-${name}`), adapter: d.adapter, op: like?.op ?? "unknown", name, environments: [env] });
      }
    }
  }
  for (const [target, keys] of vercelByTarget) {
    const values: Record<string, { secret: string }> = {};
    for (const k of keys) values[k] = { secret: `env://${k}` };
    out.push({ id: uniqueId(`env-${target}`), adapter: "vercel", op: "env", target, values, environments: [env] });
  }
  return out;
}

/** Append under `changes:` with the Document API so comments and formatting in the rest of the file survive. */
export function appendChanges(source: string, changes: ChangeDoc[]): string {
  const doc = parseDocument(source);
  let seq = doc.get("changes", true);
  if (!isSeq(seq)) {
    doc.set("changes", []);
    seq = doc.get("changes", true);
  }
  if (!isSeq(seq)) throw new Error("changes: is not a list");
  for (const c of changes) {
    const node = doc.createNode(c);
    node.spaceBefore = true;
    seq.add(node);
  }
  return doc.toString({ lineWidth: 0 });
}
