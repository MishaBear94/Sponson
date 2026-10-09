import { SponsonError } from "../errors.js";
import type { LedgerEntry, LockInfo, Receipt } from "../types.js";

/**
 * Both receipt stores share one directory layout:
 *
 *   <environment>/<scope>/latest.json
 *   <environment>/<scope>/<runId>.json
 *   <environment>/<scope>/lock.json
 */
export function receiptDir(environment: string, scope: string): string {
  return `${safe(environment)}/${safe(scope)}`;
}

export function latestPath(environment: string, scope: string): string {
  return `${receiptDir(environment, scope)}/latest.json`;
}

export function runPath(environment: string, scope: string, runId: string): string {
  return `${receiptDir(environment, scope)}/${safe(runId)}.json`;
}

export function lockPath(environment: string, scope: string): string {
  return `${receiptDir(environment, scope)}/lock.json`;
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export const RECEIPT_VERSION = 2;

/**
 * Parse a receipt of any version this Sponson understands and return it as the current (v2) shape.
 * Version 1 receipts are migrated in memory; they are written back as v2 by the next run.
 */
export function parseReceipt(text: string, where: string): Receipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new SponsonError("RECEIPT_CORRUPT", `Receipt at ${where} is not valid JSON: ${(e as Error).message}`, { where });
  }
  const r = parsed as Record<string, unknown>;
  if (typeof r !== "object" || r === null || Array.isArray(r) || typeof r.version !== "number") {
    throw new SponsonError("RECEIPT_CORRUPT", `Receipt at ${where} has no version field`, { where });
  }
  if (r.version > RECEIPT_VERSION) {
    throw new SponsonError(
      "RECEIPT_VERSION",
      `Receipt at ${where} is version ${r.version}; this Sponson understands versions 1-${RECEIPT_VERSION}. Upgrade Sponson.`,
      { where, version: r.version },
    );
  }
  if (r.version < 1 || !Number.isInteger(r.version)) {
    throw new SponsonError("RECEIPT_CORRUPT", `Receipt at ${where} has an invalid version ${String(r.version)}`, { where });
  }
  if (!r.lines || typeof r.lines !== "object" || Array.isArray(r.lines) || typeof r.scope !== "string" || !r.scope || typeof r.environment !== "string" || !r.environment) {
    throw new SponsonError("RECEIPT_CORRUPT", `Receipt at ${where} is missing required fields`, { where });
  }
  if (r.version === 1) return migrateV1(r as unknown as ReceiptV1);
  if (!Array.isArray(r.ledger) || !Array.isArray(r.history) || typeof r.hashKey !== "string") {
    throw new SponsonError("RECEIPT_CORRUPT", `Receipt at ${where} is missing required fields (ledger, history, hashKey)`, { where });
  }
  return r as unknown as Receipt;
}

/** The v1 shape: per-line resources only, no ledger. */
type ReceiptV1 = Omit<Receipt, "version" | "ledger" | "history" | "hashKey"> & { version: 1 };

/**
 * v1 → v2: the ledger is rebuilt from each line's resources. The provider block was not recorded in v1,
 * so it is `{}` (unknown); `hashKey: ""` means the hashes are raw sha256 with no key.
 * Lines of a destroy that report `destroyed` no longer manage anything.
 */
export function migrateV1(r: ReceiptV1): Receipt {
  const ledger: LedgerEntry[] = [];
  const seen = new Set<string>();
  for (const [lineId, line] of Object.entries(r.lines ?? {})) {
    if (!line || line.status === "destroyed") continue;
    for (const res of line.resources ?? []) {
      const identity = `${line.adapter}\u0000${res.key}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const entry: LedgerEntry = {
        adapter: line.adapter,
        op: line.op,
        provider: {},
        key: res.key,
        id: res.id,
        hash: res.hash,
        createdBy: res.createdBy ?? line.createdBy ?? "adopted",
        line: line.id ?? lineId,
        outputs: { ...(line.outputs ?? {}) },
      };
      if (res.label !== undefined) entry.label = res.label;
      if (line.orphan) entry.orphan = true;
      ledger.push(entry);
    }
  }
  const at = r.finishedAt || r.startedAt;
  const history = r.ctx?.git?.sha ? [{ sha: r.ctx.git.sha, at }] : [];
  return { ...r, version: 2, ledger, history, hashKey: "" };
}

export function parseLock(text: string): LockInfo | null {
  try {
    const l = JSON.parse(text) as LockInfo;
    if (typeof l.holder === "string" && typeof l.expiresAt === "string") return l;
  } catch {
    /* treat unreadable lock as absent */
  }
  return null;
}

export function lockExpired(lock: LockInfo, now = Date.now()): boolean {
  return Date.parse(lock.expiresAt) <= now;
}

export function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
