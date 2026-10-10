# Roadmap

What Sponson needs next, cut into pieces one contributor can pick up. Each item says where to start and how
to know it is done. Items marked **good first issue** need no prior knowledge of the engine; items marked
**ADR** change a format or contract and start with a design record in `docs/adr/` (see MAINTAINERS.md).

Want one? Comment on its issue (or open one from the item) so nobody duplicates work. Something missing?
Open a feature or adapter request.

Status as of 0.2.0: format, engine, three adapters (Neon branches, Vercel env + deploy, Clerk redirect URLs),
three secret sources, local and git-branch receipt stores, CLI, MCP server, GitHub Action.

## 1. Prove the sim against the real APIs

The fake cloud encodes numbered assumptions about each provider at the top of its routes file. Only V1, N1 and
N2 are pinned by `scenarios/contract.test.ts`, and the live run (`pnpm test:live`) has never been done against
real accounts. Every item here is: write an `assumption <id>:` test in the contract suite, run it against a
throwaway account, and if it fails fix the sim first, then the adapter.

| Item | Where | Label |
|------|-------|-------|
| Run `pnpm test:live` against free Vercel, Neon and Clerk dev accounts and report the results in an issue (pass/fail per assumption, API versions seen) | `scenarios/contract.test.ts` header | **good first issue** |
| Clerk C1 (duplicate redirect URL answers 422) and C2 (bare array vs `{ data, total_count }` paging) | `packages/sim/src/routes/clerk.ts` | **good first issue** |
| Neon N3 (`neondb` / `neondb_owner` defaults, `default: true` root branch) and N4 (cursor pagination) | `packages/sim/src/routes/neon.ts` | help wanted |
| Vercel V2 (deployment list order), V3 (`?decrypt=true`; `sensitive`-type vars never returned — decide how they should diff), V4 (`upsert=true` answer shape, `ENV_CONFLICT`), V5 (`project` vs `name`, deployment states), V6 (`until` pagination) | `packages/sim/src/routes/vercel.ts` | help wanted |
| A scheduled (weekly) CI job that runs the live contract suite with repository secrets, and opens an issue when an assumption breaks | `.github/workflows/` | help wanted |

## 2. More adapters

Every adapter is one file, one sim routes file and one scenario; `pnpm new:adapter <name>` generates all three
and registers them. The checklist is in CONTRIBUTING.md.

| Item | Notes | Label |
|------|-------|-------|
| **Feature flags: LaunchDarkly** — `flag_target`: turn a flag on for a preview (target the preview URL or a context key), off again on destroy | The README's fourth console. Decide the resource key (project + environment + flag + target) | adapter, help wanted |
| Feature flags: a second provider (Statsig, Unleash, PostHog or GrowthBook) | Reuse whatever shape LaunchDarkly settles on | adapter |
| Identity callbacks beyond Clerk: Auth0 (allowed callback URLs on an application), Supabase Auth redirect URLs | Small, close to `clerk.ts` | adapter, **good first issue** |
| Database branches: Supabase branching, PlanetScale branches | Close to `neon.ts`; output a connection string marked `sensitive` | adapter |
| Deploy-target env vars: Netlify, Railway, Fly.io secrets | Close to `vercel.ts`'s `env` op, without the deploy barrier at first | adapter |

## 3. More secret sources

A secret source is an object with a `scheme` and `resolve(ref, env)` (`packages/adapters/src/secrets.ts`); the
`doppler://` and `op://` sources show how to call a CLI through the injectable `Exec` so tests need no binary.

| Item | Label |
|------|-------|
| `vault://` — HashiCorp Vault KV v2 over HTTP (`VAULT_ADDR`, `VAULT_TOKEN`) | **good first issue** |
| `aws-sm://` — AWS Secrets Manager via the `aws` CLI (keeps the SDK out of the dependency tree) | **good first issue** |
| `gcp-sm://` — Google Secret Manager via `gcloud` | **good first issue** |
| `infisical://` — Infisical via its CLI | **good first issue** |
| A scenario per new source under `scenarios/e-secrets/` proving the value never reaches any output (invariant 1) | part of each item above |

## 4. Lifecycle and operations

| Item | Notes | Label |
|------|-------|-------|
| **Garbage-collect abandoned scopes** — scopes whose pull request closed (or branch was deleted) without the Action's destroy running | Find them from receipts plus the GitHub API; destroy from the ledger. Must not add a fourth command lightly: compare `apply --destroy --scope <s>` and an Action mode | **ADR** |
| **Hosted approval inbox as a `ReceiptStore`** — production approvals requested and granted outside CI, with the approver recorded in the receipt | Implements `ReceiptStore` (`packages/core/src/types.ts`); the store contract tests in `packages/core/src/receipts/stores.test.ts` must pass against it | **ADR** |
| An S3 / R2 receipt store for teams that cannot push to the repository | Same store contract; conditional writes for fencing | **ADR**, help wanted |
| `sponson plan --json` diff for Vercel `sensitive`-type variables (see V3) | Today they would always diff as `update` against the real API | help wanted |

## 5. Contributor experience

| Item | Label |
|------|-------|
| Raise the CI coverage thresholds (`.github/workflows/ci.yml`, job `coverage`) as coverage rises: pick an uncovered branch from `pnpm test:coverage` and test it | **good first issue** |
| Windows in the CI matrix (paths in the local receipt store, `git` and `node` spawning) | help wanted |
| Turn the property suite's counterexamples into scenarios automatically (print a ready-to-save YAML) | help wanted |
| A `sponson` devcontainer / Codespaces config with the sim started | **good first issue** |

## Not planned

- A general-purpose infrastructure tool. Sponson manages what ships *beside* a release (per-preview and
  per-environment state), not long-lived infrastructure — that is Terraform's and Pulumi's job.
- Storing secret values anywhere. Secrets stay references; see SECURITY.md.
