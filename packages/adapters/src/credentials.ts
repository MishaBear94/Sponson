/**
 * Checking a recipe provider's credential for `sponson init --setup`: the read-only request its recipe declares
 * (`credential.verify`), sent through the same client and authentication as the recipe's ops, so a credential that
 * passes here is one the ops will send the same way. First-class adapters check theirs in
 * `ResourceAdapter.verifyCredential`.
 */
import { SponsonError, type AdapterContext, type CredentialCheck } from "@sponson/core";
import { verifyByGet } from "./common.js";
import { httpClient } from "./http-adapter-client.js";
import { resolveRecipeApi, type Recipe } from "./recipes.js";

/**
 * Send `recipe.credential.verify` with the credential the API block `block` names (`providers.http.<api>`, or `{}` for
 * the recipe's defaults; `api` is its name, for messages). Throws what the HTTP client throws (PROVIDER_AUTH,
 * PROVIDER_NOT_FOUND, …), and PLAN_INVALID when the block lacks what the request needs (a per-account base URL).
 */
export async function verifyRecipeCredential(recipe: Recipe, api: string, block: Record<string, unknown>, actx: AdapterContext): Promise<CredentialCheck> {
  const request = recipe.credential?.verify;
  if (request === undefined) throw new SponsonError("INTERNAL", `recipe ${recipe.provider} declares no credential.verify request`, { recipe: recipe.provider });
  const where = `providers.http.${api}`;
  const resolved = resolveRecipeApi({ recipe: recipe.provider, ...block }, where);
  const client = httpClient({ ...actx, provider: resolved }, {}, { where, block: resolved });
  return verifyByGet(client, request.slice("GET ".length), "account");
}
