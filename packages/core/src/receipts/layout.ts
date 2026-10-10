import { SponsonError } from "../errors.js";
import type { LedgerEntry, LockInfo, Receipt, ReceiptLine } from "../types.js";

// Both receipt stores share one directory layout:
//
//   <environment>/<scope>/latest.json
//   <environment>/<scope>/<runId>.json
//   <environment>/<scope>/lock.json
//
// The path helpers below are exported so a custom `ReceiptStore` can use the same layout.

/** `<environment>/<scope>`, each segment made filesystem-safe. */
export function receiptDir(environment: string, scope: string): string {
  return `${safeSegment(environment)}/${safeSegment(scope)}`;
}

/** Path of a scope's latest receipt, relative to the store root. */
export function latestPath(environment: string, scope: string): string {
  return `${receiptDir(environment, scope)}/latest.json`;
}

/** Path of one run's receipt, relative to the store root. */
export function runPath(environment: string, scope: string, runId: string): string {
  return `${receiptDir(environment, scope)}/${safeSegment(runId)}.json`;
}

/** Path of a scope's lock, relative to the store root. */
export function lockPath(environment: string, scope: string): string {
  return `${receiptDir(environment, scope)}/lock.json`;
}

/** One path segment made filesystem-safe: every run of characters outside `[a-zA-Z0-9._-]` becomes `-`. */
export function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

/** The receipt format this Sponson writes. `parseReceipt` reads this and every older version. */
export const RECEIPT_VERSION = 2;

/**
 * Parse a receipt of any version this Sponson understands and return it as the current (v2) shape.
 * Version 1 receipts are migrated in memory; they are written back as v2 by the next run.
 */
export function parseReceipt(text: string, where: string): Receipt {
  const { r, version } = readVersioned(text, where);
  if (!isRecord(r.lines) || typeof r.scope !== "string" || !r.scope || typeof r.environment !== "string" || !r.environment) {
    throw new SponsonError("RECEIPT_CORRUPT", `Receipt at ${where} is missing required fields`, { where });
  }
  // The checks here are the whole validation; past them the file is trusted to have the shape its version says.
  if (version === 1) return migrateV1(r as unknown as ReceiptV1);
  if (!Array.isArray(r.ledger) || !Array.isArray(r.history) || typeof r.hashKey !== "string") {
    throw new SponsonError("RECEIPT_CORRUPT", `Receipt at ${where} is missing required fields (ledger, history, hashKey)`, { where });
  }
  return r as unknown as Receipt;
}

/** The JSON object in `text` and its format version, which must be one this Sponson reads. */
function readVersioned(text: string, where: string): { r: Record<string, unknown>; version: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new SponsonError("RECEIPT_CORRUPT", `Receipt at ${where} is not valid JSON: ${(e as Error).message}`, { where });
  }
  if (!isRecord(parsed) || typeof parsed.version !== "number") {
    throw new SponsonError("RECEIPT_CORRUPT", `Receipt at ${where} has no version field`, { where });
  }
  const version = parsed.version;
  if (version > RECEIPT_VERSION) {
    throw new SponsonError(
      "RECEIPT_VERSION",
      `Receipt at ${where} is version ${version}; this Sponson understands versions 1-${RECEIPT_VERSION}. Upgrade Sponson.`,
      { where, version },
    );
  }
  if (version < 1 || !Number.isInteger(version)) {
    throw new SponsonError("RECEIPT_CORRUPT", `Receipt at ${where} has an invalid version ${String(version)}`, { where });
  }
  return { r: parsed, version };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The v1 shape: per-line resources only, no ledger. Lines are read leniently (null lines, missing ids, resources
 * or outputs are tolerated), since nothing but the top level was ever validated.
 */
type ReceiptV1 = Omit<Receipt, "version" | "ledger" | "history" | "hashKey" | "lines" | "ctx"> & {
  version: 1;
  ctx?: { git?: { sha?: string } };
  lines: Record<string, ReceiptLineV1 | null>;
};
type ReceiptLineV1 = Pick<ReceiptLine, "adapter" | "op" | "status"> & Partial<Omit<ReceiptLine, "adapter" | "op" | "status">>;

/**
 * v1 → v2: the ledger is rebuilt from each line's resources. The provider block was not recorded in v1,
 * so it is `{}` (unknown); `hashKey: ""` means the hashes are raw sha256 with no key.
 * Lines of a destroy that report `destroyed` no longer manage anything.
 */
export function migrateV1(r: ReceiptV1): Receipt {
  const ledger: LedgerEntry[] = [];
  const seen = new Set<string>();
  for (const [lineId, line] of Object.entries(r.lines)) {
    if (!line || line.status === "destroyed") continue;
    for (const res of line.resources ?? []) {
      const identity = `${line.adapter}\u0000${res.key}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      ledger.push(ledgerEntryV1(lineId, line, res));
    }
  }
  const at = r.finishedAt || r.startedAt;
  const history = r.ctx?.git?.sha ? [{ sha: r.ctx.git.sha, at }] : [];
  // Lines and ctx are carried over as they were: the next run writes complete ones.
  return { ...r, version: 2, ledger, history, hashKey: "" } as Receipt;
}

/** One v1 line resource as a v2 ledger entry. */
function ledgerEntryV1(lineId: string, line: ReceiptLineV1, res: NonNullable<ReceiptLineV1["resources"]>[number]): LedgerEntry {
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
  return entry;
}

/** Parse a stored lock; null when it is missing or unreadable (an unreadable lock counts as absent). */
export function parseLock(text: string): LockInfo | null {
  try {
    const l = JSON.parse(text) as LockInfo;
    if (typeof l.holder === "string" && typeof l.expiresAt === "string") return l;
  } catch {
    /* treat unreadable lock as absent */
  }
  return null;
}

/** True when the lock's lease ran out, so another run may take it over. */
export function lockExpired(lock: LockInfo, now = Date.now()): boolean {
  return Date.parse(lock.expiresAt) <= now;
}

/**
 * The on-disk form of receipts and locks: pretty JSON with a trailing newline, so diffs on the receipts branch
 * read well.
 */
export function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
