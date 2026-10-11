---
"sponson": minor
"@sponson/core": minor
---

Plan and apply output, drift and destroy:

- A blocked line (and a line skipped because one it depends on is blocked) is shown as `x`, never `-`, which means a
  delete. `plan` exits 1 when a line is blocked or in error; `plan --help` and the README say so.
- A diff no longer repeats a value its label already ends in (`Neon branch sponson/preview/pr-42`, once), and a change
  between two hidden values says what it is (`changed outside Sponson (value hidden)`) instead of `(secret) → (secret)`.
- Drift remedies are said once. The engine's `DRIFT_CHANGED` message and drift message state what happened; the remedy
  is the code's CLI hint ("Keep that change by updating the plan to match, or re-run with --reconcile to overwrite
  it"), or, in the PR comment, one fix sentence on the refused line.
- `apply --destroy` still deletes a resource Sponson created that someone edited since the last apply (the pull request
  is closing), but no longer silently: it re-reads the line first, warns (`DATABASE_URL (preview, feat/x) was changed
  outside Sponson since the last apply; deleted anyway`), and records the labels under the receipt line's
  `notes.changedOutside`. There is no flag to keep it (docs/adr/0006).
- The PR comment: a plan's headline says what the preview already has and what applying adds (not "Applying this plan
  gives…" for a branch that exists); lines held back by a refused line are counted apart from the refused ones and
  have no fix of their own; identifiers in engine and provider text stay code spans instead of `&#96;` entities
  (a span holding a tag, a pipe or an entity is still escaped).
