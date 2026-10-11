/**
 * `describeInput`: a diff's new value is described by what its param is in the plan, not by how the adapter stores
 * it. An adapter that hides every value (Vercel's variables) is given resolved values only, so without this a
 * connection string from `{ from }`, a `{ secret }` and a literal would all read the same, and the renderers would
 * call all three "secret".
 */
import { describe, expect, it } from "vitest";
import type { ResolvedValue, ResourceDiff } from "../types.js";
import { describeInput } from "./inspect.js";

const hidden = (input?: string): ResourceDiff => ({ key: "k", kind: "create", label: "V (preview)", before: { state: "absent" }, after: { state: "sensitive" }, ...(input ? { input } : {}) });

describe("describeInput", () => {
  const inputs: Record<string, ResolvedValue> = {
    "values.SECRET": { state: "secret", value: null, ref: "env://STRIPE_KEY", sensitive: true },
    "values.CONN": { state: "resolved", value: null, ref: "db.connection_string", sensitive: true, dependsOn: "db" },
    "values.URL": { state: "resolved", value: "https://x.example", ref: "env.preview_url", sensitive: false, dependsOn: "env" },
    "values.MODE": { state: "literal", value: "preview" },
    "values.WAIT": { state: "pending", value: null, ref: "db.host", dependsOn: "db" },
  };

  it("a `{ secret }` is secret, a sensitive `{ from }` output is a hidden value with its reference, a literal is itself", () => {
    expect(describeInput(hidden("values.SECRET"), inputs).after).toEqual({ state: "secret", ref: "env://STRIPE_KEY" });
    expect(describeInput(hidden("values.CONN"), inputs).after).toEqual({ state: "sensitive", ref: "db.connection_string" });
    expect(describeInput(hidden("values.URL"), inputs).after).toEqual({ state: "literal", value: "https://x.example" });
    expect(describeInput(hidden("values.MODE"), inputs).after).toEqual({ state: "literal", value: "preview" });
  });

  it("leaves the adapter's side when there is no input to go by, or the value is still pending", () => {
    expect(describeInput(hidden(), inputs)).toEqual(hidden());
    expect(describeInput(hidden("values.NOPE"), inputs)).toEqual(hidden("values.NOPE"));
    const pending: ResourceDiff = { ...hidden("values.WAIT"), after: { state: "pending", ref: "db.host" } };
    expect(describeInput(pending, inputs)).toEqual(pending);
    const kept: ResourceDiff = { key: "k", kind: "unchanged", label: "V", input: "values.KEPT" };
    expect(describeInput(kept, { ...inputs, "values.KEPT": { state: "kept", value: null } })).toEqual(kept);
  });

  it("an unchanged value, which the adapter gives no sides, keeps its reference or literal", () => {
    const unchanged = (input: string): ResourceDiff => ({ key: "k", kind: "unchanged", label: "V", input });
    expect(describeInput(unchanged("values.SECRET"), inputs).after).toEqual({ state: "secret", ref: "env://STRIPE_KEY" });
    expect(describeInput(unchanged("values.CONN"), inputs).after).toEqual({ state: "sensitive", ref: "db.connection_string" });
    expect(describeInput(unchanged("values.MODE"), inputs).after).toEqual({ state: "literal", value: "preview" });
    expect(describeInput(unchanged("values.MODE"), inputs).before).toBeUndefined();
  });
});
