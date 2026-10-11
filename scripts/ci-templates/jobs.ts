/**
 * Turns one job of the CircleCI or Bitbucket template into the shell script that job runs, for
 * scripts/try-ci-templates.sh to execute inside the image the template declares. Neither host has a local runner
 * that runs a config as the host would, so this reproduces the part of the host that matters to the template:
 *
 *   CircleCI   `commands:` are expanded in place; `checkout` clones the repository into ~/project at
 *              $CIRCLE_SHA1 on $CIRCLE_BRANCH; every `run` is its own `/bin/bash -eo pipefail` (CircleCI's default
 *              shell) in ~/project, with the step's `environment:` and `$BASH_ENV` (sourced by bash at start, so an
 *              `export` appended to it reaches the later steps); `<< pipeline.parameters.x >>` is replaced by the
 *              pipeline's parameter values; `circleci-agent step halt` ends the job successfully after its step;
 *              with $SPONSON_TRY_CIRCLECI_API set, requests to https://circleci.com/ go there (a stand-in API).
 *   Bitbucket  the clone (`clone: depth: full`) into $BITBUCKET_CLONE_DIR at $BITBUCKET_COMMIT, then the step's
 *              `script:` lines in one bash session that stops at the first failing line, YAML anchors resolved.
 *
 * Everything else in the job is the template's text, unchanged.
 *
 *   tsx scripts/ci-templates/jobs.ts circleci <config.yml> <job> <out.sh> [param=value ...]
 *   tsx scripts/ci-templates/jobs.ts bitbucket <bitbucket-pipelines.yml> <pipeline path> <out.sh>
 *
 * prints the image the job runs in. A Bitbucket pipeline path is `pull-requests/**`, `branches/main` or `custom/sponson-destroy`, then `/<n>` for its n-th step
 * (0-based), e.g. `pull-requests/**\/1`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

/** A job as a script, and the image the template runs it in. */
export interface JobScript {
  image: string;
  script: string;
}

/** `'…'` for a POSIX shell. */
export function sq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

type CircleStep = string | Record<string, unknown>;
interface CircleRun {
  name?: string;
  command: string;
  environment?: Record<string, string>;
}
/** The parts of a CircleCI config the emulation reads. */
interface CircleConfig {
  parameters?: Record<string, { default?: unknown }>;
  executors: Record<string, { docker: Array<{ image: string }> }>;
  commands?: Record<string, { steps: CircleStep[] }>;
  jobs?: Record<string, { executor: string; steps: CircleStep[] }>;
}
interface BitbucketStepDef {
  name: string;
  image?: string;
  script: string[];
  trigger?: string;
}
/** The parts of a bitbucket-pipelines.yml the emulation reads. */
interface BitbucketConfig {
  image?: string;
  pipelines?: Record<string, Record<string, Array<{ step?: BitbucketStepDef }> | undefined> | undefined>;
}

/** `<< pipeline.parameters.x >>` → its value: the parameter given, else its declared default. */
function withParameters(text: string, config: CircleConfig, params: Record<string, string>): string {
  return text.replace(/<<\s*pipeline\.parameters\.([\w-]+)\s*>>/g, (_m, name: string) => {
    const declared = config.parameters?.[name];
    if (declared === undefined) throw new Error(`pipeline parameter ${name} is not declared`);
    return params[name] ?? String(declared.default ?? "");
  });
}

/** The job's steps with every `commands:` entry expanded (recursively), as CircleCI expands them. */
function expandSteps(steps: CircleStep[], config: CircleConfig): CircleStep[] {
  return steps.flatMap((step) => {
    const name = typeof step === "string" ? step : Object.keys(step)[0]!;
    const command = config.commands?.[name];
    return command ? expandSteps(command.steps, config) : [step];
  });
}

const CIRCLE_PRELUDE = `#!/bin/bash
# Emulates CircleCI running one job (scripts/ci-templates/jobs.ts).
set -u
export BASH_ENV="/tmp/.bash_env-sponson-try"; : > "$BASH_ENV"
mkdir -p /tmp/emu-bin
printf '#!/bin/sh\\n[ "$1 $2" = "step halt" ] && touch /tmp/emu-halted\\n' > /tmp/emu-bin/circleci-agent
chmod +x /tmp/emu-bin/circleci-agent
export PATH="/tmp/emu-bin:$PATH"
mkdir -p ~/project
`;

/** With $SPONSON_TRY_CIRCLECI_API set, curl sends what the job asks of https://circleci.com/ there instead. */
const CURL_SHIM = [
  'if [ -n "${SPONSON_TRY_CIRCLECI_API:-}" ]; then',
  "  cat > /tmp/emu-bin/curl <<'SHIM'",
  "#!/bin/bash",
  "p='https://circleci.com/'; args=()",
  'for a in "$@"; do args+=("${a/#"$p"/$SPONSON_TRY_CIRCLECI_API/}"); done',
  'exec /usr/bin/curl "${args[@]}"',
  "SHIM",
  "  chmod +x /tmp/emu-bin/curl",
  "fi",
  "",
].join("\n");

const CIRCLE_CHECKOUT = `echo "==> checkout (emulated: clone $SPONSON_TRY_REPO at $CIRCLE_SHA1)"
git clone -q "$SPONSON_TRY_REPO" ~/project && git -C ~/project checkout -q -B "$CIRCLE_BRANCH" "$CIRCLE_SHA1" || exit 1
`;

function circleRun(run: CircleRun): string {
  const env = Object.entries(run.environment ?? {}).map(([k, v]) => `${k}=${sq(String(v))} `).join("");
  const title = run.name ?? run.command.split("\n")[0]!;
  return [
    `echo ${sq(`==> ${title}`)}`,
    `(cd ~/project && ${env}/bin/bash -eo pipefail -c ${sq(run.command)}) || exit $?`,
    `if [ -e /tmp/emu-halted ]; then echo "==> job halted by circleci-agent step halt (success)"; exit 0; fi`,
    "",
  ].join("\n");
}

/** One CircleCI job as the script CircleCI would run, with pipeline parameters filled in. */
export function circleciJob(configText: string, job: string, params: Record<string, string> = {}): JobScript {
  const config = parse(configText) as CircleConfig;
  const def = config.jobs?.[job];
  if (!def) throw new Error(`no job ${job}`);
  const image = config.executors[def.executor]!.docker[0]!.image;
  const parts = [CIRCLE_PRELUDE, CURL_SHIM];
  for (const step of expandSteps(def.steps, config)) {
    if (step === "checkout") parts.push(CIRCLE_CHECKOUT);
    else if (typeof step === "object" && "run" in step) {
      const raw = step.run as string | CircleRun;
      const run: CircleRun = typeof raw === "string" ? { command: raw } : raw;
      parts.push(
        circleRun({
          ...run,
          command: withParameters(run.command, config, params),
          environment: Object.fromEntries(Object.entries(run.environment ?? {}).map(([k, v]) => [k, withParameters(String(v), config, params)])),
        }),
      );
    } else throw new Error(`${job}: step ${JSON.stringify(step)} is not emulated`);
  }
  parts.push('echo "==> job succeeded"\n');
  return { image, script: parts.join("\n") };
}

/** One Bitbucket step (`<pipeline path>/<n>`) as the script Pipelines would run. */
export function bitbucketStep(configText: string, selector: string): JobScript {
  const config = parse(configText, { maxAliasCount: 100 }) as BitbucketConfig;
  const m = /^(pull-requests|branches|custom)\/(.+)\/(\d+)$/.exec(selector);
  if (!m) throw new Error(`not a step selector: ${selector}`);
  const steps = (config.pipelines?.[m[1]!]?.[m[2]!] ?? []).flatMap((e) => (e.step ? [e.step] : []));
  const step = steps[Number(m[3])];
  if (!step) throw new Error(`no step ${selector}`);
  // Pipelines rejects such a file: "The first step of a pipeline can't be manual".
  if (steps[0]?.trigger === "manual") throw new Error(`${m[1]}/${m[2]}: the first step of a pipeline cannot be manual`);
  const script = [
    "#!/bin/bash",
    "# Emulates Bitbucket Pipelines running one step (scripts/ci-templates/jobs.ts).",
    `echo ${sq(`==> step: ${step.name}`)}`,
    'echo "==> clone (emulated: $SPONSON_TRY_REPO, depth full, at $BITBUCKET_COMMIT)"',
    'git clone -q "$SPONSON_TRY_REPO" "$BITBUCKET_CLONE_DIR" && cd "$BITBUCKET_CLONE_DIR" && git checkout -q "$BITBUCKET_COMMIT" || exit 1',
    "set -e",
    ...step.script.flatMap((line) => [`echo ${sq(`+ ${line}`)}`, line]),
    'echo "==> step succeeded"',
    "",
  ].join("\n");
  return { image: step.image ?? config.image ?? "atlassian/default-image", script };
}

function main(argv: string[]): void {
  const [host, file, job, out, ...rest] = argv;
  if (!host || !file || !job || !out) throw new Error("usage: jobs.ts <circleci|bitbucket> <template> <job> <out.sh> [param=value ...]");
  const text = readFileSync(file, "utf8");
  const params = Object.fromEntries(rest.map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  const result = host === "circleci" ? circleciJob(text, job, params) : bitbucketStep(text, job);
  writeFileSync(out, result.script, { mode: 0o755 });
  process.stdout.write(`${result.image}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
