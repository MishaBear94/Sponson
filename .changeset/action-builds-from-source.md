---
"sponson": minor
---

The GitHub Action now defaults to `version: source`: it builds and runs Sponson from the action's own checkout — exactly the ref the caller pinned — instead of `npx sponson@latest`, so nothing is fetched from a package registry. Pin the action to a commit SHA. An explicit npm version is still accepted once the package is published from this repository. Node 22 is now the minimum (the versions CI tests).
