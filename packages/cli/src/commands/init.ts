import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitBranchReceiptStore, isKeepRef, planRun, walkParams, type Ctx, type Drift, type Redactor, type Registry } from "@sponson/core";
import { Document, isMap, isScalar, isSeq, parseDocument, visit, type Pair } from "yaml";
import { UsageError, planPathFor, toRunOptions, withInvocation, type GlobalOpts, type Invocation, type IO } from "../context.js";
import { withRedactorWarnings } from "../output.js";
import { detectStack, fsReader, type Finding, type UnsupportedFinding } from "../stack.js";
import { composeStarter, credentialsFor, type Todo } from "../starter.js";

export interface InitOpts extends GlobalOpts {
  /** Adopt only the unmanaged resource whose key, id or label matches. */
  adopt?: string;
}

export interface InitDetected {
  /** What Sponson can use: providers (vercel, neon, clerk), frameworks and ORMs, each with its evidence. */
  found: Finding[];
  /** Detected but not managed by any built-in adapter yet, each with a pointer to the roadmap or an issue. */
  unsupported: UnsupportedFinding[];
  /** Placeholders left in the plan, with where to find the real value. */
  todo: Todo[];
  /** True when nothing Sponson manages was detected and the plan is the Vercel + Neon template. */
  assumed: boolean;
}

export interface InitResult {
  ok: true;
  command: "init";
  /** True when the plan file did not exist and a starter was written. */
  created: boolean;
  path: string;
  /**
   * What the repository's files say it uses, when a starter was written; `null` when the plan already existed.
   * File, dependency and variable names only: never a value read from an `.env` file.
   */
  detected: InitDetected | null;
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
  const result: InitResult = { ok: true, command: "init", created: false, path: planPath, detected: null, added: [], warnings: [] };
  const text: string[] = [];

  if (existing === null) {
    const starter = await writeStarter(planPath, io);
    result.created = true;
    result.detected = starter.detected;
    text.push(...starter.text);
  } else {
    text.push(...(await withInvocation(opts, io, redactor, (inv) => adoptUnmanaged(inv, existing, opts, io, result))));
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
      "Receipts will live on orphan branches of this repository, one per environment and scope (`sponson-receipts/<env>/<scope>`). Every `sponson apply` pushes a small JSON file to its scope's branch recording what it did and the hashes of what it wrote, so the next run (on any machine, including CI) can detect drift and know what to destroy. These branches share no history with your code, are never merged, and use the same credentials you already push with.",
    );
  }
  io.stdout.write(text.join("\n") + "\n");
  return 0;
}

/** Append a line for every unmanaged resource (or only `--adopt`'s) to the existing plan. Returns the text for humans. */
async function adoptUnmanaged(inv: Invocation, existing: string, opts: InitOpts, io: IO, result: InitResult): Promise<string[]> {
  const text: string[] = [];
  const plan = await planRun(toRunOptions(inv, io));
  result.warnings.push(...inv.warnings, ...plan.warnings);
  let unmanaged = plan.drift.filter((d) => d.kind === "unmanaged");
  if (opts.adopt !== undefined) {
    const wanted = opts.adopt;
    const adoptable = unmanaged.map((d) => d.resource.key);
    unmanaged = unmanaged.filter((d) => [d.resource.key, d.resource.id, d.resource.label].includes(wanted));
    if (unmanaged.length === 0) {
      throw new UsageError(
        `Nothing to adopt: no unmanaged resource in ${inv.ctx.env}/${inv.ctx.scope} matches \`${wanted}\`. ` +
          (adoptable.length ? `Adoptable keys: ${adoptable.join(", ")}` : "There are no unmanaged resources to adopt."),
        { adopt: wanted, adoptable },
      );
    }
  }
  const { adoptions, warnings } = adoptChanges(unmanaged, inv.registry, inv.ctx, inv.plan.changes.map((c) => c.id));
  result.warnings.push(...warnings);
  if (adoptions.length > 0) {
    await writeFile(result.path, appendChanges(existing, adoptions.map((a) => a.change)), "utf8");
    result.added = adoptions.map((a) => ({ id: a.change.id, adapter: String(a.change.adapter), op: String(a.change.op), keys: a.keys }));
  }
  if (result.added.length === 0) {
    text.push(`${result.path} already covers everything in ${inv.ctx.env}. Nothing to adopt.`);
    return text;
  }
  text.push(`Added ${result.added.length} line${result.added.length === 1 ? "" : "s"} to ${result.path}: ${result.added.map((a) => a.id).join(", ")}`);
  if (adoptions.some((a) => keepsValues(a.change))) {
    text.push("Adopted variables are written as `{ keep: true }`: Sponson keeps their live values and never destroys them. Replace `{ keep: true }` with a value or `{ secret: \"env://KEY\" }` to let Sponson manage the value.");
  }
  return text;
}

// ---------------------------------------------------------------------------
// Starter plan
// ---------------------------------------------------------------------------

/** Detect the stack from the repository's files, write the starter plan composed for it, and summarise. */
async function writeStarter(planPath: string, io: IO): Promise<{ detected: InitDetected; text: string[] }> {
  const { VERCEL_PROJECT_ID, VERCEL_ORG_ID, NEON_PROJECT_ID, CLOUDFLARE_ACCOUNT_ID } = io.env;
  const detection = await detectStack(fsReader(io.cwd), { VERCEL_PROJECT_ID, VERCEL_ORG_ID, NEON_PROJECT_ID, CLOUDFLARE_ACCOUNT_ID });
  const starter = composeStarter(detection);
  await writeFile(planPath, starter.text, "utf8");
  const detected: InitDetected = { found: detection.found, unsupported: detection.unsupported, todo: starter.todos, assumed: starter.assumed };
  return { detected, text: [`Wrote ${planPath}`, ...initSummary(detected, credentialsFor(detection))] };
}

/** The short human summary: what was found, what is not supported yet, what is left to fill in, what to run next. */
export function initSummary(d: InitDetected, credentials: string[]): string[] {
  const out = [
    d.assumed
      ? `Detected: ${d.found.length ? `${d.found.map((f) => f.name).join(", ")}, but ` : ""}nothing Sponson manages; wrote the Vercel + Neon template`
      : `Detected: ${d.found.map((f) => `${f.name} (${f.evidence[0]!})`).join(", ")}`,
  ];
  if (d.unsupported.length) out.push("Not supported yet (no line manages them):", ...d.unsupported.map((u) => `  ${u.name} (${u.evidence[0]!}): ${u.pointer}`));
  if (d.todo.length) out.push("To fill in:", ...d.todo.map((t) => `  ${t.path} (now ${JSON.stringify(t.placeholder)}): ${t.hint}`));
  out.push(`Next: set ${credentials.join(", ")} in your environment, then run \`sponson plan\``);
  return out;
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

export interface Adoption {
  change: ChangeDoc;
  /** Resource keys this line adopts. */
  keys: string[];
}

/**
 * Turn unmanaged drift into plan lines. What a line looks like is provider knowledge, so each op that listed
 * the resources builds its own lines (`OpSpec.adopt`); this only groups, makes ids unique and scopes the lines
 * to the current environment. Resources whose op cannot adopt are reported as warnings, never guessed at.
 */
export function adoptChanges(unmanaged: Drift[], registry: Registry, ctx: Ctx, takenIds: string[]): { adoptions: Adoption[]; warnings: string[] } {
  const ids = new Set(takenIds);
  const uniqueId = (base: string) => {
    const root = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "") || "adopted";
    let id = root;
    let n = 2;
    while (ids.has(id)) id = `${root}-${n++}`;
    ids.add(id);
    return id;
  };

  const groups = new Map<string, { adapter: string; op: string | undefined; drift: Drift[] }>();
  for (const d of unmanaged) {
    const k = `${d.adapter}\u0000${d.op ?? ""}`;
    const g = groups.get(k) ?? { adapter: d.adapter, op: d.op, drift: [] };
    g.drift.push(d);
    groups.set(k, g);
  }

  const adoptions: Adoption[] = [];
  const warnings: string[] = [];
  for (const { adapter, op, drift } of groups.values()) {
    const keys = drift.map((d) => d.resource.key).join(", ");
    const spec = op === undefined ? undefined : registry.op(adapter, op);
    if (!spec?.adopt) {
      warnings.push(`cannot adopt ${keys}: adapter ${adapter}${op ? ` (op ${op})` : ""} has no adopt()`);
      continue;
    }
    for (const line of spec.adopt(drift.map((d) => d.resource), ctx)) {
      adoptions.push({ change: { id: uniqueId(line.id), adapter, op: op!, ...line.params, environments: [ctx.env] }, keys: line.keys });
    }
  }
  return { adoptions, warnings };
}

/** Whether a line adopts values as `{ keep: true }` (and so needs the note on how to take them over). */
function keepsValues(change: ChangeDoc): boolean {
  let found = false;
  walkParams(change, [], (_p, v) => {
    if (isKeepRef(v)) found = true;
  });
  return found;
}

/**
 * Append lines to `changes:` as text. Each new line is rendered on its own and spliced in after the last
 * existing line of the list, so every byte already in the file (comments, quoting, flow maps, blank lines)
 * stays exactly as it was.
 */
export function appendChanges(source: string, changes: ChangeDoc[]): string {
  if (changes.length === 0) return source;
  const seq = parseDocument(source).get("changes", true);
  const block = (indent: number) => renderChanges(changes, indent);
  if (seq === undefined) return addChangesKey(source, block(2));
  if (isScalar(seq) && (seq.value === null || seq.value === "")) return fillEmptyChanges(source, block(2));
  if (!isSeq(seq) || !seq.range) throw new UsageError("`changes:` in the plan is not a list; fix the plan before adopting");
  if (seq.flow) {
    if (seq.items.length > 0) throw new UsageError("`changes:` is written as a flow list (`[...]`) with items; rewrite it as a block list to adopt into it");
    return replaceEmptyFlowList(source, seq.range, block(2));
  }
  return extendBlockList(source, seq.range, block);
}

/** No `changes:` key at all: add the list at the end of the file. */
function addChangesKey(source: string, block: string): string {
  const base = source === "" || source.endsWith("\n") ? source : `${source}\n`;
  return `${base}changes:${block}`;
}

/** `changes:` with nothing under it: the list goes right after that line. */
function fillEmptyChanges(source: string, block: string): string {
  const keyAt = source.search(/^changes:/m);
  if (keyAt < 0) throw new UsageError("`changes:` must be a top-level key of the plan");
  const eol = source.indexOf("\n", keyAt);
  const head = eol < 0 ? source : source.slice(0, eol);
  return head + block.replace(/\n$/, "") + (eol < 0 ? "\n" : source.slice(eol));
}

/** `changes: []`: a block list in place of the brackets. */
function replaceEmptyFlowList(source: string, [start, end]: [number, number, number], block: string): string {
  const rest = source.slice(end);
  return source.slice(0, start).replace(/[ \t]+$/, "") + block.replace(/\n$/, "") + (rest.startsWith("\n") ? rest : `\n${rest}`);
}

/** A block list: new items go after its last item, at the list's own indentation. */
function extendBlockList(source: string, [start, end]: [number, number, number], block: (indent: number) => string): string {
  const indent = start - (source.lastIndexOf("\n", start - 1) + 1);
  const head = source.slice(0, end);
  return (head.endsWith("\n") ? head : `${head}\n`) + block(indent).replace(/\n$/, "") + "\n" + source.slice(end);
}

/** Each change as a block-list item at `indent`, each preceded by a newline. */
function renderChanges(changes: ChangeDoc[], indent: number): string {
  return changes
    .map((c) => {
      const item = new Document([c]);
      visit(item, { Pair: (_k, pair) => compactPair(pair) });
      const text = item.toString({ lineWidth: 0 }).replace(/\n+$/, "");
      return "\n" + text.split("\n").map((l) => (l === "" ? l : " ".repeat(indent) + l)).join("\n") + "\n";
    })
    .join("");
}

/** `environments: [preview]` and reference forms read as one value: `NAME: { keep: true }`, not a nested block. */
function compactPair(pair: Pair<unknown, unknown>): void {
  if (isScalar(pair.key) && pair.key.value === "environments" && isSeq(pair.value)) pair.value.flow = true;
  const only = isMap(pair.value) && pair.value.items.length === 1 ? pair.value.items[0]!.key : undefined;
  if (isMap(pair.value) && isScalar(only) && ["keep", "secret", "from"].includes(String(only.value))) pair.value.flow = true;
}
