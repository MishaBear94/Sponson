# Sponson

[![ci](https://github.com/MishaBear94/Sponson/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MishaBear94/Sponson/actions/workflows/ci.yml)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node: >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)
[![docs](https://img.shields.io/badge/docs-sponson.mintlify.site-0D9373.svg)](https://sponson.mintlify.site)

Sponson is the plan for everything that ships beside the code.

A sponson is the float welded to the side of a hull so the boat does not roll. The code is the hull. The preview database, environment variables, callbacks, and feature flags are the float. Sponson writes that float into one file an agent can read and a human can diff.

```yaml
# release.plan.yaml
version: 1
providers:
  vercel: { project: prj_xxx }
  neon:   { project: proj_xxx }

changes:
  - id: db
    adapter: neon
    op: branch
    parent: main
    environments: [preview]

  - id: env
    adapter: vercel
    op: env
    target: preview
    values:
      DATABASE_URL: { from: db.connection_string }      # a reference, never a value
      STRIPE_KEY:   { secret: "env://STRIPE_KEY" }      # a reference, never a value
    environments: [preview]

  - id: callback
    adapter: clerk
    op: redirect_allow
    url: { from: env.preview_url }                      # exists only after the deploy
    environments: [preview]
```

```
$ sponson plan
sponson plan · preview · pr-42 · plan 7aba4410

+ db        neon.branch           create     Neon branch sponson/preview/pr-42
+ env       vercel.env            create
    + DATABASE_URL (preview)  (pending ← db.connection_string)
    + STRIPE_KEY (preview)    (secret ← env://STRIPE_KEY)
? callback  clerk.redirect_allow  pending    waiting on `env` (deploy)

2 to create, 1 pending
```

## Why this exists

Agents can already change a repository. They cannot safely change the rest of a release.

The code lands in Git. The things that have to move with it do not. A preview database lives in the database console. Environment variables live in the deploy console. OAuth callbacks live in an identity console. Feature flags live in a fourth. A person copies state between them by hand. An agent does the same thing with no shared record of what it intended, what it tried, and what a human approved.

Existing tools each own one slice. Terraform and Pulumi plan resources, not the preview data and callback that belong to this release. Vercel and Railway deploy the app, not the secrets and flags that have to match it. Doppler and Infisical hold secrets, not the release those secrets belong to. A sequence of agent tool calls is not itself a record. A release needs its own file.

Sponson is that file. The format is the product. A hosted approval inbox can come later. A new cloud does not.

## What it does

One release, one plan. Three commands.

| Command | What it does | Writes anything? |
|---|---|---|
| `sponson init` | Detects your stack from the repository's files (Vercel, Neon, PlanetScale, Supabase, Clerk, LaunchDarkly, the framework and ORM) and writes a plan for it, with the project ids it can find. Run again to adopt resources the plan does not know about. | the plan file only |
| `sponson plan` | Reads live state, prints the diff and any drift. | no |
| `sponson apply` | Runs the plan in dependency order. Rolls back what this run created if a line fails. Writes a receipt. | yes |

- **Secrets are references.** `{ secret: "env://NAME" }`, or any other [secret scheme](docs/plan-format.md#secret-schemes). Every command resolves them, `plan` and `apply --destroy` included (so a scheme backed by a secret manager's CLI runs that CLI on `plan` too), and registers each value for masking before anything is printed; only `apply` hands values to an adapter. They are redacted from every byte of output. A literal that looks like a secret is rejected at parse time.
- **References cross lines.** `{ from: db.connection_string }` reads another line's output. Outputs that only exist after an external event (a deploy) stop the run with status `partial`; the next `apply` continues from there. Same command, no flags.
- **Drift is reported, never silently overwritten.** Something changed in a console since the last apply? `plan` says so; `apply` refuses that line until you pass `--reconcile`. Something exists that the plan does not mention? It is listed and left alone.
- **Receipts are the agent's memory.** Each run writes what actually happened to an orphan branch of your repo, one per environment and scope (`sponson-receipts/<env>/<scope>`, so unrelated pull requests never wait on each other): a ledger of every resource the scope owns (kept across failed, refused and crashed runs), what each line did, and which commits were applied. Creates are recorded before they are sent, so even a write whose response was lost is never forgotten. The agent reads the receipt, not its own last tool call.
- **Adopting is not copying.** `sponson init` adopts existing resources as `{ keep: true }`: Sponson takes over that they exist, keeps their live values, and never destroys them.
- **Production needs a human.** `--env production` without `--approved-by` is refused before any adapter is touched. The default environment is always `preview`; nothing is inferred from a branch name.
- **Destroy is symmetric.** `sponson apply --destroy` removes what Sponson created, in reverse order, and never touches resources it merely adopted.

## Quick start

### Try it in 60 seconds

No Vercel, Neon or Clerk account needed: `@sponson/sim` is a local fake cloud with their APIs. You need Node.js 22
or later, git and curl. In one terminal, start it with a ready demo repository:

```bash
npx --yes @sponson/sim --demo sponson-demo
```

Leave it running. In a second terminal, run these one at a time (the first terminal prints the same list):

```bash
cd sponson-demo && source sim.env
sponson plan
sponson apply
sponson apply
curl -s -o /dev/null "$SPONSON_SIM_URL/_chaos" -d '{"drift":{"vercel.env.preview.DATABASE_URL":"postgres://typed-in-the-console"}}'
sponson plan
sponson apply --destroy
```

1. `sim.env` points `sponson` at the fake cloud with placeholder tokens, and runs it through npx if it is not installed.
2. `plan` reads live state and prints the diff of `release.plan.yaml`: a Neon branch to create, and a `DATABASE_URL`
   and a Clerk redirect that wait on it. Nothing is written.
3. `apply` creates the branch, writes its connection string into Vercel's `DATABASE_URL` by reference (the password
   is never printed), finds the preview deployment of this commit, and allows its URL as a Clerk redirect.
4. The same `apply` again: every line `unchanged`, zero writes.
5. The `curl` plays someone editing `DATABASE_URL` in the Vercel console.
6. `plan` reports the drift and blocks that line: `apply` will not overwrite it without `--reconcile`.
7. `apply --destroy` removes everything the demo created, in reverse order. Ctrl-C in the first terminal stops the
   fake cloud.

`scenarios/docs/try-it.test.ts` runs these exact commands from this file on every CI run.

### Install

Install the CLI from npm (Node.js 22 or later):

```bash
npm install -g sponson    # or run it without installing: npx sponson <command>
```

To run an unreleased commit instead, run it from source (the workspace packages resolve to their TypeScript
sources, so it runs through the `tsx` loader rather than a build):

```bash
git clone https://github.com/MishaBear94/Sponson ~/sponson && (cd ~/sponson && pnpm install)
alias sponson="node --import ~/sponson/node_modules/tsx/dist/loader.mjs ~/sponson/packages/cli/src/bin.ts"
```

Then, in your app's repository:

```bash
sponson init          # detects the stack, writes release.plan.yaml, adds .sponson/ to .gitignore
sponson plan          # read-only diff
sponson apply         # creates the branch, injects the variable, waits for the deploy
```

`sponson init` reads the repository's files only (no network, no credentials): `.vercel/project.json` and
`vercel.json`, `package.json` dependencies, Prisma and Drizzle configs, `.neon`, and the variable *names* in
`.env.example`, `.env.local` and the other `.env*` files. It never reads a value out of them, except to recognise a
database host such as `*.neon.tech`. It writes a line only for what it found (one database: a Neon branch, a PlanetScale branch and
password, or a Supabase preview branch, in that order of preference when several are detected; the Vercel preview
variable that references it under the name your code reads; a Clerk redirect or a Supabase Auth redirect for the
preview URL), fills in the project ids it can find, and marks each one it cannot with a `TODO` comment saying where to
look (`vercel link`, `neonctl projects list`, `supabase link`). LaunchDarkly gets a commented example line to fill in with a
flag key and uncomment. Services Sponson does not manage yet (Auth0, Netlify, Cloudflare, PostHog, Stripe,
Sentry, …) are listed as "not supported yet" with a link to the
[roadmap](ROADMAP.md), never silently dropped. With nothing detected it writes the Vercel + Neon template.

```
$ sponson init
Wrote release.plan.yaml
Detected: Vercel (.vercel/project.json), Neon (package.json: @neondatabase/serverless), Clerk (package.json: @clerk/nextjs), Next.js (package.json: next), Prisma (package.json: @prisma/client)
To fill in:
  providers.neon.project (now "proj_xxx"): run `neonctl projects list`, or https://console.neon.tech → your project → Settings → General → Project ID
Next: set VERCEL_TOKEN, NEON_API_KEY, CLERK_SECRET_KEY in your environment, then run `sponson plan`
```

`sponson init --json` reports the same under `detected`: `found` and `unsupported` (each with its `evidence`),
`todo` (each placeholder's `path` and `hint`) and `assumed` (true when it wrote the template).

Which providers are covered today, and what is planned, is measured in [docs/coverage.md](docs/coverage.md).

Third-party adapters and secret sources load as plugins: `SPONSON_PLUGINS=sponson-adapter-x,./local-adapter.mjs`, each module exporting `register(registry)`.

Credentials come from the providers' own conventions (`VERCEL_TOKEN` for Vercel; every adapter's variable is listed under [built-in ops](docs/plan-format.md#built-in-ops)). Sponson has no credential store of its own.

In GitHub Actions, one workflow with three triggers calls the same action:

```yaml
on:
  pull_request: { types: [opened, synchronize, closed] }
  deployment_status:
permissions: { contents: write, pull-requests: write, deployments: read }
jobs:
  sponson:
    runs-on: ubuntu-latest
    # only finished preview deployments; production has its own approved job (see action/README.md)
    if: >-
      github.event_name == 'pull_request' || (github.event.deployment_status.state == 'success' &&
      github.event.deployment.environment != 'Production' && github.event.deployment.environment != 'production')
    env:
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      CLERK_SECRET_KEY: ${{ secrets.CLERK_SECRET_KEY }}
    steps:
      - uses: actions/checkout@v4
        # full history lets Sponson recognise a late build of an older commit
        with: { ref: "${{ github.event.deployment.sha || github.sha }}", fetch-depth: 0 }
      - uses: MishaBear94/Sponson/action@<commit-sha>
        with:
          command: ${{ github.event.action == 'closed' && 'destroy' || 'apply' }}
```

The action comments the plan and the receipt on the pull request. See [action/README.md](action/README.md).

### For agents

`sponson mcp` exposes `sponson_plan`, `sponson_apply` and `sponson_receipt` over stdio. [SKILL.md](SKILL.md) tells an agent when to write a plan line, when to stop and show a human the diff, what `partial` and `blocked` mean, and why it must never write a secret value or approve production itself.

Every command (`init` included) takes `--json`, and every outcome, failures included, is one JSON document: `{ ok, command, ... }` or `{ ok: false, command, error: { code, message } }`. That holds for a mistyped flag (`USAGE`), a plan error, a provider failure (`PROVIDER_*`) and an unexpected crash (`INTERNAL`) alike, and the MCP tools return the same envelope as the first line of every result. `ok` is true exactly when the exit code is 0. Pending, secret and sensitive values are `null` next to an explicit `state`, never placeholder text; display strings exist only in the human-readable output. Secrets are masked in every form a provider may echo them (raw, JSON-escaped, URL-encoded, base64, the password inside a connection string) before anything is printed, logged or written to a receipt, and JSON is masked field by field so redaction can never change its structure.

## Integrations

Copy-paste setups beside the [GitHub Action](action/README.md), each with its prerequisites, the variables to set and
the token that lets it push receipts ([overview](integrations/README.md)):

- [GitLab CI/CD](integrations/gitlab/README.md): merge request pipelines; the review environment's `on_stop` job
  destroys the preview when the merge request is merged or closed.
- [CircleCI](integrations/circleci/README.md): pull request branches, destroy through the API, production behind a
  hold job.
- [Bitbucket Pipelines](integrations/bitbucket/README.md): pull request pipelines, a custom destroy pipeline,
  production as a manual deployment step.
- [Agent tools](integrations/agents/README.md): the MCP server configuration for Claude Code, Cursor, Codex CLI,
  Windsurf and VS Code, and where SKILL.md goes in each.

## How it works

```text
release.plan.yaml ──▶ sponson plan ──▶ diff + drift        (reads adapters, writes nothing)
                 └──▶ sponson apply ─▶ receipt            (dependency order, rollback on failure)
                                        │
                        ┌───────────────┼────────────────┐
                        ▼               ▼                ▼
                   neon.branch     vercel.env      clerk.redirect_allow
                                        │
                                   ── deploy ──   external event: stop, record `waiting`,
                                        │         resume on the next apply
                                        ▼
                                   preview_url ──▶ callback
```

A plan is a flat list. Each line is one adapter op, filtered by `environments:`. Order is derived from references. Every value has a state (`literal`, `resolved`, `pending`, `secret` or `kept`), and the JSON output carries it explicitly so an agent never has to parse prose.

Receipts live on an orphan git branch so CI runs, which start from nothing, can still see what the last run did. The store is an interface; `local` is the alternative, and a hosted one is where a control plane would plug in.

## Verification without a cloud account

This repository was built and accepted entirely against a local fake cloud, because no real provider account was available during development.

- `packages/sim` serves the API subsets the adapters use, with a chaos endpoint: latency, failing or hanging the next N requests matching a rule, `429` with `Retry-After`, lost responses after a successful write, pagination, Neon's asynchronous operations, deployment lifecycles, and console-style drift (edit, delete, delete-and-recreate).
- `scenarios/` holds the acceptance scenarios: one YAML file per failure mode (anywhere under `scenarios/`, grouped by failure family such as mid-run failure, concurrency, drift, secrets, the deploy barrier and mistakes agents or humans make), each run end to end through the CLI by `scenarios/runner.test.ts`.
- `scenarios/journeys/` holds long system tests, one directory per dimension: among them a week of a team's CI lifecycle, many actors at once on real git receipts (including SIGKILL mid-apply), providers misbehaving like real clouds, an agent driving Sponson only through MCP and JSON, humans editing consoles and refactoring plans, and every channel a secret could leak through (including the receipts branches' history and PR comments).
- `property/` generates random plans, failures (including lost responses) and drift, and checks the invariants numbered at the top of `property/engine.property.test.ts`, among them that `plan` writes nothing and that nothing Sponson created survives a successful destroy, over hundreds of generated cases per run (`SPONSON_PROPERTY_RUNS` sets how many).

What the fake cannot prove is that the real APIs behave as assumed. The assumptions are numbered at the top of each provider's routes file in `packages/sim/src/routes/`, each marked verified or unverified.

- **Checked against the published specifications** (Vercel's, Neon's and Supabase's Management API OpenAPI documents, Clerk's Backend API OpenAPI and, for one list envelope, Clerk's own SDKs; LaunchDarkly's REST API reference): every HTTP call the adapters make (path, version, query parameters, request body, response fields read, statuses handled) and every assumption the specifications can settle. The check found and fixed real mismatches, among them Vercel's deployment `gitSource` missing the required repository id and Neon connection strings hard-coded to a new project's database and role names. [docs/api-verification.md](docs/api-verification.md) has the per-call tables, sources and dates.
- **Still needs a live run**: what no specification states, such as how fast an env write reaches a deployment, which Neon requests answer `423` while a branch is created, whether a Neon branch being deleted still lists, which status Clerk gives a duplicate redirect URL, whether LaunchDarkly accepts re-adding a target its variation already serves, and how long a Supabase preview branch takes to come up. `scenarios/contract.test.ts` pins the critical ones: it runs against the sim by default and against the real APIs with `pnpm test:live` (see the file header for the required variables). It has not yet been run against real accounts.

## Status

Format, engine, the [built-in adapters](docs/plan-format.md#built-in-ops) and [secret schemes](docs/plan-format.md#secret-schemes), local and git-branch receipt stores, CLI, MCP server, GitHub Action, [templates](integrations/README.md) for GitLab CI/CD, CircleCI and Bitbucket Pipelines (not yet run on those hosts). Not yet: feature-flag rules (LaunchDarkly individual targets are supported) and flag providers other than LaunchDarkly, social-login callbacks beyond Clerk and Supabase Auth, a hosted approval inbox, garbage collection of scopes whose PR closed without the action running.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): how a `plan` and an `apply` run through the code, the ledger, scopes, redaction.
- [docs/plan-format.md](docs/plan-format.md): every key of `release.plan.yaml`, value forms, `${ctx.*}`, the built-in ops.
- [docs/errors.md](docs/errors.md): every error code, its exit code and remedy (generated from the code).
- [docs/adr/](docs/adr/README.md): the design decisions and why they were made.
- [examples/](examples/README.md): complete, tested plans to start from.

Editors with the YAML language server validate and complete the plan file from its JSON Schema. Add this as the first
line of `release.plan.yaml`:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/MishaBear94/Sponson/main/schema/release.plan.schema.json
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full adapter checklist: the adapter file, its registration (or a plugin loaded with `SPONSON_PLUGINS`), one sim routes file, and one scenario.

## License

Apache-2.0.
