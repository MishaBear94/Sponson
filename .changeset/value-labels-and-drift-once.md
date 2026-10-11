---
"sponson": patch
"@sponson/core": patch
"@sponson/adapters": patch
---

Plan output and the PR comment, from a newcomer walkthrough of 0.9.0:

- A value is labelled by what it is in the plan, the same way in the CLI and the PR comment: `(secret ← env://KEY)`
  only for a `{ secret }` reference, `(value hidden ← db.connection_string)` for a sensitive `{ from }` output, and a
  literal as itself. Before, a connection string read as a secret and a literal Vercel variable as `(secret)`.
  Adapters name the param a diff comes from (`ResourceDiff.input`; Vercel, Netlify and Cloudflare Pages variables), and
  the engine describes the new side from it.
- Drift is said once: a drifted resource says "changed outside Sponson" on its own row (CLI) or next to its name (PR
  comment), the refused line keeps only the code and the fix, and the drift section lists only what no line shows.
  Under `apply`'s table the last line names the failed line and its code instead of repeating the error.
- `apply --destroy` no longer prints an `outputs` block for what it just deleted (the receipt keeps the outputs).
- No internal field names in human text: a refused production run says "This run applies to production, and nobody
  approved it." (was "approval is required (approvedBy)").
- The `DRIFT_CHANGED` hint says in plain words what `--reconcile` does to a resource deleted and re-created outside
  Sponson: it adopts the new one, keeps it and will not delete it.
