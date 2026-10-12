/**
 * No tracked file holds a string shaped like a real provider credential or account id. GitHub push protection scans
 * every pushed commit for these shapes and refuses the push, so an example value that merely looks real (a Twilio
 * Account SID in a recipe's example, say) blocks the release. Examples use obvious placeholders instead
 * (`ACxxxxxxxx…`).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SHAPES: Record<string, RegExp> = {
  "Twilio Account SID": /\bAC[0-9a-f]{32}\b/,
  "Twilio API key SID": /\bSK[0-9a-f]{32}\b/,
  "AWS access key id": /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  "GitHub token": /\bgh[pousr]_[0-9A-Za-z]{36}\b/,
  "Stripe live key": /\b(sk|rk)_live_[0-9A-Za-z]{16,}\b/,
  "Slack token": /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/,
};

/** Shapes that are fixed, published fakes (the AWS docs' example key), not credentials. */
const ALLOWED = new Set(["AKIAIOSFODNN7EXAMPLE"]);

const root = new URL("../..", import.meta.url);
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((f) => f !== "" && !/\.(png|jpe?g|gif|ico|woff2?|lockb?)$/.test(f) && f !== "pnpm-lock.yaml");

describe("tracked files", () => {
  it("hold no credential-shaped strings", () => {
    const hits: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(new URL(f, root), "utf8");
      } catch {
        continue; // removed in the working tree but still in the index
      }
      for (const [kind, shape] of Object.entries(SHAPES)) {
        for (const m of text.matchAll(new RegExp(shape.source, "g"))) if (!ALLOWED.has(m[0])) hits.push(`${f}: ${kind}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
