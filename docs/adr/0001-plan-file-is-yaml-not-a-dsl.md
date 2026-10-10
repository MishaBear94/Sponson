# 1. The plan file is YAML, not a DSL

Date: 2026-10-10

## Status

Accepted

## Context

Sponson has two kinds of users, people and coding agents, and the plan file is the interface both of them edit. A
change that ships with code (a database branch, a variable, a callback URL) has to be readable in a pull request diff
by a person and writable without mistakes by an agent.

A custom language (HCL-like, or an embedded TypeScript API) could express more: loops, conditionals, functions. It
would also need its own parser, formatter, editor support and documentation, and agents write unfamiliar languages
far less reliably than YAML. None of that extra expressiveness was asked for by any use case we had.

## Decision

The plan is a YAML file, `release.plan.yaml`, with a fixed structure: `version`, optional `environments`,
`providers` and `receipts`, and a flat list of `changes`. Each change names an adapter and an op; every other key is a
parameter. Values are literals or one of three reference objects (`{ from }`, `{ secret }`, `{ keep: true }`). The
only interpolation is `${ctx.*}` over a fixed set of run-context variables. There are no user-defined variables, no
expressions and no conditionals other than the per-line `environments:` filter
([ADR 0012](0012-flat-plan-with-environment-filters.md)).

Dependencies are not declared: they follow from `from:` references. `depends_on` exists only for ordering without a
data dependency.

A JSON Schema (`schema/release.plan.schema.json`) describes the file for editors; the parser in
`packages/core/src/plan.ts` is the authority.

## Consequences

- Editors highlight, complete and validate the file through the YAML language server and the schema; agents write it
  with the same accuracy as any other YAML.
- Some repetition is accepted: the same variable for two environments is two lines. YAML anchors work but produce a
  `YAML_ANCHOR` warning, because they make diffs harder to review.
- Anything that needs computation (string concatenation with a reference, loops over a list) cannot be expressed. A
  `{ from }` reference is always a whole value. If real use cases need more, they have to be argued for one by one.
- The format can be validated without running anything, so most mistakes fail at parse time with a stable error code
  instead of halfway through an apply.
