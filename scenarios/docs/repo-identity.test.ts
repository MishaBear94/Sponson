/**
 * The project's GitHub address lives in one place: `repository.url` in the root package.json.
 * Every link to this project — README badges, docs links, the JSON Schema URL, `uses: <owner>/<repo>/action@…`,
 * package metadata, the release workflow's repository guard — must use exactly that owner/name, so moving the
 * project is a one-line change that this test then walks you through.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { repository: { url: string } };
const canonical = /github\.com\/([^/]+\/[^/.]+)/.exec(root.repository.url)?.[1] ?? "";
const repoName = canonical.split("/")[1] ?? "";

/** Every text file a contributor would commit (no git needed: the scaffold's test runs this in a plain copy). */
const SKIP = new Set(["node_modules", "dist", "coverage", ".git", ".sponson", "brainstorm"]);
function walk(dir: string, rel = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name)) return [];
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(join(dir, e.name), r) : [r];
  });
}
const files = walk(REPO).filter((f) => !f.endsWith("pnpm-lock.yaml") && /\.(md|ya?ml|json|ts|tmpl|mjs)$/.test(f));

/** owner/name references to a repository called like this project, in any of the forms we write. */
const PATTERNS = [
  /github\.com\/([\w.-]+\/[\w.-]+)/g,
  /raw\.githubusercontent\.com\/([\w.-]+\/[\w.-]+)/g,
  /uses:\s*([\w.-]+\/[\w.-]+)\/action@/g,
  /github\.repository\s*==\s*'([\w.-]+\/[\w.-]+)'/g,
];

describe("repository identity", () => {
  it("has a canonical owner/name in the root package.json", () => {
    expect(canonical).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });

  it("every package points at the same repository", () => {
    for (const p of ["core", "adapters", "sim", "cli"]) {
      const pkg = JSON.parse(readFileSync(join(REPO, `packages/${p}/package.json`), "utf8")) as { repository?: { url?: string } };
      expect(pkg.repository?.url, `packages/${p}/package.json repository.url`).toBe(root.repository.url);
    }
  });

  it("every package has the project's homepage and npm keywords", () => {
    const home = (JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { homepage?: string }).homepage;
    expect(home, "root package.json homepage").toMatch(/^https:\/\//);
    for (const p of ["core", "adapters", "sim", "cli"]) {
      const pkg = JSON.parse(readFileSync(join(REPO, `packages/${p}/package.json`), "utf8")) as { homepage?: string; keywords?: string[] };
      expect(pkg.homepage, `packages/${p}/package.json homepage`).toBe(home);
      expect(pkg.keywords?.length, `packages/${p}/package.json keywords (how npm search finds it)`).toBeGreaterThan(0);
      const publish = (pkg as { publishConfig?: { provenance?: boolean; access?: string } }).publishConfig;
      // The release workflow sets NPM_CONFIG_PROVENANCE, but `changeset publish` runs `pnpm publish`, which ignores it.
      expect(publish?.provenance, `packages/${p}/package.json publishConfig.provenance (npm provenance on publish)`).toBe(true);
      expect(publish?.access, `packages/${p}/package.json publishConfig.access`).toBe("public");
    }
  });

  it("a package README that names a Node.js version names the one its engines require", () => {
    for (const p of ["core", "adapters", "sim", "cli"]) {
      const pkg = JSON.parse(readFileSync(join(REPO, `packages/${p}/package.json`), "utf8")) as { engines?: { node?: string } };
      const required = /\d+/.exec(pkg.engines?.node ?? "")?.[0];
      const readme = readFileSync(join(REPO, `packages/${p}/README.md`), "utf8");
      for (const m of readme.matchAll(/Node\.js (\d+)/g)) expect(m[1], `packages/${p}/README.md says Node.js ${m[1]}; engines.node is ${pkg.engines?.node}`).toBe(required);
    }
  });

  it("every link to this project uses the canonical owner/name", () => {
    const wrong: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(REPO, f), "utf8");
      for (const re of PATTERNS) {
        for (const m of text.matchAll(re)) {
          const ref = m[1]!.replace(/\.git$/, "");
          const name = ref.split("/")[1] ?? "";
          if (name.toLowerCase() === repoName.toLowerCase() && ref !== canonical) wrong.push(`${f}: ${ref} (expected ${canonical})`);
        }
      }
    }
    expect(wrong, "links to this project with a different owner/name — update them to match package.json").toEqual([]);
  });
});
