import { SponsonError } from "../errors.js";
import { LockHeldError, LockLostError, type LockInfo, type Receipt } from "../types.js";
import type { RunOptions } from "./types.js";

/**
 * The scope lock held as a lease: renewed in the background while the run works, and
 * every receipt write is fenced on it. A run that lost its lease stops before writing.
 */
export class Lease {
  private timer: NodeJS.Timeout | null = null;
  private lost: LockLostError | null = null;

  private constructor(
    private readonly opts: RunOptions,
    readonly holder: string,
    readonly preempted: LockInfo | null,
    private readonly ttl: number,
  ) {}

  static async acquire(opts: RunOptions, holder: string): Promise<Lease> {
    const ttl = opts.lockTtlMs ?? 15 * 60 * 1000;
    const deadline = Date.now() + (opts.waitTimeoutMs ?? 10 * 60 * 1000);
    for (;;) {
      try {
        const preempted = await opts.store.acquireLock(opts.ctx.env, opts.ctx.scope, holder, ttl);
        const lease = new Lease(opts, holder, preempted, ttl);
        lease.startRenewing();
        return lease;
      } catch (e) {
        if (!(e instanceof LockHeldError)) throw e;
        if (!opts.wait || Date.now() > deadline) {
          throw new SponsonError("LOCK_HELD", `Another run (${e.lock.holder}) holds the lock for ${opts.ctx.env}/${opts.ctx.scope} until ${e.lock.expiresAt}. Wait for it, or pass --wait.`, { lock: e.lock });
        }
        await new Promise((r) => setTimeout(r, opts.pollIntervalMs ?? 2000));
      }
    }
  }

  private startRenewing(): void {
    const every = Math.max(50, Math.floor(this.ttl / 3));
    this.timer = setInterval(() => {
      this.opts.store.renewLock(this.opts.ctx.env, this.opts.ctx.scope, this.holder, this.ttl).catch((e) => {
        if (e instanceof LockLostError) this.lost = e;
      });
    }, every);
    this.timer.unref();
  }

  /** Throw LOCK_LOST when another run took the scope; called before every write to a provider. */
  assertHeld(): void {
    if (this.lost) throw lockLost(this.lost);
  }

  /** Write the receipt only if we still hold the lock at that instant. */
  async write(receipt: Receipt): Promise<void> {
    this.assertHeld();
    try {
      await this.opts.store.write(receipt, { holder: this.holder });
    } catch (e) {
      if (e instanceof LockLostError) throw lockLost(e);
      throw e;
    }
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.opts.store.releaseLock(this.opts.ctx.env, this.opts.ctx.scope, this.holder).catch(() => {});
  }
}

function lockLost(e: LockLostError): SponsonError {
  return new SponsonError("LOCK_LOST", `${e.message}. This run stopped without writing further; the other run's receipt is authoritative. Re-run plan to see the current state.`, {
    holder: e.holder,
    current: e.current,
  });
}
