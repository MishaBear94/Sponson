/**
 * What the GraphQL sims (routes/railway.ts, routes/fly.ts) share: reading an operation's kind and root field from a
 * request body, and answering in the GraphQL envelope. They do not parse GraphQL: a simulated schema is a table of
 * root fields, each resolved from the request's variables, so a plan line must pass its inputs as variables (as the
 * official clients do), not inline.
 */
import { Reply } from "./provider.js";

/** One GraphQL request as the sims see it. */
export interface GraphqlOperation {
  kind: "query" | "mutation";
  /** The first selected top-level field (after an alias). */
  root: string;
  variables: Record<string, unknown>;
}

/** The operation of a request body; a 400 GRAPHQL_PARSE_FAILED answer when the body is not one. */
export function graphqlOperation(body: unknown): GraphqlOperation | Reply {
  if (typeof body !== "object" || body === null) return graphqlError("request body must be a JSON object { query, variables }", "GRAPHQL_PARSE_FAILED", 400);
  const { query, variables } = body as Record<string, unknown>;
  if (typeof query !== "string") return graphqlError("`query` is required", "GRAPHQL_PARSE_FAILED", 400);
  const text = query.replace(/#[^\n]*/g, "").trim();
  const kind = /^mutation\b/.test(text) ? "mutation" : "query";
  const m = /^\s*([_A-Za-z]\w*)(\s*:\s*([_A-Za-z]\w*))?/.exec(text.slice(text.indexOf("{") + 1));
  if (!m) return graphqlError("no field selected", "GRAPHQL_PARSE_FAILED", 400);
  const vars = typeof variables === "object" && variables !== null && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
  return { kind, root: m[3] ?? m[1]!, variables: vars };
}

/** A successful answer: `{ data }`. */
export function graphqlData(data: unknown): Reply {
  return new Reply(200, { data });
}

/** A failed answer: `{ errors: [{ message, extensions: { code } }], data: null }`, HTTP 200 unless said otherwise. */
export function graphqlError(message: string, code: string, status = 200): Reply {
  return new Reply(status, { errors: [{ message, extensions: { code } }], data: null });
}

/** True when a request body is a mutation: only those change state (the write log). */
export function isMutation(body: unknown): boolean {
  const op = graphqlOperation(body);
  return !(op instanceof Reply) && op.kind === "mutation";
}
