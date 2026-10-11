import type { ResourceAdapter } from "@sponson/core";
import { action } from "./http-adapter-action.js";
import { DEFAULT_AUTH_DEPS, type AuthDeps } from "./http-adapter-auth.js";
import { withDeps } from "./http-adapter-client.js";
import { listItem } from "./http-adapter-list.js";
import { resource } from "./http-adapter-resource.js";

/**
 * Where the generic adapter's credential and base URL override are configured: in the plan, per API, rather than
 * in fixed variables. Declared for the generated docs.
 */
const ABOUT = { credentialEnv: "providers.http.<api>.auth", baseUrlEnv: "providers.http.<api>.base_url_env" } as const;

/**
 * The generic adapter with its run-time dependencies (how `auth.command` runs a CLI, the clock for token expiry and
 * request signatures) replaced: for tests. Everything else uses `httpAdapter`.
 */
export function createHttpAdapter(deps: Partial<AuthDeps> = {}): ResourceAdapter {
  const all = { ...DEFAULT_AUTH_DEPS, ...deps };
  return { name: "http", ops: { resource: withDeps(resource, all), list_item: withDeps(listItem, all), action: withDeps(action, all) }, about: ABOUT };
}

/**
 * The generic `http` adapter: any JSON (or form, or XML) REST API, or a GraphQL one, described in the plan instead of
 * in TypeScript (ADR 0017). Op `resource` manages one object per item (a feature flag, a webhook endpoint, a
 * variable); op `list_item` keeps one value in a list on a parent object (an allowed origin, a callback URL). Each
 * op `action` sends one request when the line's trigger changes (an Inngest sync, a cache purge; ADR 0022). Each
 * line names an API configured under `providers.http.<api>` (`base_url`, how it authenticates, optional static
 * headers).
 */
export const httpAdapter: ResourceAdapter = { name: "http", ops: { resource, list_item: listItem, action }, about: ABOUT };
