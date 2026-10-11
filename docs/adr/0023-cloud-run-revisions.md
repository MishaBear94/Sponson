# 23. Cloud Run revisions: `cloud_run.revision`

Date: 2026-10-11

## Status

Proposed. Amends [ADR 0020](0020-recipes.md) (Amendment 5's Google Cloud Run decision): the `cloud_run.traffic_tag`
recipe is removed.

## Context

The last uncovered row of [docs/coverage.yaml](../coverage.yaml), `cloud-run-tag`, asks for what
`gcloud run deploy --no-traffic --tag pr-42 --update-env-vars …` does: a revision of a service per pull request, with
that pull request's image and variables, reachable at its own URL and serving no traffic. ADR 0020 shipped the tag
alone as a recipe (`cloud_run.traffic_tag`, read-modify-write of the service's `traffic`) and left the row uncovered,
because the revision and its variables were made by a deploy Sponson did not perform. [`vercel.deploy`](../plan-format.md#verceldeploy)
has since shown that starting a deploy is a side effect a plan may own.

A revision is not something a request template can make. Cloud Run's revisions are immutable and made by changing
the service's whole `template` (assumption CR4 in `packages/sim/src/routes/cloud_run.ts`), so a new one must start
from the template the service has; the patch answers a long-running operation that must be polled (CR9); and a
template change alone moves the share of traffic on LATEST to the new revision (CR5), so the patch must also pin it.

## Decision

- **A first-class adapter, `cloud_run`, with one op, `revision`.** Given a service (`providers.cloud_run.project` and
  `.region`, param `service`), an `image` and `env` (literals, `{ from }`, `{ secret }`), it makes a revision from the
  service's current template with that image and those variables, named `<service>-<tag>-<hash of the contents>`,
  and puts the tag (default: the scope, `pr-42`) on it with no traffic share. Two patches, each with an `updateMask`
  and the service's `etag` and each waited for: the template (with every LATEST target bound to the revision it
  serves, as gcloud's `--no-traffic` does), then `traffic` with the tag moved onto the revision. Its outputs are the
  revision's name and the tag's URL exactly as `trafficStatuses[].uri` answers it; the URL is never built (CR6).
- **No traffic is moved, so a line writes no environment** (`writesEnvironment` null) unless its provider block says
  `production: true`, the way an `http` API block does: then every run with the line needs approval.
- **Destroy removes the tag only.** The revision is left: Cloud Run deletes non-addressable revisions past its
  per-service limit by itself (CR12), and a revision cannot be deleted while it may receive traffic.
- **Drift** is the tagged revision's image and the values of the variables the line declares. Revisions being
  immutable, a console edit is a redeploy under the tag (`changed`); a removed tag is `missing`. Reconciling finds the
  plan's revision again by its name and moves the tag back; nothing is made twice.
- **One way for one job.** The `cloud_run.traffic_tag` recipe is removed: the op makes the revision and the tag, and
  a recipe tagging a revision someone else deployed would be a second, weaker way to cover the same row.
- **The credential is gcloud's token, through the shared machinery.** The adapter's requests go through the generic
  adapter's client with a fixed `command` credential (`gcloud auth print-access-token`, CR1), so the token is fetched
  once per run, re-fetched after a 401 and masked like any secret. `AdapterAbout` gains an optional
  `credentialCommand` so the generated docs and `sponson init` say which command, rather than naming an environment
  variable that does not exist.

## Consequences

- The `cloud-run-tag` row is covered, and with it every row of the coverage matrix that is not manual.
- A service whose traffic was on LATEST has it pinned to the revision that served it, as after any
  `gcloud run deploy --no-traffic`: later production deploys do not receive traffic until it is sent to them
  (`gcloud run services update-traffic --to-latest`, or `gcloud run deploy` followed by it). docs/plan-format.md says
  so.
- The service's template is left as the preview revision's, as after any `gcloud run deploy --tag`: a production
  deploy that sets only some variables (`--update-env-vars`) inherits the preview's others. Production deploys should
  set every variable (`--set-env-vars`, or `gcloud run services replace`).
- **Breaking** for lines that used `recipe: cloud_run.traffic_tag`: destroy their scopes (or remove the tags by hand)
  before upgrading, then use `cloud_run.revision`.
- The etag precondition (CR8) and the operation ending when the revision is ready (CR9) are not documented; the
  adapter retries a refused patch after reading the service again, and waits for the revision's `Ready` condition
  as well. `scenarios/contract.test.ts` pins both for a live run.
