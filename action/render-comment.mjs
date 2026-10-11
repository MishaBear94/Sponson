// Renders the pull request comment from the CLI's saved `--json` result with Sponson's own renderer: the same
// markdown `sponson plan|apply --format markdown` prints. Run by action.yml's `run` step. Reads only environment
// variables (RESULT_PATH, COMMENT_PATH, SPONSON_MARKDOWN_MODULE, SPONSON_ENV, SPONSON_COMMAND, SPONSON_EXIT and the
// run's GITHUB_* variables) and writes COMMENT_PATH. Exits non-zero when the installed Sponson has no renderer; the
// comment step then posts a short fallback.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const env = process.env;
let envelope = null;
try {
  envelope = JSON.parse(readFileSync(env.RESULT_PATH, "utf8"));
} catch {
  envelope = null; // a crash: no JSON at all
}
const mod = await import(pathToFileURL(env.SPONSON_MARKDOWN_MODULE).href);
if (typeof mod.renderMarkdown !== "function") {
  console.error("sponson: this version has no markdown renderer (renderMarkdown); the comment falls back to a summary");
  process.exit(1);
}
const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
const exit = Number(env.SPONSON_EXIT);
const body = mod.renderMarkdown(envelope, {
  environment: env.SPONSON_ENV || "preview",
  command: env.SPONSON_COMMAND || "apply",
  exitCode: env.SPONSON_EXIT !== undefined && env.SPONSON_EXIT !== "" && Number.isFinite(exit) ? exit : undefined,
  runUrl,
});
writeFileSync(env.COMMENT_PATH, body);
