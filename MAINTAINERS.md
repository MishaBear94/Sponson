# Maintainers and governance

Sponson is small and intends to stay easy to run. This document says who decides, how, and how to join them.

## Maintainers

Keep this list in sync with `.github/CODEOWNERS`.

| Name | GitHub | Areas |
|------|--------|-------|
| Markov Wong | [@MishaBear94](https://github.com/MishaBear94) | everything (lead maintainer) |

Emeritus maintainers are listed here when they step back; they keep their credit, not their merge rights.

## Roles

- **Contributor** — anyone who opens an issue, a discussion or a pull request.
- **Reviewer** — a regular contributor trusted to review one area (an adapter, the sim, the Action). Reviewers'
  approvals count toward the review rule below for their area. Listed in `.github/CODEOWNERS`.
- **Maintainer** — merges, releases, triages, and owns the decisions below. Listed above.

## How decisions are made

1. **Most changes**: a pull request with passing CI and the approvals required below. Disagreement is resolved
   in the PR; if it does not converge, a maintainer decides and writes down why.
2. **Design changes** — anything that changes the plan format (`release.plan.yaml`), the receipt format, the
   adapter contract (`packages/core/src/types.ts`), the JSON output envelope, error codes or exit codes, one of
   the eight invariants, or adds a CLI command — need an **Architecture Decision Record** in `docs/adr/`,
   merged before or with the implementation. An ADR states the context, the decision, the alternatives
   rejected and the consequences. Use the next free number; ADRs are never edited after acceptance except to
   mark them superseded by a later one.
3. **Lazy consensus**: an ADR PR that has been open for 7 days with at least one maintainer approval and no
   unresolved objection from a maintainer is accepted.
4. If maintainers disagree, the lead maintainer decides. When there are three or more maintainers, a simple
   majority of maintainers decides instead.

## Review rules

- Every PR needs **one approving review from a maintainer or a reviewer for the touched area**, and green CI.
- PRs that touch **security-sensitive code** — redaction (`packages/core/src/redact.ts`, `packages/cli/src/output.ts`),
  approval and scope boundaries (`packages/core/src/engine/`), receipt stores (`packages/core/src/receipts/`),
  secret sources, plugin loading, or `action/` — need a **maintainer** approval, and should add or extend a test
  for the invariant they touch.
- Authors do not approve their own PRs. A maintainer may merge their own PR after another person's approval;
  a sole maintainer may merge trivial changes (typos, dependency bumps with green CI) without one.
- Squash-merge, with a commit message that says why.
- User-visible changes carry a changeset (see CONTRIBUTING.md); the release PR turns them into CHANGELOG.md.

## Becoming a reviewer or maintainer

There is no quota and no seniority requirement. What counts is sustained, careful work:

- **Reviewer for an area**: several merged PRs in that area (for example an adapter you wrote, with its sim
  routes and scenario) and helpful reviews of others' PRs there. Any maintainer may propose you; you are added
  to `CODEOWNERS` once you agree.
- **Maintainer**: an active reviewer for roughly three months who has shown judgement on the invariants, the
  security scope in SECURITY.md, and the "fix the structural reason" rule in CONTRIBUTING.md. Proposed by a
  maintainer in a PR editing this file; accepted by lazy consensus of the existing maintainers (7 days, no
  objection).
- Maintainers who are inactive for six months are asked whether they want to move to emeritus. Merge and
  publish rights are removed when they do, or after a further month without an answer.

## Releases

Maintainers release with changesets (`.github/workflows/release.yml`); see "Releasing" in CONTRIBUTING.md.
npm publishing rights and the `NPM_TOKEN` secret are held by at least two maintainers once there are two.

## Code of conduct

Everyone in the project follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Maintainers enforce it.
