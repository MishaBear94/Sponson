# Roadmap

What Sponson needs next, cut into pieces one contributor can pick up. Each item says where to start and how
to know it is done. Items marked **good first issue** need no prior knowledge of the engine; items marked
**ADR** change a format or contract and start with a design record in `docs/adr/` (see MAINTAINERS.md).

Want one? Comment on its linked issue so nobody duplicates work; for an item without one, open it from the item. Something missing?
Open a feature or adapter request.

Status as of 0.3.0: format, engine, the built-in adapters ([listed here](docs/plan-format.md#built-in-ops)),
built-in secret sources (listed in [docs/plan-format.md](docs/plan-format.md#secret-schemes)), local and git-branch receipt stores, CLI, MCP server, GitHub Action.

## 1. Prove the sim against the real APIs

The fake cloud encodes numbered assumptions about each provider at the top of its routes file. Every adapter call
and every assumption has been checked against the providers' published API specifications
([docs/api-verification.md](docs/api-verification.md)); each assumption is marked verified or unverified there and
in its routes file. What remains needs a live account: V1, N1, N2, C2 and PS1, PS4, PS5, PS7, PS8 are pinned by
`scenarios/contract.test.ts`, and the live run (`pnpm test:live`) has never been done against real accounts. Every item here is: write an
`assumption <id>:` test in the contract suite, run it against a throwaway account, and if it fails fix the sim
first, then the adapter.

| Item | Where | Label |
|------|-------|-------|
| Run `pnpm test:live` against free Vercel, Neon and Clerk dev accounts and report the results in an issue (pass/fail per assumption, API versions seen) ([#10](https://github.com/MishaBear94/Sponson/issues/10)) | `scenarios/contract.test.ts` header | **good first issue** |
| Clerk C1 (status and wording of a duplicate redirect URL; the adapter re-reads after any 400/422) ([#11](https://github.com/MishaBear94/Sponson/issues/11)) | `packages/sim/src/routes/clerk.ts` | **good first issue** |
| Neon N1 (does a branch being deleted still list?), N2 (which requests answer 423 during a create) and N5 (status of a duplicate branch name) ([#12](https://github.com/MishaBear94/Sponson/issues/12)) | `packages/sim/src/routes/neon.ts` | help wanted |
| Vercel V2 (deployment list order), V3 (does the deprecated `?decrypt=true` still decrypt; `sensitive`-type vars are never returned — decide how they should diff), V4 (`created` for updated entries, `ENV_CONFLICT`), V5 (branch auto-cancel; a `gitSource` deployment built from the project's `link`), V6 (`until` on the env list) ([#13](https://github.com/MishaBear94/Sponson/issues/13)) | `packages/sim/src/routes/vercel.ts` | help wanted |
| PlanetScale PS4 (how long a new branch takes to be ready), PS5 (status of a duplicate branch name), PS7 (deletion timing), PS9 (duplicate password names), PS12 (a password on a branch still provisioning): run the PlanetScale block of `pnpm test:live` against a throwaway database | `packages/sim/src/routes/planetscale.ts` | help wanted |
| A scheduled (weekly) CI job that runs the live contract suite with repository secrets, and opens an issue when an assumption breaks ([#14](https://github.com/MishaBear94/Sponson/issues/14)) | `.github/workflows/` | help wanted |

## 2. More adapters

Every adapter is one file, one sim routes file and one scenario; `pnpm new:adapter <name>` generates all three
and registers them. The checklist is in CONTRIBUTING.md.

[docs/coverage.md](docs/coverage.md) measures which providers' per-environment state is covered today and ranks what to build next.

Many rows need no adapter at all: the generic `http` adapter ([ADR 0017](docs/adr/0017-generic-http-adapter.md),
[plan format](docs/plan-format.md#the-generic-http-adapter)) manages plain CRUD objects and list entries of any JSON
REST API from the plan. The items below are those whose lifecycle needs more (asynchronous provisioning, a deploy
barrier, instruction-based updates, an output that exists only once), or that are common enough to deserve a
tested, documented first-class op. Next for the `http` adapter itself: preconditions (ETag) for list writes,
polling until ready, an OAuth2 client-credentials token, and pagination by page number or `Link` header.

| Item | Notes | Label |
|------|-------|-------|
| Feature flags: LaunchDarkly rules — serve a variation to contexts whose `url` matches (an `addRule` clause), beside the individual targets `launchdarkly.flag_target` manages ([#15](https://github.com/MishaBear94/Sponson/issues/15)) | Rules are ordered and have no client-chosen identity; needs a rule `ref` or description to find ours | adapter |
| Feature flags: a second provider (Statsig, Unleash, PostHog or GrowthBook) | Reuse `launchdarkly.flag_target`'s shape: key `target:<flag>:<context kind>:<key>` under a provider block naming the project and environment; the hash covers the variation | adapter |
| Identity callbacks beyond Clerk and Supabase Auth: Auth0 (allowed callback URLs on an application) ([#16](https://github.com/MishaBear94/Sponson/issues/16)) | Small, close to `clerk.ts` | adapter, **good first issue** |
| PlanetScale: deploy requests on merge, and PlanetScale Postgres (roles instead of passwords) | `packages/adapters/src/planetscale.ts`; a password-like credential is a [once-only output](docs/adr/0018-once-only-outputs.md) | adapter |
| Supabase follow-ups: a branch's API keys (`GET /v1/projects/{ref}/api-keys`) and pooler connection string (`/config/database/pooler`, IPv4) as outputs; `git_branch` and `with_data` on create | `supabase.branch` outputs only the direct (IPv6) connection string and the API URL today | adapter, **good first issue** |
| Deploy-target env vars: Railway, Fly.io secrets | Close to `vercel.ts`'s and `netlify.ts`'s `env` ops, without the deploy barrier at first | adapter |

## 3. More secret sources

A secret source is an object with a `scheme`, `resolve(ref, env)`, and the `form` and `resolvedBy` the generated docs read (`packages/adapters/src/secrets.ts`).
The CLI-backed sources (e.g. `aws-sm://`) show how to call a CLI through the injectable `Exec` so tests need no binary.

| Item | Label |
|------|-------|
| `vault://` — HashiCorp Vault KV v2 over HTTP (`VAULT_ADDR`, `VAULT_TOKEN`) ([#17](https://github.com/MishaBear94/Sponson/issues/17)) | **good first issue** |
| `infisical://` — Infisical via its CLI ([#18](https://github.com/MishaBear94/Sponson/issues/18)) | **good first issue** |
| A scenario per new source under `scenarios/e-secrets/` proving the value never reaches any output (invariant 1) | part of each item above |

## 4. Lifecycle and operations

| Item | Notes | Label |
|------|-------|-------|
| **Garbage-collect abandoned scopes** — scopes whose pull request closed (or branch was deleted) without the Action's destroy running | Find them from receipts plus the GitHub API; destroy from the ledger. Must not add a fourth command lightly: compare `apply --destroy --scope <s>` and an Action mode | **ADR** |
| **Remove receipts branches of destroyed scopes** — since [ADR 0016](docs/adr/0016-one-receipts-ref-per-scope.md) each scope has its own `sponson-receipts/<env>/<scope>` branch, and nothing deletes it after destroy | Keep the history long enough that a late deployment event for a destroyed PR stays stale; likely part of the garbage-collection work above | **ADR** |
| **Hosted approval inbox as a `ReceiptStore`** — production approvals requested and granted outside CI, with the approver recorded in the receipt | Implements `ReceiptStore` (`packages/core/src/types.ts`); the store contract tests in `packages/core/src/receipts/stores.test.ts` must pass against it | **ADR** |
| An S3 / R2 receipt store for teams that cannot push to the repository | Same store contract; conditional writes for fencing | **ADR**, help wanted |
| `sponson plan --json` diff for Vercel `sensitive`-type variables (see V3) | Today they would always diff as `update` against the real API | help wanted |

## 5. Contributor experience

| Item | Label |
|------|-------|
| Raise the coverage thresholds (`vitest.config.ts`, enforced by `pnpm test:coverage` in CI) as coverage rises: pick an uncovered branch from `pnpm test:coverage` and test it | **good first issue** |
| Windows in the CI matrix (paths in the local receipt store, `git` and `node` spawning) ([#19](https://github.com/MishaBear94/Sponson/issues/19)) | help wanted |
| Turn the property suite's counterexamples into scenarios automatically (print a ready-to-save YAML) | help wanted |
| A `sponson` devcontainer / Codespaces config with the sim started ([#20](https://github.com/MishaBear94/Sponson/issues/20)) | **good first issue** |

## Not planned

- A general-purpose infrastructure tool. Sponson manages what ships *beside* a release (per-preview and
  per-environment state), not long-lived infrastructure — that is Terraform's and Pulumi's job.
- Storing secret values anywhere. Secrets stay references; see SECURITY.md.
