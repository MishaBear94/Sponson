/**
 * The `sponson` package's programmatic API: run the CLI in-process, detect the run context the way the CLI
 * does (for embedding the engine), and the contract a third-party plugin (listed in `$SPONSON_PLUGINS`)
 * implements. Everything else is internal and may change.
 */
export { run, type RunIO } from "./main.js";
export {
  detectCtx,
  DEFAULT_CTX_SOURCES,
  bitbucketPipelinesSource,
  circleCiSource,
  githubActionsSource,
  gitlabCiSource,
  localGitSource,
  sponsonEnvSource,
  type CtxFacts,
  type CtxOverrides,
  type CtxSource,
} from "./detect.js";
export type { SponsonPlugin } from "./registry.js";
