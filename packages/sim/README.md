# @sponson/sim

A local fake cloud for testing [Sponson](https://github.com/MishaBear94/Sponson#readme): subsets of the Vercel, Neon and Clerk APIs with chaos injection, started in-process with `startSim()` or from the command line with `sponson-sim`.

- `npx --yes @sponson/sim --demo sponson-demo`: the fake cloud plus a ready demo repository, and the commands to run
  next (the "Try it in 60 seconds" section of Sponson's README).
- `npx --yes @sponson/sim --port 4777`: just the fake cloud.
- `eval "$(npx --yes @sponson/sim env)"`: point `sponson` at a sim already running on that port.

Documentation: <https://sponson.mintlify.site>. Source and issues: [GitHub](https://github.com/MishaBear94/Sponson).
