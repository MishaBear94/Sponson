import { setTimeout as sleep } from "node:timers/promises";
import { SponsonError } from "../errors.js";
import { LockHeldError, LockLostError, type LockInfo, type Receipt } from "../types.js";
import type { RunOptions } from "./types.js";

/**
 * The scope lock held as a lease: renewed in the background while the run works, and
 * every receipt write is fenced on it. A run that lost its lease stops before writing.
 *
 * The holder also keeps its own view of when the lease runs out (measured from when each
 * acquire/renew was *sent*). Once a slow store has let that get close, the holder stops on its
 * own: another run may legitimately take an expired lock, and the store's verdict on a late
 * renewal arrives too late to prevent two runs writing to the same scope.
 */
export class Lease {
  private timer: NodeJS.Timeout | null = null;
  private lost: LockLostError | null = null;
  private released = false;
  /** Local deadline after which another run may have taken the lock. */
  private validUntil: number;

  private constructor(
    private readonly opts: RunOptions,
    readonly holder: string,
    readonly preempted: LockInfo | null,
    private readonly ttl: number,
    sentAt: number,
  ) {
    this.validUntil = sentAt + ttl;
  }

  static async acquire(opts: RunOptions, holder: string): Promise<Lease> {
    const ttl = opts.lockTtlMs ?? 15 * 60 * 1000;
    const deadline = Date.now() + (opts.waitTimeoutMs ?? 10 * 60 * 1000);
    for (;;) {
      try {
        const sentAt = Date.now();
        const preempted = await opts.store.acquireLock(opts.ctx.env, opts.ctx.scope, holder, ttl);
        const lease = new Lease(opts, holder, preempted, ttl, sentAt);
        lease.startRenewing();
        return lease;
      } catch (e) {
        if (!(e instanceof LockHeldError)) throw e;
        if (!opts.wait || Date.now() > deadline) {
          throw new SponsonError("LOCK_HELD", `Another run (${e.lock.holder}) holds the lock for ${opts.ctx.env}/${opts.ctx.scope} until ${e.lock.expiresAt}. Wait for it, or run again with waiting enabled (wait).`, { lock: e.lock });
        }
        await sleep(opts.pollIntervalMs ?? 2000);
      }
    }
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
        this.opts.store
          .renewLock(this.opts.ctx.env, this.opts.ctx.scope, this.holder, this.ttl)
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
   * Guard for writes to PROVIDERS, which cannot be fenced: throw LOCK_LOST when another run took the scope, or
   * could have by now because our renewals stopped getting through (the holder's own deadline).
   */
  assertHeld(): void {
    if (this.lost) throw lockLost(this.lost);
    const margin = this.ttl / 5;
    if (Date.now() >= this.validUntil - margin) {
      throw lockLost(new LockLostError(this.holder, null), "the lease was about to expire because renewals were not getting through");
    }
  }

  /**
   * Write the receipt. Receipts ARE fenced: the store checks atomically that we still hold the lock, which is the
   * authoritative answer — so the holder's local deadline (a guess, for unfenceable provider writes) does not apply
   * here. A run whose renewals lagged but whose lock nobody took still records everything it did.
   */
  async write(receipt: Receipt): Promise<void> {
    if (this.lost) throw lockLost(this.lost);
    try {
      await this.opts.store.write(receipt, { holder: this.holder });
    } catch (e) {
      if (e instanceof LockLostError) throw lockLost(e);
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

  async release(): Promise<void> {
    this.released = true;
    if (this.timer) clearTimeout(this.timer);
    await this.opts.store.releaseLock(this.opts.ctx.env, this.opts.ctx.scope, this.holder).catch(() => {});
  }
}

function lockLost(e: LockLostError, why?: string): SponsonError {
  const what = why ? `This run stopped: ${why}` : e.message;
  return new SponsonError("LOCK_LOST", `${what}. This run stopped without writing further; the other run's receipt is authoritative. Re-run plan to see the current state.`, {
    holder: e.holder,
    current: e.current,
  });
}
