# Labels

The labels this repository uses, so triage is consistent. Nothing syncs this file automatically; when you
add or rename a label in GitHub, update it here (or create them all with the `gh` commands at the bottom).

## Type

| Label | Colour | Meaning |
|-------|--------|---------|
| `bug` | `d73a4a` | Sponson does something wrong. |
| `enhancement` | `a2eeef` | New behaviour or an improvement to existing behaviour. |
| `adapter` | `5319e7` | A new provider adapter, secret source or receipt store, or a change to one. |
| `documentation` | `0075ca` | Docs only. |
| `security` | `b60205` | Hardening with no live vulnerability. Vulnerabilities go through SECURITY.md, never an issue. |
| `dependencies` | `0366d6` | Dependency updates (Dependabot applies it). |

## Contributor experience

| Label | Colour | Meaning |
|-------|--------|---------|
| `good first issue` | `7057ff` | Scoped, with pointers to the files involved and how to test it. A newcomer can finish it in an afternoon. |
| `help wanted` | `008672` | Maintainers would welcome a PR; may need more context than a good first issue. |
| `needs-triage` | `ededed` | New, not yet looked at by a maintainer (issue forms apply it). |
| `needs-repro` | `fbca04` | Cannot act until there is a reproduction — ideally a YAML scenario against the sim. |
| `needs-adr` | `fbca04` | A design change that needs an ADR in `docs/adr/` before code (see MAINTAINERS.md). |
| `blocked` | `000000` | Waiting on something outside this issue (named in a comment). |
| `wontfix` | `ffffff` | Out of scope or rejected; the closing comment says why. |
| `duplicate` | `cfd3d7` | Closed in favour of the linked issue. |

## Area

One `area/*` label per issue where possible. They map to the layout in CONTRIBUTING.md.

| Label | Colour | Covers |
|-------|--------|--------|
| `area/core` | `c5def5` | Plan model, parser, engine (ledger, plan, apply, destroy, leases), error codes |
| `area/receipts` | `c5def5` | Receipt format and stores (local, git branch), migrations |
| `area/redaction` | `c5def5` | `Redactor`, output serialisation, anything about secrets in output |
| `area/adapters` | `c5def5` | `packages/adapters`: providers, secret sources, HTTP layer, authoring helpers |
| `area/sim` | `c5def5` | `packages/sim`: the fake cloud, chaos, provider routes and their assumptions |
| `area/cli` | `c5def5` | `packages/cli`: commands, rendering, JSON envelope, plugins |
| `area/mcp` | `c5def5` | The MCP server (`sponson mcp`) |
| `area/action` | `c5def5` | The GitHub Action in `action/` |
| `area/tests` | `c5def5` | Scenarios, journeys, property suite, contract suite, test harnesses |
| `area/ci` | `c5def5` | Workflows, release automation, repository tooling |
| `area/docs` | `c5def5` | README, SKILL.md, `docs/`, examples |

## Creating them

```bash
gh label create "good first issue" --color 7057ff --description "Scoped for a first contribution" --force
gh label create adapter            --color 5319e7 --description "Provider adapter, secret source or receipt store" --force
gh label create needs-triage       --color ededed --description "Not yet triaged" --force
gh label create needs-repro        --color fbca04 --description "Needs a reproduction" --force
gh label create needs-adr          --color fbca04 --description "Needs an ADR in docs/adr" --force
gh label create blocked            --color 000000 --description "Waiting on something else" --force
gh label create security           --color b60205 --description "Hardening (vulnerabilities: SECURITY.md)" --force
gh label create dependencies       --color 0366d6 --description "Dependency updates" --force
for a in core receipts redaction adapters sim cli mcp action tests ci docs; do
  gh label create "area/$a" --color c5def5 --force
done
```
