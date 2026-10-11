---
"@sponson/sim": patch
---

The demo's `sim.env` always runs the CLI of the sim's own version, `npx --yes sponson@<version>`, as a shell function
that shadows any `sponson` on PATH: a global install of another version can no longer run the demo against a fake
cloud it does not match.
