---
"sponson": patch
"@sponson/adapters": patch
---

`sponson init` and `init --setup`:

- A recipe default the plan runs with (Stripe's webhook `path`) is written with a `# CHECK:` note instead of a
  `# TODO:`. It is listed as "please check" and reported as `detected.check`, and never blocks `ready` or the workflow
  offer; only placeholders the plan cannot run with (`proj_xxx`, `<id>`) are TODOs.
- `setup.next` in `--json` is `{ command, why }`: `command` is the command to run next (`sponson plan` once ready,
  `sponson init --setup` when a token only needs typing) or `null` when the next step is a person's (a TODO, a new
  token); `why` says what to do.
- Without a terminal (`--json` in CI or from an agent), a missing token is reported with advice that fits: set it in
  the environment the command runs with, or run `sponson init --setup` in an interactive terminal to type it.
