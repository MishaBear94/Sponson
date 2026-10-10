import { readFile } from "node:fs/promises";
import { isAlias, parseDocument, visit, type Document } from "yaml";
import { z } from "zod";
import { SponsonError } from "./errors.js";
import { sha256 } from "./hash.js";
import { isFromRef, isKeepRef, isSecretRef, type Change, type Plan } from "./types.js";

/** The plan file name the CLI looks for in the working directory. */
export const PLAN_FILENAME = "release.plan.yaml";

const RESERVED_KEYS = new Set(["id", "adapter", "op", "environments", "depends_on"]);

const idSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9_-]*$/, "ids are lowercase: letters, digits, `-` and `_`, starting with a letter");

const changeSchema = z
  .object({
    id: idSchema,
    adapter: z.string().min(1),
    op: z.string().min(1),
    environments: z.array(z.string().min(1)).min(1).optional(),
    depends_on: z.array(idSchema).optional(),
  })
  .loose();

const planSchema = z.object({
  version: z.literal(1),
  environments: z.array(z.string().min(1)).min(1).optional(),
  providers: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  receipts: z.enum(["git-branch", "local"]).optional(),
  changes: z.array(changeSchema),
});

/** Parameter names whose literal values are almost certainly secrets. */
const SECRET_KEY_PATTERN = /(_KEY|_SECRET|_TOKEN|PASSWORD|_PASS|PASSWD|API_KEY|PRIVATE)$/i;

/** Something allowed in a plan but worth telling the author about. */
export interface ParseWarning {
  code: "YAML_ANCHOR";
  message: string;
}

/** A parsed plan and the warnings parsing produced. */
export interface ParsedPlan {
  plan: Plan;
  warnings: ParseWarning[];
}

/**
 * Read and parse a plan file. Throws PLAN_PARSE / PLAN_INVALID / REF_UNKNOWN / SECRET_LITERAL with a message
 * naming the line at fault. Use it to get the `plan` every run takes.
 */
export async function loadPlan(path: string): Promise<ParsedPlan> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (e) {
    throw new SponsonError("PLAN_PARSE", `Cannot read ${path}: ${(e as Error).message}`, { path });
  }
  return parsePlan(source, path);
}

/** Parse plan text (for plans that do not live in a file). `path` is used in messages only. */
export function parsePlan(source: string, path?: string): ParsedPlan {
  const doc = parseDocument(source, { prettyErrors: true, merge: true });
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    throw new SponsonError("PLAN_PARSE", `${path ?? "plan"}: ${first.message}`, { path });
  }

  const warnings: ParseWarning[] = [];
  if (usesAliases(doc)) {
    warnings.push({
      code: "YAML_ANCHOR",
      message: "Plan uses YAML anchors/aliases. They are allowed but hard to read; prefer repeating the lines.",
    });
  }

  const raw = doc.toJS();
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.join(".");
    throw new SponsonError("PLAN_INVALID", `${path ?? "plan"}: ${where ? where + ": " : ""}${describeIssue(issue, raw)}`, {
      path,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const changes: Change[] = parsed.data.changes.map((c) => {
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c)) {
      if (!RESERVED_KEYS.has(k)) params[k] = v;
    }
    const change: Change = { id: c.id, adapter: c.adapter, op: c.op, params };
    if (c.environments) change.environments = c.environments;
    if (c.depends_on) change.depends_on = c.depends_on;
    return change;
  });

  const plan: Plan = {
    version: 1,
    environments: parsed.data.environments ?? inferEnvironments(changes),
    providers: parsed.data.providers ?? {},
    receipts: parsed.data.receipts ?? "git-branch",
    changes,
    hash: sha256(source),
  };
  if (path) plan.path = path;

  validateSemantics(plan);
  return { plan, warnings };
}

function describeIssue(issue: z.core.$ZodIssue, raw: unknown): string {
  // Friendlier messages for the mistakes agents make most.
  if (issue.path[issue.path.length - 1] === "environments" && issue.code === "invalid_type") {
    return `environments must be a list, e.g. \`environments: [preview]\` (got ${typeName(valueAt(raw, issue.path))})`;
  }
  return issue.message;
}

/** The value at a schema issue's path in the raw document (zod 4 issues no longer carry it). */
function valueAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let cur = raw;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

function typeName(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

function inferEnvironments(changes: Change[]): string[] {
  const envs = new Set<string>(["preview", "production"]);
  for (const c of changes) for (const e of c.environments ?? []) envs.add(e);
  return [...envs];
}

function validateSemantics(plan: Plan): void {
  const ids = new Set<string>();
  for (const c of plan.changes) {
    if (ids.has(c.id)) {
      throw new SponsonError("PLAN_INVALID", `Duplicate change id \`${c.id}\``, { id: c.id });
    }
    ids.add(c.id);
  }

  for (const c of plan.changes) {
    for (const env of c.environments ?? []) {
      if (!plan.environments.includes(env)) {
        throw new SponsonError(
          "PLAN_INVALID",
          `Line \`${c.id}\` targets environment \`${env}\`, which is not declared. Known: ${plan.environments.join(", ")}`,
          { id: c.id, environment: env },
        );
      }
    }
    for (const dep of c.depends_on ?? []) {
      if (!ids.has(dep)) {
        throw new SponsonError("REF_UNKNOWN", `Line \`${c.id}\` depends_on unknown id \`${dep}\``, { id: c.id, ref: dep });
      }
    }
    walkParams(c.params, [], (path, value) => checkParamValue(c.id, ids, path, value));
  }
}

/** One param leaf: no literal secrets, no pasted plan output, and references that point somewhere real. */
function checkParamValue(id: string, ids: Set<string>, path: string[], value: unknown): void {
  const last = path[path.length - 1] ?? "";
  // Numbers count too: `ADMIN_PASSWORD: 84736291` is a secret written in YAML's other scalar type.
  if ((typeof value === "string" || typeof value === "number") && SECRET_KEY_PATTERN.test(last) && !isPendingPlaceholder(String(value))) {
    throw new SponsonError(
      "SECRET_LITERAL",
      `Line \`${id}\`: \`${path.join(".")}\` looks like a secret but is a literal. Use \`{ secret: "env://${last}" }\` instead.`,
      { id, path: path.join(".") },
    );
  }
  if (typeof value === "string" && isPendingPlaceholder(value)) {
    throw new SponsonError(
      "PLAN_INVALID",
      `Line \`${id}\`: \`${path.join(".")}\` contains display text \`${value}\`. Write a reference, e.g. \`{ from: "db.connection_string" }\`.`,
      { id, path: path.join(".") },
    );
  }
  if (isFromRef(value)) {
    const [target] = value.from.split(".");
    if (!target || !ids.has(target)) {
      throw new SponsonError("REF_UNKNOWN", `Line \`${id}\` references unknown id \`${target ?? value.from}\` in \`${value.from}\``, {
        id,
        ref: value.from,
      });
    }
    if (!value.from.includes(".")) {
      throw new SponsonError("REF_UNKNOWN", `Line \`${id}\`: reference \`${value.from}\` must name an output, e.g. \`${value.from}.id\``, {
        id,
        ref: value.from,
      });
    }
  }
  if (isSecretRef(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value.secret)) {
    throw new SponsonError("PLAN_INVALID", `Line \`${id}\`: secret reference \`${value.secret}\` must be a URL like \`env://NAME\``, {
      id,
      ref: value.secret,
    });
  }
}

/** Text that `plan` prints for unresolved values; must never come back into the file. */
function isPendingPlaceholder(s: string): boolean {
  return /^\((pending|secret)\s*←/.test(s) || /^<(pending|secret)[:>]/.test(s);
}

/**
 * Visit every leaf of a params object. ValueSpec objects (`{from}`, `{secret}`, `{keep}`) are leaves.
 */
export function walkParams(
  value: unknown,
  path: string[],
  fn: (path: string[], value: unknown) => void,
): void {
  if (isFromRef(value) || isSecretRef(value) || isKeepRef(value)) {
    fn(path, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkParams(v, [...path, String(i)], fn));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walkParams(v, [...path, k], fn);
    return;
  }
  fn(path, value);
}

/** Lines that apply to `env`. */
export function changesFor(plan: Plan, env: string): Change[] {
  return plan.changes.filter((c) => !c.environments || c.environments.includes(env));
}

/** Ids of lines a change reads from (via `from:`) plus explicit depends_on. */
export function dependenciesOf(change: Change): string[] {
  const deps = new Set<string>(change.depends_on ?? []);
  walkParams(change.params, [], (_p, v) => {
    if (isFromRef(v)) deps.add(v.from.split(".")[0]!);
  });
  return [...deps];
}

function usesAliases(doc: Document): boolean {
  let found = false;
  visit(doc, (_key, node) => {
    if (!isAlias(node)) return undefined;
    found = true;
    return visit.BREAK;
  });
  return found;
}
