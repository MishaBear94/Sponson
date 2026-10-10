import type { ResourceAdapter } from "@sponson/core";
import { listItem } from "./http-adapter-list.js";
import { resource } from "./http-adapter-resource.js";

/**
 * Where the generic adapter's credential and base URL override are configured: in the plan, per API, rather than
 * in fixed variables. Declared for the generated docs.
 */
const ABOUT = { credentialEnv: "providers.http.<api>.auth", baseUrlEnv: "providers.http.<api>.base_url_env" } as const;

/**
 * The generic `http` adapter: any JSON REST API described in the plan instead of in TypeScript (ADR 0017). Op
 * `resource` manages one object per item (a feature flag, a webhook endpoint); op `list_item` keeps one value in a
 * list on a parent object (an allowed origin, a callback URL). Each line names an API configured under
 * `providers.http.<api>` (`base_url`, the NAME of the environment variable holding its credential, optional static
 * headers).
 */
export const httpAdapter: ResourceAdapter = { name: "http", ops: { resource, list_item: listItem }, about: ABOUT };
