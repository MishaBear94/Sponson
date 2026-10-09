/**
 * Simulated Clerk: the instance's allowed redirect URLs.
 *
 * Assumptions about the real API that this fake encodes and that are most likely wrong (see vercel.ts for how
 * they are checked):
 *   C1. A duplicate redirect URL answers 422.
 *   C2. The list is a bare JSON array, or, with chaos `page_size`, `{ data, total_count }` paged by
 *       `offset`/`limit`.
 */
import { page, Reply, type CreatedBy, type ProviderSim, type SimCore } from "../provider.js";

export interface ClerkRedirect {
  id: string;
  url: string;
  createdAt: number;
  createdBy: CreatedBy;
}

export interface ClerkState {
  redirect_urls: ClerkRedirect[];
}

export interface ClerkSeed {
  redirect_urls: string[];
}

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
      const all = state.redirect_urls.map((r) => ({ id: r.id, url: r.url }));
      if (core.chaos.page_size <= 0) return new Reply(200, all);
      const limit = url.searchParams.get("limit");
      const pg = page(core, all, url.searchParams.get("offset"), limit && /^\d+$/.test(limit) ? Number(limit) : undefined);
      return new Reply(200, { data: pg.items, total_count: all.length });
    }
    if (path === "/redirect_urls" && method === "POST") {
      const b = (body ?? {}) as { url?: string };
      if (!b.url) return new Reply(400, { error: "url required" });
      if (state.redirect_urls.some((r) => r.url === b.url)) return new Reply(422, { error: "redirect url already exists" });
      const r = redirect(core, b.url, Date.now(), "api");
      state.redirect_urls.push(r);
      return new Reply(200, { id: r.id, url: r.url });
    }
    if ((m = path.match(/^\/redirect_urls\/([^/]+)$/)) && method === "DELETE") {
      const r = state.redirect_urls.find((x) => x.id === m![1]);
      if (!r) return new Reply(404, { error: "not found" });
      state.redirect_urls = state.redirect_urls.filter((x) => x !== r);
      return new Reply(200, { id: r.id, object: "redirect_url", deleted: true });
    }
    return new Reply(404, { error: "not found" });
  },
};

function redirect(core: SimCore, url: string, createdAt: number, createdBy: CreatedBy): ClerkRedirect {
  return { id: core.nextId("ru_"), url, createdAt, createdBy };
}
