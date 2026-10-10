/**
 * The zero-account demo behind `sponson-sim --demo <dir>`: a git repository holding a plan wired to the projects
 * the sim seeds by default, an env file that points `sponson` at the running sim, and the commands to run next.
 * The README's "Try it in 60 seconds" block is these commands verbatim; `scenarios/docs/try-it.test.ts` runs that
 * block and checks it against what `demoSteps` prints, so the two cannot drift apart.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { simEnv } from "./index.js";

const exec = promisify(execFile);

/** The branch the demo commit is on; Vercel variables are written for it. */
export const DEMO_BRANCH = "feat/checkout";
/** The pull request the demo pretends to be, so the scope reads `pr-42` as in the README. */
export const DEMO_PR = "42";
/** The file `source` loads in the second terminal. */
export const DEMO_ENV_FILE = "sim.env";

/**
 * Comments carry the explanation, because a newcomer reads this file before running anything. It uses only the
 * projects every provider's default seed creates (`prj_demo`, `proj_demo`; Clerk needs none).
 */
export const DEMO_PLAN = `# A release plan for a preview of this branch, against the fake cloud started by \`sponson-sim --demo\`.
version: 1
# Receipts (what each run did) go to .sponson/receipts in this directory: the demo has no git remote.
receipts: local
providers:
  vercel: { project: prj_demo }
  neon: { project: proj_demo }

changes:
  # 1. A Neon database branch for this preview, forked from main.
  - id: db
    adapter: neon
    op: branch
    parent: main
    environments: [preview]

  # 2. The branch's connection string as the preview's DATABASE_URL. A reference, never a value: nobody copies
  #    a password between consoles, and it is masked in every line Sponson prints.
  - id: env
    adapter: vercel
    op: env
    target: preview
    values:
      DATABASE_URL: { from: db.connection_string }
    environments: [preview]

  # 3. The preview's URL as an allowed Clerk redirect. The URL exists only once Vercel has deployed this commit,
  #    so this line waits for the deploy.
  - id: callback
    adapter: clerk
    op: redirect_allow
    url: { from: env.preview_url }
    environments: [preview]
`;

/** A console edit, as the sim's drift control applies it: someone pastes another database into DATABASE_URL. */
export const DEMO_DRIFT = { "vercel.env.preview.DATABASE_URL": "postgres://typed-in-the-console" };

/**
 * What to run in the second terminal, in order. No inline comments: interactive zsh (macOS's default shell)
 * treats `#` as an argument unless `interactivecomments` is set, so a pasted comment would break the command.
 */
export function demoSteps(dir: string): string[] {
  return [
    `cd ${shellQuote(dir)} && source ${DEMO_ENV_FILE}`,
    "sponson plan",
    "sponson apply",
    "sponson apply",
    `curl -s -o /dev/null "$SPONSON_SIM_URL/_chaos" -d '${JSON.stringify({ drift: DEMO_DRIFT })}'`,
    "sponson plan",
    "sponson apply --destroy",
  ];
}

/** One line per step of `demoSteps`, for the printed walkthrough. */
const STEP_NOTES = [
  "point sponson at the fake cloud (placeholder tokens, no accounts)",
  "the diff: a branch to create, a variable and a callback waiting on it",
  "creates the branch, injects DATABASE_URL by reference, finds the preview deploy, allows its URL",
  "again: every line unchanged, zero writes",
  "play a human editing DATABASE_URL in the Vercel console",
  "the drift is caught: that line is blocked until you `sponson apply --reconcile`",
  "removes everything this scope created, in reverse order",
];

/**
 * The env file: the sim's URLs and placeholder tokens (`simEnv`), `SPONSON_SIM_URL` for the drift command, and the
 * pull request number. Setting `SPONSON_CTX_PR` also keeps `sponson` from asking `gh` which pull request this is,
 * which in a repository without a remote only costs time. Without a global install, `sponson` falls back to npx.
 */
export function demoEnvFile(url: string): string {
  const lines = [
    "# Points sponson at the fake cloud started by `sponson-sim --demo`. Load it with: source sim.env",
    ...envExports(url),
    "# The demo pretends this branch is pull request #42 (scope pr-42).",
    `export SPONSON_CTX_PR=${DEMO_PR}`,
    "# Not installed globally? Run the published CLI through npx.",
    'command -v sponson >/dev/null 2>&1 || sponson() { npx --yes sponson "$@"; }',
  ];
  return `${lines.join("\n")}\n`;
}

/** `export NAME=value` for everything a shell needs to point `sponson` at the sim at `url`. */
export function envExports(url: string): string[] {
  return [`export SPONSON_SIM_URL=${url}`, ...Object.entries(simEnv(url)).map(([k, v]) => `export ${k}=${v}`)];
}

/**
 * Write the demo into `dir`: the plan, a .gitignore, the env file, and one commit on `DEMO_BRANCH`. The commit's
 * author, dates and contents are fixed, so its sha (and with it the preview URL the sim derives from it) is the
 * same on every machine. The env file is ignored: it holds the port, which differs between runs.
 * Refuses a non-empty directory rather than mixing the demo into someone's files.
 */
export async function writeDemo(dir: string, url: string): Promise<void> {
  const existing = await readdir(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  if (existing.length > 0) throw new Error(`${dir} is not empty; pass a new directory to --demo (or delete this one)`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "release.plan.yaml"), DEMO_PLAN);
  await writeFile(join(dir, ".gitignore"), `.sponson/\n${DEMO_ENV_FILE}\n`);
  await writeFile(join(dir, DEMO_ENV_FILE), demoEnvFile(url));
  await git(dir, ["init", "-q"]);
  await git(dir, ["checkout", "-q", "-b", DEMO_BRANCH]);
  await git(dir, ["add", "release.plan.yaml", ".gitignore"]);
  await git(dir, ["commit", "-q", "--no-verify", "-m", "Add the Sponson demo plan"]);
}

/** The walkthrough printed once the sim is up and the demo is written. */
export function demoInstructions(dir: string, url: string): string {
  const steps = demoSteps(dir);
  return [
    `Fake cloud (Vercel, Neon and Clerk APIs) listening on ${url}. State lives in memory; Ctrl-C stops it.`,
    `Demo repository written to ${dir}: release.plan.yaml creates a Neon branch, puts its connection string`,
    "into Vercel's DATABASE_URL by reference, waits for the preview deploy, then allows its URL in Clerk.",
    "",
    "In a second terminal, run these one at a time:",
    "",
    ...steps.map((s) => `  ${s}`),
    "",
    "What each one does:",
    "",
    ...STEP_NOTES.map((note, i) => `  ${String(i + 1)}. ${note}`),
    "",
  ].join("\n");
}

/**
 * Git with the demo's fixed identity. Inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE would point it at
 * another repository (they are set inside git hooks), and a user's signing or hook settings would change the
 * commit, so both are overridden.
 */
async function git(cwd: string, args: string[]): Promise<void> {
  const { GIT_DIR: _d, GIT_WORK_TREE: _w, GIT_INDEX_FILE: _i, ...env } = process.env;
  const fixed = { GIT_AUTHOR_NAME: "Sponson demo", GIT_AUTHOR_EMAIL: "demo@sponson.invalid", GIT_COMMITTER_NAME: "Sponson demo", GIT_COMMITTER_EMAIL: "demo@sponson.invalid", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
  const config = ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main"];
  try {
    await exec("git", [...config, ...args], { cwd, env: { ...env, ...fixed } });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") throw new Error("the demo needs git on PATH (Sponson reads the branch and commit from it)");
    throw new Error(`git ${args.join(" ")} failed: ${(err.stderr ?? err.message).trim()}`);
  }
}

/** Quote a path for a POSIX shell only when it needs it, so the common case reads naturally. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}
