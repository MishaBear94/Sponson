import { chmod, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitWorkdir } from "./git-workdir.js";

describe("GitWorkdir.close", () => {
  it("never throws, even when the clone cannot be removed (the run's outcome is already decided)", async () => {
    const wd = new GitWorkdir("https://example.invalid/repo.git", undefined);
    await wd.init();
    const dir = wd.path;
    const stuck = join(dir, "stuck");
    await mkdir(stuck);
    await writeFile(join(stuck, "file"), "x");
    await chmod(stuck, 0o500); // its entries cannot be unlinked
    try {
      await expect(wd.close()).resolves.toBeUndefined();
      expect(wd.path).toBe(""); // the next use makes a fresh clone, never this one
    } finally {
      await chmod(stuck, 0o700).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes the clone it created", async () => {
    const wd = new GitWorkdir("https://example.invalid/repo.git", undefined);
    await wd.init();
    const dir = wd.path;
    await wd.close();
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
