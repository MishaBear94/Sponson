# 17. A generic, declarative `http` adapter

Date: 2026-10-11

## Status

Proposed

## Context

Sponson ships first-class adapters for a few providers, each a TypeScript file with its own sim routes, scenarios
and docs. What ships beside the code of a typical web product is much wider: feature flags, webhook endpoints,
auth redirect and CORS allow-lists, per-environment config vars, DNS records, sending domains. A coverage survey of
Western SaaS found dozens of such rows; most are plain CRUD on one object, or one entry in a list held by a parent
object. Writing an adapter per provider can never cover that long tail, and every row left uncovered is a console
step someone has to remember for every pull request.

The engine's guarantees must not weaken on the way: intents before creates
([ADR 0005](0005-receipts-are-a-ledger-with-write-ahead-intents.md)), idempotent apply, drift by hash
([ADR 0006](0006-drift-kinds-and-refusing-changed-values.md)), destroy only what Sponson created, secrets as
references that never reach output ([ADR 0014](0014-secrets-are-references.md)), and markers that never reach
`apply`. The plan stays YAML ([ADR 0001](0001-plan-file-is-yaml-not-a-dsl.md)): no expressions, no scripts.

Two things in the adapter contract stood in the way of a generic adapter:

- **Identity.** A ledger entry's identity is adapter + the whole `providers.<adapter>` block + key. A generic adapter
  needs one configuration per API, and if they all lived in one block, adding a second API would re-identify every
  resource of the first.
- **Outputs.** `OpSpec.outputs` is static, and `from:` references are checked against it before any provider call.
  A generic object's outputs (a webhook's signing secret, a flag's key) are named by the plan line.

## Decision

A built-in adapter `http` with two ops, configured entirely in the plan, built with the stable authoring API
(`clientFor`, `requireEnv`, `paramError`, `desiredSide`, `assertNoPending`, `listAll`, `isProviderError`).

### The provider block: one per API

```yaml
providers:
  http:
    statsig:
      base_url: https://statsigapi.net/console/v1
      auth: { header: STATSIG-API-KEY, value_env: STATSIG_CONSOLE_KEY }
    stripe:
      base_url: https://api.stripe.com/v1
      auth: { bearer_env: STRIPE_SECRET_KEY }
      encoding: form
```

- `auth` is `{ bearer_env }`, `{ header, value_env }` or `{ basic: { user_env, password_env } }`: always variable
  names, never values. The credential's name must end like the names the engine already masks (`TOKEN`, `SECRET`,
  `_KEY`, …), so its value is masked in every output whatever the adapter does; the adapter masks it (and a Basic
  credential's encoded form) in its own error text too.
- Optional `base_url_env` (an override, as every built-in adapter has), static `headers`, `encoding: json | form`.

### Two engine hooks, both optional on `OpSpec`

- `providerFor(block, params)`: the part of `providers.<adapter>` a line uses. The engine uses it for
  `actx.provider` and for ledger identity, so `providers.http.<api>` is each API's own identity, and `destroy`
  finds its base URL and credential variable in the ledger as for any adapter. An unknown API is `PLAN_INVALID`
  before any request.
- `outputsFor(params)`: the outputs one line declares. The engine specialises the op per line in `prepare`, so a
  `from:` naming an undeclared output is still `REF_OUTPUT_UNKNOWN` before any request.

Adapters that do not define them behave exactly as before.

### Op `resource`: one object per item

```yaml
- id: flag
  adapter: http
  op: resource
  api: statsig
  find: { path: /gates, list_path: /data, match: { name: "checkout-${ctx.scope}" } }
  read: { path: "/gates/{id}" }
  create: { path: /gates }
  update: { method: PATCH }
  item_path: /data
  fields: { description: New checkout for this preview, isEnabled: true }
```

- Located by `find` (a list, the array in it, the fields that identify the object) or by a `read` path that names
  it (a client-chosen id). `find` runs in `read`, before every create, so a create whose answer was lost is found
  and claimed instead of duplicated; `create.idempotency_key: true` adds an `Idempotency-Key` (derived from the
  resource key, the commit and the body) and makes the create safe to retry within the run.
- Key: `<find.path>[<field>=<value>,…]`, or the read path: every dimension that tells two objects apart, the base
  URL being in the provider block. Record id: the request that removes it (`DELETE /gates/<id>`), so destroy needs
  nothing but the ledger, and a re-created object shows as replaced.
- Hash: `sha256(canonicalJson)` of the declared `fields` only, compared in the same form by `diff`. Undeclared
  fields are not Sponson's. `{ keep: true }` takes the live value. A difference with no `update` declared is
  `PARAM_INVALID` at plan time.
- `exists_status` / `gone_status` add a provider's own statuses for "already exists" and "gone"; `destroy: keep`
  leaves the object in place.

### Op `list_item`: one entry in a collection on a parent

```yaml
- id: origin
  adapter: http
  op: list_item
  api: auth0
  parent: { path: "/clients/{client}" }
  vars: { client: abc123 }
  list_path: /web_origins
  item: { from: web.preview_url }
```

- The collection is a JSON array (`shape: array`, items are values or maps identified by `key_field`), a delimited
  string (`shape: delimited`, a comma-separated allow-list), or a keyed map (`shape: map`, `item` is the name and
  `value` the value; written as a merge patch where `null` deletes, as config-var APIs do).
- Read-modify-write: read the parent, change only this item, write the collection (alone, or with
  `send: parent` the whole object back), then read again; the write counts only once the item is seen as planned,
  and is retried up to three times if a concurrent writer dropped it. Writes are sent as idempotent (`PUT`, or
  `PATCH`/`POST` with `idempotent: true`), since they set state, so a dropped connection is retried.
- Key: `<parent.path>#<list_path>=<item>`. The record id is the item's locator (paths, method, shape, item), so
  destroy removes exactly that item and nothing else. Every other item is left as it is and reported as
  `unmanaged` (`listScope`).

### Invariants, and where each is kept

| Invariant | How |
|---|---|
| Intents before creates | `actx.intend([key])` right before a create request or before adding an item; `created` lists only keys this call created. |
| Idempotent apply | `apply` compares the declared state with the live one first and returns without a request when they agree. |
| Drift by hash | One hash per resource over the declared state in canonical JSON; `diff` uses the same form. |
| Destroy only what Sponson created | Destroy works from ledger records (the engine skips adopted ones); a list item's destroy removes that item only; 404 (or `gone_status`) is success. |
| Secrets as references | Credentials are variable names; secret values travel in params only during `apply`; hashes, never values, reach records; sensitive outputs are declared so. |
| Markers never reach apply | `assertNoPending` at the top of `apply`; `read` returns null and `diff` shows `pending` while a key depends on a pending value. |

## What it deliberately does not do

- **No preconditions** (ETag / `If-Match`, version fields) for list writes, and no per-parent lock across scopes.
  The re-read narrows the window and reports what it sees; it cannot close it. Two scopes editing one parent at the
  same moment can still lose a write (ROADMAP, the shared-parent item).
- **No polling**: an object that becomes ready asynchronously, or whose output appears later, needs a first-class
  adapter.
- **Create-only outputs** (a Stripe webhook signing secret) are returned by the run that creates the object and
  reach dependent lines in that run, but a later run cannot read them again. There is no declaration that makes the
  engine refuse such a later run.
- ~~No OAuth2 client-credentials exchange, no command-produced tokens, no request signing (SigV4).~~ Added by the
  [amendment](#amendment-run-time-credentials-xml-and-graphql) below, with HTTP Digest.
- **No expressions or scripts**, no JSON Patch generation, no pagination by page number or `Link` header (only a
  cursor read from the body), no `listScope` for `resource` (a collection holds much that is not this release's)
  and no `adopt`. (GraphQL requests were added by the amendment.)

## Alternatives considered

- **JavaScript plugins only** (`SPONSON_PLUGINS`). Already possible, and still the answer for anything with a real
  lifecycle. But it asks every team to write, test and version TypeScript for what is one request each way, and an
  agent editing a plan cannot add a row without leaving the plan. The declarative adapter covers the CRUD rows; the
  plugin path stays for the rest.
- **OpenAPI-driven adapters** (point at a provider's spec, pick an operation). Many providers publish no spec or an
  incomplete one; specs do not say which fields identify an object, which are write-only, or what "already exists"
  looks like, so the plan would need the same declarations anyway, plus a spec loader and its failure modes.
- **An exec/script adapter** (run a command per step). It would make any side effect possible and none of the
  invariants checkable: no idempotency, no hash the engine understands, secrets in process arguments and logs, and
  a dependency on whatever is installed on the runner.
- **One `providers.http` block for all APIs without `providerFor`.** Adding or editing one API would re-identify
  every resource of every other API; rejected for the identity reason above.

## Consequences

- A plan can manage a webhook, a flag or an allow-list entry of any JSON REST API without code, with the same
  receipts, drift and destroy as the built-in adapters.
- `OpSpec` gained two optional hooks (`providerFor`, `outputsFor`). Third-party adapters may use them; nothing
  requires them.
- Editing an API's block (base URL, credential variable, headers, encoding) re-identifies its resources, as moving a
  line to another project would; destroy the scope first, or expect the old entries to become orphans.
- The record id encodes how an object is removed; changing `delete` (or a list item's parent request) for an
  applied line looks like a replacement and needs `--reconcile`, which then treats the resource as adopted.
- The sim gained a generic REST provider (`packages/sim/src/routes/rest.ts`): collections, parents with lists,
  form bodies, merge patch, header credentials; its assumptions describe a conventional REST API, not one provider.
  The plan line remains the only description of a real API, so a wrong line is found by `sponson plan` against the
  real provider, not by the sim.
- `destroy: keep` is an explicit, per-line exception to "after a destroy nothing Sponson created survives".

## Amendment: run-time credentials, XML and GraphQL

Date: 2026-10-11

### Context

The [coverage survey](../coverage.md) left about twenty rows the generic adapter could express as requests but not
authenticate or encode: Auth0, Kinde and Okta take an OAuth2 client-credentials token; Google Cloud (Firebase
authorized domains, GCS CORS) and Azure take a token their CLI prints; AWS (S3 bucket CORS, Amplify branch
variables) signs every request with SigV4, and S3 speaks XML; MongoDB Atlas API keys use HTTP Digest; Railway and
Fly.io manage variables and secrets through GraphQL. Each would otherwise need a first-class adapter for one
credential flow, or a plugin.

### Decision

**Four more `auth` forms**, each still a set of environment variable NAMES (or a literal command), so the API block
(the ledger identity) holds nothing secret:

| Form | At run time |
|---|---|
| `oauth2_client_credentials: { token_url, client_id_env, client_secret_env, audience?, scope?, extra?, auth_method?, token_url_env? }` | RFC 6749 §4.4 against the token endpoint (`client_secret_post` or `client_secret_basic`); the access token sent as a bearer token. |
| `command: [argv…]` | The CLI run without a shell through the same injectable `Exec` as the CLI-backed secret sources; its trimmed stdout is the bearer token. An argument that is (or holds) a reference is refused: nothing is expanded. |
| `aws_sigv4: { region, service, access_key_id_env, secret_access_key_env, session_token_env? }` | Every request signed (header form, payload hash signed); S3 bodies also get `Content-MD5`. No AWS SDK: a signer of ~150 lines checked against AWS's published test vectors. |
| `digest: { user_env, password_env }` | RFC 7616, MD5 or SHA-256 (and `-sess`), `qop=auth`; the 401's challenge is answered, then reused with the next nonce count. |

The HTTP client (`apiClient`, stable authoring API) gained an optional `RequestSigner`: asked for each request's
headers (every attempt, so a signature or token is fresh), and told about a 401, after which the request is sent
once more. A 401 means nothing happened, so resending is safe for any method.

**Tokens are secrets from the moment they exist.** `AdapterContext` gained an optional `secret(value)`, which the
engine implements by registering the value with the run's `Redactor`; the adapter calls it before the token is first
sent, and masks every token it obtained in its own error text as well (for engines without the hook). Tokens live in
memory only, one per run and API block (a cache keyed by the run's `ctx`, the block and a hash of the credential's
inputs), are refreshed shortly before they expire (OAuth2 `expires_in`; five minutes for a command) and once after
a 401.

**`encoding: xml`**, with a minimal codec (xml.ts): elements to maps, repeated elements to lists, text to strings,
attributes as `@name`. No DTDs or entities beyond the predefined ones (no XXE, no expansion). Where `list_item`
expects a list in an XML document, a lone element is a list of one. Two `list_item` parent options make S3 CORS
expressible, and are not S3-specific: `if_missing: empty` (a 404 parent is an empty collection) and
`when_empty: delete` (an API that refuses an empty collection has it removed instead). `send: collection` and
`body_list_path` cover APIs that replace a map they are sent, read from one place and written to another (Amplify
`UpdateBranch`). A versioned JSON media type (`media_type`) covers Atlas.

**GraphQL as a request kind of `http.resource`**: any of `find`, `read`, `create`, `update`, `delete` may be
`{ graphql: { query, variables, data_path, idempotent } }`, a POST to the API's `base_url`; `errors[]` are classified
into the same `PROVIDER_*` codes as HTTP statuses. The key of a GraphQL-located object is its root field, its
variables and its data path (not the query text); the record id is the delete mutation with its variables, so
destroy still needs only the ledger. `{ secret }` is refused in the variables of the requests that become the key or
the record id. A scalar answer is read as `{ value }`, so Railway's variable map can be compared field by field.

### Invariants

| Invariant | How it is kept |
|---|---|
| Credentials only from environment variable NAMES | The forms take names (`*_env`, ending like the names the engine masks); a command takes literal arguments only. |
| No credential or token in output, receipts or errors (I1) | Engine-masked variables; obtained tokens registered through `actx.secret` before first use and masked locally too; GraphQL error names never include mutation variables; scenarios assert I1 with every issued token listed. |
| Identity holds no secret | The block is names and URLs; token caches are keyed by a hash, in memory. |
| `plan` writes nothing (I4) | Token requests and GraphQL queries are POSTs that change nothing: the sims leave them out of the write log (`ProviderSim.isWrite`), and a scenario per form checks it. |
| Idempotent apply, drift by hash, destroy only what Sponson created | Unchanged: the new forms change how a request is authenticated or encoded, not what is sent or compared. |

### Testing

The sims check each scheme for real, server side, with code written from the specifications independently of the
client (the sim depends on nothing in the repo): the REST sim's `auth` seed adds an OAuth2 token endpoint (expiry,
revocation), fixed bearer tokens (a command's), Digest challenges and SigV4 verification; an `aws` sim verifies SigV4
for S3 CORS (XML, `Content-MD5`, `NoSuchCORSConfiguration`, `MalformedXML`) and Amplify branches; `railway` and `fly`
sims answer the operations those providers' official clients send. Both the client signer and the sim's verifier are
pinned to AWS's published vectors, and the Digest code to RFC 7616's worked example, so a wrong signer fails against
the sim instead of being mirrored by it.

### Not done

- `private_key_jwt` client authentication (Okta's own management API requires it), the OAuth2 device or
  authorization-code flows, AWS profiles, instance roles and SSO (only keys from variables), SigV4a, presigned URLs,
  chunked uploads, Digest `auth-int`.
- GraphQL subscriptions, pagination of a GraphQL `find`, and filling mutation variables from `fields` (values are
  written in both places).
- A secret whose value the API never returns (Fly.io) is not compared, so a changed value is not detected.
- The examples for Auth0, Kinde, Okta, Google, Azure, AWS, Atlas, Railway and Fly.io are checked against sims built
  from those providers' documentation and official clients, not against the live APIs (docs/api-verification.md).

### Consequences

- `ApiClientOptions.signer` / `accept` and `encoding: "xml"`, the `RequestSigner` and `SignableRequest` types, and
  `AdapterContext.secret` are new optional parts of the authoring API; nothing existing changes meaning.
- `ProviderSim.authorized` receives the request (for signatures) and the provider's state, and may answer with a
  `Reply` (a challenge); `ProviderSim.isWrite` lets a sim keep non-mutating POSTs out of the write log.
