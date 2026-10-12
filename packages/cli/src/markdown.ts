/**
 * The pull request comment: one pure function from a `--json` envelope (plan, apply, destroy, or an error) to
 * GitHub-flavoured markdown. The GitHub Action renders it from the envelope it saved, `--format markdown` prints it,
 * and any other consumer of `--json` (a GitLab note, an agent) can call it on the same envelope.
 *
 * What it promises:
 * - a reviewer understands in five seconds what the preview has (a headline counting what exists) and what is
 *   cleaned up when the pull request closes (cleaned up / kept / left for you);
 * - no hidden value is ever shown: resources by label, inputs as references (`← db.connection_string`,
 *   `← env://KEY`), a literal as itself (it is in the repository already), only outputs that are URLs, as links (the envelope is redacted before it gets here; nothing is added back);
 * - provider text (errors, labels) cannot break out: HTML-escaped and flattened to one line, code spans cannot be
 *   closed early, links only to `http(s)` URLs;
 * - it starts with `<!-- sponson:<env> -->`, the marker the action updates its one comment per environment by;
 * - it fits GitHub's comment limit (65,536 characters): whole sections are left out from the end, with a note.
 */
import { cliHintFor, type ErrorCode } from "@sponson/core";

/** GitHub's limit on a comment body, in characters. */
export const GITHUB_COMMENT_LIMIT = 65_536;

/** What `renderMarkdown` needs besides the envelope; every field is optional. */
export interface MarkdownOptions {
  /** The environment the comment is for: its marker. Default: the envelope's, else `preview`. */
  environment?: string;
  /** `plan`, `apply` or `destroy`: names the command when the envelope does not (an error, a crash). */
  command?: string;
  /** The command's exit code, for a crash (no envelope). */
  exitCode?: number;
  /** A link to the CI run, shown in the footer. */
  runUrl?: string;
  /** Maximum length of the comment. Default: a margin below `GITHUB_COMMENT_LIMIT`. */
  maxLength?: number;
}

/** The marker the comment starts with; the action finds its comment by it. */
export function commentMarker(environment: string): string {
  return `<!-- sponson:${String(environment).replace(/[^A-Za-z0-9_.-]/g, "_")} -->`;
}

// ---------------------------------------------------------------------------
// Loose shapes of the envelope: it arrives as parsed JSON, so every field is checked before use.
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

interface Res {
  key: string;
  label?: string;
  createdBy?: string;
}

interface Line {
  id: string;
  adapter: string;
  op: string;
  status: string;
  resources: Res[];
  removed: Res[];
  outputs: Obj;
  consoleUrl?: string;
  waitingFor?: string;
  waitingOn?: string;
  error?: string;
  errorCode?: string;
  orphan?: boolean;
  notes: Obj;
  diffs: Diff[];
  manual?: Todo;
}

interface Diff {
  key: string;
  label: string;
  kind: string;
  after: Obj | undefined;
}

interface Todo {
  line: string;
  title: string;
  action: string;
  instructions: string;
  observable: boolean;
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const optStr = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

function toRes(v: unknown): Res | null {
  if (!isObj(v)) return null;
  return { key: str(v.key), ...(optStr(v.label) ? { label: str(v.label) } : {}), ...(optStr(v.createdBy) ? { createdBy: str(v.createdBy) } : {}) };
}

function toDiff(v: unknown): Diff | null {
  if (!isObj(v)) return null;
  return { key: str(v.key), label: str(v.label ?? v.key), kind: str(v.kind), after: isObj(v.after) ? v.after : undefined };
}

function toTodo(v: unknown): Todo | null {
  if (!isObj(v)) return null;
  return { line: str(v.line), title: str(v.title), action: str(v.action), instructions: str(v.instructions), observable: v.observable === true };
}

function toLine(v: unknown): Line | null {
  if (!isObj(v)) return null;
  const list = <T>(x: unknown, f: (y: unknown) => T | null): T[] => arr(x).map(f).filter((y): y is T => y !== null);
  const manual = toTodo(v.manual);
  return {
    id: str(v.id),
    adapter: str(v.adapter),
    op: str(v.op),
    status: str(v.status),
    resources: list(v.resources, toRes),
    removed: list(v.removed, toRes),
    outputs: isObj(v.outputs) ? v.outputs : {},
    consoleUrl: optStr(v.consoleUrl),
    waitingFor: optStr(v.waitingFor),
    waitingOn: optStr(v.waitingOn),
    error: optStr(v.error),
    errorCode: optStr(v.errorCode),
    orphan: v.orphan === true,
    notes: isObj(v.notes) ? v.notes : {},
    diffs: list(v.diffs, toDiff),
    ...(manual ? { manual } : {}),
  };
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/** Provider text as one line of inert markdown: no tag, no HTML comment, no code span, no table cell end. */
export function esc(s: unknown): string {
  return str(s)
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;")
    .replace(/`/g, "&#96;")
    .replace(/([*_[\]])/g, "\\$1")
    .replace(/\r\n|\r|\n/g, " ");
}

/** An identifier in a code span: no backticks or line breaks, never HTML-interpreted there. */
function code(s: unknown): string {
  const t = str(s).replace(/[`\r\n]/g, "");
  return "`" + (t || " ") + "`";
}

/** What may stand in a code span taken over from provider or engine text: no backtick, tag, entity, cell end or escape. */
const SAFE_SPAN = /^`[^`<>&|\\\r\n]+`$/;

/**
 * At most `n` characters of provider or engine text, escaped. Its `identifier` spans (`depends on \`env\``) stay code
 * spans, as everywhere else in the comment, instead of showing as `&#96;` entities; a span holding anything that could
 * open a tag or break out is escaped like the rest.
 */
function clip(s: unknown, n = 300): string {
  const t = str(s).trim();
  const cut = t.length > n ? `${t.slice(0, n - 1)}…` : t;
  return cut
    .split(/(`[^`\r\n]+`)/)
    .map((part) => (SAFE_SPAN.test(part) ? code(part.slice(1, -1)) : esc(part)))
    .join("");
}

/** A link to an `http(s)` URL, or the text alone when the URL is anything else. */
function link(text: string, url: unknown): string {
  const u = str(url);
  if (!/^https?:\/\/[^\s<>"`\\]+$/.test(u) || u.length > 2000) return text;
  return `[${text}](${u.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
}

/** Instructions a person follows, shown whole (ADR 0021): preformatted, escaped. */
function pre(t: string): string {
  return "<pre>" + t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r\n|\r/g, "\n").trimEnd() + "</pre>";
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** What a resource of an op is, for people: singular and plural. Ops not listed are "other resources". */
const NOUNS: Record<string, [string, string]> = {
  "neon.branch": ["database branch", "database branches"],
  "planetscale.branch": ["database branch", "database branches"],
  "supabase.branch": ["database branch", "database branches"],
  "xata.branch": ["database branch", "database branches"],
  "planetscale.password": ["database password", "database passwords"],
  "vercel.env": ["variable", "variables"],
  "netlify.env": ["variable", "variables"],
  "cloudflare.pages_env": ["variable", "variables"],
  "clerk.redirect_allow": ["auth callback", "auth callbacks"],
  "supabase.auth_redirect": ["auth callback", "auth callbacks"],
  "launchdarkly.flag_target": ["feature flag target", "feature flag targets"],
  "algolia.index": ["search index", "search indexes"],
  "contentful.environment": ["content environment", "content environments"],
  "contentful.api_key_access": ["content API key grant", "content API key grants"],
  "cloud_run.revision": ["Cloud Run revision", "Cloud Run revisions"],
  "digitalocean.app": ["app", "apps"],
  "vercel.deploy": ["deployment", "deployments"],
  "manual.step": ["manual step", "manual steps"],
  "http.action": ["one-off action", "one-off actions"],
};
const OTHER: [string, string] = ["other resource", "other resources"];
const VARIABLE_OPS = new Set(["vercel.env", "netlify.env", "cloudflare.pages_env"]);

function nounOf(l: Pick<Line, "adapter" | "op">): [string, string] {
  return NOUNS[`${l.adapter}.${l.op}`] ?? OTHER;
}

function count(n: number, noun: [string, string]): string {
  if (n === 1 && noun[0] === "database branch") return "its own database branch";
  return `${n} ${n === 1 ? noun[0] : noun[1]}`;
}

/** "a, b and c". */
function andList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Counts per noun, in first-seen order: "its own database branch, 3 variables and 1 auth callback". */
function tally(entries: Array<{ noun: [string, string]; n: number }>): string {
  const by = new Map<string, { noun: [string, string]; n: number }>();
  for (const e of entries) {
    if (e.n <= 0) continue;
    const cur = by.get(e.noun[0]) ?? { noun: e.noun, n: 0 };
    cur.n += e.n;
    by.set(e.noun[0], cur);
  }
  return andList([...by.values()].map((e) => count(e.n, e.noun)));
}

/** Who the comment is about: "the preview for pr-42", "production (main)". */
function who(environment: string, scope: string): string {
  if (environment === "preview") return scope ? `the preview for ${esc(scope)}` : "the preview";
  return scope ? `${esc(environment)} (${esc(scope)})` : esc(environment);
}

/** "This preview", "This production environment". */
function subject(environment: string): string {
  return environment === "preview" ? "This preview" : `This ${esc(environment)} environment`;
}

const MAX_NAMES = 8;

/**
 * Several labels as one phrase. Labels sharing a trailing "(…)" (Vercel's `KEY (preview, feat/x)`) are listed by
 * name, with the suffix once after the count: "3 variables (preview, feat/x): `A`, `B` and `C`". `extra` appends to
 * each name (a reference).
 */
function namesPhrase(l: Pick<Line, "adapter" | "op">, labels: string[], extra: (i: number) => string = () => ""): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return esc(labels[0]) + extra(0);
  const suffix = /\s(\([^()]*\))$/.exec(labels[0]!)?.[1];
  const shared = suffix !== undefined && labels.every((x) => x.endsWith(` ${suffix}`));
  const names = shared ? labels.map((x) => x.slice(0, -suffix!.length - 1)) : labels;
  const shown = names.slice(0, MAX_NAMES).map((n, i) => (shared ? code(n) : esc(n)) + extra(i));
  if (names.length > MAX_NAMES) shown.push(`${names.length - MAX_NAMES} more`);
  const n = count(labels.length, nounOf(l)).replace(/^its own /, "1 ");
  return `${n}${shared ? ` ${esc(suffix)}` : ""}: ${andList(shown)}`;
}

function resourcesText(l: Line, list: Res[]): string {
  return namesPhrase(l, list.map((r) => r.label ?? r.key));
}

/** URL outputs as links (the preview URL has a line of its own); any other output is not shown. */
function outputLinks(outputs: Obj): string[] {
  return Object.entries(outputs)
    .filter(([k, v]) => k !== "preview_url" && typeof v === "string" && /^https?:\/\//.test(v))
    .map(([k, v]) => link(esc(k.replace(/_/g, " ")), v));
}

function consoleLink(url: string | undefined): string {
  return url ? ` · ${link("console", url)}` : "";
}

/** What a line waits for, said so that the reader knows whether to act. */
function waitPhrase(waitingFor: string | undefined, waitingOn?: string): string {
  if (waitingFor === "deploy") return "waits for the preview deploy: the run after the deploy finishes it, nothing to retry";
  if (waitingFor === "confirmation") return "waits for a person to do the manual step below";
  if (waitingFor) return `waits for ${esc(waitingFor)}`;
  return waitingOn ? `waits for ${code(waitingOn)}` : "waits for a line it depends on";
}

/** One sentence: how to fix a refusal or failure, in this comment's words; else the CLI's remedy. */
const FIX: Partial<Record<string, string>> = {
  DRIFT_CHANGED: "Keep that change by updating the plan, or overwrite it with `sponson apply --reconcile`.",
  ENV_NOT_APPROVED: "Production needs a person's approval: run it with `--approved-by <who>` from your approval workflow, never from an agent.",
  MANUAL_STEP_PENDING: "A person does the step below, then runs `sponson apply --confirm <line>`.",
  OWNED_BY_OTHER_SCOPE: "Another pull request or branch manages it: destroy that scope first, or give this one its own name in the plan.",
  LOCK_HELD: "Another run is applying this scope: wait for it, or run with `--wait`.",
  LOCK_LOST: "Another run took this scope over: re-run the job once it finished.",
  PROVIDER_AUTH: "The provider rejected the credentials: check the token in this job's secrets.",
  PROVIDER_TRANSIENT: "The provider failed temporarily: re-run the job (apply resumes safely).",
  PROVIDER_TIMEOUT: "The provider did not answer in time: re-run the job (apply resumes safely).",
  SECRET_UNRESOLVED: "A secret reference could not be read: check that the secret exists and this job can read it.",
  // The fix is the refused line's, said there once.
  DEPENDENCY_BLOCKED: "",
  EXTERNAL_FAILED: "The deploy it waited for failed: fix the deploy and push again.",
  WAIT_TIMEOUT: "The deploy did not finish in time: re-run once it has.",
  INTENT_UNRESOLVED: "Check the provider's console and remove it by hand if it exists.",
  ROLLBACK_FAILED: "Check the provider's console and remove what is left by hand.",
  DESTROY_FAILED: "Check the provider's console, then run the destroy again or remove it by hand.",
  STALE: "Nothing to do: a newer commit was already applied.",
};

function fixFor(errorCode: string | undefined): string {
  if (!errorCode) return "";
  return FIX[errorCode] ?? cliHintFor(errorCode as ErrorCode) ?? "";
}

/** What went wrong and the fix. `said`: the line already says what happened (a drifted name), so only the code. */
function problem(error: string | undefined, errorCode: string | undefined, said = false): string {
  const fix = fixFor(errorCode);
  const what = [error && !said ? clip(error) : "", errorCode ? `(${code(errorCode)})` : ""].filter(Boolean).join(" ");
  return [what, fix ? `**Fix:** ${fix}` : ""].filter(Boolean).join(" ");
}

function todoBlock(t: Todo): string {
  const flag = t.action === "undo" ? `sponson apply --destroy --confirm ${t.line}` : `sponson apply --confirm ${t.line}`;
  const verify = t.action === "do" && t.observable ? " (or the next apply sees it done by itself)" : "";
  return `- ${code(t.line)} ${t.action === "undo" ? "undo: " : ""}${esc(t.title)}\n\n${pre(t.instructions)}\n\n  Then a person confirms it: ${code(flag)}${verify}`;
}

function manualSection(todos: Todo[], heading: string): string {
  if (!todos.length) return "";
  return `**${heading}** (no API can do these; a person does them, agents never confirm them)\n\n${todos.map(todoBlock).join("\n\n")}`;
}

/** What each kind of drift is. Facts only: the fix for a refused line is said once, on that line. */
const DRIFT: Record<string, string> = {
  changed: "was changed outside Sponson since the last apply.",
  replaced: "was deleted and re-created outside Sponson since the last apply.",
  missing: "was deleted outside Sponson; the next apply creates it again.",
  unmanaged: "exists, but no line manages it. **Fix:** `sponson init --adopt <key>` adds a line that adopts it (never destroyed).",
  orphan: "is no longer in the plan; it is left alone until this scope is destroyed.",
};

/** What happened outside Sponson to a resource a line manages, said on that line: by `line\0resourceKey`. */
type Marks = Map<string, string>;

/** The drift each line says on its own resource, from the envelope's drift. */
function driftMarks(drift: unknown[]): Marks {
  const out: Marks = new Map();
  for (const d of drift.filter(isObj)) {
    const r = isObj(d.resource) ? d.resource : {};
    if (d.kind === "changed" && optStr(d.line)) out.set(`${str(d.line)}\u0000${str(r.key)}`, d.replaced === true ? "deleted and re-created outside Sponson" : "changed outside Sponson");
  }
  return out;
}

const markOf = (marks: Marks, l: Line, key: string): string | undefined => marks.get(`${l.id}\u0000${key}`);

/** The drift no line of the comment says (`shown`: whether one does). */
function driftSection(drift: unknown[], shown: (line: string, key: string) => boolean = () => false): string {
  const items = drift.filter(isObj).flatMap((d) => {
    const r = isObj(d.resource) ? d.resource : {};
    if (d.kind === "changed" && shown(str(d.line), str(r.key))) return [];
    const name = str(r.label) || str(r.key) || str(d.adapter);
    const where = d.line ? ` (line ${code(d.line)})` : "";
    const kind = d.kind === "changed" && d.replaced === true ? "replaced" : str(d.kind);
    return [`- ${esc(name)}${where} ${DRIFT[kind] ?? clip(d.message)}`];
  });
  return items.length ? `**Drift**\n\n${items.join("\n")}` : "";
}

function warningsSection(warnings: unknown[]): string {
  const items = warnings.map((w) => `- ${clip(w, 500)}`);
  return items.length ? `**Warnings**\n\n${items.join("\n")}` : "";
}

// ---------------------------------------------------------------------------
// The comment, assembled to fit
// ---------------------------------------------------------------------------

interface Parts {
  title: string;
  /** Always kept: the headline and what to do next. */
  lead: string[];
  /** One list item per line, kept from the first while they fit. */
  items: string[];
  /** Sections after the list, kept from the first while they fit. */
  blocks: string[];
  footer: string;
}

function footer(bits: string[], runUrl: string | undefined): string {
  const all = [...bits.filter(Boolean), runUrl ? link("run log", runUrl) : ""].filter(Boolean);
  return all.length ? `<sub>${all.join(" · ")}</sub>` : "";
}

const LEFT_OUT = "left out: the comment would exceed GitHub's size limit. The run log and the JSON result have everything.";
/** Room kept for the notes that say what was left out. */
const NOTE_ROOM = 2 * (LEFT_OUT.length + 40);

/** As many list items as fit in `budget` characters, and an item saying how many were left out. */
function fitItems(items: string[], budget: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const item of items) {
    if (used + item.length + 1 > budget) break;
    kept.push(item);
    used += item.length + 1;
  }
  const rest = items.length - kept.length;
  if (rest > 0) kept.push(`- _${rest} more line${rest === 1 ? "" : "s"} ${LEFT_OUT}_`);
  return kept.join("\n");
}

function assemble(marker: string, p: Parts, max: number): string {
  const head = [`${marker}\n### ${p.title}`, ...p.lead.filter(Boolean)].join("\n\n");
  const tail = p.footer ? `\n\n${p.footer}` : "";
  const out = [head];
  let used = head.length + tail.length;
  if (p.items.length) {
    const list = fitItems(p.items, max - used - NOTE_ROOM);
    out.push(list);
    used += list.length + 2;
  }
  const blocks = p.blocks.filter(Boolean);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const left = blocks.length - i;
    const note = `_${left} more section${left === 1 ? "" : "s"} ${LEFT_OUT}_`;
    if (used + b.length + 2 + note.length + 2 > max) {
      out.push(note);
      break;
    }
    out.push(b);
    used += b.length + 2;
  }
  const body = out.join("\n\n") + tail;
  // A lead or title so long it alone exceeds the budget (it cannot be, from real envelopes): cut it hard.
  return body.length > max ? body.slice(0, max - 1) + "…" : body;
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

const PLAN_PHRASE: Record<string, string> = {
  create: "will be created",
  update: "will be updated",
  unchanged: "up to date",
  run: "will run once",
  todo: "a person does this by hand (below)",
};

/**
 * A new value as a reference and what it is, the same words as the CLI (render.ts `sideText`): `secret` only for a
 * `{ secret }` reference, `value hidden` for another sensitive value (a `{ from }` output), and a literal as itself
 * (it is in the repository already; one matching a secret arrives described as hidden), unless the label already ends
 * in it. `mark` is what happened to the resource outside Sponson, said here once.
 */
function sideText(after: Obj | undefined, mark?: string, name = ""): string {
  const ref = after ? optStr(after.ref) : undefined;
  const label = after?.state === "secret" ? "secret" : after?.state === "sensitive" ? "value hidden" : after?.state === "pending" && !ref ? "pending" : "";
  const notes = [label, mark ?? ""].filter(Boolean);
  return `${ref ? ` ← ${code(ref)}` : literalText(after, name)}${notes.length ? ` (${notes.join("; ")})` : ""}`;
}

/** A literal value as ` = \`value\``: clipped, and left out when the label already says it. */
function literalText(after: Obj | undefined, label: string): string {
  if (after?.state !== "literal" || typeof after.value !== "string") return "";
  const v = after.value;
  if (label === v || label.endsWith(` ${v}`)) return "";
  return ` = ${code(v.length > 80 ? `${v.slice(0, 79)}…` : v)}`;
}

/** A plan line's resources by label, each value shown only as a reference, a drifted one saying so. */
function planWhat(l: Line, marks: Marks): string {
  return namesPhrase(
    l,
    l.diffs.map((d) => d.label),
    (i) => sideText(l.diffs[i]!.after, markOf(marks, l, l.diffs[i]!.key), l.diffs[i]!.label),
  );
}

/** A line held back only because a line it depends on is refused or failed: it has no fix of its own. */
const heldBack = (l: Line): boolean => l.errorCode === "DEPENDENCY_BLOCKED";

/** Whether a refusal for drift is already said on the line, by the name of the resource it happened to. */
const driftSaid = (l: Line, keys: string[], marks: Marks): boolean => l.errorCode === "DRIFT_CHANGED" && keys.some((k) => markOf(marks, l, k) !== undefined);

function planPhrase(l: Line, marks: Marks): string {
  if (l.status === "pending") return waitPhrase(l.waitingFor, l.waitingOn);
  const said = driftSaid(l, l.diffs.map((d) => d.key), marks);
  if (l.status === "blocked") return `${heldBack(l) ? "held back" : "refused"}${said ? " " : ": "}${problem(l.error, l.errorCode, said)}`;
  if (l.status === "error") return `error: ${problem(l.error, l.errorCode)}`;
  return PLAN_PHRASE[l.status] ?? esc(l.status);
}

function planBullet(l: Line, marks: Marks): string {
  const what = l.manual ? esc(l.manual.title) : planWhat(l, marks) || esc(nounOf(l)[0]);
  return `- ${code(l.id)} ${what}${what ? " — " : ""}${planPhrase(l, marks)}`;
}

/** What lines of these plan statuses amount to: "its own database branch and 2 variables"; "" for none. */
function planTally(lines: Line[], statuses: string[]): string {
  return tally(lines.filter((l) => statuses.includes(l.status) && l.adapter !== "manual").map((l) => ({ noun: nounOf(l), n: Math.max(l.diffs.length, 1) })));
}

/**
 * The plan's headline, by what is already there and what applying it would do: a preview whose branch exists
 * "already has" it; only what is missing is what "applying this plan gives".
 */
function planHeadline(environment: string, lines: Line[]): string[] {
  if (lines.length === 0) return ["This plan manages nothing in this environment."];
  const has = planTally(lines, ["unchanged"]);
  const adds = planTally(lines, ["create", "pending"]);
  const updates = planTally(lines, ["update"]).replace(/^its own /, "1 ");
  const runs = planTally(lines, ["run"]);
  const self = subject(environment).replace(/^This/, "this");
  return [
    has ? `${subject(environment)} already has ${has}.` : "",
    adds ? (has ? `Applying this plan adds ${adds.replace(/^its own /, "1 ")}.` : `Applying this plan gives ${self} ${adds}.`) : "",
    updates ? `Applying this plan updates ${updates}.` : "",
    runs ? `Applying this plan runs ${runs}.` : "",
  ].filter(Boolean);
}

/**
 * "**1 line is refused**, and 1 line that depends on it is held back: …". Lines refused (or failed) and the lines
 * they hold back are counted apart: only the first have something to fix.
 */
function refusedLead(refused: number, held: number, verb: [string, string]): string {
  if (!refused && !held) return "";
  const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
  const heldText = `${lines(held)} that depend${held === 1 ? "s" : ""} on ${refused === 1 ? "it" : "them"} ${held === 1 ? "is" : "are"} held back`;
  if (!refused) return `**${lines(held)} ${held === 1 ? "is" : "are"} held back** by a line ${held === 1 ? "it depends" : "they depend"} on: see below.`;
  const head = `**${lines(refused)} ${refused === 1 ? verb[0] : verb[1]}**`;
  return `${head}${held ? `, and ${heldText}` : ""}: see below for why and how to fix it.`;
}

function renderPlan(e: Obj, o: MarkdownOptions): Parts {
  const environment = str(e.environment) || (o.environment ?? "preview");
  const lines = arr(e.lines).map(toLine).filter((l): l is Line => l !== null);
  const notApplied = lines.filter((l) => l.status === "blocked" || l.status === "error");
  const held = notApplied.filter(heldBack).length;
  const lead = [
    ...planHeadline(environment, lines),
    refusedLead(notApplied.length - held, held, ["is refused", "are refused"]),
    e.lock && isObj(e.lock) ? `An apply is running on this scope (${esc(e.lock.holder)}); this plan may change.` : "",
    e.requiresApproval === true ? "Applying it needs a person's approval: it writes to production (`--approved-by <who>`)." : "",
  ];
  const todos = lines.map((l) => l.manual).filter((t): t is Todo => !!t);
  const marks = driftMarks(arr(e.drift));
  const shown = (line: string, key: string) => lines.some((l) => l.id === line && !l.manual && l.diffs.some((d) => d.key === key));
  return {
    title: `Sponson plan: ${who(environment, str(e.scope))}`,
    lead,
    items: lines.map((l) => planBullet(l, marks)),
    blocks: [manualSection(todos, "Manual steps"), driftSection(arr(e.drift), shown), warningsSection(arr(e.warnings))],
    footer: footer([`plan ${esc(str(e.planHash).slice(0, 8))}`], o.runUrl),
  };
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

const LIVE = new Set(["applied", "unchanged"]);
/** Statuses after which what a line made no longer exists. */
const GONE = new Set(["rolled_back", "destroyed"]);

const APPLY_PHRASE: Record<string, string> = {
  applied: "set up in this run",
  unchanged: "unchanged",
  rolled_back: "rolled back: this run created it, then removed it because another line failed",
  skipped: "skipped",
};

function applyPhrase(l: Line, marks: Marks): string {
  if (l.orphan) return "no longer in the plan: left alone until the pull request closes";
  if (l.status === "waiting") return waitPhrase(l.waitingFor);
  if (l.status === "failed") return `failed: ${problem(l.error, l.errorCode)}`;
  const said = driftSaid(l, l.resources.map((r) => r.key), marks);
  if (l.status === "blocked") return `refused${said ? " " : ": "}${problem(l.error, l.errorCode, said)}`;
  if (l.status === "rollback_failed") return `failed, and rolling it back failed too, so it may still exist: ${problem(l.error, l.errorCode)}`;
  if (l.status === "skipped" && (l.error || l.errorCode)) return `skipped: ${problem(l.error?.replace(/^skipped: /, ""), l.errorCode)}`;
  return APPLY_PHRASE[l.status] ?? esc(l.status);
}

/** What each resource's value stands for, by line and resource key: the apply envelope's `inputs`. */
type Sides = Record<string, unknown>;

function applyBullet(l: Line, marks: Marks, sides: Sides): string {
  const own = sides[l.id];
  const sideOf = (r: Res): Obj | undefined => {
    const side = isObj(own) ? own[r.key] : undefined;
    return isObj(side) ? side : undefined;
  };
  const what = namesPhrase(l, l.resources.map((r) => r.label ?? r.key), (i) => sideText(sideOf(l.resources[i]!), markOf(marks, l, l.resources[i]!.key), l.resources[i]!.label ?? l.resources[i]!.key)) || esc(nounOf(l)[0]);
  const undescribed = VARIABLE_OPS.has(`${l.adapter}.${l.op}`) && l.resources.some((r) => sideOf(r) === undefined);
  const values = undescribed ? ", values not shown" : "";
  const links = outputLinks(l.outputs);
  const extra = links.length ? ` · ${links.join(" · ")}` : "";
  return `- ${code(l.id)} ${what}${values} — ${applyPhrase(l, marks)}${consoleLink(LIVE.has(l.status) ? l.consoleUrl : undefined)}${extra}`;
}

function previewUrl(lines: Line[]): string {
  for (const l of lines) {
    const u = l.outputs.preview_url;
    if (typeof u === "string" && /^https?:\/\//.test(u)) return u;
  }
  return "";
}

function applyTitle(rc: Obj, lines: Line[], manual: boolean): string {
  const target = who(str(rc.environment), str(rc.scope));
  if (rc.stale === true) return `Sponson skipped this run for ${target}: a newer commit was already applied`;
  if (rc.status === "failed") return `Sponson could not apply ${target}`;
  if (manual) return `Sponson: ${target} waits for a person`;
  if (rc.status === "partial" || lines.some((l) => l.status === "waiting")) return `Sponson: ${target} is almost ready`;
  return `Sponson: ${target} is ready`;
}

function applyLead(rc: Obj, lines: Line[]): string[] {
  const environment = str(rc.environment);
  const live = lines.filter((l) => !l.orphan && !GONE.has(l.status) && l.resources.length > 0);
  const has = tally(live.map((l) => ({ noun: nounOf(l), n: l.resources.length })));
  const waiting = lines.filter((l) => l.status === "waiting");
  const later = tally(waiting.map((l) => ({ noun: nounOf(l), n: Math.max(l.resources.length, 1) }))).replace(/^its own /, "1 ");
  const failed = lines.filter((l) => ["failed", "rollback_failed", "blocked"].includes(l.status)).length;
  const skipped = lines.filter((l) => l.status === "skipped" && heldBack(l)).length;
  const url = previewUrl(lines);
  return [
    has ? `${subject(environment)} has ${has}.` : `Nothing is set up for ${environment === "preview" ? "this preview" : esc(environment)} yet.`,
    later ? `Still to come: ${later}${waiting.every((l) => l.waitingFor === "deploy") ? ", once the preview deploy finishes (nothing to retry)" : ""}.` : "",
    failed ? `${refusedLead(failed, skipped, ["did not apply", "did not apply"])}${lines.some((l) => l.status === "rolled_back") ? " What this run created was rolled back." : ""}` : "",
    url ? `**Preview:** ${link(esc(url), url)}` : "",
    rc.approvedBy ? `Approved by ${esc(rc.approvedBy)}.` : "",
  ];
}

function renderApply(e: Obj, rc: Obj, o: MarkdownOptions): Parts {
  const lines = Object.values(isObj(rc.lines) ? rc.lines : {}).map(toLine).filter((l): l is Line => l !== null);
  const todos = arr(e.manual).map(toTodo).filter((t): t is Todo => t !== null);
  const runVerb = rc.destroy === true ? "destroy" : "apply";
  const plan = isObj(rc.plan) ? str(rc.plan.hash).slice(0, 8) : "";
  const marks = driftMarks(arr(e.drift));
  const shown = (line: string, key: string) => lines.some((l) => l.id === line && l.resources.some((r) => r.key === key));
  return {
    title: applyTitle(rc, lines, todos.length > 0),
    lead: rc.stale === true ? ["Nothing was changed."] : applyLead(rc, lines),
    items: lines.map((l) => applyBullet(l, marks, isObj(e.inputs) ? e.inputs : {})),
    blocks: [manualSection(todos, "Manual steps waiting for a person"), driftSection(arr(e.drift), shown), warningsSection(arr(e.warnings))],
    footer: footer([`${runVerb} ${esc(rc.runId)}`, plan ? `plan ${esc(plan)}` : ""], o.runUrl),
  };
}

// ---------------------------------------------------------------------------
// destroy
// ---------------------------------------------------------------------------

function groupText(l: Line, list: Res[]): string {
  const t = resourcesText(l, list);
  return t || esc(nounOf(l)[0]);
}

function leftForYou(l: Line): string[] {
  const out: string[] = [];
  if (l.status === "destroy_failed") out.push(`${code(l.id)} ${groupText(l, l.resources)}: ${problem(l.error, l.errorCode)}${consoleLink(l.consoleUrl)}`);
  if (l.status === "waiting") out.push(`${code(l.id)} ${waitPhrase(l.waitingFor)}`);
  const survivors = arr(l.notes.notSponsons).map(str).filter(Boolean);
  if (survivors.length) out.push(`${code(l.id)} ${survivors.map(esc).join(", ")}: re-created outside Sponson, so not Sponson's to delete; remove it by hand if nobody needs it`);
  return out;
}

function renderDestroy(e: Obj, rc: Obj, o: MarkdownOptions): Parts {
  const lines = Object.values(isObj(rc.lines) ? rc.lines : {}).map(toLine).filter((l): l is Line => l !== null);
  const cleaned = lines.map((l) => ({ l, list: l.removed.filter((r) => r.createdBy !== "adopted") })).filter((x) => x.list.length > 0);
  const kept = lines
    .map((l) => ({ l, list: l.removed.filter((r) => r.createdBy === "adopted") }))
    .map((x) => (x.list.length ? x : { l: x.l, list: arr(x.l.notes.adoptedKept).map((k) => ({ key: str(k) })) }))
    .filter((x) => x.list.length > 0);
  const todos = arr(e.manual).map(toTodo).filter((t): t is Todo => t !== null);
  const left = [...lines.flatMap(leftForYou), ...todos.map((t) => `${code(t.line)} undo by hand: ${esc(t.title)} (below)`)];
  const target = who(str(rc.environment), str(rc.scope));
  const title = rc.status === "complete" && todos.length === 0 ? `Sponson cleaned up ${target}` : `Sponson could not clean up everything for ${target}`;
  const list = (xs: Array<{ l: Line; list: Res[] }>) => (xs.length ? xs.map((x) => groupText(x.l, x.list)).join("; ") : "nothing");
  return {
    title,
    lead: [
      `**Cleaned up:** ${list(cleaned)}.`,
      `**Kept (adopted, never destroyed):** ${list(kept)}.`,
      `**Left for you:** ${left.length ? "" : "nothing."}${left.length ? `\n\n${left.map((x) => `- ${x}`).join("\n")}` : ""}`,
    ],
    items: [],
    blocks: [manualSection(todos, "Undo by hand"), warningsSection(arr(e.warnings))],
    footer: footer([`destroy ${esc(rc.runId)}`], o.runUrl),
  };
}

// ---------------------------------------------------------------------------
// errors and crashes
// ---------------------------------------------------------------------------

/** Codes that are a refusal before anything was written (exit 2): the comment says "refused", not "failed". */
const REFUSALS = new Set(["PLAN_PARSE", "PLAN_INVALID", "REF_UNKNOWN", "REF_CYCLE", "REF_FILTERED", "REF_OUTPUT_UNKNOWN", "CTX_NULL", "ENV_UNKNOWN", "ENV_NOT_APPROVED", "SECRET_LITERAL", "ADAPTER_UNKNOWN", "OP_UNKNOWN", "PARAM_INVALID", "USAGE", "LOCK_HELD"]);

function renderError(e: Obj, o: MarkdownOptions): Parts {
  const err = isObj(e.error) ? e.error : {};
  const errCode = str(err.code);
  const command = o.command ?? (str(e.command) || "run");
  const fix = FIX[errCode] ?? (optStr(err.hint) ? esc(err.hint) : "");
  return {
    title: `Sponson ${esc(command)} ${REFUSALS.has(errCode) ? "refused" : "failed"}: ${code(errCode || "ERROR")}`,
    lead: [clip(err.message, 1000), fix ? `**Fix:** ${fix}` : "", REFUSALS.has(errCode) ? "Nothing was written." : ""],
    items: [],
    blocks: [],
    footer: footer([], o.runUrl),
  };
}

function renderCrash(o: MarkdownOptions): Parts {
  return {
    title: `Sponson ${esc(o.command ?? "run")} crashed (exit ${o.exitCode ?? "unknown"})`,
    lead: ["It printed no result. The run log says what happened."],
    items: [],
    blocks: [],
    footer: footer([], o.runUrl),
  };
}

/**
 * The PR comment for a `--json` envelope (`sponson plan --json`, `sponson apply --json`, `apply --destroy --json`,
 * or any error envelope). `null`, or anything that is not an envelope, renders as a crash. Pure: same input, same text.
 *
 * @example
 * ```ts
 * const envelope = JSON.parse(stdoutOfApplyJson);
 * const body = renderMarkdown(envelope, { environment: "preview", runUrl });
 * ```
 */
export function renderMarkdown(envelope: unknown, opts: MarkdownOptions = {}): string {
  const e = isObj(envelope) ? envelope : null;
  const rc = e && isObj(e.receipt) ? e.receipt : null;
  const environment = opts.environment ?? (str(rc?.environment ?? e?.environment) || "preview");
  const max = Math.min(opts.maxLength ?? GITHUB_COMMENT_LIMIT - 1536, GITHUB_COMMENT_LIMIT);
  return assemble(commentMarker(environment), partsOf(e, rc, opts), max) + "\n";
}

/** Which comment an envelope is: destroy, apply, plan, an error, or (anything else) a crash. */
function partsOf(e: Obj | null, rc: Obj | null, opts: MarkdownOptions): Parts {
  if (!e) return renderCrash(opts);
  if (rc) return rc.destroy === true ? renderDestroy(e, rc, opts) : renderApply(e, rc, opts);
  if (e.command === "plan" && Array.isArray(e.lines)) return renderPlan(e, opts);
  return isObj(e.error) ? renderError(e, opts) : renderCrash(opts);
}

/**
 * The CI run a comment links to, from the variables each supported CI sets: GitHub Actions, GitLab CI/CD, CircleCI,
 * Bitbucket Pipelines. Undefined elsewhere.
 */
export function ciRunUrl(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  if (env.CI_JOB_URL) return env.CI_JOB_URL;
  if (env.CIRCLE_BUILD_URL) return env.CIRCLE_BUILD_URL;
  if (env.BITBUCKET_GIT_HTTP_ORIGIN && env.BITBUCKET_BUILD_NUMBER) return `${env.BITBUCKET_GIT_HTTP_ORIGIN}/pipelines/results/${env.BITBUCKET_BUILD_NUMBER}`;
  return undefined;
}
