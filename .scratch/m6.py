import re
pat=re.compile(r"<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> main\n", re.S)
def resolve(p, choices):
    s=open(p).read(); n=0
    def sub(m):
        nonlocal n
        c=choices[n]; n+=1
        if c=="ours": return m.group(1)
        if c=="theirs": return m.group(2)
        return c
    s=pat.sub(sub,s)
    assert n==len(choices),(p,n)
    assert "<<<<<<<" not in s, p
    open(p,'w').write(s)
def edit(p, pairs):
    s=open(p).read()
    for a,b in pairs:
        assert s.count(a)==1,(p,a)
        s=s.replace(a,b)
    open(p,'w').write(s)

resolve('packages/adapters/src/http-adapter-client.ts', [
'''import { SponsonError, canonicalJson, type AdapterContext, type Literal, type OpSpec } from "@sponson/core";
import { clientFor, optionalEnv } from "./common.js";
''',
'''/** The dependencies an op was built with, by the adapter context each of its calls received (see `withDeps`). */
const DEPS = new WeakMap<AdapterContext, AuthDeps>();

/**
 * `op` with every call's adapter context carrying `deps` (how `auth.command` runs a CLI, the clock), so the
 * clients built inside see them. The built-in adapter uses the real ones; tests inject fakes.
 */
export function withDeps(op: OpSpec, deps: AuthDeps): OpSpec {
  const bind = (actx: AdapterContext): AdapterContext => {
    const bound = { ...actx };
    DEPS.set(bound, deps);
    return bound;
  };
  return {
    ...op,
    read: (actx, params) => op.read(bind(actx), params),
    apply: (actx, params, live) => op.apply(bind(actx), params, live),
    destroy: (actx, resources) => op.destroy(bind(actx), resources),
    ...(op.listScope ? { listScope: (actx: AdapterContext, params: Record<string, unknown>) => op.listScope!(bind(actx), params) } : {}),
  };
}

/** The variables holding a credential's secret part, for `refuse_credential`. */
function secretEnvs(auth: Auth): string[] {
  switch (auth.kind) {
    case "bearer":
    case "header":
      return [auth.env];
    case "headers":
      return auth.headers.map((h) => h.env);
    case "basic":
    case "digest":
      return [auth.passwordEnv];
    case "oauth2":
      return [auth.clientSecretEnv];
    case "sigv4":
      return [auth.secretAccessKeyEnv];
    default:
      return [];
  }
}

/**
 * Refuse a credential the API refuses (`refuse_credential`): PROVIDER_AUTH naming the variable and the prefix,
 * never the value, before any request is sent.
 */
function refuseCredentials(cfg: ApiConfig, env: NodeJS.ProcessEnv): void {
  if (!cfg.refuse || /^(1|true)$/i.test(env[cfg.refuse.unlessEnv] ?? "")) return;
  for (const name of secretEnvs(cfg.auth)) {
    const value = env[name] ?? "";
    const prefix = cfg.refuse.prefixes.find((p) => value.startsWith(p));
    if (!prefix) continue;
    throw new SponsonError(
      "PROVIDER_AUTH",
      `${ADAPTER}: ${name} holds a \\`${prefix}…\\` credential, which this API refuses (refuse_credential): a preview environment must not write with it. ` +
        `Use a test-mode credential, or set ${cfg.refuse.unlessEnv}=1 if this run really is meant to use it.`,
      { adapter: ADAPTER, env: name },
    );
  }
}

/**
 * The client for the line's API. The credential (a static header, or a signer for the forms obtained or computed
 * per request) comes from http-adapter-auth.ts; everything it holds or obtains is masked in this client's error text
 * too, whatever the engine already masks. `opts`: where the block is, for messages; whether a block without `auth`
 * sends no credential (a manual step's verify request); the adapter named in errors.
''',
])
s=open('packages/adapters/src/http-adapter-client.ts').read()
s=s.replace('''  const cred = credentialFor(actx, cfg.auth, DEPS.get(actx) ?? DEFAULT_AUTH_DEPS, redact);''','''  refuseCredentials(cfg, actx.env);
  const cred = credentialFor(actx, cfg.auth, DEPS.get(actx) ?? DEFAULT_AUTH_DEPS, redact);''')
open('packages/adapters/src/http-adapter-client.ts','w').write(s)

resolve('packages/adapters/src/http-adapter-resource.ts', [
'''function parseLocator(id: string): { method: string; path: string; gone: number[]; body: Record<string, unknown>; graphql?: GraphqlSpec } | null {
  const g = /^(KEEP )?GRAPHQL (\\{.*\\})$/s.exec(id);
  if (g) {
    try {
      const r = JSON.parse(g[2]!) as { query?: unknown; variables?: unknown };
      if (typeof r.query === "string" && isObject(r.variables)) return { method: g[1] ? "KEEP" : "GRAPHQL", path: "", gone: [], body: {}, graphql: { query: r.query, variables: r.variables, idempotent: true } };
    } catch {
      // reported by the caller
    }
    return null;
  }
  const m = /^(DELETE|POST|KEEP) (\\/\\S*)(?: gone=([\\d,]+))?(?: body=(\\{.*\\}))?$/.exec(id);
  if (!m) return null;
  let body: unknown = {};
  try {
    body = m[4] ? JSON.parse(m[4]) : {};
  } catch {
    return null;
  }
  return isObject(body) ? { method: m[1]!, path: m[2]!, gone: m[3] ? m[3].split(",").map(Number) : [], body } : null;
''',
'''        if (req.graphql) await graphqlRequest(httpClient(actx, { encoding: "json" }), req.graphql, undefined, actx.redact, true);
        else await write(httpClient(actx), req.method, req.path, req.method === "POST" ? req.body : undefined, true);
''',
])
resolve('packages/adapters/src/http-adapter-spec.ts', [
'''const API_KEYS = ["base_url", "base_url_env", "auth", "headers", "encoding", "media_type", "production", "refuse_credential"];
''',
'''  /**
   * How the object is removed. A `POST` with a `body` archives instead of deleting (Stripe prices cannot be deleted,
   * only set `active: false`); the body is part of the record id, so destroy needs nothing but the ledger. Or a
   * GraphQL mutation.
   */
  delete: { method: string; path: string; body?: Record<string, unknown>; graphql?: GraphqlSpec };
''',
'''function parseDelete(v: unknown, vars: Record<string, unknown>, read: { path: string; graphql?: GraphqlSpec } | undefined): ResourceSpec["delete"] {
  if (v === undefined && (read === undefined || read.graphql)) throw fail("`delete` is required: `{ path: /things/{id} }` or `{ graphql: { query: … } }` (no `read.path` to default to)", "delete");
  const r = parseRequest(v ?? {}, "delete", ["DELETE", "POST"], "DELETE", vars, true, read?.graphql ? undefined : read?.path);
  if (r.graphql) return { method: r.method, path: r.path, graphql: r.graphql };
  if (Object.keys(r.body).length === 0) return { method: r.method, path: r.path };
  if (r.method !== "POST") throw fail("`delete.body` needs `method: POST` (an archive request such as `{ active: false }`)", "delete.body");
  // The body travels in the record id, which the ledger keeps: plain values only, never a reference or a secret.
  if (firstMarker(r.body) !== undefined || JSON.stringify(r.body).includes("${")) throw fail("`delete.body` must hold literal values only", "delete.body");
  return { method: r.method, path: r.path, body: r.body };
''',
])
p='schema/release.plan.schema.json'
s=open(p).read()
m=pat.search(s)
ours,theirs=m.group(1),m.group(2)
refuse=theirs[theirs.index('        "refuse_credential": {'):]
# insert refuse_credential after production line in ours
lines=ours.split("\n")
prod_i=[i for i,l in enumerate(lines) if l.startswith('        "production"')][0]
media_i=[i for i,l in enumerate(lines) if l.startswith('        "media_type"')][0]
lines[media_i]=lines[media_i]+","
new_ours="\n".join(lines[:media_i+1])+"\n"+refuse.rstrip("\n")+"\n"+"\n".join(lines[media_i+1:])
s=s[:m.start()]+new_ours+s[m.end():]
assert "<<<<<<<" not in s
open(p,'w').write(s)
