/** Chaos configuration: what the fake cloud does wrong on purpose, and which requests it does it to. */

export interface ChaosConfig {
  latency_ms: number;
  /** Remaining requests (matching `fail_on`) that will fail with `status`. */
  fail_next: number;
  status: number;
  /** Sent as `Retry-After` (seconds) with chaos 429s. */
  retry_after?: number;
  /** Remaining requests (matching `fail_on`) that are performed, then answered by destroying the socket. */
  drop_response_next: number;
  /** Remaining requests (matching `fail_on`) that are accepted and never answered. */
  hang_next: number;
  /**
   * Remaining requests (matching `fail_on`) that are held, neither performed nor answered, until released
   * (`POST /_release` or `state.release()`); then they are performed and answered as usual. Lets a test pin
   * one client inside a request while another runs, instead of hoping timing makes them overlap.
   */
  hold_next: number;
  /**
   * Which requests the counters above apply to: `"METHOD /path-glob"` or a list of them.
   * Absent means every write. Reads are only affected by a rule whose method is GET.
   */
  fail_on?: string | string[];
  /** Deployment mode: ok | never | fail | stale | double | cancel | delay:<seconds>. */
  deploy: string;
  /** QUEUED → BUILDING → READY takes this long for deployments created through the API (and `ok` auto-deploys). */
  deploy_ms: number;
  /** After a Neon branch create, writes to that branch and further creates in the project answer 423 for this long. */
  neon_op_ms: number;
  /** When > 0, Neon branches, Vercel envs and Clerk redirect URLs are listed in pages of this size. */
  page_size: number;
  /** Keys a Vercel bulk upsert reports under `failed` (and does not write). */
  env_upsert_fail: string[];
}

export interface ChaosRequest extends Partial<ChaosConfig> {
  /** Applied immediately to state, not stored. */
  drift?: Record<string, string>;
}

/** What chaos does to one request. */
export type ChaosAction = { kind: "hold" } | { kind: "hang" } | { kind: "drop" } | { kind: "fail"; status: number; headers: Record<string, string> };

export const DEFAULT_CHAOS: ChaosConfig = {
  latency_ms: 0,
  fail_next: 0,
  status: 503,
  drop_response_next: 0,
  hang_next: 0,
  hold_next: 0,
  deploy: "ok",
  deploy_ms: 0,
  neon_op_ms: 0,
  page_size: 0,
  env_upsert_fail: [],
};

export const CHAOS_KEYS = new Set<string>([...Object.keys(DEFAULT_CHAOS), "fail_on", "retry_after"]);

/** A fresh default config (no shared arrays). */
export function defaultChaos(): ChaosConfig {
  return { ...DEFAULT_CHAOS, env_upsert_fail: [] };
}

/**
 * Decide what chaos does to this request, consuming one count of `c` when it does something.
 * Writes are eligible when `fail_on` is absent or matches; reads only when a GET rule matches.
 */
export function chaosFor(c: ChaosConfig, method: string, path: string): ChaosAction | null {
  if (c.hold_next <= 0 && c.hang_next <= 0 && c.drop_response_next <= 0 && c.fail_next <= 0) return null;
  const rules = c.fail_on === undefined ? [] : Array.isArray(c.fail_on) ? c.fail_on : [c.fail_on];
  const isRead = method === "GET" || method === "HEAD";
  const eligible = isRead
    ? rules.some((r) => ruleMethod(r) === "GET" && matchesRule(r, "GET", path))
    : rules.length === 0 || rules.some((r) => matchesRule(r, method, path));
  if (!eligible) return null;
  if (c.hold_next > 0) {
    c.hold_next -= 1;
    return { kind: "hold" };
  }
  if (c.hang_next > 0) {
    c.hang_next -= 1;
    return { kind: "hang" };
  }
  if (c.drop_response_next > 0) {
    c.drop_response_next -= 1;
    return { kind: "drop" };
  }
  if (c.fail_next > 0) {
    c.fail_next -= 1;
    const headers: Record<string, string> = c.status === 429 && c.retry_after !== undefined ? { "retry-after": String(c.retry_after) } : {};
    return { kind: "fail", status: c.status, headers };
  }
  return null;
}

/** `"DELETE /neon/*"`: method must match exactly (or be `*`), `*` in the path matches anything. */
export function matchesRule(rule: string, method: string, path: string): boolean {
  const space = rule.indexOf(" ");
  const m = ruleMethod(rule);
  const ruleGlob = space < 0 ? "*" : rule.slice(space + 1).trim();
  if (m !== "*" && m !== method.toUpperCase()) return false;
  const re = new RegExp("^" + ruleGlob.split("*").map(escapeRe).join(".*") + "$");
  return re.test(path);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ruleMethod(rule: string): string {
  const space = rule.indexOf(" ");
  return (space < 0 ? rule : rule.slice(0, space)).toUpperCase();
}
