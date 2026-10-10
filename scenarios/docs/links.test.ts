/**
 * The prose docs point into the code. When a file moves, these pointers break silently; this suite makes them fail:
 * every relative Markdown link must resolve to a file, and every repo path written in backticks
 * (`packages/core/src/engine/apply.ts`) must exist.
 */
import { access, readdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO } from "./plans.js";

async function markdownFiles(): Promise<string[]> {
  const out = ["README.md", "ARCHITECTURE.md", "CONTRIBUTING.md", "examples/README.md"].map((f) => join(REPO, f));
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".md")) out.push(p);
    }
  };
  await walk(join(REPO, "docs"));
  return out;
}

const exists = (p: string) => access(p).then(() => true, () => false);

/** Prefixes of repository paths worth checking when they appear in backticks. */
const REPO_PATH = /`((?:packages|scenarios|property|schema|scripts|examples|docs|action)\/[A-Za-z0-9_./<>*-]+)`/g;

describe.each((await markdownFiles()).map((f) => [relative(REPO, f), f] as const))("%s", (_rel, file) => {
  it("links and repo paths resolve", async () => {
    const text = await readFile(file, "utf8");
    const broken: string[] = [];
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1]!.split("#")[0]!;
      if (!target || /^[a-z]+:/i.test(target)) continue; // anchors only, or http(s)/mailto
      if (!(await exists(join(dirname(file), target)))) broken.push(`link ${m[1]}`);
    }
    for (const m of text.matchAll(REPO_PATH)) {
      const path = m[1]!.replace(/[.,:]+$/, "");
      if (/[<>*]/.test(path)) continue; // a pattern such as scenarios/<category>/<name>.yaml
      if (!(await exists(join(REPO, path)))) broken.push(`path ${path}`);
    }
    expect(broken).toEqual([]);
  });
});
