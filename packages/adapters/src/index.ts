import { Registry } from "@sponson/core";
import { clerkAdapter } from "./clerk.js";
import { httpAdapter } from "./http-adapter.js";
import { neonAdapter } from "./neon.js";
import { awsSecretsManagerSource, dopplerSecretSource, envSecretSource, gcpSecretManagerSource, opSecretSource } from "./secrets.js";
import { vercelAdapter } from "./vercel.js";
import { planetscaleAdapter } from "./planetscale.js";
import { launchdarklyAdapter } from "./launchdarkly.js";
import { supabaseAdapter } from "./supabase.js";
import { manualAdapter } from "./manual.js";

/**
 * The stable adapter authoring API: what templates/adapter (`pnpm new:adapter`) uses, and what an out-of-tree
 * adapter may rely on across minor releases. From common.ts: the helpers below (see the comment at its top).
 * From http.ts: `ApiClient`, `Page`, `Shape`, `ShapeError`, `isObject`, `obj`, `records`, `listAll`,
 * `withQuery` and `isProviderError`; the rest of http.ts is exported for the built-in adapters and tests.
 * scenarios/tooling/new-adapter.test.ts fails if the template imports a helper that is not exported here.
 */
export { clientFor, requireEnv, optionalEnv, requireProvider, diffValue, desiredSide, assertNoPending, deleteIgnoringNotFound, paramError, stringParam } from "./common.js";
export * from "./http.js";
export * from "./neon.js";
export * from "./vercel.js";
export * from "./clerk.js";
export { httpAdapter } from "./http-adapter.js";
export * from "./secrets.js";
export * from "./planetscale.js";
export * from "./launchdarkly.js";
export * from "./supabase.js";
export { manualAdapter } from "./manual.js";

/** Every built-in adapter and secret source. The CLI uses this; tests build narrower registries. */
export function createRegistry(): Registry {
  return new Registry().addAdapter(neonAdapter).addAdapter(vercelAdapter).addAdapter(clerkAdapter).addAdapter(planetscaleAdapter).addAdapter(launchdarklyAdapter).addAdapter(httpAdapter).addAdapter(supabaseAdapter).addAdapter(manualAdapter).addSecretSource(envSecretSource).addSecretSource(dopplerSecretSource()).addSecretSource(opSecretSource()).addSecretSource(awsSecretsManagerSource()).addSecretSource(gcpSecretManagerSource());
}
