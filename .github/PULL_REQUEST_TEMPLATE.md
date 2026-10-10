<!--
Thanks for contributing! Keep the PR to one concern. Security issues: do not open a PR — see SECURITY.md.
-->

## What and why

<!-- What changes for a user or an adapter author, and why. Link the issue: "Closes #123". -->

## How it was tested

<!-- Commands you ran, new tests/scenarios, and anything verified by hand (e.g. against `pnpm sim` or real APIs). -->

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass locally.
- [ ] New behaviour has a test: a unit test next to the code, a YAML scenario under `scenarios/`, or a journey. A bug fix starts with a test that fails without it.
- [ ] Adapters only: the op follows the rules in CONTRIBUTING.md (`read`/`diff` never write, `apply` idempotent, `actx.intend` before every create, `destroy` treats "gone" as success), has sim routes with numbered API assumptions, and a scenario.
- [ ] A changeset (`pnpm changeset`) describes any user-visible change — or this PR is docs/tests/CI only.
- [ ] Docs updated where behaviour changed (README, SKILL.md, package READMEs, `docs/`).
- [ ] Adapters only: `pnpm docs:gen` run, the op's section written in `docs/plan-format.md`, and its provider block and params in `schema/release.plan.schema.json`.
- ADR (tick one). Needed for changes to the plan format or its semantics, receipts, the safety rules (invariants, approval, drift), or the public API (adapter contract, JSON output, error/exit codes, CLI commands); not for a new adapter or secret source that follows the existing patterns.
  - [ ] An ADR in `docs/adr/` is included or already merged: <!-- link -->
  - [ ] Not needed because: <!-- one line, e.g. "new adapter following the existing pattern" -->

### Invariants touched

<!-- Tick any invariant (CONTRIBUTING.md, "The invariants") this PR could affect, and say how it is still checked. -->

- [ ] 1 — no output contains a registered secret value
- [ ] 2 — a failed line with successful rollback leaves the resource set unchanged
- [ ] 3 — `apply; apply`: the second performs zero writes
- [ ] 4 — `plan` performs zero writes
- [ ] 5 — resources no line declares and Sponson never created are never changed
- [ ] 6 — every receipt parses at every moment
- [ ] 7 — nothing writes to `production` without approval
- [ ] 8 — after a successful destroy, nothing Sponson created survives
- [ ] None of the above
