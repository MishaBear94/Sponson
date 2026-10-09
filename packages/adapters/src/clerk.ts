import { isPendingMarker, sha256, type AdapterContext, type OpSpec, type ResourceAdapter, type ResourceRecord } from "@sponson/core";
import { assertNoPending, deleteIgnoringNotFound, diffValue, requireEnv, stringParam } from "./common.js";
import { apiClient, isHttpError, type ApiClient } from "./http.js";

export const CLERK_DEFAULT_API_URL = "https://api.clerk.com/v1";

interface RedirectUrl {
  id: string;
  url: string;
}

function client(actx: AdapterContext): ApiClient {
  const token = requireEnv(actx.env, "CLERK_SECRET_KEY", "clerk");
  return apiClient({ baseUrl: actx.env.CLERK_API_URL || CLERK_DEFAULT_API_URL, token });
}

function redirectKey(url: string): string {
  return `redirect:${url}`;
}

function record(r: RedirectUrl): ResourceRecord {
  return { key: redirectKey(r.url), id: r.id, hash: sha256(r.url), label: `Clerk redirect ${r.url}` };
}

async function list(api: ApiClient): Promise<RedirectUrl[]> {
  return api.get<RedirectUrl[]>("/redirect_urls");
}

const redirect_allow: OpSpec = {
  outputs: { id: { available: "immediate" } },

  async read(actx, params) {
    if (isPendingMarker(params.url)) return null;
    const url = stringParam(params, "url");
    const found = (await list(client(actx))).find((r) => r.url === url);
    if (!found) return null;
    return { resources: [record(found)], outputs: { id: found.id } };
  },

  diff(live, params) {
    const url = params.url;
    const key = isPendingMarker(url) ? "redirect:(pending)" : redirectKey(String(url));
    const current = live?.resources.find((r) => r.key === key);
    return [diffValue({ key, label: "Clerk redirect", live: current, desired: url, sensitive: false })];
  },

  async apply(actx, params, live) {
    assertNoPending(params, "clerk");
    const url = stringParam(params, "url");
    if (live?.resources.some((r) => r.key === redirectKey(url))) return { resources: live.resources, outputs: live.outputs, created: [] };
    actx.log(`allow redirect ${url}`);
    const api = client(actx);
    try {
      const r = await api.post<RedirectUrl>("/redirect_urls", { url });
      return { resources: [record(r)], outputs: { id: r.id }, created: [redirectKey(url)] };
    } catch (e) {
      if (!isHttpError(e, 422)) throw e;
      // Someone registered it between our read and this write (a retried run, a parallel job). It exists, which is
      // what the plan asked for; it is not ours to roll back, so it is adopted rather than created.
      const found = (await list(api)).find((r) => r.url === url);
      if (!found) throw e;
      return { resources: [record(found)], outputs: { id: found.id }, created: [] };
    }
  },

  async destroy(actx, resources) {
    const api = client(actx);
    for (const r of resources) await deleteIgnoringNotFound(api, `/redirect_urls/${r.id}`);
  },

  async listScope(actx) {
    return (await list(client(actx))).map(record);
  },
};

export const clerkAdapter: ResourceAdapter = { name: "clerk", ops: { redirect_allow } };
