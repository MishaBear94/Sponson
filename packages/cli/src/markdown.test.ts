/**
 * renderMarkdown on hand-built envelopes: the cases real runs rarely produce (hostile provider text, stale runs,
 * destroy failures, orphans, crashes) and the escaping and size guarantees. Real `--json` output is rendered in
 * scenarios/journeys/secrets/pr-comment.test.ts.
 */
import { describe, expect, it } from "vitest";
import { GITHUB_COMMENT_LIMIT, ciRunUrl, commentMarker, esc, renderMarkdown } from "./markdown.js";

const line = (over: Record<string, unknown> = {}) => ({ id: "env", adapter: "vercel", op: "env", status: "applied", createdBy: "sponson", resources: [], outputs: {}, ...over });
const apply = (lines: Record<string, unknown>, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  ok: true,
  command: "apply",
  receipt: { runId: "run-1", environment: "preview", scope: "pr-42", status: "complete", plan: { hash: "abcdef0123" }, lines, ...over },
  drift: [],
  warnings: [],
  ...extra,
});

/** Outside the marker: no tag, no HTML comment, no unbalanced code span. */
function inert(md: string): string[] {
  const problems: string[] = [];
  const rest = md.replace(/^<!-- sponson:[^>]* -->\n/, "");
  if (rest.includes("<!--")) problems.push("HTML comment");
  const prose = rest.replace(/`[^`\n]*`/g, "");
  if (/<(?!\/?(pre|sub)>)[a-z!/]/i.test(prose)) problems.push(`tag: ${/<(?!\/?(pre|sub)>)[a-z!/][^>]{0,20}/i.exec(prose)?.[0]}`);
  for (const l of rest.split("\n")) if (((l.match(/`/g) ?? []).length % 2) !== 0) problems.push(`odd backticks: ${l}`);
  if (/\r/.test(md)) problems.push("CR");
  return problems;
}

describe("renderMarkdown", () => {
  const hostile = ["<!DOCTYPE html><html><body><h1>502</h1><!-- cf-ray 8c2f", "one\r\ntwo | pipe\r`tick` <script>alert(1)</script> & [x](javascript:alert(1)) *bold* _it_"];

  it.each(hostile)("provider text %# stays inert and on its line", (error) => {
    const md = renderMarkdown(apply({ env: line({ status: "failed", errorCode: "PROVIDER_TRANSIENT", error }) }, { status: "failed" }));
    expect(inert(md), md).toEqual([]);
    const bullet = md.split("\n").find((l) => l.startsWith("- `env`"))!;
    expect(bullet).toContain("`PROVIDER_TRANSIENT`");
    expect(bullet).toContain("**Fix:**");
    expect(md).not.toMatch(/(?<!\\)\]\(javascript:/);
  });

  it("escapes error envelopes, drift, warnings and labels", () => {
    const err = renderMarkdown({ ok: false, command: "apply", error: { code: "INTERNAL", message: "<b>x</b>\n| y", hint: "<i>h</i>" } }, { command: "apply" });
    expect(err).toContain("### Sponson apply failed: `INTERNAL`");
    expect(err).toContain("&lt;b&gt;x&lt;/b&gt; &#124; y");
    expect(err).toContain("**Fix:** &lt;i&gt;h&lt;/i&gt;");
    const plan = renderMarkdown({
      ok: true,
      command: "plan",
      environment: "preview",
      scope: "pr-42",
      planHash: "abcdef0123",
      requiresApproval: true,
      lock: { holder: "run-9<x>" },
      lines: [{ id: "a", adapter: "http", op: "resource", status: "create", diffs: [{ key: "k", kind: "create", label: "<img src=x>", after: { state: "literal", value: "SECRETISH" } }] }],
      drift: [{ kind: "unmanaged", adapter: "vercel", resource: { key: "k2", label: "<img src=y>" }, message: "m" }],
      warnings: ["`w`\r\n<i>"],
    });
    expect(inert(plan), plan).toEqual([]);
    // A literal is the plan's own text, already in the repository: shown as itself, in a code span (inert).
    expect(plan).toContain("&lt;img src=x&gt; = `SECRETISH`");
    expect(plan).toContain("An apply is running on this scope (run-9&lt;x&gt;)");
    expect(plan).toContain("needs a person's approval");
    expect(plan).toContain("`sponson init --adopt <key>`");
  });

  it("shows a literal as itself, other values only as references, and outputs only as URL links", () => {
    const plan = renderMarkdown({
      ok: true,
      command: "plan",
      environment: "preview",
      scope: "pr-42",
      planHash: "abcdef0123",
      lines: [
        {
          id: "env",
          adapter: "vercel",
          op: "env",
          status: "update",
          diffs: [
            { key: "a", kind: "update", label: "FLAG (preview)", before: { state: "literal", value: "off" }, after: { state: "literal", value: "on-value-123" } },
            { key: "b", kind: "create", label: "DATABASE_URL (preview)", after: { state: "pending", ref: "db.connection_string" } },
            { key: "c", kind: "update", label: "STRIPE_KEY (preview)", before: { state: "sensitive" }, after: { state: "secret", ref: "env://STRIPE_KEY" } },
          ],
        },
      ],
      drift: [],
      warnings: [],
    });
    expect(plan).toContain("`env` 3 variables (preview): `FLAG` = `on-value-123`, `DATABASE_URL` ← `db.connection_string` and `STRIPE_KEY` ← `env://STRIPE_KEY` (secret) — will be updated");
    const md = renderMarkdown(apply({ db: line({ id: "db", adapter: "neon", op: "branch", resources: [{ key: "b", label: "Neon branch x" }], outputs: { host: "h.example", branch_id: "br-1", dashboard: "https://example.com/d", evil: "javascript:alert(1)" }, consoleUrl: "javascript:alert(1)" }) }));
    expect(md).not.toContain("h.example");
    expect(md).toContain("[dashboard](https://example.com/d)");
    expect(md).not.toContain("javascript:");
  });

  it("apply says what each value stands for, as plan does, from the envelope's inputs: a literal as itself, a reference kept when unchanged", () => {
    const resources = [
      { key: "a", label: "MODE (preview)" },
      { key: "b", label: "DATABASE_URL (preview)" },
      { key: "c", label: "STRIPE_KEY (preview)" },
    ];
    const inputs = { env: { a: { state: "literal", value: "preview" }, b: { state: "sensitive", ref: "db.connection_string" }, c: { state: "secret", ref: "env://STRIPE_KEY" } } };
    const md = renderMarkdown(apply({ env: line({ status: "unchanged", resources }) }, {}, { inputs }));
    expect(md).toContain("`env` 3 variables (preview): `MODE` = `preview`, `DATABASE_URL` ← `db.connection_string` (value hidden) and `STRIPE_KEY` ← `env://STRIPE_KEY` (secret) — unchanged");
    expect(md).not.toContain("values not shown");
    // An envelope without inputs (an older Sponson's) still says the values are not shown.
    expect(renderMarkdown(apply({ env: line({ resources }) }))).toContain(", values not shown — set up in this run");
  });

  it("stale, orphan, rollback failure and blocked lines each say what happened", () => {
    const stale = renderMarkdown(apply({ a: line({ status: "skipped", errorCode: "STALE", error: "stale: …" }) }, { stale: true }));
    expect(stale).toContain("a newer commit was already applied");
    expect(stale).toContain("Nothing was changed.");
    const md = renderMarkdown(
      apply(
        {
          a: line({ id: "a", orphan: true, status: "unchanged", resources: [{ key: "k", label: "OLD (preview)" }] }),
          b: line({ id: "b", status: "rollback_failed", errorCode: "ROLLBACK_FAILED", error: "boom" }),
          c: line({ id: "c", status: "blocked", errorCode: "OWNED_BY_OTHER_SCOPE", error: "owned by pr-7" }),
        },
        { status: "failed", approvedBy: "alice" },
      ),
    );
    expect(md).toContain("no longer in the plan");
    expect(md).toContain("rolling it back failed too");
    expect(md).toContain("refused: owned by pr-7 (`OWNED_BY_OTHER_SCOPE`) **Fix:** Another pull request or branch manages it");
    expect(md).toContain("Approved by alice.");
  });

  it("destroy: cleaned up, kept and left for you, including failures, survivors and undo steps", () => {
    const md = renderMarkdown(
      apply(
        {
          db: line({ id: "db", adapter: "neon", op: "branch", status: "destroy_failed", errorCode: "DESTROY_FAILED", error: "409", resources: [{ key: "b", label: "Neon branch x", createdBy: "sponson" }] }),
          env: line({ status: "destroyed", removed: [{ key: "a", label: "A (preview)", createdBy: "sponson" }, { key: "b", label: "B (preview)", createdBy: "sponson" }, { key: "c", label: "C (preview)", createdBy: "adopted" }], notes: { notSponsons: ["D (preview)"] } }),
          old: line({ id: "old", status: "skipped", notes: { adoptedKept: ["env:preview:LEGACY"] } }),
        },
        { destroy: true, status: "failed", runId: "destroy-1" },
        { manual: [{ line: "g", title: "Remove the callback", action: "undo", instructions: "Remove it.", observable: false }] },
      ),
    );
    expect(md).toContain("### Sponson could not clean up everything for the preview for pr-42");
    expect(md).toContain("**Cleaned up:** 2 variables (preview): `A` and `B`.");
    expect(md).toContain("**Kept (adopted, never destroyed):** C (preview); env:preview:LEGACY.");
    expect(md).toContain("- `db` Neon branch x: 409 (`DESTROY_FAILED`)");
    expect(md).toContain("D (preview): re-created outside Sponson");
    expect(md).toContain("`sponson apply --destroy --confirm g`");
    const nothing = renderMarkdown(apply({}, { destroy: true }, { warnings: ["Nothing to destroy: no receipt for this scope."] }));
    expect(nothing).toContain("**Cleaned up:** nothing.");
  });

  it("a crash, or anything that is not an envelope, still renders a titled comment with the marker", () => {
    for (const e of [null, "garbage", 42, { foo: 1 }]) {
      const md = renderMarkdown(e, { environment: "preview", command: "apply", exitCode: 1 });
      expect(md.startsWith(`${commentMarker("preview")}\n### Sponson apply crashed (exit 1)`)).toBe(true);
    }
  });

  it("the marker is the environment's, made safe", () => {
    expect(commentMarker("preview")).toBe("<!-- sponson:preview -->");
    expect(commentMarker("x --><b>")).toBe("<!-- sponson:x_--__b_ -->");
    expect(renderMarkdown(apply({}, { environment: "staging" })).startsWith("<!-- sponson:staging -->")).toBe(true);
  });

  it("fits GitHub's limit, keeping the title and headline, and says what it left out", () => {
    const lines: Record<string, unknown> = {};
    for (let i = 0; i < 3000; i++) lines[`l${i}`] = line({ id: `l${i}`, status: "unchanged", resources: [{ key: `k${i}`, label: `VAR_${i}_${"x".repeat(30)} (preview)` }] });
    const huge = "step\n".repeat(20_000);
    const md = renderMarkdown(apply(lines, {}, { manual: [{ line: "m", title: "t", action: "do", instructions: huge, observable: false }] }));
    expect(md.length).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
    expect(md).toContain("This preview has 3000 variables.");
    expect(md).toMatch(/- _\d+ more lines left out/);
    expect(md).toMatch(/_1 more section left out/);
    expect(inert(md)).toEqual([]);
  });

  it("esc neutralises markdown and HTML", () => {
    expect(esc("a_b*c[d](e)<f>|`g`\\")).toBe("a\\_b\\*c\\[d\\](e)&lt;f&gt;&#124;&#96;g&#96;\\\\");
  });

  it("ciRunUrl reads each CI's variables", () => {
    expect(ciRunUrl({ GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "a/b", GITHUB_RUN_ID: "7" })).toBe("https://github.com/a/b/actions/runs/7");
    expect(ciRunUrl({ CI_JOB_URL: "https://gitlab.com/a/b/-/jobs/1" })).toBe("https://gitlab.com/a/b/-/jobs/1");
    expect(ciRunUrl({ CIRCLE_BUILD_URL: "https://circleci.com/x/1" })).toBe("https://circleci.com/x/1");
    expect(ciRunUrl({ BITBUCKET_GIT_HTTP_ORIGIN: "https://bitbucket.org/a/b", BITBUCKET_BUILD_NUMBER: "3" })).toBe("https://bitbucket.org/a/b/pipelines/results/3");
    expect(ciRunUrl({})).toBeUndefined();
  });
});
