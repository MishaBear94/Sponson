import { SponsonError } from "../errors.js";
import type { LockInfo, Receipt } from "../types.js";

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

export function parseReceipt(text: string, where: string): Receipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new SponsonError("RECEIPT_CORRUPT", `Receipt at ${where} is not valid JSON: ${(e as Error).message}`, { where });
  }
  const r = parsed as Partial<Receipt>;
  if (typeof r !== "object" || r === null || typeof r.version !== "number") {
    throw new SponsonError("RECEIPT_CORRUPT", `Receipt at ${where} has no version field`, { where });
  }
  if (r.version > 1) {
    throw new SponsonError("RECEIPT_VERSION", `Receipt at ${where} is version ${r.version}; this Sponson understands version 1. Upgrade Sponson.`, {
      where,
      version: r.version,
    });
  }
  if (!r.lines || typeof r.lines !== "object" || !r.scope || !r.environment) {
    throw new SponsonError("RECEIPT_CORRUPT", `Receipt at ${where} is missing required fields`, { where });
  }
  return r as Receipt;
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
