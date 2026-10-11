# @sponson/core

## 0.5.0

### Minor Changes

- 499907c: **Breaking:** a `launchdarkly` provider block that names a production environment now needs `--approved-by`, even
  under `--env preview`: `production: true` in the block, or, without that key, an `environment` key containing `prod`
  in any case. If such a key is not production (`preprod`), add `production: false` to the block before the next apply.
  
  The approval gate sees the provider block: `OpSpec.writesEnvironment(params, ctx, provider)` gets the line's provider
  block as a third argument (optional for callers, so existing adapters and callers keep working). The generic `http`
  adapter takes `production: true` on an API block, making every line through that API need approval.
- 77006c1: Add the generic `http` adapter: manage any JSON (or form-encoded) REST API from the plan, without TypeScript. `http.resource` keeps one object per item (a feature flag, a webhook endpoint), located by a path or by a list and the fields that identify it; `http.list_item` keeps one entry in an array, a delimited string or a keyed map on a parent object (an allowed origin, a redirect allow-list entry, a config var) by read-modify-write with re-read verification. Each API is a block under `providers.http.<api>` that names its credential's environment variable (bearer, custom header or Basic). Intents, idempotent apply, drift by hash, destroy of only what Sponson created and secret redaction work as for every other adapter. See ADR 0017 and docs/plan-format.md. `OpSpec` gains two optional hooks, `providerFor` and `outputsFor`; the HTTP client takes static headers, form encoding and a content type; the sim gains a generic REST provider (`rest`).
- c3a65ba: One-off actions (ADR 0022): a new `http.action` op sends one request (or GraphQL request) when its declared `trigger` changes, for side effects with nothing to read back or delete (an Inngest sync, a cache purge, a deploy notification). `plan` shows the new status `run` (symbol `>`) until the current trigger has run in the scope, then `unchanged`; `apply` sends it, checks the answer (status, `ok_status`, `expect`), and records the trigger hash, its outputs and its optional `undo`, which `apply --destroy` sends. Delivery is at least once (nothing is recorded before the request is sent; `request.idempotency_key: true` derives an `Idempotency-Key` from the ledger key and the trigger hash), and rollback never undoes an action. A request may go to an absolute `url` (the app's own endpoint), which never receives an API credential. The engine gained the optional `OpSpec.action` hook, `ActionTrigger`, `LedgerEntry.action`, and `run` in `PlanLineStatus` and `DiffKind`. The REST sim gained logged endpoints (`endpoints`, `calls`; assumption R9).
- 4bd1595: The generic `http` adapter authenticates with a header credential behind a literal `prefix` (`Authorization: Api-Key <key>`), several credential headers at once (`auth: { headers: [...] }`), an OAuth2 client-credentials token (`auth: { oauth2_client_credentials }`: Auth0, Kinde, Okta custom servers), a token a CLI prints (`auth: { command: [gcloud, auth, print-access-token] }`), AWS SigV4 (`auth: { aws_sigv4 }`) and HTTP Digest (`auth: { digest }`: MongoDB Atlas), speaks XML (`encoding: xml`, S3 bucket CORS) and GraphQL (`{ graphql: { query, variables, data_path } }` in place of any request of `http.resource`: Railway variables, Fly.io secrets). Tokens obtained at run time are registered with the redactor through the new optional `AdapterContext.secret`. `http.list_item` gains `parent.if_missing`, `parent.when_empty`, `send: collection`, and API blocks a versioned `media_type`. The sim checks each scheme for real (an OAuth2 token endpoint, Digest challenges, SigV4 verification) and adds `aws`, `railway` and `fly` providers.
- 67f0615: `http` lines may take their credential from another line: `credential: { from: <line>.<output> }` (a sensitive output that is not once-only) or `credential: { secret: … }` replaces the API block's variable for that line, never part of its identity; the line must say `destroy: keep`. The engine checks such params before any request through the new optional `OpSpec.credentialInputs` hook (a literal, a non-sensitive or a once-only output is `PARAM_INVALID`). A `POST` delete's body may name the object with `{id}` (Datadog's `{ public_ids: ["{id}"] }`), and `http.list_item` over XML reads a lone element as a list of one where the item declares a list. The REST sim gained stored generated fields with a header that accepts them, and bulk deletes by body.
- aebda52: Added manual steps (ADR 0021) for state no API can manage, such as a Google OAuth client's redirect URIs. A
  `manual.step` line (`title`, `instructions`, optional `undo`, `vars` and a `verify` GET) is shown by `plan` as `todo`
  with its instructions filled in. `apply` leaves it and the lines that depend on it waiting, applies everything else,
  and exits 2 with the new code `MANUAL_STEP_PENDING` and the steps' instructions in `manual`, until a person runs
  `apply --confirm <line>` (or its verify request sees it done); the ledger records who confirmed it (`--approved-by`,
  else the git user) and when. A verified step that stops verifying is `missing` drift. `apply --destroy` shows the
  step's `undo` and waits for the same confirmation. The MCP `sponson_apply` tool takes `confirm`; agents never pass
  it on their own. For adapter authors: `OpSpec.manual`, `PlanLineStatus` `todo`, and `RunOptions.confirm` /
  `confirmedBy`.
- Once-only outputs are now kept only when proven: the ledger records a keyed fingerprint (never the value) of each `once` output on the producer and of the value each dependent was written with, and a later run keeps a dependent as `{ keep: true }` only when they match. A dependent added later, one whose producer was adopted, one edited outside Sponson, or one that must be created again is refused with `OUTPUT_UNAVAILABLE`. New `sponson apply --recreate <line>` (and `recreate` on the MCP apply tool, `RunOptions.recreate`) deletes what that line created and creates it again in the same run, so the new value reaches every dependent. See ADR 0018.
- e303004: Ops can declare an output `once: true`: the provider reveals it only when the resource is created (a database password). It reaches dependent lines in that run. In later runs a reference to it resolves to `{ keep: true }`, so a dependent that holds the value stays unchanged and a re-apply writes nothing. A dependent that would need the value again is refused with the new error code `OUTPUT_UNAVAILABLE` before anything is written. Adapters can also declare a second credential variable with `about.extraCredentialEnv`. The in-memory test adapter (`@sponson/core/testing`) has a new once-only output, `token`, and treats `{ keep: true }` values as the marker contract says. See ADR 0018.
- b645c29: Added locks on shared parent objects (ADR 0019). An op whose items live in one list on a shared provider object (an
  Auth0 application's callback URLs, Supabase's `uri_allow_list`) declares it with `OpSpec.lockOn`; apply, rollback
  and destroy then write it holding a lease on that object in the receipts store (a lock-only branch
  `sponson-receipts/_locks/<hash>`), so concurrent pull requests and environments never lose each other's items. A held
  lock fails the line with `LOCK_HELD`, or is waited for with `--wait`. `ReceiptStore` gains optional parent-lock
  methods, implemented by both built-in stores; custom stores get them from their scope-lock methods.

### Patch Changes

- The git-branch store's temporary working clone is removed with retries and never fails a finished command; git runs without automatic gc or maintenance, whose background writes raced the removal (`ENOTEMPTY` after a successful apply).
- d9ab332: Published with npm provenance: each package's `publishConfig` now asks for it. 0.4.0 went out without attestations because `changeset publish` runs `pnpm publish`, which ignores the release workflow's `NPM_CONFIG_PROVENANCE`.

## 0.4.0

### Patch Changes

- b028881: Internal: drift judgement in `inspectLine` and ownership in apply's ledger update are named steps (`judge`, `created`/`stillOurs`); behaviour is unchanged. Lint now caps cyclomatic complexity at 20.
- eec4766: Internal: the git receipt store's plumbing (working clone, git invocations, push outcomes) moved to `receipts/git-workdir.ts`; the store keeps locks, fencing, retries and migration. Behaviour is unchanged.
- 9b6c97a: Internal: scope drift, destroy, receipt parsing and listing, `init`'s plan editing, the sims' chaos selection and request handling are split into named steps; behaviour is unchanged. Lint caps cyclomatic complexity at 15.
- 53e7446: npm metadata: every package has keywords and its homepage is the documentation site (https://sponson.mintlify.site); the package READMEs link to it, and the CLI's README states the Node.js 22 requirement its `engines` already declared.

## 0.3.0

### Minor Changes

- 0434a9e: Context detection (`detectCtx`, GitHub Actions and local git/`gh`) moved from `@sponson/core` to `sponson` behind a `CtxSource` seam (breaking for direct users of `@sponson/core`). A lease holder whose renewals stall now stops itself before its lease could be taken over. `ReceiptStore.close()` lets long-running hosts release temporary git clones. Adapters gain `adopt()`; the plan format has a JSON Schema. Adapters declare `about` (credential and base-URL variables) and secret sources declare `form`/`resolvedBy`, read by the generated docs (ADR 0015). Secret-source errors no longer repeat the reference, and a missing CLI is reported as such. `aws-sm://` resolves secrets from AWS Secrets Manager. `pnpm sim` prints a paste-ready environment block.
- 7fc20cf: The `git-branch` receipt store now keeps each environment and scope on its own orphan branch, `sponson-receipts/<env>/<scope>`, instead of one shared `sponson/receipts` branch, so pull requests applying at the same time no longer race each other for one ref (and no longer run out of the store budget with `STORE_CONTENDED` under load). Migration is automatic: a scope without its own branch is read from `sponson/receipts`, its first write moves it to its own branch, and `sponson/receipts` is never written again; delete it once every scope has run. Workflow or branch-protection filters that named `sponson/receipts` should use `sponson-receipts/**`. **Breaking** (library only): `GitBranchStoreOptions.branch` is replaced by `refPrefix` and `legacyBranch`.

### Patch Changes

- 1533787: Fixes from an independent review: a live lock an older Sponson holds on the legacy receipts branch is respected during migration (no concurrent apply, no lost receipt); the final receipt is written whenever the store's fencing allows it, even if lease renewals lagged; `list()` no longer drops scopes whose names differ only by case on macOS/Windows; Vercel `target: development` variables never trigger or wait on a deployment. The git store's own working clone is created with `mkdtemp` (owner-only, unpredictable name). A lock that cannot be released is retried and then reported in the run's warnings instead of being left behind silently.
