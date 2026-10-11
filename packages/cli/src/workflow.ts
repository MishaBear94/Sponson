/**
 * The GitHub Actions workflow `sponson init --setup` writes: the preview job of action/README.md's example workflow
 * (packages/cli/src/setup.test.ts keeps the two in step), with the variables this plan reads and the action
 * pinned to the commit of the installed version's release tag.
 */
import { execFile } from "node:child_process";

/** Where the workflow goes. An existing file is never overwritten. */
export const WORKFLOW_PATH = ".github/workflows/sponson.yml";

/** The repository the action lives in, as `uses:` names it. */
export const ACTION_REPO = "MishaBear94/Sponson";

/** The release tag of a `sponson` version, as the release workflow pushes it. */
export function releaseTag(version: string): string {
  return `sponson@${version}`;
}

/**
 * The commit a release tag points at (the peeled commit of an annotated tag), read with `git ls-remote` from
 * `$SPONSON_ACTION_REPO` (default: the action's GitHub repository); null when git, the network or the tag is missing.
 * `uses:` cannot name the tag itself: GitHub splits it at every `@`, and the tag has one.
 */
export function resolveTagCommit(tag: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string | null> {
  const url = env.SPONSON_ACTION_REPO ?? `https://github.com/${ACTION_REPO}.git`;
  return new Promise((resolve) => {
    execFile("git", ["ls-remote", "--tags", "--", url, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd, env, timeout: 15_000 }, (err, stdout) => {
      if (err) return resolve(null);
      const refs = new Map(String(stdout).split("\n").filter(Boolean).map((l) => [l.split(/\s+/)[1]!, l.split(/\s+/)[0]!] as const));
      const sha = refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null;
      resolve(sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null);
    });
  });
}

export interface WorkflowInput {
  /** Variables every step needs: provider credentials and the values `{ secret: "env://NAME" }` references. */
  variables: string[];
  /** The commit to pin the action to, or null to leave a TODO naming the tag. */
  commit: string | null;
  /** The release tag `commit` belongs to. */
  tag: string;
  /** Notes for providers that authenticate with a CLI's login instead of a variable (Cloud Run: gcloud). */
  commandNotes: string[];
}

/** The workflow file's text. */
export function renderWorkflow(w: WorkflowInput): string {
  const uses = w.commit ? `${ACTION_REPO}/action@${w.commit} # ${w.tag}` : `${ACTION_REPO}/action@<commit-sha> # TODO: the commit of tag ${w.tag}: git ls-remote https://github.com/${ACTION_REPO} 'refs/tags/${w.tag}^{}'`;
  const env = w.variables.length ? w.variables.map((v) => `      ${v}: \${{ secrets.${v} }}`) : ["      # no provider variables: this plan's providers authenticate with a CLI login"];
  return [
    "# Written by `sponson init --setup`. Sponson for pull requests: apply on open and push, finish after the preview",
    "# deploy, destroy on close. Production has its own approved job: see",
    `# https://github.com/${ACTION_REPO}/blob/main/action/README.md#example-workflow`,
    "name: sponson",
    "on:",
    "  pull_request:",
    "    types: [opened, synchronize, closed]",
    "  deployment_status:",
    "",
    "permissions:",
    "  contents: write",
    "  pull-requests: write",
    "  deployments: read",
    "",
    "concurrency:",
    "  group: sponson-${{ github.event.pull_request.number || github.event.deployment.sha || github.ref }}",
    "  cancel-in-progress: false",
    "",
    "jobs:",
    "  preview:",
    "    runs-on: ubuntu-latest",
    "    # deployment_status fires for every state and every environment: act only on a finished preview deploy.",
    "    if: >-",
    "      github.event_name == 'pull_request' ||",
    "      (github.event_name == 'deployment_status' &&",
    "       github.event.deployment_status.state == 'success' &&",
    "       github.event.deployment.environment != 'Production' &&",
    "       github.event.deployment.environment != 'production')",
    "    # Every step below needs the provider tokens, destroy included.",
    "    env:",
    ...env,
    ...w.commandNotes.map((n) => `    # ${n}`),
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with:",
    "          # for deployment_status, check out the commit that was deployed",
    "          ref: ${{ github.event.deployment.sha || github.sha }}",
    "          # full history lets Sponson recognise a late build of an older commit",
    "          fetch-depth: 0",
    "",
    "      - name: Destroy preview resources",
    "        if: github.event_name == 'pull_request' && github.event.action == 'closed'",
    `        uses: ${uses}`,
    "        with:",
    "          command: destroy",
    "          env: preview",
    "",
    "      - name: Apply preview resources",
    "        if: github.event_name != 'pull_request' || github.event.action != 'closed'",
    `        uses: ${uses}`,
    "        with:",
    "          command: apply",
    "          env: preview",
    "",
  ].join("\n");
}
