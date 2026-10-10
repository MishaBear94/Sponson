/**
 * GraphQL requests for `http.resource`: any of `find`, `read`, `create`, `update` and `delete` may be
 * `{ graphql: { query, variables?, data_path? } }` instead of a method and a path. The request is a POST of
 * `{ query, variables }` as JSON to the API's `base_url` (the GraphQL endpoint); what it answers is `data`, and a
 * non-empty `errors` array is a provider error classified like an HTTP status would be (not found, conflict, not
 * authorised, …). See ADR 0017 (amendment) and docs/plan-format.md#graphql-requests.
 */
import { SponsonError, canonicalJson, markerKind } from "@sponson/core";
import { paramError } from "./common.js";
import { isObject, type ApiClient, type ProviderErrorCode } from "./http.js";

const ADAPTER = "http";

/** One GraphQL request of a line: the document, its variables (values may be references), and where the result is. */
export interface GraphqlSpec {
  query: string;
  variables: Record<string, unknown>;
  /** JSON pointer into `data` to the result (the object, the list); absent: the op's `item_path` / `find.list_path`. */
  dataPath?: string;
  /** The mutation sets state (an upsert), so a dropped connection may be retried. */
  idempotent: boolean;
}

/** The placeholder a variable may hold to receive the object's id: a string leaf that is exactly this. */
export const ID_VARIABLE = "{id}";

const GRAPHQL_KEYS = ["query", "variables", "data_path", "idempotent"];

/** `<param>.graphql`, checked. `{id}` may appear as a variable value only where the id is known (not in find or create). */
function queryParam(v: unknown, param: string): string {
  if (typeof v !== "string" || !v.includes("{") || rootField(v) === undefined) {
    throw paramError(ADAPTER, `\`${param}\` must be a GraphQL document with one operation, e.g. "mutation($input: X!) { thing(input: $input) }"`, param);
  }
  return v;
}

function variablesParam(v: unknown, param: string, idAllowed: boolean): Record<string, unknown> {
  const variables = v ?? {};
  if (!isObject(variables)) throw paramError(ADAPTER, `\`${param}\` must be a map of variable name to value`, param);
  if (!idAllowed && usesId(variables)) throw paramError(ADAPTER, `\`${param}\` uses "${ID_VARIABLE}", which is not known here (the id exists only once the object does)`, param);
  return variables;
}

export function parseGraphql(v: unknown, param: string, idAllowed: boolean): GraphqlSpec {
  if (!isObject(v)) throw paramError(ADAPTER, `\`${param}\` must be a map: { query, variables?, data_path? }`, param);
  const extra = Object.keys(v).find((k) => !GRAPHQL_KEYS.includes(k));
  if (extra) throw paramError(ADAPTER, `\`${param}.${extra}\` is not known (known: ${GRAPHQL_KEYS.join(", ")})`, `${param}.${extra}`);
  const query = queryParam(v.query, `${param}.query`);
  const variables = variablesParam(v.variables, `${param}.variables`, idAllowed);
  const dp = v.data_path;
  if (dp !== undefined && (typeof dp !== "string" || (dp !== "" && !dp.startsWith("/")))) throw paramError(ADAPTER, `\`${param}.data_path\` must be a JSON pointer into \`data\`, e.g. /app/secrets`, `${param}.data_path`);
  if (v.idempotent !== undefined && typeof v.idempotent !== "boolean") throw paramError(ADAPTER, `\`${param}.idempotent\` must be true or false`, `${param}.idempotent`);
  return { query, variables, ...(typeof dp === "string" ? { dataPath: dp } : {}), idempotent: v.idempotent === true };
}

/**
 * The first top-level field the operation selects (`variables` in `query($p: String!) { variables(projectId: $p) }`,
 * after any alias): it names the request in keys and labels. Undefined when the document has none.
 */
export function rootField(query: string): string | undefined {
  const withoutComments = query.replace(/#[^\n]*/g, "");
  const body = withoutComments.slice(withoutComments.indexOf("{") + 1);
  const m = /^\s*([_A-Za-z][_0-9A-Za-z]*)(\s*:\s*([_A-Za-z][_0-9A-Za-z]*))?/.exec(body);
  return m ? (m[3] ?? m[1]) : undefined;
}

/** True when some string leaf of `v` is exactly `{id}`. */
export function usesId(v: unknown): boolean {
  if (v === ID_VARIABLE) return true;
  if (Array.isArray(v)) return v.some(usesId);
  return isObject(v) && Object.values(v).some(usesId);
}

/** `v` with every `{id}` leaf replaced by `id`. */
export function fillVariables(v: unknown, id: string | undefined): unknown {
  if (v === ID_VARIABLE && id !== undefined) return id;
  if (Array.isArray(v)) return v.map((x) => fillVariables(x, id));
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillVariables(x, id)]));
  return v;
}

/** True when a variable is still a pending reference or an unresolved secret (the request cannot be made yet). */
export function variablesPending(v: unknown): boolean {
  const kind = markerKind(v);
  if (kind === "pending" || kind === "secret") return true;
  if (Array.isArray(v)) return v.some(variablesPending);
  return isObject(v) && Object.values(v).some(variablesPending);
}

/**
 * How a locating request (`read`, `find`) is named in resource keys: `graphql:variables({"environmentId":"…"})`.
 * Never the query text, so rewording a query does not re-identify the resource.
 */
export function requestName(g: GraphqlSpec): string {
  return `graphql:${rootField(g.query) ?? "operation"}(${canonicalJson(g.variables)})`;
}

const BY_CODE: Record<string, ProviderErrorCode> = {
  UNAUTHENTICATED: "PROVIDER_AUTH",
  UNAUTHORIZED: "PROVIDER_AUTH",
  FORBIDDEN: "PROVIDER_AUTH",
  NOT_FOUND: "PROVIDER_NOT_FOUND",
  CONFLICT: "PROVIDER_CONFLICT",
  ALREADY_EXISTS: "PROVIDER_CONFLICT",
  RATE_LIMITED: "PROVIDER_TRANSIENT",
  TOO_MANY_REQUESTS: "PROVIDER_TRANSIENT",
  SERVICE_UNAVAILABLE: "PROVIDER_TRANSIENT",
  BAD_USER_INPUT: "PROVIDER_INVALID",
  GRAPHQL_VALIDATION_FAILED: "PROVIDER_INVALID",
  GRAPHQL_PARSE_FAILED: "PROVIDER_INVALID",
};

/**
 * The PROVIDER_* code of a GraphQL error: its message first (Railway answers a denied token with
 * `INTERNAL_SERVER_ERROR` "Not Authorized"), then `extensions.code`, then PROVIDER_INVALID.
 */
export function classifyGraphqlError(message: string, code: string | undefined): ProviderErrorCode {
  if (/\b(not authori[sz]ed|unauthori[sz]ed|unauthenticated|forbidden|permission denied)\b/i.test(message)) return "PROVIDER_AUTH";
  if (/\b(not found|does not exist|could not find|no such)\b/i.test(message)) return "PROVIDER_NOT_FOUND";
  if (/\b(already exists|already taken|duplicate)\b/i.test(message)) return "PROVIDER_CONFLICT";
  const byCode = code === undefined ? undefined : BY_CODE[code.toUpperCase()];
  if (byCode) return byCode;
  return code?.toUpperCase() === "INTERNAL_SERVER_ERROR" ? "PROVIDER_TRANSIENT" : "PROVIDER_INVALID";
}

function errorOf(errors: unknown[], name: string, redact: (t: string) => string): SponsonError {
  const first = isObject(errors[0]) ? errors[0] : {};
  const message = typeof first.message === "string" ? first.message : JSON.stringify(first);
  const ext = isObject(first.extensions) ? first.extensions : {};
  const code = typeof ext.code === "string" ? ext.code : undefined;
  const text = redact(message).replace(/\s+/g, " ").slice(0, 300);
  const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : "";
  return new SponsonError(classifyGraphqlError(message, code), `${ADAPTER}: GraphQL ${name} → ${code ?? "error"}: ${text}${more}`, {
    adapter: ADAPTER,
    method: "POST",
    path: name,
    ...(code ? { graphqlCode: code } : {}),
  });
}

/**
 * Send one GraphQL request and return its `data` (null when absent). HTTP failures are classified by the client as
 * for any request; a 2xx answer with `errors` is classified here.
 */
export async function graphqlRequest(api: ApiClient, g: GraphqlSpec, id: string | undefined, redact: (t: string) => string, mutation: boolean): Promise<unknown> {
  const body = { query: g.query, variables: fillVariables(g.variables, id) };
  // Named by its root field only: a mutation's variables may hold the very secret it writes.
  const name = rootField(g.query) ?? "operation";
  let answer: unknown;
  try {
    answer = await api.post("", body, undefined, { idempotent: !mutation || g.idempotent });
  } catch (e) {
    // The client names the request `POST <path>`, and a GraphQL request's path is empty: name the operation instead.
    if (e instanceof SponsonError) throw new SponsonError(e.code, e.message.replace(/^http: POST {2}→/, `${ADAPTER}: GraphQL ${name} →`), { ...e.details, path: name });
    throw e;
  }
  if (!isObject(answer)) throw new SponsonError("PROVIDER_RESPONSE", `${ADAPTER}: GraphQL ${name}: the answer is not a JSON object`, { adapter: ADAPTER, method: "POST", path: name });
  if (Array.isArray(answer.errors) && answer.errors.length > 0) throw errorOf(answer.errors, name, redact);
  return answer.data ?? null;
}
