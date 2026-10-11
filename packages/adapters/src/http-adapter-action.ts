/**
 * `http.action`: one request (or GraphQL request) sent when the line's trigger changes, for side effects with
 * nothing to read back or delete: an Inngest sync of a preview deployment, a cache purge, a deploy notification.
 * See ADR 0022 and docs/plan-format.md#httpaction.
 *
 * The engine owns the line's state (`OpSpec.action`): the ledger key is `action:<line id>`, the hash the trigger's,
 * and `apply` is called only to send it. This file parses the line, sends the request and checks the answer
 * (status, `expect`), takes the declared outputs, and returns the record id that says how to undo it:
 *
 * - `FORGET`: no `undo`; destroy forgets the record;
 * - `UNDO <canonical JSON request>`: the `undo` request with every value resolved when the action ran (references
 *   and outputs filled in, never a secret), so destroy needs nothing but the ledger.
 *
 * A request goes either to the line's API (`path`, or `graphql`; the `providers.http.<api>` block's base URL,
 * credential and headers) or to an absolute `url` (the app's own endpoint, such as a preview deployment's
 * `/api/inngest`), which gets no credential and no API headers: a URL resolved at run time never receives the
 * API's credential. A `url` line has no `api` and its provider block (ledger identity) is empty.
 */
import { SponsonError, canonicalJson, sha256, type AdapterContext, type ApplyResult, type Literal, type OpSpec, type OutputSpec } from "@sponson/core";
import { assertNoPending, clientFor, paramError } from "./common.js";
import { isObject, isProviderError, type ApiClient } from "./http.js";
import { HEADER_NAME } from "./http-adapter-auth.js";
import { httpClient, literalOf } from "./http-adapter-client.js";
import { parseGraphql, graphqlRequest, rootField, type GraphqlSpec } from "./http-adapter-graphql.js";
import { ADAPTER, apiBlock, apiEnvironment, at, fillPath, firstMarker, placeholders, pointerTokens } from "./http-adapter-spec.js";
import { expandRecipe } from "./recipes.js";

/** One request of an action: to the API (`path` or `graphql`) or to an absolute `url`. */
export interface ActionRequest {
  method: string;
  /** Relative to the API's base URL; placeholders from `vars` (and, in `undo`, from the outputs). */
  path?: string;
  /** An absolute http(s) URL; a reference until it resolves. */
  url?: unknown;
  /** Absent: no body. */
  body?: unknown;
  /** Header name → value (references allowed; a `{ secret }` only in `request`, never in `undo`). */
  headers: Record<string, unknown>;
  contentType?: string;
  graphql?: GraphqlSpec;
}

/** `http.action` params, checked. Values may still be markers. */
export interface ActionSpec {
  api?: string;
  vars: Record<string, unknown>;
  trigger: Record<string, unknown>;
  request: ActionRequest & { idempotencyKey: boolean };
  undo?: ActionRequest;
  /** Statuses (400–499) that count as success too, with no answer to read (an "already done" 409). */
  okStatus: number[];
  /** JSON pointer → value the answer must hold, or the action failed. */
  expect: Record<string, unknown>;
  /** Output name → JSON pointer into the answer. Never sensitive: an unchanged line's outputs come from the ledger. */
  outputs: Record<string, string>;
}

const ACTION_PARAMS = ["api", "vars", "trigger", "request", "undo", "ok_status", "expect", "outputs"];
const REQUEST_KEYS = ["method", "path", "url", "body", "headers", "content_type", "graphql", "idempotency_key"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function fail(message: string, param: string): SponsonError {
  return paramError(ADAPTER, message, param);
}

function mapParam(v: unknown, param: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (!isObject(v)) throw fail(`\`${param}\` must be a map`, param);
  return v;
}

function headersParam(v: unknown, param: string): Record<string, unknown> {
  const o = mapParam(v, param);
  for (const k of Object.keys(o)) {
    if (!HEADER_NAME.test(k)) throw fail(`\`${param}.${k}\` is not a header name`, `${param}.${k}`);
    if (/^(authorization|accept|content-type|idempotency-key)$/i.test(k)) throw fail(`\`${param}.${k}\` is set by Sponson or the API block`, `${param}.${k}`);
  }
  return o;
}

function contentTypeParam(v: unknown, param: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !/^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/.test(v)) throw fail(`\`${param}\` must be a media type such as application/json`, param);
  return v;
}

/** Where a request goes: exactly one of `path`, `url` and `graphql`. */
function target(o: Record<string, unknown>, param: string): Pick<ActionRequest, "path" | "url" | "graphql"> {
  const given = ["path", "url", "graphql"].filter((k) => o[k] !== undefined);
  if (given.length !== 1) throw fail(`\`${param}\` needs exactly one of \`path\` (relative to the API's base_url), \`url\` (an absolute URL, sent without the API's credential) or \`graphql\``, param);
  if (o.graphql !== undefined) {
    const extra = Object.keys(o).find((k) => k !== "graphql" && k !== "idempotency_key");
    if (extra) throw fail(`\`${param}.${extra}\` does not apply to a GraphQL request (the query and its variables say everything)`, `${param}.${extra}`);
    return { graphql: parseGraphql(o.graphql, `${param}.graphql`, false) };
  }
  if (o.path !== undefined) {
    if (typeof o.path !== "string" || !o.path.startsWith("/")) throw fail(`\`${param}.path\` must be a path starting with "/" (relative to the API's base_url)`, `${param}.path`);
    return { path: o.path };
  }
  // A reference (pending, or written as `{ from }`) and an uninterpolated `${ctx.*}` are checked once resolved.
  const known = typeof o.url === "string" && firstMarker(o.url) === undefined && !o.url.includes("${");
  if (known && !/^https?:\/\/\S+$/.test(o.url as string)) throw fail(`\`${param}.url\` must be an absolute http(s) URL`, `${param}.url`);
  return { url: o.url };
}

function parseRequest(v: unknown, param: string): ActionSpec["request"] {
  if (!isObject(v)) throw fail(`\`${param}\` is required: \`{ method, path | url | graphql, body?, headers? }\``, param);
  const extra = Object.keys(v).find((k) => !REQUEST_KEYS.includes(k));
  if (extra) throw fail(`\`${param}.${extra}\` is not known (known: ${REQUEST_KEYS.join(", ")})`, `${param}.${extra}`);
  if (v.idempotency_key !== undefined && typeof v.idempotency_key !== "boolean") throw fail(`\`${param}.idempotency_key\` must be true or false`, `${param}.idempotency_key`);
  const where = target(v, param);
  const method = where.graphql ? "POST" : methodOf(v.method, `${param}.method`);
  if (method === "GET" && v.body !== undefined) throw fail(`\`${param}.body\` cannot be sent with GET`, `${param}.body`);
  const contentType = contentTypeParam(v.content_type, `${param}.content_type`);
  return {
    method,
    ...where,
    ...(v.body !== undefined ? { body: v.body } : {}),
    headers: headersParam(v.headers, `${param}.headers`),
    ...(contentType ? { contentType } : {}),
    idempotencyKey: v.idempotency_key === true,
  };
}

function methodOf(v: unknown, param: string): string {
  if (v === undefined) return "POST";
  const m = typeof v === "string" ? v.toUpperCase() : "";
  if (!METHODS.includes(m)) throw fail(`\`${param}\` must be one of ${METHODS.join(", ")}`, param);
  return m;
}

function parseUndo(v: unknown): ActionRequest | undefined {
  if (v === undefined || v === null) return undefined;
  const r = parseRequest(v, "undo");
  if (r.idempotencyKey) throw fail("`undo.idempotency_key` does not apply: an undo is sent once, by destroy", "undo.idempotency_key");
  const { idempotencyKey: _unused, ...undo } = r;
  return undo;
}

function parseOutputs(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, p] of Object.entries(mapParam(v, "outputs"))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw fail(`output name \`${name}\` must be letters, digits and _`, `outputs.${name}`);
    if (typeof p !== "string" || (p !== "" && !p.startsWith("/"))) {
      throw fail(`\`outputs.${name}\` must be a JSON pointer into the answer, such as /data/id (an action's outputs are never sensitive: an unchanged line passes on the recorded ones)`, `outputs.${name}`);
    }
    out[name] = p;
  }
  return out;
}

function parseOkStatus(v: unknown): number[] {
  if (v === undefined) return [];
  const list = Array.isArray(v) ? v : [v];
  if (!list.every((s) => Number.isInteger(s) && (s as number) >= 400 && (s as number) <= 499)) throw fail("`ok_status` must be a list of HTTP statuses 400–499 that also mean success (such as 409, already done)", "ok_status");
  return list as number[];
}

function parseExpect(v: unknown): Record<string, unknown> {
  const o = mapParam(v, "expect");
  for (const p of Object.keys(o)) if (!p.startsWith("/")) throw fail(`\`expect.${p}\` must be a JSON pointer into the answer, such as /data/status`, `expect.${p}`);
  return o;
}

/** Path placeholders must be declared: in `vars`, or (in `undo`) an output of the action. */
function checkPlaceholders(req: ActionRequest | undefined, param: string, known: string[]): void {
  for (const name of req?.path ? placeholders(req.path) : []) {
    if (!known.includes(name)) throw fail(`\`${param}.path\` uses \`{${name}}\`, which is not declared in \`vars\`${param === "undo" ? " or `outputs`" : ""}`, `${param}.path`);
  }
}

/** The request goes to the API (its block, credential and base URL), not to an absolute URL. */
function usesApi(req: ActionRequest): boolean {
  return req.url === undefined;
}

/** `http.action` params, checked; PARAM_INVALID naming the field otherwise. */
export function parseAction(line: Record<string, unknown>): ActionSpec {
  const params = expandRecipe(line, "action");
  const extra = Object.keys(params).find((k) => !ACTION_PARAMS.includes(k));
  if (extra) throw fail(`\`${extra}\` is not a parameter of http.action (known: ${ACTION_PARAMS.join(", ")})`, extra);
  const trigger = mapParam(params.trigger, "trigger");
  if (Object.keys(trigger).length === 0) throw fail("`trigger` is required: the values whose change makes the action run again, e.g. `{ sha: \"${ctx.git.sha}\", url: { from: web.preview_url } }`", "trigger");
  const vars = mapParam(params.vars, "vars");
  const request = parseRequest(params.request, "request");
  const undo = parseUndo(params.undo);
  const outputs = parseOutputs(params.outputs);
  checkPlaceholders(request, "request", Object.keys(vars));
  checkPlaceholders(undo, "undo", [...Object.keys(vars), ...Object.keys(outputs)]);
  const api = typeof params.api === "string" && params.api !== "" ? params.api : undefined;
  const needsApi = usesApi(request) || (undo !== undefined && usesApi(undo));
  if (needsApi && !api) throw fail("`api` is required for a `path` or `graphql` request: the name of an API configured under `providers.http`", "api");
  if (!needsApi && line.api !== undefined) throw fail("a `url` request is sent without the API's credential, so the line takes no `api`: remove it", "api");
  return { ...(api && needsApi ? { api } : {}), vars, trigger, request, ...(undo ? { undo } : {}), okStatus: parseOkStatus(params.ok_status), expect: parseExpect(params.expect), outputs };
}

/** `OpSpec.providerFor`: the API block for a line that talks to its API; nothing for one that only calls a `url`. */
function actionProvider(block: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
  const spec = parseAction(params);
  return spec.api ? apiBlock(block, { ...params, api: spec.api }) : {};
}

function actionOutputs(params: Record<string, unknown>): Record<string, OutputSpec> {
  return Object.fromEntries(Object.keys(parseAction(params).outputs).map((n) => [n, { available: "immediate" }]));
}

/** Where a request goes, for labels and errors: the API's path or GraphQL field, or the URL. */
function describe(spec: ActionSpec, req: ActionRequest, outputs: Record<string, unknown> = {}): string {
  if (req.graphql) return `${spec.api} GraphQL ${rootField(req.graphql.query) ?? "operation"}`;
  if (req.path) return `${spec.api} ${req.method} ${fillPath(req.path, { ...outputs, ...spec.vars }) ?? req.path}`;
  return `${req.method} ${typeof req.url === "string" && firstMarker(req.url) === undefined ? req.url : "(url pending)"}`;
}

/** The `Idempotency-Key`: one per action and trigger, so a run sent again after a crash is answered once. */
function idempotencyKey(actx: AdapterContext, key: string, hash: string): string {
  return `sponson-${sha256(`${actx.ctx.env}|${actx.ctx.scope}|${key}|${hash}`).slice(0, 40)}`;
}

/** Header values as strings; PARAM_INVALID for one that is not a scalar. */
function headerValues(req: ActionRequest, param: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw fail(`\`${param}.headers.${k}\` must be a string, number or boolean`, `${param}.headers.${k}`);
    out[k] = String(v);
  }
  return out;
}

/** The client a request goes through, and the path to send it to. A `url` request carries no credential. */
function clientOf(actx: AdapterContext, req: ActionRequest, headers: Record<string, string>, vars: Record<string, unknown>, param: string): { api: ApiClient; path: string } {
  const opts = { headers, ...(req.contentType ? { contentType: req.contentType } : {}) };
  if (req.url !== undefined) {
    if (typeof req.url !== "string" || !/^https?:\/\/\S+$/.test(req.url)) throw fail(`\`${param}.url\` must resolve to an absolute http(s) URL`, `${param}.url`);
    // Named by its path in messages (`PUT /api/inngest → 500`); the origin is the client's base URL.
    const url = new URL(req.url);
    return { api: clientFor(actx, ADAPTER, { baseUrl: url.origin, token: "", authHeader: "none", encoding: "json", ...opts }), path: `${url.pathname}${url.search}` };
  }
  const path = req.path === undefined ? "" : fillPath(req.path, vars);
  if (path === undefined) throw fail(`\`${param}.path\`: a placeholder has no value`, `${param}.path`);
  return { api: httpClient(actx, req.graphql ? { encoding: "json", headers } : opts), path };
}

/** Send one request; the answer, or undefined when it was a listed `ok_status` (nothing to read). */
async function send(actx: AdapterContext, req: ActionRequest, c: { api: ApiClient; path: string }, idempotent: boolean, okStatus: number[]): Promise<unknown> {
  try {
    if (req.graphql) return await graphqlRequest(c.api, { ...req.graphql, idempotent }, undefined, actx.redact, true);
    if (req.method === "GET") return await c.api.get(c.path);
    if (req.method === "DELETE") return await c.api.delete(c.path);
    if (req.method === "PUT") return await c.api.put(c.path, req.body);
    if (req.method === "PATCH") return await c.api.patch(c.path, req.body, undefined, { idempotent });
    return await c.api.post(c.path, req.body, undefined, { idempotent });
  } catch (e) {
    const status = isProviderError(e) ? e.details.status : undefined;
    if (status !== undefined && okStatus.includes(status)) return undefined;
    // A 2xx answer that is not JSON (`OK`): accepted; there is just nothing to read.
    if (isProviderError(e, "PROVIDER_RESPONSE") && status !== undefined && status >= 200 && status < 300) return undefined;
    throw e;
  }
}

/** Every `expect` pointer holds its value in the answer, or the action failed (PROVIDER_RESPONSE). */
function checkExpect(spec: ActionSpec, answer: unknown, what: string): void {
  for (const [pointer, want] of Object.entries(spec.expect)) {
    const got = at(answer, pointerTokens(pointer));
    if (canonicalJson(got ?? null) === canonicalJson(want)) continue;
    const shown = got === undefined ? "nothing" : JSON.stringify(got).slice(0, 120);
    throw new SponsonError("PROVIDER_RESPONSE", `${ADAPTER}: ${what}: the answer has ${shown} at ${pointer}, expected ${JSON.stringify(want)} (\`expect\`)`, { adapter: ADAPTER, param: `expect.${pointer}` });
  }
}

function outputsOf(spec: ActionSpec, answer: unknown): Record<string, Literal> {
  const out: Record<string, Literal> = {};
  for (const [name, pointer] of Object.entries(spec.outputs)) {
    const v = literalOf(at(answer, pointerTokens(pointer)));
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/**
 * The record id: `FORGET`, or the undo request with everything resolved now (outputs fill its placeholders). Kept
 * in receipts, so it may not carry a secret.
 */
function undoId(actx: AdapterContext, spec: ActionSpec, outputs: Record<string, Literal>): string {
  const u = spec.undo;
  if (!u) return "FORGET";
  const path = u.path === undefined ? undefined : fillPath(u.path, { ...outputs, ...spec.vars });
  if (u.path !== undefined && path === undefined) throw new SponsonError("PROVIDER_RESPONSE", `${ADAPTER}: \`undo.path\` ${u.path}: the answer has no value for one of its placeholders`, { adapter: ADAPTER, param: "undo.path" });
  const request = { method: u.method, ...(path !== undefined ? { path } : {}), ...(u.url !== undefined ? { url: u.url } : {}), ...(u.body !== undefined ? { body: u.body } : {}), ...(u.graphql ? { graphql: { query: u.graphql.query, variables: u.graphql.variables } } : {}), headers: headerValues(u, "undo") };
  const id = `UNDO ${canonicalJson(request)}`;
  if (actx.redact(id) !== id) throw fail("`undo` may not hold a secret: it is kept in receipts so that destroy can send it", "undo");
  return id;
}

/**
 * What the ledger knows a line's action by, as far as the line decides it: the key is the engine's
 * (`action:<line id>`), the record id `FORGET` or the undo request (its placeholders filled when it runs). The
 * recipe identity lock (recipes.test.ts) pins it per recipe op.
 */
export function actionIdentity(spec: ActionSpec): { key: string; id: string } {
  const u = spec.undo;
  if (!u) return { key: "action:<line id>", id: "FORGET" };
  const template = { method: u.method, path: u.path, url: u.url, body: u.body, graphql: u.graphql ? { query: u.graphql.query, variables: u.graphql.variables } : undefined };
  return { key: "action:<line id>", id: `UNDO ${canonicalJson(JSON.parse(JSON.stringify(template)))}` };
}

/** The undo request a record id names; null for `FORGET`. */
function parseUndoId(id: string): ActionRequest | null {
  if (id === "FORGET" || id === "") return null;
  const m = /^UNDO (\{.*\})$/s.exec(id);
  const r = m ? (JSON.parse(m[1]!) as Record<string, unknown>) : undefined;
  if (!r || typeof r.method !== "string") throw new SponsonError("INTERNAL", `${ADAPTER}: record id is not an action's undo request`, { adapter: ADAPTER });
  const g = isObject(r.graphql) ? r.graphql : undefined;
  return {
    method: r.method,
    ...(typeof r.path === "string" ? { path: r.path } : {}),
    ...(r.url !== undefined ? { url: r.url } : {}),
    ...(r.body !== undefined ? { body: r.body } : {}),
    headers: isObject(r.headers) ? r.headers : {},
    ...(g ? { graphql: { query: String(g.query), variables: isObject(g.variables) ? g.variables : {}, idempotent: true } } : {}),
  };
}

async function run(actx: AdapterContext, params: Record<string, unknown>, key: string, hash: string): Promise<ApplyResult> {
  const spec = parseAction(params);
  const req = spec.request;
  const what = describe(spec, req);
  const headers = { ...headerValues(req, "request"), ...(req.idempotencyKey ? { "Idempotency-Key": idempotencyKey(actx, key, hash) } : {}) };
  actx.log(`run ${what}`);
  const answer = await send(actx, req, clientOf(actx, req, headers, spec.vars, "request"), req.idempotencyKey, spec.okStatus);
  checkExpect(spec, answer, what);
  const outputs = outputsOf(spec, answer);
  return { resources: [{ key, id: undoId(actx, spec, outputs), hash, label: what }], outputs, created: [] };
}

/** `http.action`: one request sent when the line's trigger changes; the engine records which trigger ran. */
export const action: OpSpec = {
  outputs: {},
  outputsFor: actionOutputs,
  providerFor: actionProvider,
  writesEnvironment: apiEnvironment,

  action(params) {
    const spec = parseAction(params);
    if (firstMarker(spec.trigger) !== undefined) return null;
    return { trigger: spec.trigger, label: describe(spec, spec.request) };
  },

  async read() {
    // The engine owns an action's state (OpSpec.action): there is nothing at the provider to read back.
    return null;
  },

  diff() {
    return [];
  },

  async apply(actx, params, live) {
    assertNoPending(params, ADAPTER);
    const r = live?.resources[0];
    if (!r) throw new SponsonError("INTERNAL", `${ADAPTER}: http.action is applied by the engine's action path, which passes its ledger key and trigger hash`, { adapter: ADAPTER });
    return run(actx, params, r.key, r.hash);
  },

  async destroy(actx, resources) {
    for (const r of resources) {
      const undo = parseUndoId(r.id);
      if (!undo) continue;
      actx.log(`undo ${r.label ?? r.key}`);
      try {
        await send(actx, undo, clientOf(actx, undo, headerValues(undo, "undo"), {}, "undo"), true, []);
      } catch (e) {
        // Already undone (or never there): what destroy wanted.
        if (!isProviderError(e, "PROVIDER_NOT_FOUND")) throw e;
      }
    }
  },
};
