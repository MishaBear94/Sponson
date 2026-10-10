/**
 * The documentation site (site/, published with Mintlify) is generated from the repository's Markdown by
 * scripts/gen-site.ts. This suite fails when:
 *
 *   - a generated file is out of date, or a generated page is left over from a source that is gone (run
 *     `pnpm site:gen`);
 *   - docs.json references a page, logo or favicon that does not exist, or a page is in no navigation group;
 *   - a page links somewhere that resolves nowhere: a site route with no page, an anchor with no heading (Mintlify's
 *     anchor rule), a relative path (Mintlify does not resolve them), or a repository path on GitHub that does not
 *     exist. `mint broken-links --check-anchors` checks the same from Mintlify's side.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generate, GENERATED_MARK, HAND_WRITTEN, GITHUB_BLOB, GITHUB_TREE, headingAnchors, mapLines, SITE, sitePages, stalePages } from "../../scripts/gen-site.js";
import { REPO } from "./plans.js";

const files = await generate();
const pages = await sitePages();
const config = JSON.parse(await readFile(join(REPO, SITE, "docs.json"), "utf8")) as Record<string, unknown>;

/** Every page string anywhere under `navigation`. */
function navPages(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(navPages);
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    return [...(Array.isArray(o.pages) ? o.pages.filter((p): p is string => typeof p === "string") : []), ...Object.values(o).flatMap((v) => (typeof v === "object" ? navPages(v) : []))];
  }
  return [];
}

const pageFile = (route: string) => [".mdx", ".md"].map((ext) => `${SITE}/${route}${ext}`).find((p) => existsSync(join(REPO, p)));

it("site/ is up to date with its sources (run pnpm site:gen)", async () => {
  const stale: string[] = [];
  for (const f of files) {
    const onDisk = await readFile(join(REPO, f.path), "utf8").catch(() => null);
    if (onDisk !== f.content) stale.push(f.path);
  }
  stale.push(...(await stalePages(files)).map((p) => `${p} (no longer generated)`));
  expect(stale, "run pnpm site:gen").toEqual([]);
});

it("docs.json references only pages and assets that exist, and every page is in the navigation", () => {
  const nav = navPages(config.navigation);
  expect(nav.length).toBeGreaterThan(0);
  expect(nav.filter((p) => !pageFile(p))).toEqual([]);
  expect(pages.filter((p) => !nav.includes(p.replace(/^site\//, "").replace(/\.mdx?$/, "")))).toEqual([]);
  const logo = config.logo as Record<string, string>;
  for (const asset of [logo.light!, logo.dark!, config.favicon as string]) expect(existsSync(join(REPO, SITE, asset)), asset).toBe(true);
});

it("generated pages carry the generated marker; the hand-written pages exist and do not", async () => {
  for (const f of files.filter((f) => f.path.endsWith(".mdx"))) expect(f.content, f.path).toContain(GENERATED_MARK);
  for (const route of HAND_WRITTEN) {
    const file = pageFile(route);
    expect(file, route).toBeDefined();
    expect(await readFile(join(REPO, file!), "utf8"), route).not.toContain(GENERATED_MARK);
  }
});

/** Links outside fenced code and code spans. */
function links(text: string): string[] {
  const out: string[] = [];
  const prose = mapLines(text, (line, fenced) => (fenced ? "" : line)).replace(/(`+)[\s\S]*?[^`]\1(?!`)/g, "");
  for (const m of prose.matchAll(/\]\(([^)\s]+)\)/g)) out.push(m[1]!);
  return out;
}

const anchorsByRoute = new Map<string, Set<string>>();
async function anchorsOf(file: string): Promise<Set<string>> {
  if (!anchorsByRoute.has(file)) anchorsByRoute.set(file, new Set((headingAnchors(await readFile(join(REPO, file), "utf8"))).values()));
  return anchorsByRoute.get(file)!;
}

describe.each([...pages, `${SITE}/README.md`].map((p) => [p] as const))("%s", (file) => {
  it("every link resolves", async () => {
    const text = await readFile(join(REPO, file), "utf8");
    const broken: string[] = [];
    for (const link of links(text)) {
      const [path, anchor] = link.split("#") as [string, string | undefined];
      if (link.startsWith(GITHUB_BLOB) || link.startsWith(GITHUB_TREE)) {
        if (!existsSync(join(REPO, path.slice(GITHUB_BLOB.length)))) broken.push(`${link} (no such file in the repository)`);
      } else if (/^[a-z][a-z0-9+.-]*:/i.test(link)) {
        continue;
      } else if (file === `${SITE}/README.md`) {
        // Read on GitHub, not published: relative links are fine there.
        if (!existsSync(join(REPO, SITE, path))) broken.push(link);
      } else if (link.startsWith("/") || link.startsWith("#")) {
        const target = link.startsWith("#") ? file : pageFile(path === "/" ? "index" : path.slice(1));
        if (!target) broken.push(`${link} (no such page)`);
        else if (anchor && !(await anchorsOf(target)).has(anchor)) broken.push(`${link} (no such heading)`);
      } else {
        broken.push(`${link} (relative links do not work on the site: use /route or a GitHub URL)`);
      }
    }
    expect(broken).toEqual([]);
  });
});
