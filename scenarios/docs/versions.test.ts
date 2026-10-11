/**
 * The front-door docs never name a Sponson version as an example: an example version is the one current when it
 * was written, and reads as a recommendation long after (the action's `version` input said "e.g. `0.4.0`" at 0.9.0).
 * They say how to find the version instead, or name the current one. Pins a reader is told to replace, and "X and
 * later" feature notes, live in integrations/ and are not checked here.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO } from "./plans.js";

const VERSION = (JSON.parse(await readFile(join(REPO, "packages/cli/package.json"), "utf8")) as { version: string }).version;
const DOCS = ["README.md", "action/README.md", "SKILL.md"];

describe("no stale example versions", () => {
  it.each(DOCS)("%s names no Sponson version but the current one", async (doc) => {
    const text = await readFile(join(REPO, doc), "utf8");
    const versions = [...text.matchAll(/(?<![\w./-])\d+\.\d+\.\d+(?![\w.-])/g)].map((m) => m[0]);
    expect(versions.filter((v) => v !== VERSION), doc).toEqual([]);
  });
});
