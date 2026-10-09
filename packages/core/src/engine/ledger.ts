import { createHmac, randomBytes } from "node:crypto";
import { canonicalJson } from "../hash.js";
import type { LedgerEntry, Receipt } from "../types.js";

/**
 * Everything Sponson knows about in one environment+scope, keyed by resource identity
 * (adapter + provider block + adapter key) — independent of plan lines and of any single run.
 *
 * A run starts from the previous ledger and only changes entries it observed or wrote,
 * so failed, skipped and waiting lines never make Sponson forget what it owns.
 */
export class Ledger {
  private readonly entries = new Map<string, LedgerEntry>();

  constructor(
    /** Key for value hashes; "" means raw sha256 (receipts migrated from v1). */
    readonly hashKey: string,
    entries: LedgerEntry[] = [],
  ) {
    for (const e of entries) this.entries.set(identity(e.adapter, e.provider, e.key), { ...e });
  }

  static from(previous: Receipt | null): Ledger {
    return previous ? new Ledger(previous.hashKey, previous.ledger) : new Ledger(randomBytes(16).toString("hex"));
  }

  /** The stored form of an adapter's raw sha256 value hash. */
  keyed(rawHash: string): string {
    return this.hashKey ? createHmac("sha256", this.hashKey).update(rawHash).digest("hex") : rawHash;
  }

  get(adapter: string, provider: Record<string, unknown>, key: string): LedgerEntry | undefined {
    return this.entries.get(identity(adapter, provider, key));
  }

  /** Insert or replace; an existing entry keeps its position so destroy order stays creation order. */
  put(entry: LedgerEntry): LedgerEntry {
    this.entries.set(identity(entry.adapter, entry.provider, entry.key), entry);
    return entry;
  }

  delete(entry: Pick<LedgerEntry, "adapter" | "provider" | "key">): void {
    this.entries.delete(identity(entry.adapter, entry.provider, entry.key));
  }

  all(): LedgerEntry[] {
    return [...this.entries.values()];
  }

  /** Entries Sponson would destroy with the scope. Intents are included: if they exist, they are ours. */
  owned(): LedgerEntry[] {
    return this.all().filter((e) => e.createdBy !== "adopted");
  }

  toJSON(): LedgerEntry[] {
    return this.all().map((e) => ({ ...e }));
  }
}

export function identity(adapter: string, provider: Record<string, unknown>, key: string): string {
  return `${adapter}|${canonicalJson(provider)}|${key}`;
}
