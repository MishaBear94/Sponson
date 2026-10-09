import { isPendingMarker, sha256, type AdapterContext, type OpSpec, type ResourceAdapter, type ResourceRecord } from "@sponson/core";
import { assertNoPending, clientFor, deleteIgnoringNotFound, diffValue, requireEnv, stringParam } from "./common.js";
import { ShapeError, isObject, isProviderError, listAll, records, type ApiClient, type Page } from "./http.js";

export const CLERK_DEFAULT_API_URL = "https://api.clerk.com/v1";
/** Page size asked for when Clerk answers with the paginated envelope. */
const CLERK_PAGE_LIMIT = 100;

interface RedirectUrl {
  id: string;
  url: string;
}

function client(actx: AdapterContext): ApiClient {
  const token = requireEnv(actx.env, "CLERK_SECRET_KEY", "clerk");
  return clientFor(actx, "clerk", { baseUrl: actx.env.CLERK_API_URL || CLERK_DEFAULT_API_URL, token });
}

const REDIRECT_PREFIX = "redirect:";

function redirectKey(url: string): string {
  return `${REDIRECT_PREFIX}${url}`;
}

function record(r: RedirectUrl): ResourceRecord {
  return { key: redirectKey(r.url), id: r.id, hash: sha256(r.url), label: `Clerk redirect ${r.url}` };
}

/**
 * GET /redirect_urls answers a bare array (everything) or the paginated `{ data, total_count }` envelope, paged by
 * `offset`/`limit`. Both are accepted; anything else is a PROVIDER_RESPONSE naming the endpoint.
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
  return listAll(api, "/redirect_urls", (body): Page<RedirectUrl> => {
    const p = parseRedirects(body);
    seen += p.items.length;
    const more = p.total !== undefined && seen < p.total;
    return { items: p.items.map((r) => ({ id: r.id, url: r.url })), next: more ? { offset: String(seen), limit: String(CLERK_PAGE_LIMIT) } : null };
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
      if (!isProviderError(e, "PROVIDER_CONFLICT")) throw e;
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

export const clerkAdapter: ResourceAdapter = { name: "clerk", ops: { redirect_allow } };
