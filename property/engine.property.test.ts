/**
 * Property-based layer from brainstorm/design/验收策略.md.
 *
 * Random plans (DAGs of fake.item lines), random pre-existing resources, random failures,
 * random console edits between runs. Only the seven invariants are checked; any failing
 * case is printed by fast-check as a minimal counterexample and can be turned into a scenario.
 */
import fc from "fast-check";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyRun, destroyRun, FakeCloud, fakeSecretSource, LocalReceiptStore, parsePlan, planRun, Redactor, Registry, type Ctx, type RunOptions } from "@sponson/core";

const ctx: Ctx = { env: "preview", git: { branch: "feat/p", sha: "0123456789abcdef", short_sha: "0123456" }, pr: { number: 7 }, scope: "pr-7" };
const SECRET = "very-secret-value-42";

interface Line {
  i: number;
  value: { kind: "literal"; v: string } | { kind: "ref"; j: number; out: "id" | "secret" | "url" } | { kind: "secret" };
}

interface Case {
  lines: Line[];
  seeded: Array<{ name: string; value: string; planned: boolean }>;
  failApplyAt: number | null;
  failDestroyAt: number | null;
  external: "ok" | "never" | "fail";
  driftAt: number | null;
  deleteAt: number | null;
  reconcile: boolean;
}

const lineArb = (i: number): fc.Arbitrary<Line> =>
  fc
    .oneof(
      { weight: 3, arbitrary: fc.record({ kind: fc.constant("literal" as const), v: fc.stringMatching(/^[a-z]{1,6}$/) }) },
      { weight: 3, arbitrary: i === 0 ? fc.record({ kind: fc.constant("literal" as const), v: fc.constant("x") }) : fc.record({ kind: fc.constant("ref" as const), j: fc.integer({ min: 0, max: i - 1 }), out: fc.constantFrom("id" as const, "secret" as const, "url" as const) }) },
      { weight: 1, arbitrary: fc.constant({ kind: "secret" as const }) },
    )
    .map((value) => ({ i, value }));

const caseArb: fc.Arbitrary<Case> = fc.integer({ min: 2, max: 7 }).chain((n) =>
  fc.record({
    lines: fc.tuple(...Array.from({ length: n }, (_, i) => lineArb(i))).map((t) => [...t]),
    seeded: fc.array(fc.record({ name: fc.constantFrom("legacy", "n0", "n1", "other"), value: fc.constantFrom("seed", "x"), planned: fc.boolean() }), { maxLength: 2 }),
    failApplyAt: fc.option(fc.integer({ min: 0, max: n - 1 }), { nil: null }),
    failDestroyAt: fc.option(fc.integer({ min: 0, max: n - 1 }), { nil: null }),
    external: fc.constantFrom("ok" as const, "never" as const, "fail" as const),
    driftAt: fc.option(fc.integer({ min: 0, max: n - 1 }), { nil: null }),
    deleteAt: fc.option(fc.integer({ min: 0, max: n - 1 }), { nil: null }),
    reconcile: fc.boolean(),
  }),
);

function toYaml(lines: Line[]): string {
  const body = lines
    .map((l) => {
      const value =
        l.value.kind === "literal" ? JSON.stringify(l.value.v) : l.value.kind === "ref" ? `{ from: n${l.value.j}.${l.value.out} }` : `{ secret: "fake://TOKEN" }`;
      return `  - id: n${l.i}\n    adapter: fake\n    op: item\n    name: n${l.i}\n    value: ${value}`;
    })
    .join("\n");
  return `version: 1\nchanges:\n${body}\n`;
}

async function harness(c: Case) {
  const cloud = new FakeCloud();
  const redactor = new Redactor();
  const registry = new Registry().addAdapter(cloud.adapter()).addSecretSource(fakeSecretSource({ TOKEN: SECRET }));
  const store = new LocalReceiptStore(await mkdtemp(join(tmpdir(), "sponson-prop-")));
  const plan = parsePlan(toYaml(c.lines)).plan;
  const seededNames = new Set<string>();
  for (const s of c.seeded) {
    cloud.seed(s.name, s.value);
    seededNames.add(s.name);
  }
  cloud.external = c.external;
  const opts = (extra: Partial<RunOptions> = {}): RunOptions => ({ plan, ctx, registry, store, env: {}, redactor, ...extra });
  return { cloud, redactor, store, plan, opts, seededNames };
}

const outputs: string[] = [];
function record(x: unknown) {
  outputs.push(JSON.stringify(x));
}

describe("engine invariants", () => {
  it("hold for random plans, failures and drift", async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async (c) => {
        outputs.length = 0;
        const { cloud, redactor, store, opts, seededNames } = await harness(c);
        const unmanagedBefore = new Map([...cloud.items.values()].filter((i) => !c.lines.some((l) => `n${l.i}` === i.name)).map((i) => [i.name, i.value]));

        // I4: plan is read-only
        const p1 = await planRun(opts());
        record(p1);
        expect(cloud.writes).toHaveLength(0);

        // I7: production never touched without approval
        await expect(applyRun(opts({ ctx: { ...ctx, env: "production" } }))).rejects.toMatchObject({ code: "ENV_NOT_APPROVED" });
        expect(cloud.writes).toHaveLength(0);

        // first apply with an optional injected failure
        const namesBefore = new Set(cloud.items.keys());
        if (c.failApplyAt !== null) cloud.failNext("apply", `n${c.failApplyAt}`);
        const a1 = await applyRun(opts());
        record(a1);
        // I6: receipt parseable
        expect((await store.read("preview", "pr-7"))?.runId).toBe(a1.receipt.runId);

        const lineFailed = Object.values(a1.receipt.lines).some((l) => l.status === "failed");
        const rollbackFailed = Object.values(a1.receipt.lines).some((l) => l.status === "rollback_failed");
        if (lineFailed && !rollbackFailed) {
          // I2: when one of our lines fails, rollback restores the set of resources.
          // (A failed deploy also makes the run `failed`, but then nothing is rolled back on purpose.)
          expect(new Set(cloud.items.keys())).toEqual(namesBefore);
        }

        // I3: idempotence, when the world did not change in between
        if (a1.receipt.status !== "failed") {
          const w = cloud.writes.length;
          const a2 = await applyRun(opts());
          record(a2);
          expect(cloud.writes.length).toBe(w);
          for (const l of Object.values(a2.receipt.lines)) expect(["unchanged", "waiting", "skipped"]).toContain(l.status);
        }

        // console edits between runs
        if (c.driftAt !== null) cloud.drift(`n${c.driftAt}`, "edited");
        if (c.deleteAt !== null) cloud.delete(`n${c.deleteAt}`);
        const p2 = await planRun(opts());
        record(p2);
        const a3 = await applyRun(opts({ reconcile: c.reconcile }));
        record(a3);
        if (c.driftAt !== null && !c.reconcile && a1.receipt.lines[`n${c.driftAt}`]?.status === "applied" && cloud.items.has(`n${c.driftAt}`)) {
          // a value we applied, then someone edited: either refused (DRIFT_CHANGED) or nothing to change
          const line = a3.receipt.lines[`n${c.driftAt}`]!;
          if (line.status === "failed") expect(line.error).toMatch(/--reconcile/);
        }

        // destroy, with an optional injected failure
        if (c.failDestroyAt !== null) cloud.failNext("destroy", `n${c.failDestroyAt}`);
        const d = await destroyRun(opts());
        record(d);
        // seeded items survive destroy unless Sponson (re)created them after a human deleted them
        for (const name of seededNames) {
          if (c.deleteAt !== null && `n${c.deleteAt}` === name) continue;
          const ours = Object.values(a3.receipt.lines).some((l) => l.resources.some((r) => r.key === `item:${name}` && r.createdBy === "sponson"));
          if (!ours) expect(cloud.items.has(name)).toBe(true);
        }

        // I5: unmanaged resources untouched throughout
        for (const [name, value] of unmanagedBefore) {
          if (c.driftAt !== null && `n${c.driftAt}` === name) continue;
          if (c.deleteAt !== null && `n${c.deleteAt}` === name) continue;
          expect(cloud.items.get(name)?.value).toBe(value);
        }

        // I1: no secret in any output
        const everything = outputs.join("\n");
        expect(everything).not.toContain(SECRET);
        for (const v of [...cloud.items.values()]) if (v.value.startsWith("s-")) expect(everything).not.toContain(v.value);
        expect(redactor.leaks(everything)).toEqual([]);
      }),
      { numRuns: Number(process.env.SPONSON_PROPERTY_RUNS ?? 300), verbose: true },
    );
  }, 300_000);
});
