import { Registry } from "@sponson/core";
import { clerkAdapter } from "./clerk.js";
import { httpAdapter } from "./http-adapter.js";
import { neonAdapter } from "./neon.js";
import { awsSecretsManagerSource, azureKeyVaultSource, bitwardenSecretsManagerSource, dopplerSecretSource, envSecretSource, gcpSecretManagerSource, infisicalSecretSource, opConnectSecretSource, opSecretSource, vaultSecretSource } from "./secrets.js";
import { vercelAdapter } from "./vercel.js";
import { netlifyAdapter } from "./netlify.js";
import { planetscaleAdapter } from "./planetscale.js";
import { launchdarklyAdapter } from "./launchdarkly.js";
import { supabaseAdapter } from "./supabase.js";
import { manualAdapter } from "./manual.js";
import { cloudflareAdapter } from "./cloudflare.js";
import { algoliaAdapter } from "./algolia.js";
import { xataAdapter } from "./xata.js";
import { digitaloceanAdapter } from "./digitalocean.js";
import { cloudRunAdapter } from "./cloud_run.js";

/**
 * The stable adapter authoring API: what templates/adapter (`pnpm new:adapter`) uses, and what an out-of-tree
 * adapter may rely on across minor releases. From common.ts: the helpers below (see the comment at its top).
 * From http.ts: `ApiClient`, `Page`, `Shape`, `ShapeError`, `isObject`, `obj`, `records`, `listAll`,
 * `withQuery` and `isProviderError`; the rest of http.ts is exported for the built-in adapters and tests.
 * scenarios/tooling/new-adapter.test.ts fails if the template imports a helper that is not exported here.
 */
export { clientFor, requireEnv, optionalEnv, requireProvider, diffValue, desiredSide, assertNoPending, deleteIgnoringNotFound, paramError, stringParam, verifyByGet } from "./common.js";
export { verifyRecipeCredential } from "./credentials.js";
export * from "./http.js";
export * from "./neon.js";
export * from "./vercel.js";
export * from "./clerk.js";
export { httpAdapter } from "./http-adapter.js";
export { RECIPES_DIR, expandRecipe, loadRecipe, loadRecipes, recipeCredentialEnv, recipeNames, resolveRecipeApi, type Recipe, type RecipeAssumption, type RecipeCredential, type RecipeDetect, type RecipeOp, type RecipeParam, type RecipeParamType, type RecipeSimHints, type RecipeStarter } from "./recipes.js";
export { detectableProviders, type DetectableProvider } from "./providers.js";
export * from "./secrets.js";
export * from "./planetscale.js";
export * from "./launchdarkly.js";
export * from "./supabase.js";
export { manualAdapter } from "./manual.js";
export * from "./netlify.js";
export * from "./cloudflare.js";
export * from "./algolia.js";
export * from "./xata.js";
export * from "./digitalocean.js";
export * from "./cloud_run.js";

/** Every built-in adapter and secret source. The CLI uses this; tests build narrower registries. */
export function createRegistry(): Registry {
  return new Registry().addAdapter(neonAdapter).addAdapter(vercelAdapter).addAdapter(clerkAdapter).addAdapter(planetscaleAdapter).addAdapter(launchdarklyAdapter).addAdapter(httpAdapter).addAdapter(supabaseAdapter).addAdapter(netlifyAdapter).addAdapter(cloudflareAdapter).addAdapter(manualAdapter).addAdapter(algoliaAdapter).addAdapter(xataAdapter).addAdapter(digitaloceanAdapter).addAdapter(cloudRunAdapter).addSecretSource(envSecretSource).addSecretSource(dopplerSecretSource()).addSecretSource(opSecretSource()).addSecretSource(awsSecretsManagerSource()).addSecretSource(gcpSecretManagerSource()).addSecretSource(vaultSecretSource).addSecretSource(infisicalSecretSource()).addSecretSource(azureKeyVaultSource()).addSecretSource(opConnectSecretSource).addSecretSource(bitwardenSecretsManagerSource());
}
