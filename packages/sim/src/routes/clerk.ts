/**
 * Simulated Clerk: the instance's allowed redirect URLs.
 *
 * Assumptions about the real API that this fake encodes, each marked with how far it is checked. "Verified" means
 * against Clerk's published Backend API OpenAPI document (github.com/clerk/openapi-specs, bapi/2026-05-12.yml,
 * identical for /redirect_urls back to 2021-02-05; fetched 2026-10-10); see docs/api-verification.md:
 *   C1. A duplicate redirect URL answers 422 (ClerkErrors body). Unverified: the spec documents 400 and 422 for
 *       POST /redirect_urls without saying which a duplicate gets. The adapter checks the list after either.
 *   C2. GET /redirect_urls is a bare JSON array (verified); with `paginated=true` it is `{ data, total_count }`
 *       paged by `offset`/`limit` (limit 1–500, default 10: verified parameters). The envelope is not in the
 *       spec; it is how Clerk's own SDKs (clerk/javascript RedirectUrlApi, clerk-sdk-go redirecturl) call and
 *       decode it. Chaos `page_size` caps the page further.
 *   C3. A redirect URL is `{ object: "redirect_url", id, url, created_at, updated_at }` and DELETE answers a
 *       DeletedObject `{ object, id, deleted }` (verified).
 */
import { page, Reply, type CreatedBy, type ProviderSim, type SimCore } from "../provider.js";

/** One allow-listed redirect URL. */
export interface ClerkRedirect {
  id: string;
  url: string;
  createdAt: number;
  createdBy: CreatedBy;
}

/** Simulated Clerk: the instance's redirect allow-list. */
export interface ClerkState {
  redirect_urls: ClerkRedirect[];
}

/** Initial Clerk state. */
export interface ClerkSeed {
  redirect_urls: string[];
}

/** Simulated Clerk (redirect URL allow-list); see the assumptions at the top of this file. */
export const clerkSim: ProviderSim<ClerkState, ClerkSeed> = {
  env: { token: "CLERK_SECRET_KEY", url: "CLERK_API_URL", testToken: "tok_clerk" },
  defaultSeed: { redirect_urls: [] },

  reset(core, seed) {
    const now = Date.now();
    return { redirect_urls: (seed?.redirect_urls ?? []).map((url) => redirect(core, url, now, "sim")) };
  },

  /** `redirect.<url>`: "delete" | "recreate". Clerk has one instance per key, so there is no `clerk:<project>.` form. */
  drift(core, state, { key, rest, value, only }) {
    if (only !== undefined || !rest.startsWith("redirect.")) return false;
    const url = rest.slice("redirect.".length);
    if (value !== "delete" && value !== "recreate") throw new Error(`drift ${key}: only "delete" and "recreate" are supported`);
    const hit = state.redirect_urls.filter((r) => r.url === url);
    state.redirect_urls = state.redirect_urls.filter((r) => !hit.includes(r));
    if (value === "recreate") for (const r of hit) state.redirect_urls.push(redirect(core, r.url, Date.now(), "sim"));
    return true;
  },

  routes(core, state, { method, url, path, body }) {
    let m: RegExpMatchArray | null;

    if (path === "/redirect_urls" && method === "GET") {
      const all = state.redirect_urls.map(publicRedirect);
      if (url.searchParams.get("paginated") !== "true") return new Reply(200, all);
      const limit = url.searchParams.get("limit");
      const offset = url.searchParams.get("offset");
      if ((limit !== null && !/^\d+$/.test(limit)) || (offset !== null && !/^\d+$/.test(offset)) || Number(limit ?? 10) < 1 || Number(limit ?? 10) > 500) {
        return clerkError(422, "form_param_format_invalid", "limit must be 1–500 and offset ≥ 0");
      }
      const pg = page(core, all, offset, Number(limit ?? 10));
      return new Reply(200, { data: pg.items, total_count: all.length });
    }
    if (path === "/redirect_urls" && method === "POST") {
      const b = (body ?? {}) as { url?: string };
      if (!b.url) return clerkError(422, "form_param_missing", "url is required");
      if (state.redirect_urls.some((r) => r.url === b.url)) return clerkError(422, "duplicate_record", "redirect url already exists");
      const r = redirect(core, b.url, Date.now(), "api");
      state.redirect_urls.push(r);
      return new Reply(200, publicRedirect(r));
    }
    if ((m = path.match(/^\/redirect_urls\/([^/]+)$/)) && method === "DELETE") {
      const r = state.redirect_urls.find((x) => x.id === m![1]);
      if (!r) return clerkError(404, "resource_not_found", "not found");
      state.redirect_urls = state.redirect_urls.filter((x) => x !== r);
      return new Reply(200, { id: r.id, object: "redirect_url", deleted: true });
    }
    return clerkError(404, "resource_not_found", "not found");
  },
};

/** The spec's RedirectURL: `object`, `id`, `url`, `created_at`, `updated_at` (all required). */
function publicRedirect(r: ClerkRedirect) {
  return { object: "redirect_url", id: r.id, url: r.url, created_at: r.createdAt, updated_at: r.createdAt };
}

/** The spec's ClerkErrors body. */
function clerkError(status: number, code: string, message: string): Reply {
  return new Reply(status, { errors: [{ code, message, long_message: message }] });
}

function redirect(core: SimCore, url: string, createdAt: number, createdBy: CreatedBy): ClerkRedirect {
  return { id: core.nextId("ru_"), url, createdAt, createdBy };
}
