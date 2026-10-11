/**
 * Every provider a repository's files can show it uses, with what to detect it by: first-class adapters from their
 * `about` (title, category, detect), recipe providers from their file's `detect` block. `sponson init` detects from
 * this list and the provider catalog (docs/providers.md) is generated from it, so declaring `detect` on an adapter
 * or in a recipe file is all it takes for both; neither keeps a list of providers of its own.
 */
import type { AdapterAbout, ProviderDetect, Registry } from "@sponson/core";
import { loadRecipes, recipeCredentialEnv, type Recipe } from "./recipes.js";

/** A provider `sponson init` can detect: who manages it, what to detect it by, and the credential it reads. */
export interface DetectableProvider {
  /** The adapter's name, or the recipe's provider: what `init` reports as the finding's id. */
  id: string;
  /** As people write it (Vercel, Stripe). */
  title: string;
  /** A docs/coverage.yaml category id. */
  category: string;
  /** Managed by a first-class adapter, or by recipes of the generic `http` adapter. */
  via: "adapter" | "recipe";
  detect: ProviderDetect;
  /** The variables its credential is read from when Sponson runs (never written into a plan). */
  credentials: string[];
  /** The command whose output is its credential, when it takes a CLI's token instead (`gcloud auth print-access-token`). */
  credentialCommand?: readonly string[];
  /** For a recipe provider, its recipe. */
  recipe?: Recipe;
}

/** A first-class adapter as a detectable provider; one that takes a CLI's token reads no credential variable. */
function adapterProvider(name: string, about: AdapterAbout, detect: ProviderDetect): DetectableProvider {
  const command = about.credentialCommand;
  return {
    id: name,
    title: about.title ?? name,
    category: about.category ?? "other",
    via: "adapter",
    detect,
    credentials: [...(about.extraCredentialEnv ?? []), ...(command ? [] : [about.credentialEnv])],
    ...(command ? { credentialCommand: command } : {}),
  };
}

/** The detectable providers: the registry's adapters in registration order, then the recipes by provider. */
export function detectableProviders(registry: Registry, recipes: Recipe[] = loadRecipes()): DetectableProvider[] {
  const out: DetectableProvider[] = [];
  for (const name of registry.adapterNames()) {
    const about = registry.adapter(name).about;
    if (about?.detect) out.push(adapterProvider(name, about, about.detect));
  }
  const taken = new Set(out.map((p) => p.id));
  for (const recipe of recipes) {
    const d = recipe.detect;
    // A provider a first-class adapter already detects keeps the adapter's lines (its recipe adds ops beside them).
    if (!d || taken.has(recipe.provider)) continue;
    out.push({
      id: recipe.provider,
      title: recipe.title,
      category: recipe.category,
      via: "recipe",
      detect: { ...(d.deps ? { deps: d.deps } : {}), ...(d.env ? { env: d.env } : {}), ...(d.files ? { files: d.files } : {}), ...(d.db_hosts ? { dbHosts: d.db_hosts } : {}) },
      credentials: recipeCredentialEnv(recipe),
      recipe,
    });
  }
  return out;
}
