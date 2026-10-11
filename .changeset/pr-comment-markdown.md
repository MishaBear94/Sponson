---
"sponson": minor
"@sponson/core": minor
"@sponson/adapters": minor
---

The pull request comment is redesigned for the reviewer, and any CI or agent can post it.

- **What the comment says.** A headline ("This preview has its own database branch, 2 variables and 1 auth callback"), the preview URL as a link, then one line per plan line: what it manages (by name; values never shown, inputs only as references), whether it was set up or is unchanged, a link to the provider's console, and what a waiting line waits for. A refusal, a failure or drift is one sentence with the fix (`--reconcile`, `--approved-by`, `--confirm`). On destroy: "Cleaned up", "Kept (adopted, never destroyed)" and "Left for you". Still one comment per environment, updated in place by its `<!-- sponson:<env> -->` marker; a comment that would exceed GitHub's 65,536 characters keeps its headline and says what it left out.
- **`--format markdown`** on `plan` and `apply` prints that comment (also for errors, with the same exit code); `--format json` is `--json`. The `sponson` package exports the renderer, `renderMarkdown(envelope)`, a pure function of a `--json` envelope.
- **The GitHub Action** renders its comment with that renderer from the JSON it saves (`action/render-comment.mjs`), so the comment and the CLI never disagree. With `version: <npm version>` the action now installs Sponson with `npm install` into the runner's temporary directory instead of `npx`; a version older than the renderer gets a one-line summary comment.
- **Receipts** carry `lines[id].consoleUrl` (the provider console page for what a line manages) after apply, and `lines[id].removed` (what destroy deleted, or forgot because it was adopted) after `--destroy`. Ops declare console pages with the new optional `OpSpec.consoleUrl`; Neon links the branch, Vercel the project's Environment Variables page, Clerk the dashboard, and recipes the new optional `console_url: { template, source }` (filled for `stripe.webhook_endpoint`).
- The GitLab, CircleCI and Bitbucket READMEs (integrations/README.md) show how to post the same comment as a merge request note or pull request comment.
