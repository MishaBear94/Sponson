#!/usr/bin/env bash
# Runs the GitLab, CircleCI and Bitbucket templates under integrations/ for real, as close to their hosts as a laptop
# allows, against the fake cloud, with the Sponson packed from this checkout. Not part of `pnpm test`: it needs Docker
# and network access (npm, for the CLI's dependencies; gitlab-ci-local). integrations/README.md, "How the templates
# are checked", says what is real here and what is emulated.
#
#   scripts/try-ci-templates.sh [gitlab] [circleci] [bitbucket]     (default: all three)
#   KEEP=1 scripts/try-ci-templates.sh ...                          keep the scratch directory for inspection
#   SPONSON_TRY_VERSION=0.5.0 scripts/try-ci-templates.sh ...       run that release from npm instead of this checkout
#                                                                   (the fake cloud still comes from this checkout)
#
# For each host, in a fresh scratch directory (mktemp) with a fresh fake cloud:
#   - a scratch app repository (bare `origin.git`, the "hosted" repository) whose main branch has a release plan
#     (a Neon branch, the preview's DATABASE_URL by reference, a production variable from a secret) and the host's
#     template, the Sponson version replaced by the one under test; a pull request branch adds a Clerk callback
#     on the preview URL (so it waits for the deploy) and changes the app;
#   - the pull request pipeline: plan, apply, finish (apply --wait); the preview resources must exist;
#   - the default-branch pipeline: production, with an approver; the production variable must exist;
#   - the destroy the host runs when the pull request closes; the preview resources must be gone, production kept;
#   - the receipts must have been pushed to origin.git, through the URL the template builds;
#   - the plan command without --pr/--branch/--sha must detect the same scope from the host's variables (pull
#     request, main, and a tag build on CircleCI and Bitbucket).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GITLAB_CI_LOCAL="gitlab-ci-local@4.76.1"
CIS=("$@")
[ ${#CIS[@]} -gt 0 ] || CIS=(gitlab circleci bitbucket)
for ci in "${CIS[@]}"; do
  case "$ci" in gitlab | circleci | bitbucket) ;; *) echo "unknown CI: $ci (gitlab, circleci, bitbucket)" >&2; exit 2 ;; esac
done
for tool in docker node pnpm git curl; do command -v "$tool" >/dev/null || { echo "needs $tool on PATH" >&2; exit 2; }; done
docker info >/dev/null 2>&1 || { echo "needs a running Docker daemon" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sponson-try-ci.XXXXXX")"
RUN="sponson-try-$$"
NET="$RUN"
SUMMARY=()

cleanup() {
  local ids
  ids="$(docker ps -aq --filter "label=$RUN" 2>/dev/null || true)"
  [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  if [ "${KEEP:-}" = 1 ]; then
    echo "scratch directory kept: $WORK"
  else
    # Jobs run as root or another uid in their containers; let a container remove what they wrote.
    docker run --rm -v "$WORK:/w" node:22 sh -c 'rm -rf /w/* /w/.[!.]*' >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }
pass() { SUMMARY+=("$1"); printf '\033[32mok\033[0m %s\n' "$1"; }

# ---------------------------------------------------------------------------------------------------------------
# This checkout, packed as it would be published, and the fake cloud and npm registry that serve it to the jobs.

say "packing the packages of this checkout"
(cd "$ROOT" && pnpm -s -r --filter "./packages/**" pack --pack-destination "$WORK/pkgs" >/dev/null)
ls "$WORK/pkgs"
# What the registry serves in place of npm: this checkout's packages, or nothing (SPONSON_TRY_VERSION: the release).
mkdir -p "$WORK/serve"
if [ -n "${SPONSON_TRY_VERSION:-}" ]; then
  VERSION="$SPONSON_TRY_VERSION"
  UNDER_TEST="sponson@$VERSION from npm"
else
  VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/packages/cli/package.json")"
  UNDER_TEST="sponson $VERSION packed from this checkout"
  cp "$WORK/pkgs/"*.tgz "$WORK/serve/"
fi

docker network create --label "$RUN" "$NET" >/dev/null
for image in node:22 cimg/node:lts; do docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null; done

# The env every job gets beside the host's own variables: the fake cloud's API URLs (each adapter's *_API_URL) and
# the npm registry serving the Sponson under test. Both are emulation; a real pipeline has neither.
"$ROOT/node_modules/.bin/tsx" "$ROOT/packages/sim/src/bin.ts" env --port 4777 \
  | sed -n 's/^export \([A-Z0-9_]*_URL\)=http:\/\/127\.0\.0\.1:4777/\1=http:\/\/sim:4777/p' | grep -v '^SPONSON_SIM_URL=' >"$WORK/emulation.env"
printf 'npm_config_registry=http://registry:4873/\nnpm_config_update_notifier=false\nnpm_config_fund=false\nnpm_config_audit=false\n' >>"$WORK/emulation.env"
# The provider tokens the CI's secret variables would hold (the sim accepts its placeholder tokens).
"$ROOT/node_modules/.bin/tsx" "$ROOT/packages/sim/src/bin.ts" env --port 4777 \
  | grep -E '^export (VERCEL_TOKEN|NEON_API_KEY|CLERK_SECRET_KEY)=' | sed 's/^export //' >"$WORK/tokens.env"
echo "PRODUCTION_DATABASE_URL=postgres://prod.example/app" >"$WORK/production-secrets.env"

SIM=""
start_fakes() {
  docker rm -f "$RUN-fakes" >/dev/null 2>&1 || true
  docker run -d --label "$RUN" --name "$RUN-fakes" --network "$NET" --network-alias sim --network-alias registry \
    -p 127.0.0.1::4777 -v "$WORK/pkgs:/pkgs:ro" -v "$WORK/serve:/serve:ro" -v "$ROOT/scripts/ci-templates/fakes.mjs:/fakes.mjs:ro" node:22 \
    sh -c 'mkdir -p /f && cd /f && npm init -y >/dev/null && npm install -s --no-audit --no-fund /pkgs/sponson-sim-*.tgz && cp /fakes.mjs . && exec node fakes.mjs /serve http://registry:4873' >/dev/null
  SIM="http://$(docker port "$RUN-fakes" 4777/tcp | head -1)"
  local up=""
  for _ in $(seq 1 60); do curl -fs "$SIM/_state" >/dev/null 2>&1 && { up=1; break; }; sleep 1; done
  [ -n "$up" ] || { docker logs "$RUN-fakes" >&2; fail "the fake cloud did not start"; }
  # A preview deploy takes 20 s to be ready, so the first apply stops at the deploy barrier and finish has to wait.
  curl -fs -o /dev/null "$SIM/_chaos" -d '{"deploy_ms": 20000}' || fail "could not set the fake cloud's deploy time"
}

# Checks on the fake cloud's state: `check <label> <js expression over s, the state>`, e.g. s.neon...
check() {
  curl -fs "$SIM/_state" >"$WORK/state.json"
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const ok = (0, eval)(`(s) => (${process.argv[2]})`)(s);
    if (!ok) { console.error(JSON.stringify(s, null, 1).slice(0, 4000)); process.exit(1); }
  ' "$WORK/state.json" "$2" || fail "$1"
  pass "$1"
}

# The fake cloud's state for a scope: the Neon branch, the preview variable for the branch, the Clerk redirect.
neon_branch() { echo "s.neon.projects.proj_demo.branches.some((b) => b.name === 'sponson/preview/$1')"; }
preview_env() { echo "s.vercel.projects.prj_demo.envs.some((e) => e.key === 'DATABASE_URL' && e.target.includes('preview') && e.gitBranch === '$1')"; }
clerk_redirect() { echo "s.clerk.redirect_urls.some((r) => r.url.endsWith('.vercel.app'))"; }
production_env() { echo "s.vercel.projects.prj_demo.envs.some((e) => e.key === 'DATABASE_URL' && e.target.includes('production'))"; }

receipts_pushed() { # <origin.git> <ref suffix>...
  local repo="$1"; shift
  for ref in "$@"; do
    git --git-dir="$repo" rev-parse -q --verify "refs/heads/sponson-receipts/$ref" >/dev/null || {
      git --git-dir="$repo" for-each-ref --format='%(refname)' >&2
      fail "no receipts branch sponson-receipts/$ref in origin.git"
    }
  done
  pass "receipts pushed to origin.git through the template's remote URL: $*"
}

# ---------------------------------------------------------------------------------------------------------------
# The scratch app repository

PLAN_MAIN='version: 1
environments: [preview, production]
providers:
  vercel: { project: prj_demo }
  neon: { project: proj_demo }
changes:
  - id: db
    adapter: neon
    op: branch
    parent: main
    environments: [preview]
  - id: env
    adapter: vercel
    op: env
    target: preview
    values:
      DATABASE_URL: { from: db.connection_string }
    environments: [preview]
  - id: env-production
    adapter: vercel
    op: env
    target: production
    values:
      DATABASE_URL: { secret: "env://PRODUCTION_DATABASE_URL" }
    environments: [production]
'
PLAN_PR_ADDS='  - id: callback
    adapter: clerk
    op: redirect_allow
    url: { from: env.preview_url }
    environments: [preview]
'

# make_repo <dir> <template> <path in the repo>: sets REPO, ORIGIN, MAIN_SHA, PR_SHA.
make_repo() {
  local dir="$1" template="$2" target="$3"
  REPO="$dir/app"
  ORIGIN="$dir/origin.git"
  mkdir -p "$REPO/$(dirname "$target")"
  grep -q "npx -y sponson@" "$ROOT/$template" || fail "$template pins no sponson version"
  sed "s/npx -y sponson@[0-9][0-9A-Za-z.+-]*/npx -y sponson@$VERSION/g" "$ROOT/$template" >"$REPO/$target"
  printf '%s' "$PLAN_MAIN" >"$REPO/release.plan.yaml"
  printf '{ "name": "app", "private": true, "version": "1.0.0" }\n' >"$REPO/package.json"
  printf 'console.log("hello");\n' >"$REPO/index.js"
  printf '.sponson/\n.gitlab-ci-local/\nnode_modules/\n' >"$REPO/.gitignore"
  local g=(git -C "$REPO" -c user.name=try -c user.email=try@sponson.invalid -c commit.gpgsign=false)
  "${g[@]}" init -q -b main
  "${g[@]}" add -A
  "${g[@]}" commit -q -m "app with a release plan and the CI template"
  "${g[@]}" checkout -q -b feat/checkout
  printf 'console.log("hello, checkout");\n' >"$REPO/index.js"
  printf '%s' "$PLAN_PR_ADDS" >>"$REPO/release.plan.yaml"
  "${g[@]}" commit -q -am "checkout page, and its Clerk callback"
  git init -q --bare "$ORIGIN"
  "${g[@]}" push -q "$ORIGIN" main feat/checkout
  MAIN_SHA="$(git -C "$REPO" rev-parse main)"
  PR_SHA="$(git -C "$REPO" rev-parse feat/checkout)"
  # Jobs run as root (node:22) or circleci (cimg/node); both must be able to push receipts.
  chmod -R a+rwX "$dir"
}

# The receipts remote: the template exports SPONSON_RECEIPTS_REMOTE as an HTTPS URL with a token for the real
# host. git rewrites exactly that URL (url.<base>.insteadOf) to the mounted origin.git, so the push only succeeds
# when the template built the URL expected here; nothing in the template is changed.
receipts_rewrite() { # <URL the template builds>
  printf 'GIT_CONFIG_COUNT=2\nGIT_CONFIG_KEY_0=url.file:///origin.git.insteadOf\nGIT_CONFIG_VALUE_0=%s\nGIT_CONFIG_KEY_1=safe.directory\nGIT_CONFIG_VALUE_1=*\n' "$1"
}

# ---------------------------------------------------------------------------------------------------------------
# CircleCI and Bitbucket: each job's script, verbatim, in the template's image, with the host's variables.

# run_job <host> <template in the repo> <job> <env file> [docker -e …] -- [pipeline parameters]
run_job() {
  local host="$1" template="$2" job="$3" envfile="$4"; shift 4
  local docker_env=() params=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do docker_env+=("$1"); shift; done
  [ $# -eq 0 ] || shift
  params=("$@")
  local script="$WORK/$host/jobs/$(echo "$job" | tr '/*' '__').sh"
  mkdir -p "$WORK/$host/jobs"
  local image
  image="$("$ROOT/node_modules/.bin/tsx" "$ROOT/scripts/ci-templates/jobs.ts" "$host" "$template" "$job" "$script" ${params[@]+"${params[@]}"})"
  say "$host: $job (in $image)"
  LOG="${script%.sh}.log"
  docker run --rm --label "$RUN" --network "$NET" -v "$WORK/$host/origin.git:/origin.git" -v "$WORK/$host/jobs:/jobs:ro" \
    --env-file "$WORK/emulation.env" --env-file "$envfile" -e SPONSON_TRY_REPO=file:///origin.git \
    ${docker_env[@]+"${docker_env[@]}"} "$image" bash "/jobs/$(basename "$script")" 2>&1 | tee "$LOG" || fail "$host: $job failed"
  pass "$host: $job"
}

# expect_log <label> <extended regex>: the last job's output (LOG) matches.
expect_log() { grep -Eq "$2" "$LOG" || fail "$1 (no /$2/ in $LOG)"; pass "$1"; }

# Releases up to 0.5.0 took a tag build's branch from the detached checkout (scope branch-HEAD); skip that check
# when one of them is under test.
tags_detected() {
  case "${SPONSON_TRY_VERSION:-}" in 0.[0-4].* | 0.5.0) echo "(skipping the tag build check: sponson@$VERSION predates it)"; return 1 ;; *) return 0 ;; esac
}

# detect_scope <host> <image> <expected scope> <sha> [docker -e …]: the templates' plan command without
# --pr/--branch/--sha, in a detached checkout of <sha> (as the hosts check out), reaches <expected scope> from the
# host's variables alone (packages/cli/src/detect.ts).
detect_scope() {
  local host="$1" image="$2" expected="$3" sha="$4"; shift 4
  mkdir -p "$WORK/$host/jobs"
  cat >"$WORK/$host/jobs/detect.sh" <<EOF
set -e
git clone -q "\$SPONSON_TRY_REPO" /tmp/detect && cd /tmp/detect && git checkout -q --detach $sha
npx -y sponson@$VERSION plan --env preview --json >/tmp/plan.json || true
node -e 'console.log("detected scope: " + JSON.parse(require("fs").readFileSync("/tmp/plan.json", "utf8")).scope)'
EOF
  LOG="$WORK/$host/jobs/detect-$expected.log"
  docker run --rm --label "$RUN" --network "$NET" -v "$WORK/$host/origin.git:/origin.git" -v "$WORK/$host/jobs:/jobs:ro" \
    --env-file "$WORK/emulation.env" --env-file "$WORK/$host/ci.env" -e SPONSON_TRY_REPO=file:///origin.git "$@" \
    "$image" bash /jobs/detect.sh 2>&1 | tee "$LOG" || fail "$host: detection run failed"
  expect_log "$host: without --pr/--branch/--sha, the host's variables give scope $expected" "^detected scope: $expected\$"
}

try_circleci() {
  say "CircleCI: integrations/circleci/config.yml"
  make_repo "$WORK/circleci" integrations/circleci/config.yml .circleci/config.yml
  start_fakes
  local cfg="$REPO/.circleci/config.yml" env="$WORK/circleci/ci.env" pr=12
  { cat "$WORK/tokens.env"; echo "SPONSON_GIT_TOKEN=ghp_try"; receipts_rewrite "https://x-access-token:ghp_try@github.com/acme/app.git"
    printf 'CI=true\nCIRCLECI=true\nCIRCLE_PROJECT_USERNAME=acme\nCIRCLE_PROJECT_REPONAME=app\nCIRCLE_REPOSITORY_URL=git@github.com:acme/app.git\nCIRCLE_WORKFLOW_ID=00000000-0000-4000-8000-000000000001\nCIRCLE_BUILD_NUM=1\nCIRCLE_NODE_TOTAL=1\nCIRCLE_NODE_INDEX=0\nCIRCLE_WORKING_DIRECTORY=~/project\n'
  } >"$env"
  local on_pr=(-e CIRCLE_BRANCH=feat/checkout -e "CIRCLE_SHA1=$PR_SHA" -e "CIRCLE_PULL_REQUEST=https://github.com/acme/app/pull/$pr" -e "CIRCLE_PULL_REQUESTS=https://github.com/acme/app/pull/$pr")
  local on_main=(-e CIRCLE_BRANCH=main -e "CIRCLE_SHA1=$MAIN_SHA")

  # workflow sponson-preview, on a push to the PR's branch
  run_job circleci "$cfg" sponson-plan "$env" "${on_pr[@]}" -e CIRCLE_JOB=sponson-plan
  run_job circleci "$cfg" sponson-apply "$env" "${on_pr[@]}" -e CIRCLE_JOB=sponson-apply
  expect_log "circleci: sponson-apply stopped at the deploy barrier" "apply partial"
  run_job circleci "$cfg" sponson-finish "$env" "${on_pr[@]}" -e CIRCLE_JOB=sponson-finish
  expect_log "circleci: sponson-finish waited for the deploy and finished" "apply complete"
  check "circleci: preview resources exist (Neon branch, DATABASE_URL, Clerk redirect)" "$(neon_branch pr-$pr) && $(preview_env feat/checkout) && $(clerk_redirect)"
  detect_scope circleci cimg/node:lts "pr-$pr" "$PR_SHA" "${on_pr[@]}"
  detect_scope circleci cimg/node:lts main "$MAIN_SHA" "${on_main[@]}"
  # a tag build: CircleCI sets CIRCLE_TAG and no CIRCLE_BRANCH, and checks the commit out detached
  if tags_detected; then detect_scope circleci cimg/node:lts branch-v1.0.0 "$MAIN_SHA" -e CIRCLE_TAG=v1.0.0 -e "CIRCLE_SHA1=$MAIN_SHA"; fi

  # a push to main: sponson-preview's jobs halt (no pull request); sponson-production after the hold approval. Its
  # approver step reads CircleCI's API, answered by a stand-in (fakes.mjs) with the documented response shapes.
  run_job circleci "$cfg" sponson-plan "$env" "${on_main[@]}" -e CIRCLE_JOB=sponson-plan
  expect_log "circleci: on main (no pull request) the preview job halts" "halted by circleci-agent step halt"
  run_job circleci "$cfg" sponson-production "$env" "${on_main[@]}" -e CIRCLE_JOB=sponson-production --env-file "$WORK/production-secrets.env" \
    -e CIRCLE_TOKEN=circle_try -e SPONSON_TRY_CIRCLECI_API=http://registry:4873/_circleci
  expect_log "circleci: the approver read from CircleCI's API is recorded" "approved by alice"
  check "circleci: production variable exists" "$(production_env)"

  # workflow sponson-destroy: a pipeline on main with the PR's parameters, as the README's curl starts it
  run_job circleci "$cfg" sponson-destroy "$env" "${on_main[@]}" -e CIRCLE_JOB=sponson-destroy -- sponson-destroy-pr=$pr sponson-destroy-branch=feat/checkout
  check "circleci: preview resources destroyed, production kept" "!($(neon_branch pr-$pr)) && !($(preview_env feat/checkout)) && !($(clerk_redirect)) && $(production_env)"
  receipts_pushed "$ORIGIN" "preview/pr-$pr" production/main
}

try_bitbucket() {
  say "Bitbucket: integrations/bitbucket/bitbucket-pipelines.yml"
  make_repo "$WORK/bitbucket" integrations/bitbucket/bitbucket-pipelines.yml bitbucket-pipelines.yml
  start_fakes
  local cfg="$REPO/bitbucket-pipelines.yml" env="$WORK/bitbucket/ci.env" pr=13
  { cat "$WORK/tokens.env"; echo "SPONSON_GIT_TOKEN=bb_try"; receipts_rewrite "https://x-token-auth:bb_try@bitbucket.org/acme/app.git"
    printf 'CI=true\nBITBUCKET_REPO_FULL_NAME=acme/app\nBITBUCKET_WORKSPACE=acme\nBITBUCKET_REPO_SLUG=app\nBITBUCKET_CLONE_DIR=/opt/atlassian/pipelines/agent/build\nBITBUCKET_GIT_HTTP_ORIGIN=http://bitbucket.org/acme/app\n'
  } >"$env"
  local on_pr=(-e BITBUCKET_BUILD_NUMBER=1 -e BITBUCKET_BRANCH=feat/checkout -e "BITBUCKET_COMMIT=$PR_SHA" -e "BITBUCKET_PR_ID=$pr" -e BITBUCKET_PR_DESTINATION_BRANCH=main)
  local on_main=(-e BITBUCKET_BUILD_NUMBER=2 -e BITBUCKET_BRANCH=main -e "BITBUCKET_COMMIT=$MAIN_SHA")

  run_job bitbucket "$cfg" "pull-requests/**/0" "$env" "${on_pr[@]}"
  run_job bitbucket "$cfg" "pull-requests/**/1" "$env" "${on_pr[@]}"
  expect_log "bitbucket: sponson apply stopped at the deploy barrier" "apply partial"
  run_job bitbucket "$cfg" "pull-requests/**/2" "$env" "${on_pr[@]}"
  expect_log "bitbucket: sponson finish waited for the deploy and finished" "apply complete"
  check "bitbucket: preview resources exist (Neon branch, DATABASE_URL, Clerk redirect)" "$(neon_branch pr-$pr) && $(preview_env feat/checkout) && $(clerk_redirect)"
  detect_scope bitbucket node:22 "pr-$pr" "$PR_SHA" "${on_pr[@]}"
  detect_scope bitbucket node:22 main "$MAIN_SHA" "${on_main[@]}"
  # a tag pipeline: Pipelines sets BITBUCKET_TAG and no BITBUCKET_BRANCH, and checks the commit out detached
  if tags_detected; then detect_scope bitbucket node:22 branch-v1.0.0 "$MAIN_SHA" -e BITBUCKET_BUILD_NUMBER=3 -e BITBUCKET_TAG=v1.0.0 -e "BITBUCKET_COMMIT=$MAIN_SHA"; fi

  # branches: main, its automatic first step, then the manual production step: deployment variables, and who
  # started it
  run_job bitbucket "$cfg" "branches/main/0" "$env" "${on_main[@]}"
  run_job bitbucket "$cfg" "branches/main/1" "$env" "${on_main[@]}" --env-file "$WORK/production-secrets.env" \
    -e "BITBUCKET_STEP_TRIGGERER_UUID={0f1e2d3c-0000-4000-8000-000000000000}" -e BITBUCKET_DEPLOYMENT_ENVIRONMENT=production
  expect_log "bitbucket: the step's triggerer is recorded as the approver" "approved by \{0f1e2d3c-0000-4000-8000-000000000000\}"
  check "bitbucket: production variable exists" "$(production_env)"

  # custom: sponson-destroy, run on main with the PR's id and branch (the README's Run pipeline)
  run_job bitbucket "$cfg" "custom/sponson-destroy/0" "$env" "${on_main[@]}" -e "SPONSON_PR_ID=$pr" -e SPONSON_PR_BRANCH=feat/checkout
  check "bitbucket: preview resources destroyed, production kept" "!($(neon_branch pr-$pr)) && !($(preview_env feat/checkout)) && !($(clerk_redirect)) && $(production_env)"
  receipts_pushed "$ORIGIN" "preview/pr-$pr" production/main
}

# ---------------------------------------------------------------------------------------------------------------
# GitLab: gitlab-ci-local runs the template itself (rules, stages, extends, environments, scoped variables) in Docker.

# gitlab-ci-local wants to be started in the project (its --cwd takes relative paths only).
gcl_in_repo() { (cd "$REPO" && npx -y "$GITLAB_CI_LOCAL" "$@"); }

try_gitlab() {
  say "GitLab: integrations/gitlab/gitlab-ci.yml with $GITLAB_CI_LOCAL"
  make_repo "$WORK/gitlab" integrations/gitlab/gitlab-ci.yml .gitlab-ci.yml
  # gitlab-ci-local derives CI_SERVER_* and CI_PROJECT_PATH from the origin remote, as GitLab knows them.
  git -C "$REPO" remote add origin https://gitlab.example.com/acme/app.git
  start_fakes
  local iid=11 vars="$WORK/gitlab/variables.yml"
  # Project CI/CD variables: the preview tokens scoped to review/*, the production ones (and the secret) to production.
  {
    echo "SPONSON_GITLAB_TOKEN: glpat-try"
    while IFS='=' read -r k v; do printf '%s:\n  values:\n    "review/*": %s\n    "production": %s\n' "$k" "$v" "$v"; done <"$WORK/tokens.env"
    while IFS='=' read -r k v; do printf '%s:\n  values:\n    "production": %s\n' "$k" "$v"; done <"$WORK/production-secrets.env"
    while IFS='=' read -r k v; do printf '%s: "%s"\n' "$k" "$v"; done < <(cat "$WORK/emulation.env"; receipts_rewrite "https://oauth2:glpat-try@gitlab.example.com:443/acme/app.git")
  } >"$vars"
  local gcl=(gcl_in_repo --variables-file "$vars" --network "$NET" --volume "$WORK/gitlab/origin.git:/origin.git"
    --pull-policy if-not-present --no-artifacts-to-source --timestamps)
  # A merge request pipeline (not merged results): GitLab sets these and leaves CI_COMMIT_BRANCH unset.
  local mr=(--variable CI_PIPELINE_SOURCE=merge_request_event --variable "CI_MERGE_REQUEST_IID=$iid" --variable CI_MERGE_REQUEST_ID=9$iid
    --variable CI_MERGE_REQUEST_SOURCE_BRANCH_NAME=feat/checkout --variable CI_MERGE_REQUEST_SOURCE_BRANCH_SHA=
    --variable CI_MERGE_REQUEST_TARGET_BRANCH_NAME=main --variable "CI_MERGE_REQUEST_DIFF_BASE_SHA=$MAIN_SHA"
    --variable CI_MERGE_REQUEST_EVENT_TYPE=detached --unset-variable CI_COMMIT_BRANCH)

  git -C "$REPO" checkout -q feat/checkout
  say "gitlab: merge request pipeline !$iid"
  LOG="$WORK/gitlab/mr-pipeline.log"
  "${gcl[@]}" "${mr[@]}" 2>&1 | tee "$LOG" || fail "gitlab: merge request pipeline failed"
  pass "gitlab: merge request pipeline (sponson:plan, sponson:apply, sponson:finish)"
  expect_log "gitlab: sponson:apply stopped at the deploy barrier" "sponson:apply.*apply partial"
  expect_log "gitlab: sponson:finish waited for the deploy and finished" "sponson:finish.*apply complete"
  check "gitlab: preview resources exist (Neon branch, DATABASE_URL, Clerk redirect)" "$(neon_branch pr-$iid) && $(preview_env feat/checkout) && $(clerk_redirect)"

  # Detection: a job beside the template's (it includes the template and extends its .sponson-mr) runs the plan
  # command without --pr/--branch/--sha, with the variables gitlab-ci-local sets for the merge request pipeline.
  sed "s/@VERSION/@$VERSION/" >"$REPO/.gitlab-ci-detect.yml" <<'YAML'
include:
  - local: .gitlab-ci.yml
sponson:detect:
  extends: .sponson-mr
  stage: sponson-plan
  environment: { name: review/mr-$CI_MERGE_REQUEST_IID, action: prepare }
  script:
    - npx -y sponson@VERSION plan --env preview --json > /tmp/plan.json || true
    - |
      node -e 'console.log("detected scope: " + JSON.parse(require("fs").readFileSync("/tmp/plan.json", "utf8")).scope)'
YAML
  LOG="$WORK/gitlab/detect.log"
  "${gcl[@]}" "${mr[@]}" --file .gitlab-ci-detect.yml sponson:detect 2>&1 | tee "$LOG" || fail "gitlab: detection job failed"
  expect_log "gitlab: without --pr/--branch/--sha, the merge request pipeline's variables give scope pr-$iid" "sponson:detect +> detected scope: pr-$iid"

  git -C "$REPO" checkout -q main
  say "gitlab: pipeline on the default branch, starting the manual sponson:production"
  LOG="$WORK/gitlab/main-pipeline.log"
  "${gcl[@]}" --variable CI_PIPELINE_SOURCE=push --variable GITLAB_USER_LOGIN=alice --manual sponson:production 2>&1 | tee "$LOG" || fail "gitlab: default branch pipeline failed"
  pass "gitlab: default branch pipeline (sponson:production, manual)"
  expect_log "gitlab: the manual job's starter is recorded as the approver" "approved by alice"
  check "gitlab: production variable exists" "$(production_env)"

  # GitLab runs the on_stop job when the MR is merged or closed, on the MR's ref.
  git -C "$REPO" checkout -q feat/checkout
  say "gitlab: stopping review/mr-$iid (its on_stop job, sponson:destroy)"
  "${gcl[@]}" "${mr[@]}" sponson:destroy || fail "gitlab: sponson:destroy failed"
  pass "gitlab: sponson:destroy (the environment's on_stop job)"
  check "gitlab: preview resources destroyed, production kept" "!($(neon_branch pr-$iid)) && !($(preview_env feat/checkout)) && !($(clerk_redirect)) && $(production_env)"
  receipts_pushed "$ORIGIN" "preview/pr-$iid" production/main
}

for ci in "${CIS[@]}"; do "try_$ci"; done

say "summary ($UNDER_TEST)"
printf '  %s\n' "${SUMMARY[@]}"
