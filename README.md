# Sponson

Sponson is the plan for everything that ships beside the code.

A sponson is the float welded to the side of a hull so the boat does not roll. The code is the hull. The preview database, environment variables, callbacks, and feature flags are the float. Sponson writes that float into one file an agent can read and a human can diff.

This repository is the start of that format. The CLI is not here yet.

## Why this exists

Agents can already change a repository. They cannot safely change the rest of a release.

The code lands in Git. The things that have to move with it do not. A preview database lives in the database console. Environment variables live in the deploy console. OAuth callbacks live in an identity console. Feature flags live in a fourth. A person copies state between them by hand. An agent does the same thing with no shared record of what it intended, what it tried, and what a human approved.

Existing tools each own one slice. Terraform and Pulumi plan resources, not the preview data and callback that belong to this release. Vercel and Railway deploy the app, not the secrets and flags that have to match it. Doppler and Infisical hold secrets, not the release those secrets belong to. The Model Context Protocol revision of 28 July 2026 removed protocol-level sessions, so a sequence of tool calls is not itself a record. A release needs its own file.

Sponson is that file. The format is the product. A hosted preview control plane can come later. A new cloud does not.

## What it solves

One release, one plan.

- The plan lists every side effect of this commit: a database branch, a secret reference injected into a preview environment, a callback URL, a flag change.
- Secrets appear as references, never as values.
- `plan` reads current state and prints a diff. Nothing runs.
- `apply` runs only that file. A failed line tears down what this plan created.
- A human, or a CI rule, approves before the same plan can touch production.
- The receipt is written back into the file. The agent's next step reads the receipt, not its own memory.

The first adapters are Vercel preview variables and Neon branches. Social-login callbacks and flag targeting are out of the first cut: provider allow-lists and per-environment flag rules are still console-owned.

## Architecture

```text
repo
  release.plan          the intent and, after apply, the receipt
        |
        v
  sponson plan          read adapters, diff against the file
        |
        v
  sponson apply         run the file, in dependency order
        |
        +-- vercel adapter     preview env vars, secret values only in-process
        +-- neon adapter       branch, schema diff, delete on failure
        |
        v
  receipt in release.plan
```

The plan is a text file committed next to the change. Each line is one change, with an id, an adapter, an operation, and a reference to any line it waits on. Apply order is explicit. A preview URL does not exist until deploy finishes, so a callback line depends on the deploy line instead of assuming an instant result.

Adapters read and write one system. They do not own the record. `plan` re-reads live state on every run and marks drift it did not author. It does not overwrite that drift.

Secret values are resolved inside `apply`, sent to the adapter, and left out of the file and the logs. The file keeps the reference.

There is no control plane in this repository. The standard is the file other tools and agent skills agree to write.

## User journey

1. A person, or an agent, changes the app and declares the side effects in `release.plan`: branch the database, point the preview environment at that branch.
2. `sponson plan` reads Vercel and Neon and prints the diff. The agent stops. The person reads the same file in the pull request.
3. `sponson apply` creates the Neon branch, injects the connection reference into the Vercel preview environment, and waits for the preview URL.
4. A line fails. Apply deletes the branch it created and writes the failed line into the receipt. Nothing is left to clean up by hand.
5. The preview is good. A person approves, or CI policy passes. The same file is applied to production. The receipt records which lines landed and which were rejected.
6. The agent reads the receipt and continues. It does not infer success from its last tool call.

## Status

The format and the two adapters are the first milestone. Social login callbacks, feature-flag targeting, and a hosted approval inbox are not.

## License

Apache-2.0, to be added with the first code.
