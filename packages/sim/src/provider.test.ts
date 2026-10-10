import { describe, expect, it } from "vitest";
import { DEFAULT_CHAOS } from "./chaos.js";
import { Reply, route, router, type SimCore } from "./provider.js";

const core: SimCore = { chaos: { ...DEFAULT_CHAOS }, nextId: (p) => `${p}1` };
const req = (method: string, path: string) => ({ method, path, url: new URL(`http://sim.local${path}`), body: undefined });

describe("router", () => {
  const serve = router<{ hits: string[] }>(
    [
      route("GET", "/projects/:project/items/:id", ({ state, params }) => {
        state.hits.push("item");
        return new Reply(200, params);
      }),
      route("GET", "/projects/:project/items/special", () => new Reply(200, "never: the route above matches first")),
      route("DELETE", "/projects/:project", ({ params }) => new Reply(200, { deleted: params.project })),
      route("GET", "/v1.0/ping", () => new Reply(200, "pong")),
    ],
    () => new Reply(404, "fallback"),
  );

  it("passes each :name segment, URI-decoded, as params", () => {
    const state = { hits: [] as string[] };
    const r = serve(core, state, req("GET", "/projects/p%2F1/items/a%20b"));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ project: "p/1", id: "a b" });
    expect(state.hits).toEqual(["item"]);
  });

  it("answers with the first route that matches", () => {
    expect(serve(core, { hits: [] }, req("GET", "/projects/p/items/special")).body).toEqual({ project: "p", id: "special" });
  });

  it("needs the method to match too", () => {
    expect(serve(core, { hits: [] }, req("DELETE", "/projects/p")).body).toEqual({ deleted: "p" });
    expect(serve(core, { hits: [] }, req("GET", "/projects/p")).body).toBe("fallback");
  });

  it("matches whole paths, segments literally, and never an empty segment", () => {
    expect(serve(core, { hits: [] }, req("GET", "/v1.0/ping")).body).toBe("pong");
    expect(serve(core, { hits: [] }, req("GET", "/v1x0/ping")).body).toBe("fallback");
    expect(serve(core, { hits: [] }, req("GET", "/v1.0/ping/more")).body).toBe("fallback");
    expect(serve(core, { hits: [] }, req("DELETE", "/projects/")).body).toBe("fallback");
  });
});
