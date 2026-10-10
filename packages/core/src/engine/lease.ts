import { setTimeout as sleep } from "node:timers/promises";
import { SponsonError } from "../errors.js";
import { PARENT_LOCKS_ENVIRONMENT, parentLockScope } from "../receipts/layout.js";
import { LockHeldError, LockLostError, type LockInfo, type Receipt, type ReceiptStore } from "../types.js";
import type { RunOptions } from "./types.js";

/** What a lease locks: the run's scope, or a shared parent object (ADR 0019). Same semantics, different key. */
export interface LockTarget {
  /** For messages: `preview/pr-42`, or `parent object auth0:acme:client:abc`. */
  readonly label: string;
  /** Set for a parent-object lock: its identity. */
  readonly parent?: string;
  acquire(holder: string, ttlMs: number): Promise<LockInfo | null>;
  renew(holder: string, ttlMs: number): Promise<void>;
  release(holder: string): Promise<void>;
}

/** The scope lock of the run. */
export function scopeTarget(opts: RunOptions): LockTarget {
  const { store, ctx } = opts;
  return {
    label: `${ctx.env}/${ctx.scope}`,
    acquire: (holder, ttl) => store.acquireLock(ctx.env, ctx.scope, holder, ttl),
    renew: (holder, ttl) => store.renewLock(ctx.env, ctx.scope, holder, ttl),
    release: (holder) => store.releaseLock(ctx.env, ctx.scope, holder),
  };
}

/**
 * The lock of a shared parent object, across every scope and environment. A store that does not implement the
 * parent-lock methods gets them from its scope-lock methods under the reserved environment (the same layout).
 */
export function parentTarget(store: ReceiptStore, parent: string): LockTarget {
  const scope = parentLockScope(parent);
  return {
    label: `parent object ${parent}`,
    parent,
    acquire: (holder, ttl) => (store.acquireParentLock ? store.acquireParentLock(parent, holder, ttl) : store.acquireLock(PARENT_LOCKS_ENVIRONMENT, scope, holder, ttl)),
    renew: (holder, ttl) => (store.renewParentLock ? store.renewParentLock(parent, holder, ttl) : store.renewLock(PARENT_LOCKS_ENVIRONMENT, scope, holder, ttl)),
    release: (holder) => (store.releaseParentLock ? store.releaseParentLock(parent, holder) : store.releaseLock(PARENT_LOCKS_ENVIRONMENT, scope, holder)),
  };
}

/**
 * A lock held as a lease (the scope's, or a parent object's): renewed in the background while the run works, and
 * every receipt write is fenced on the scope's lease. A run that lost its lease stops before writing.
 *
 * The holder also keeps its own view of when the lease runs out (measured from when each
 * acquire/renew was *sent*). Once a slow store has let that get close, the holder stops on its
 * own: another run may legitimately take an expired lock, and the store's verdict on a late
 * renewal arrives too late to prevent two runs writing to the same scope (or parent object).
 */
export class Lease {
  private timer: NodeJS.Timeout | null = null;
  private lost: LockLostError | null = null;
  private released = false;
  /** Local deadline after which another run may have taken the lock. */
  private validUntil: number;

  private constructor(
    private readonly opts: RunOptions,
    private readonly target: LockTarget,
    readonly holder: string,
    readonly preempted: LockInfo | null,
    private readonly ttl: number,
    sentAt: number,
  ) {
    this.validUntil = sentAt + ttl;
  }

  /**
   * Take the lock of `target` (the run's scope by default) or fail with LOCK_HELD; when `wait` (by default the
   * run's `wait` option), poll until it is free or the wait times out.
   */
  static async acquire(opts: RunOptions, holder: string, target: LockTarget = scopeTarget(opts), wait = opts.wait === true): Promise<Lease> {
    const ttl = opts.lockTtlMs ?? 15 * 60 * 1000;
    const deadline = Date.now() + (opts.waitTimeoutMs ?? 10 * 60 * 1000);
    for (;;) {
      try {
        const sentAt = Date.now();
        const preempted = await target.acquire(holder, ttl);
        const lease = new Lease(opts, target, holder, preempted, ttl, sentAt);
        lease.startRenewing();
        return lease;
      } catch (e) {
        if (!(e instanceof LockHeldError)) throw e;
        if (!wait || Date.now() > deadline) {
          throw new SponsonError("LOCK_HELD", `Another run (${e.lock.holder}) holds the lock for ${target.label} until ${e.lock.expiresAt}. Wait for it, or run again with waiting enabled (wait).`, {
            lock: e.lock,
            ...(target.parent ? { parent: target.parent } : {}),
          });
        }
        await sleep(opts.pollIntervalMs ?? 2000);
      }
    }
  }

  /** The parent object this lease locks; undefined for the scope lock. */
  get parent(): string | undefined {
    return this.target.parent;
  }

  /**
   * Renewal paces itself: the next renewal is scheduled only after the previous one finished.
   * A fixed interval would queue renewals faster than a slow store (a git push under load) can
   * complete them, and the run's own receipt writes would wait behind that queue.
   */
  private startRenewing(): void {
    const every = Math.max(50, Math.floor(this.ttl / 3));
    const tick = () => {
      this.timer = setTimeout(() => {
        const sentAt = Date.now();
        this.target
          .renew(this.holder, this.ttl)
          .then(() => {
            this.validUntil = sentAt + this.ttl;
          })
          .catch((e) => {
            if (e instanceof LockLostError) this.lost = e;
          })
          .finally(() => {
            if (!this.released && !this.lost) tick();
          });
      }, every);
      this.timer.unref();
    };
    tick();
  }

  /**
   * Guard for writes to PROVIDERS, which cannot be fenced: throw LOCK_LOST when another run took the lock, or
   * could have by now because our renewals stopped getting through (the holder's own deadline).
   */
  assertHeld(): void {
    if (this.lost) throw lockLost(this.lost, this.target);
    const margin = this.ttl / 5;
    if (Date.now() >= this.validUntil - margin) {
      throw lockLost(new LockLostError(this.holder, null), this.target, `the lease${this.target.parent ? ` on ${this.target.label}` : ""} was about to expire because renewals were not getting through`);
    }
  }

  /**
   * Write the receipt. Receipts ARE fenced: the store checks atomically that we still hold the lock, which is the
   * authoritative answer — so the holder's local deadline (a guess, for unfenceable provider writes) does not apply
   * here. A run whose renewals lagged but whose lock nobody took still records everything it did.
   */
  async write(receipt: Receipt): Promise<void> {
    if (this.lost) throw lockLost(this.lost, this.target);
    try {
      await this.opts.store.write(receipt, { holder: this.holder });
    } catch (e) {
      if (e instanceof LockLostError) throw lockLost(e, this.target);
      throw e;
    }
  }

  /** `write` for a run that is already stopping: never throws, reports whether the receipt landed. */
  async writeIfStillHeld(receipt: Receipt): Promise<boolean> {
    try {
      await this.write(receipt);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stop renewing and release the lock, retrying a failed release a few times. Returns a warning when it still
   * failed: the lock then stays held until the lease expires, and the user must be told, not left to find out
   * from the next run's LOCK_HELD.
   */
  async release(): Promise<string | undefined> {
    this.released = true;
    if (this.timer) clearTimeout(this.timer);
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.target.release(this.holder);
        return undefined;
      } catch (e) {
        last = e;
        await sleep(200 * 2 ** attempt);
      }
    }
    const until = new Date(this.validUntil).toISOString();
    const who = this.target.parent ? "runs writing this parent object" : "runs on this scope";
    return `Could not release the lock for ${this.target.label} (${last instanceof Error ? last.message : String(last)}); it stays held until about ${until}, and ${who} get LOCK_HELD until then.`;
  }
}

/**
 * Run `fn` holding the lease of the shared parent object `parent` (ADR 0019), or without any when `parent` is
 * undefined. The lease is released in every case; a release that keeps failing becomes a warning, as for the scope
 * lock. `wait` defaults to the run's `wait` option.
 */
export async function withParentLock<T>(opts: RunOptions, holder: string, parent: string | undefined, warnings: string[], fn: (lease: Lease | null) => Promise<T>, wait?: boolean): Promise<T> {
  if (!parent) return fn(null);
  const lease = await Lease.acquire(opts, holder, parentTarget(opts.store, parent), wait);
  try {
    return await fn(lease);
  } finally {
    const warning = await lease.release();
    if (warning) warnings.push(warning);
  }
}

/** True for the LOCK_LOST of a parent-object lease: the line stops, the scope (and its receipt) is still ours. */
export function isParentLockLoss(e: unknown): boolean {
  return e instanceof SponsonError && e.code === "LOCK_LOST" && typeof e.details.parent === "string";
}

function lockLost(e: LockLostError, target: LockTarget, why?: string): SponsonError {
  if (target.parent) {
    const what = why ? `This line stopped: ${why}` : `The lock for ${target.label} is no longer held by ${e.holder}${e.current ? ` (now ${e.current.holder})` : ""}`;
    return new SponsonError("LOCK_LOST", `${what}. The line stopped before writing further.`, { holder: e.holder, current: e.current, parent: target.parent });
  }
  const what = why ? `This run stopped: ${why}` : e.message;
  return new SponsonError("LOCK_LOST", `${what}. This run stopped without writing further; the other run's receipt is authoritative. Re-run plan to see the current state.`, {
    holder: e.holder,
    current: e.current,
  });
}
