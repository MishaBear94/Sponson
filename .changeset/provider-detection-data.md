---
"@sponson/adapters": minor
---

Provider detection is data: a recipe file's new `detect` block (package names, config files, variable names, database URL hosts, the `starter` lines and `where` to find each param) and an adapter's `about.title`, `about.category` and `about.detect` tell `sponson init` how to find the provider and what to write, so adding a recipe makes `init` detect it with no CLI change. New exports: `detectableProviders(registry)` and `recipeCredentialEnv(recipe)`. The new generated catalog, [docs/providers.md](https://github.com/MishaBear94/Sponson/blob/main/docs/providers.md), lists every supported provider by category with its ops, credential, detection signals and a line to start from.
