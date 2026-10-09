import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitBranchReceiptStore, planRun, type Drift, type Redactor } from "@sponson/core";
import { Document, isMap, isScalar, isSeq, parseDocument, visit } from "yaml";
import { UsageError, buildRunContext, planPathFor, toRunOptions, type GlobalOpts, type IO } from "../context.js";
import { withRedactorWarnings } from "../output.js";

export interface InitOpts extends GlobalOpts {
  /** Adopt only the unmanaged resource whose key, id or label matches. */
  adopt?: string;
}

export interface InitResult {
  ok: true;
  command: "init";
  /** True when the plan file did not exist and a starter was written. */
  created: boolean;
  path: string;
  /** Lines appended to an existing plan, with the resource keys each one adopts. */
  added: Array<{ id: string; adapter: string; op: string; keys: string[] }>;
  warnings: string[];
}

/**
 * `init` always makes the plan catch up with reality: it writes a starter plan when there is none,
 * and adopts unmanaged resources into an existing one. It never writes values, only references,
 * and never reformats what is already in the file.
 */
export async function initCommand(opts: InitOpts, io: IO, redactor: Redactor): Promise<number> {
  const planPath = planPathFor(opts, io);
  const existing = await readFile(planPath, "utf8").catch(() => null);
  const result: InitResult = { ok: true, command: "init", created: false, path: planPath, added: [], warnings: [] };
  const text: string[] = [];

  if (existing === null) {
    await writeFile(planPath, await starterPlan(io), "utf8");
    result.created = true;
    text.push(`Wrote ${planPath}`);
  } else {
    const rc = await buildRunContext(opts, io, redactor);
    const plan = await planRun(toRunOptions(rc, io));
    result.warnings.push(...rc.warnings, ...plan.warnings);
    let unmanaged = plan.drift.filter((d) => d.kind === "unmanaged");
    if (opts.adopt !== undefined) {
      const wanted = opts.adopt;
      const adoptable = unmanaged.map((d) => d.resource.key);
      unmanaged = unmanaged.filter((d) => [d.resource.key, d.resource.id, d.resource.label].includes(wanted));
      if (unmanaged.length === 0) {
        throw new UsageError(
          `Nothing to adopt: no unmanaged resource in ${rc.ctx.env}/${rc.ctx.scope} matches \`${wanted}\`. ` +
            (adoptable.length ? `Adoptable keys: ${adoptable.join(", ")}` : "There are no unmanaged resources to adopt."),
          { adopt: wanted, adoptable },
        );
      }
    }
    const adoptions = adoptChanges(unmanaged, rc.ctx.env, rc.plan.changes.map((c) => c.id), rc.plan.changes, rc.ctx.git.branch);
    if (adoptions.length > 0) {
      await writeFile(planPath, appendChanges(existing, adoptions.map((a) => a.change)), "utf8");
      result.added = adoptions.map((a) => ({ id: a.change.id, adapter: String(a.change.adapter), op: String(a.change.op), keys: a.keys }));
    }
    if (result.added.length === 0) text.push(`${planPath} already covers everything in ${rc.ctx.env}. Nothing to adopt.`);
    else {
      text.push(`Added ${result.added.length} line${result.added.length === 1 ? "" : "s"} to ${planPath}: ${result.added.map((a) => a.id).join(", ")}`);
      if (adoptions.some((a) => a.change.adapter === "vercel")) {
        text.push("Adopted variables are written as `{ keep: true }`: Sponson keeps their live values and never destroys them. Replace `{ keep: true }` with a value or `{ secret: \"env://KEY\" }` to let Sponson manage the value.");
      }
    }
    result.warnings = withRedactorWarnings(result.warnings, redactor);
  }

  if (await ensureGitignore(io.cwd)) text.push("Added .sponson/ to .gitignore");

  if (opts.json) {
    io.json(result);
    return 0;
  }
  if (result.warnings.length) text.push("", "warnings", ...result.warnings.map((w) => `  ${w}`));
  const origin = await GitBranchReceiptStore.originOf(io.cwd);
  if (origin) {
    text.push(
      "",
      "Receipts will live on the orphan branch `sponson/receipts` of this repository. Every `sponson apply` pushes a small JSON file there recording what it did and the hashes of what it wrote, so the next run (on any machine, including CI) can detect drift and know what to destroy. The branch shares no history with your code, is never merged, and uses the same credentials you already push with.",
    );
  }
  io.stdout.write(text.join("\n") + "\n");
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

/**
 * Resource keys are `kind:name` (neon `branch:x`, clerk `redirect:url`) or, for vercel,
 * `env:<target>:<git branch or *>:NAME` (a variable name never contains `:`, a branch may).
 */
function parseKey(d: Drift): { kind: string; target?: string; branch?: string; name: string } {
  const key = d.resource.key;
  const i = key.indexOf(":");
  if (i < 0) return { kind: "", name: d.resource.label ?? key };
  const kind = key.slice(0, i);
  const rest = key.slice(i + 1);
  if (kind === "env") {
    const j = rest.indexOf(":");
    const k = rest.lastIndexOf(":");
    if (j >= 0 && k > j) return { kind, target: rest.slice(0, j), branch: rest.slice(j + 1, k), name: rest.slice(k + 1) };
    if (j >= 0) return { kind, target: rest.slice(0, j), name: rest.slice(j + 1) };
  }
  return { kind, name: rest };
}

export interface Adoption {
  change: ChangeDoc;
  /** Resource keys this line adopts. */
  keys: string[];
}

/**
 * Group unmanaged drift into plan lines. Values are never written: adopted variables are
 * `{ keep: true }` — Sponson takes over that they exist, not what they contain.
 * Vercel lines are grouped by (target, git branch) so a project-wide variable is adopted as
 * project-wide (`branch: "*"`), never re-created as a branch-scoped copy.
 */
export function adoptChanges(unmanaged: Drift[], env: string, takenIds: string[], existing: Array<{ id: string; adapter: string; op: string; params: Record<string, unknown> }>, currentBranch?: string): Adoption[] {
  const ids = new Set(takenIds);
  const uniqueId = (base: string) => {
    let id = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "") || "adopted";
    let n = 2;
    const root = id;
    while (ids.has(id)) id = `${root}-${n++}`;
    ids.add(id);
    return id;
  };
  const out: Adoption[] = [];
  const vercelGroups = new Map<string, { target: string; branch?: string; vars: Array<{ name: string; key: string }> }>();

  for (const d of unmanaged) {
    const { target, branch, name } = parseKey(d);
    const keys = [d.resource.key];
    switch (d.adapter) {
      case "vercel": {
        const t = target ?? "preview";
        const group = `${t}\u0000${branch ?? ""}`;
        const g = vercelGroups.get(group) ?? { target: t, ...(branch ? { branch } : {}), vars: [] };
        g.vars.push({ name, key: d.resource.key });
        vercelGroups.set(group, g);
        break;
      }
      case "neon":
        out.push({ change: { id: uniqueId(`db-${name}`), adapter: "neon", op: "branch", name, environments: [env] }, keys });
        break;
      case "clerk":
        out.push({ change: { id: uniqueId("callback"), adapter: "clerk", op: "redirect_allow", url: name, environments: [env] }, keys });
        break;
      default: {
        const like = existing.find((c) => c.adapter === d.adapter);
        out.push({ change: { id: uniqueId(`${d.adapter}-${name}`), adapter: d.adapter, op: like?.op ?? "unknown", name, environments: [env] }, keys });
      }
    }
  }
  for (const { target, branch, vars } of vercelGroups.values()) {
    const values: Record<string, { keep: true }> = {};
    for (const v of vars) values[v.name] = { keep: true };
    // The op defaults `branch` to the current git branch for preview; only write it when it differs.
    const branchParam = branch === undefined || branch === currentBranch ? {} : { branch };
    const suffix = branch === "*" ? "-shared" : branch && branch !== currentBranch ? `-${branch}` : "";
    out.push({
      change: { id: uniqueId(`env-${target}${suffix}`), adapter: "vercel", op: "env", target, ...branchParam, values, environments: [env] },
      keys: vars.map((v) => v.key),
    });
  }
  return out;
}

/**
 * Append lines to `changes:` as text. Each new line is rendered on its own and spliced in after the last
 * existing line of the list, so every byte already in the file (comments, quoting, flow maps, blank lines)
 * stays exactly as it was.
 */
export function appendChanges(source: string, changes: ChangeDoc[]): string {
  if (changes.length === 0) return source;
  const doc = parseDocument(source);
  const seq = doc.get("changes", true);
  const block = (indent: number) =>
    changes
      .map((c) => {
        const item = new Document([c]);
        visit(item, {
          Pair(_k, pair) {
            if (isScalar(pair.key) && pair.key.value === "environments" && isSeq(pair.value)) pair.value.flow = true;
            // Reference forms read as one value: `NAME: { keep: true }`, not a nested block.
            const only = isMap(pair.value) && pair.value.items.length === 1 ? pair.value.items[0]!.key : undefined;
            if (isMap(pair.value) && isScalar(only) && ["keep", "secret", "from"].includes(String(only.value))) pair.value.flow = true;
          },
        });
        const text = item.toString({ lineWidth: 0 }).replace(/\n+$/, "");
        return "\n" + text.split("\n").map((l) => (l === "" ? l : " ".repeat(indent) + l)).join("\n") + "\n";
      })
      .join("");

  if (seq === undefined) {
    // No `changes:` key at all: add the list at the end of the file.
    const base = source === "" || source.endsWith("\n") ? source : `${source}\n`;
    return `${base}changes:${block(2)}`;
  }
  if (isScalar(seq) && (seq.value === null || seq.value === "")) {
    // `changes:` with nothing under it: the list goes right after that line.
    const keyAt = source.search(/^changes:/m);
    if (keyAt < 0) throw new UsageError("`changes:` must be a top-level key of the plan");
    const eol = source.indexOf("\n", keyAt);
    const head = eol < 0 ? source : source.slice(0, eol);
    return head + block(2).replace(/\n$/, "") + (eol < 0 ? "\n" : source.slice(eol));
  }
  if (!isSeq(seq) || !seq.range) throw new UsageError("`changes:` in the plan is not a list; fix the plan before adopting");

  if (seq.flow) {
    if (seq.items.length > 0) throw new UsageError("`changes:` is written as a flow list (`[...]`) with items; rewrite it as a block list to adopt into it");
    // `changes: []` → a block list in place of the brackets.
    const [start, end] = seq.range;
    const rest = source.slice(end);
    return source.slice(0, start).replace(/[ \t]+$/, "") + block(2).replace(/\n$/, "") + (rest.startsWith("\n") ? rest : `\n${rest}`);
  }

  const start = seq.range[0];
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const indent = start - lineStart;
  const end = seq.range[1];
  const head = source.slice(0, end);
  return (head.endsWith("\n") ? head : `${head}\n`) + block(indent).replace(/\n$/, "") + "\n" + source.slice(end);
}
