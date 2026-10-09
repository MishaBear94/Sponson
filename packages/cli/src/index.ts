/**
 * The `sponson` package's programmatic API: run the CLI in-process, and the contract a third-party
 * plugin (listed in `$SPONSON_PLUGINS`) implements. Everything else is internal and may change.
 */
export { run, type RunIO } from "./main.js";
export type { SponsonPlugin } from "./registry.js";
