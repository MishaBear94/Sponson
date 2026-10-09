import { readFile } from "node:fs/promises";
import { parseDocument, visit, isAlias } from "yaml";
import { z } from "zod";
import { SponsonError } from "./errors.js";
import { sha256 } from "./hash.js";
import { isFromRef, isKeepRef, isSecretRef, type Change, type Plan } from "./types.js";

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
  .passthrough();

const planSchema = z.object({
  version: z.literal(1),
  environments: z.array(z.string().min(1)).min(1).optional(),
  providers: z.record(z.record(z.unknown())).optional(),
  receipts: z.enum(["git-branch", "local"]).optional(),
  changes: z.array(changeSchema),
});

/** Parameter names whose literal values are almost certainly secrets. */
const SECRET_KEY_PATTERN = /(_KEY|_SECRET|_TOKEN|PASSWORD|_PASS|PASSWD|API_KEY|PRIVATE)$/i;

export interface ParseWarning {
  code: "YAML_ANCHOR";
  message: string;
}

export interface ParsedPlan {
  plan: Plan;
  warnings: ParseWarning[];
}

export async function loadPlan(path: string): Promise<ParsedPlan> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (e) {
    throw new SponsonError("PLAN_PARSE", `Cannot read ${path}: ${(e as Error).message}`, { path });
  }
  return parsePlan(source, path);
}

export function parsePlan(source: string, path?: string): ParsedPlan {
  const doc = parseDocument(source, { prettyErrors: true, merge: true });
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    throw new SponsonError("PLAN_PARSE", `${path ?? "plan"}: ${first.message}`, { path });
  }

  const warnings: ParseWarning[] = [];
  let sawAlias = false;
  visit(doc, (_key, node) => {
    if (isAlias(node)) sawAlias = true;
  });
  if (sawAlias) {
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
    throw new SponsonError("PLAN_INVALID", `${path ?? "plan"}: ${where ? where + ": " : ""}${describeIssue(issue)}`, {
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

function describeIssue(issue: z.ZodIssue): string {
  // Friendlier messages for the mistakes agents make most.
  if (issue.path[issue.path.length - 1] === "environments" && issue.code === "invalid_type") {
    return `environments must be a list, e.g. \`environments: [preview]\` (got ${issue.received})`;
  }
  return issue.message;
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
    walkParams(c.params, [], (path, value) => {
      const last = path[path.length - 1] ?? "";
      // Numbers count too: `ADMIN_PASSWORD: 84736291` is a secret written in YAML's other scalar type.
      if ((typeof value === "string" || typeof value === "number") && SECRET_KEY_PATTERN.test(last) && !isPendingPlaceholder(String(value))) {
        throw new SponsonError(
          "SECRET_LITERAL",
          `Line \`${c.id}\`: \`${path.join(".")}\` looks like a secret but is a literal. Use \`{ secret: "env://${last}" }\` instead.`,
          { id: c.id, path: path.join(".") },
        );
      }
      if (typeof value === "string" && isPendingPlaceholder(value)) {
        throw new SponsonError(
          "PLAN_INVALID",
          `Line \`${c.id}\`: \`${path.join(".")}\` contains display text \`${value}\`. Write a reference, e.g. \`{ from: "db.connection_string" }\`.`,
          { id: c.id, path: path.join(".") },
        );
      }
      if (isFromRef(value)) {
        const [target] = value.from.split(".");
        if (!target || !ids.has(target)) {
          throw new SponsonError("REF_UNKNOWN", `Line \`${c.id}\` references unknown id \`${target ?? value.from}\` in \`${value.from}\``, {
            id: c.id,
            ref: value.from,
          });
        }
        if (!value.from.includes(".")) {
          throw new SponsonError("REF_UNKNOWN", `Line \`${c.id}\`: reference \`${value.from}\` must name an output, e.g. \`${value.from}.id\``, {
            id: c.id,
            ref: value.from,
          });
        }
      }
      if (isSecretRef(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value.secret)) {
        throw new SponsonError("PLAN_INVALID", `Line \`${c.id}\`: secret reference \`${value.secret}\` must be a URL like \`env://NAME\``, {
          id: c.id,
          ref: value.secret,
        });
      }
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
