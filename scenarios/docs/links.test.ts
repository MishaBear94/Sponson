/**
 * The prose docs point into the code and into each other. When a file moves or a heading is renamed, these pointers
 * break silently; this suite makes them fail: every relative Markdown link must resolve to a file, every `#anchor`
 * must name a heading of its target, and every repo path written in backticks (`packages/core/src/engine/apply.ts`)
 * must exist. Links to this repository on GitHub (`https://github.com/MishaBear94/Sponson/blob/main/<path>#anchor`, used
 * by files that are read outside the repo, such as SKILL.md and package READMEs) are checked like relative ones.
 */
import { access, readdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { slug } from "../../scripts/gen-docs.js";
import { REPO } from "./plans.js";

async function markdownFiles(): Promise<string[]> {
  const out = ["README.md", "ARCHITECTURE.md", "CONTRIBUTING.md", "SKILL.md", "examples/README.md"].map((f) => join(REPO, f));
  for (const pkg of await readdir(join(REPO, "packages"))) {
    const readme = join(REPO, "packages", pkg, "README.md");
    if (await exists(readme)) out.push(readme);
  }
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

/** This repository on GitHub; links under it are checked against the working tree. */
const GITHUB_BLOB = "https://github.com/MishaBear94/Sponson/blob/main/";

/** The anchors GitHub generates for a Markdown file's headings (outside code fences), duplicates suffixed `-1`, `-2`. */
async function anchorsOf(file: string): Promise<Set<string>> {
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]!.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
    const n = seen.get(base) ?? 0;
    seen.set(n === 0 ? base : `${base}-${n}`, 0);
    seen.set(base, n + 1);
  }
  return new Set(seen.keys());
}

describe.each((await markdownFiles()).map((f) => [relative(REPO, f), f] as const))("%s", (_rel, file) => {
  it("links, anchors and repo paths resolve", async () => {
    const text = await readFile(file, "utf8");
    const broken: string[] = [];
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = m[1]!;
      const local = link.startsWith(GITHUB_BLOB) ? join(REPO, link.slice(GITHUB_BLOB.length)) : link;
      if (local === link && /^[a-z]+:/i.test(link)) continue; // other http(s), mailto
      const [path, anchor] = local.split("#") as [string, string | undefined];
      const target = path === "" ? file : local === link ? join(dirname(file), path) : path;
      if (!(await exists(target))) {
        broken.push(`link ${link}`);
        continue;
      }
      if (anchor && target.endsWith(".md") && !(await anchorsOf(target)).has(anchor)) broken.push(`anchor ${link}`);
    }
    for (const m of text.matchAll(REPO_PATH)) {
      const path = m[1]!.replace(/[.,:]+$/, "");
      if (/[<>*]/.test(path)) continue; // a pattern such as scenarios/<category>/<name>.yaml
      if (!(await exists(join(REPO, path)))) broken.push(`path ${path}`);
    }
    expect(broken).toEqual([]);
  });
});
