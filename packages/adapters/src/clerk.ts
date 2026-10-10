import { isPendingMarker, sha256, type AdapterContext, type OpSpec, type ResourceAdapter, type ResourceRecord } from "@sponson/core";
import { assertNoPending, clientFor, deleteIgnoringNotFound, diffValue, optionalEnv, requireEnv, stringParam } from "./common.js";
import { ShapeError, isObject, isProviderError, listAll, records, type ApiClient, type Page } from "./http.js";

/** The environment clerk reads; declared once, used by the code below and by the generated docs. */
const ABOUT = { credentialEnv: "CLERK_SECRET_KEY", baseUrlEnv: "CLERK_API_URL" } as const;

/** Clerk's API base URL; `CLERK_API_URL` overrides it (the sim and tests use that). */
export const CLERK_DEFAULT_API_URL = "https://api.clerk.com/v1";
/** Page size asked for (the spec's `limit` allows 1–500, default 10). */
const CLERK_PAGE_LIMIT = 100;

interface RedirectUrl {
  id: string;
  url: string;
}

function client(actx: AdapterContext): ApiClient {
  const token = requireEnv(actx.env, ABOUT.credentialEnv, "clerk");
  return clientFor(actx, "clerk", { baseUrl: optionalEnv(actx.env, ABOUT.baseUrlEnv) ?? CLERK_DEFAULT_API_URL, token });
}

const REDIRECT_PREFIX = "redirect:";

function redirectKey(url: string): string {
  return `${REDIRECT_PREFIX}${url}`;
}

function record(r: RedirectUrl): ResourceRecord {
  return { key: redirectKey(r.url), id: r.id, hash: sha256(r.url), label: `Clerk redirect ${r.url}` };
}

/**
 * GET /redirect_urls?paginated=true answers `{ data, total_count }`, paged by `offset`/`limit` (Clerk's own SDKs ask
 * for it the same way; without `paginated` the spec documents a bare array). A bare array is still accepted;
 * anything else is a PROVIDER_RESPONSE naming the endpoint.
 */
function parseRedirects(body: unknown): { items: RedirectUrl[]; total?: number } {
  if (Array.isArray(body)) return { items: records(body, "the redirect URL list", ["id", "url"]) };
  if (!isObject(body)) throw new ShapeError(`expected a list of redirect URLs or { data, total_count }, got ${body === null ? "null" : typeof body}`);
  const items = records(body.data, "`data`", ["id", "url"]);
  if (typeof body.total_count !== "number") throw new ShapeError("expected `total_count` to be a number");
  return { items, total: body.total_count };
}

async function list(api: ApiClient): Promise<RedirectUrl[]> {
  let seen = 0;
  return listAll(api, `/redirect_urls?paginated=true&limit=${CLERK_PAGE_LIMIT}`, (body): Page<RedirectUrl> => {
    const p = parseRedirects(body);
    seen += p.items.length;
    const more = p.total !== undefined && seen < p.total;
    return { items: p.items.map((r) => ({ id: r.id, url: r.url })), next: more ? { offset: String(seen) } : null };
  });
}

const redirect_allow: OpSpec = {
  outputs: { id: { available: "immediate" } },

  async read(actx, params) {
    if (isPendingMarker(params.url)) return null;
    const url = stringParam(params, "url", "clerk");
    const found = (await list(client(actx))).find((r) => r.url === url);
    if (!found) return null;
    return { resources: [record(found)], outputs: { id: found.id } };
  },

  diff(live, params) {
    const url = params.url;
    const key = isPendingMarker(url) ? "redirect:(pending)" : redirectKey(String(url));
    const current = live?.resources.find((r) => r.key === key);
    return [diffValue({ key, label: "Clerk redirect", live: current, desired: url, sensitive: false, liveValue: String(url) })];
  },

  async apply(actx, params, live) {
    assertNoPending(params, "clerk");
    const url = stringParam(params, "url", "clerk");
    const key = redirectKey(url);
    if (live?.resources.some((r) => r.key === key)) return { resources: live.resources, outputs: live.outputs, created: [] };
    const api = client(actx);
    await actx.intend([key]);
    actx.log(`allow redirect ${url}`);
    try {
      const r = await api.post("/redirect_urls", { url }, (b) => records([b], "the created redirect URL", ["id", "url"])[0]!);
      return { resources: [record(r)], outputs: { id: r.id }, created: [key] };
    } catch (e) {
      // The spec documents 400 and 422 for a refused create without saying which a duplicate gets, so any refusal
      // is checked against the list before it is reported.
      const refused = isProviderError(e, "PROVIDER_INVALID") && (e.details.status === 400 || e.details.status === 422);
      if (!isProviderError(e, "PROVIDER_CONFLICT") && !refused) throw e;
      // It exists already: registered by someone else, or by an earlier attempt of ours whose answer was lost.
      // Either way it is not created by this call; the engine claims it if an earlier intent of ours named it.
      const found = (await list(api)).find((r) => r.url === url);
      if (!found) throw e;
      return { resources: [record(found)], outputs: { id: found.id }, created: [] };
    }
  },

  async destroy(actx, resources) {
    const api = client(actx);
    for (const r of resources) await deleteIgnoringNotFound(api, `/redirect_urls/${encodeURIComponent(r.id)}`);
  },

  async listScope(actx) {
    return (await list(client(actx))).map(record);
  },

  /** One line per allowed URL. */
  adopt(resources) {
    return resources.map((r) => ({ id: "callback", params: { url: r.key.slice(REDIRECT_PREFIX.length) }, keys: [r.key] }));
  },
};

/**
 * Clerk: op `redirect_allow` keeps a redirect URL (e.g. a preview URL) on the allow-list. Needs
 * `CLERK_SECRET_KEY`.
 */
export const clerkAdapter: ResourceAdapter = { name: "clerk", ops: { redirect_allow }, about: ABOUT };
