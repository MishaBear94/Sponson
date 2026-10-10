# Sponson

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
| `sponson init` | Detects your Vercel and Neon projects and writes a starter plan. Run again to adopt resources the plan does not know about. | the plan file only |
| `sponson plan` | Reads live state, prints the diff and any drift. | no |
| `sponson apply` | Runs the plan in dependency order. Rolls back what this run created if a line fails. Writes a receipt. | yes |

- **Secrets are references.** `{ secret: "env://NAME" }`, `doppler://`, `op://`, `aws-sm://`. Values are resolved inside `apply`, handed to the adapter, and redacted from every byte of output. A literal that looks like a secret is rejected at parse time.
- **References cross lines.** `{ from: db.connection_string }` reads another line's output. Outputs that only exist after an external event (a deploy) stop the run with status `partial`; the next `apply` continues from there. Same command, no flags.
- **Drift is reported, never silently overwritten.** Something changed in a console since the last apply? `plan` says so; `apply` refuses that line until you pass `--reconcile`. Something exists that the plan does not mention? It is listed and left alone.
- **Receipts are the agent's memory.** Each run writes what actually happened to an orphan branch `sponson/receipts` in your repo: a ledger of every resource the scope owns (kept across failed, refused and crashed runs), what each line did, and which commits were applied. Creates are recorded before they are sent, so even a write whose response was lost is never forgotten. The agent reads the receipt, not its own last tool call.
- **Adopting is not copying.** `sponson init` adopts existing resources as `{ keep: true }`: Sponson takes over that they exist, keeps their live values, and never destroys them.
- **Production needs a human.** `--env production` without `--approved-by` is refused before any adapter is touched. The default environment is always `preview`; nothing is inferred from a branch name.
- **Destroy is symmetric.** `sponson apply --destroy` removes what Sponson created, in reverse order, and never touches resources it merely adopted.

## Quick start

```bash
npx sponson init          # writes release.plan.yaml, adds .sponson/ to .gitignore
npx sponson plan          # read-only diff
npx sponson apply         # creates the branch, injects the variable, waits for the deploy
```

Third-party adapters and secret sources load as plugins: `SPONSON_PLUGINS=sponson-adapter-x,./local-adapter.mjs`, each module exporting `register(registry)`.

Credentials come from the providers' own conventions — `VERCEL_TOKEN`, `NEON_API_KEY`, `CLERK_SECRET_KEY` — Sponson has no credential store of its own.

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
      - uses: sponson/sponson/action@v1
        with:
          command: ${{ github.event.action == 'closed' && 'destroy' || 'apply' }}
```

The action comments the plan and the receipt on the pull request. See [action/README.md](action/README.md).

### For agents

`sponson mcp` exposes `sponson_plan`, `sponson_apply` and `sponson_receipt` over stdio. [SKILL.md](SKILL.md) tells an agent when to write a plan line, when to stop and show a human the diff, what `partial` and `blocked` mean, and why it must never write a secret value or approve production itself.

Every command (`init` included) takes `--json`, and every outcome, failures included, is one JSON document: `{ ok, command, ... }` or `{ ok: false, command, error: { code, message } }`. That holds for a mistyped flag (`USAGE`), a plan error, a provider failure (`PROVIDER_*`) and an unexpected crash (`INTERNAL`) alike, and the MCP tools return the same envelope as the first line of every result. `ok` is true exactly when the exit code is 0. Pending, secret and sensitive values are `null` next to an explicit `state`, never placeholder text; display strings exist only in the human-readable output. Secrets are masked in every form a provider may echo them (raw, JSON-escaped, URL-encoded, base64, the password inside a connection string) before anything is printed, logged or written to a receipt, and JSON is masked field by field so redaction can never change its structure.

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

A plan is a flat list. Each line is one adapter op, filtered by `environments:`. Order is derived from references. Values have five states — `literal`, `resolved`, `pending`, `secret`, `kept` — and the JSON output carries the state explicitly so an agent never has to parse prose.

Receipts live on an orphan git branch so CI runs, which start from nothing, can still see what the last run did. The store is an interface; `local` is the alternative, and a hosted one is where a control plane would plug in.

## Verification without a cloud account

This repository was built and accepted entirely against a local fake cloud, because no real Vercel, Neon or Clerk account was available during development.

- `packages/sim` serves the API subsets the adapters use, with a chaos endpoint: latency, failing or hanging the next N requests matching a rule, `429` with `Retry-After`, lost responses after a successful write, pagination, Neon's asynchronous operations, deployment lifecycles, and console-style drift (edit, delete, delete-and-recreate).
- `scenarios/*/` holds 54 YAML scenarios across nine categories — mid-run failure, concurrency, drift, references, secrets, the deploy barrier, destroy, mistakes agents make, mistakes humans make.
- `scenarios/journeys/` holds long system tests along six independent dimensions: a week of a team's CI lifecycle, many actors at once on real git receipts (including SIGKILL mid-apply), providers misbehaving like real clouds, an agent driving Sponson only through MCP and JSON, humans editing consoles and refactoring plans, and every channel a secret could leak through (including the receipts branch history and PR comments).
- `property/` generates random plans, failures (including lost responses) and drift, and checks eight invariants — among them that `plan` writes nothing and that nothing Sponson created survives a successful destroy — 1000 cases per run.

What the fake cannot prove is that the real APIs behave as assumed. The assumptions are numbered at the top of each provider's routes file in `packages/sim/src/routes/`, and `scenarios/contract.test.ts` pins the critical ones: it runs against the sim by default and against the real APIs with `pnpm test:live` (see the file header for the required variables). It has not yet been run against real accounts.

## Status

Format, engine, three adapters (Neon branches, Vercel env + deploy, Clerk redirect URLs), four secret sources, local and git-branch receipt stores, CLI, MCP server, GitHub Action. Not yet: feature-flag targeting, social-login callbacks beyond Clerk, a hosted approval inbox, garbage collection of scopes whose PR closed without the action running.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): how a `plan` and an `apply` run through the code, the ledger, scopes, redaction.
- [docs/plan-format.md](docs/plan-format.md): every key of `release.plan.yaml`, value forms, `${ctx.*}`, the built-in ops.
- [docs/errors.md](docs/errors.md): every error code, its exit code and remedy (generated from the code).
- [docs/adr/](docs/adr/README.md): the design decisions and why they were made.
- [examples/](examples/README.md): complete, tested plans to start from.

Editors with the YAML language server validate and complete the plan file from its JSON Schema. Add this as the first
line of `release.plan.yaml`:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/sponson/sponson/main/schema/release.plan.schema.json
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full adapter checklist: the adapter file, its registration (or a plugin loaded with `SPONSON_PLUGINS`), one sim routes file, and one scenario.

## License

Apache-2.0.
