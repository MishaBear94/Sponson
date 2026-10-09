import { scopeFor } from "../ctx.js";
import { isSponsonError, type ErrorCode } from "../errors.js";
import { sha256 } from "../hash.js";
import { Redactor } from "../redact.js";
import type { AdapterContext, LedgerEntry, Receipt } from "../types.js";
import { identity, Ledger } from "./ledger.js";
import type { Prepared } from "./prepare.js";
import type { RunOptions } from "./types.js";

/** Environment variable names whose values are credentials and must be masked everywhere. */
const CREDENTIAL_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|_KEY|APIKEY)$/i;

export interface SecretState {
  values: Map<string, string>;
  /** Keyed hash of each resolved value, to notice rotation between runs without storing anything reversible. */
  fingerprints: Map<string, string>;
  failures: Map<string, string>;
}

/**
 * Per-command state shared by plan, apply and destroy: the redactor (registered up front with
 * every secret, credential and sensitive output it will ever see), the ledger, the ledgers of
 * other scopes, and the factory for adapter contexts.
 */
export class RunContext {
  readonly redactor: Redactor;
  readonly env: NodeJS.ProcessEnv;
  readonly warnings: string[] = [];
  ledger!: Ledger;
  previous: Receipt | null = null;
  /** identity → scope, for resources other scopes in this environment manage. */
  readonly foreign = new Map<string, string>();
  secrets: SecretState = { values: new Map(), fingerprints: new Map(), failures: new Map() };
  /** The head branch's scope this pull request supersedes, and the receipt it was inherited from. */
  predecessor: { scope: string; receipt: Receipt } | null = null;

  constructor(readonly opts: RunOptions) {
    this.redactor = opts.redactor ?? new Redactor();
    this.env = opts.env ?? process.env;
    for (const [name, value] of Object.entries(this.env)) {
      if (value && CREDENTIAL_NAME.test(name)) this.redactor.register(value);
    }
  }

  /** Load our receipt (tolerating corruption) and every other scope's ledger in this environment. */
  async load(): Promise<void> {
    const { store, ctx } = this.opts;
    try {
      this.previous = await store.read(ctx.env, ctx.scope);
    } catch (e) {
      if (isSponsonError(e) && e.code === "RECEIPT_CORRUPT") {
        this.warnings.push(`${e.message}. Continuing as if there were no receipt: drift detection is disabled for this run.`);
        this.previous = null;
      } else throw e;
    }
    this.ledger = Ledger.from(this.previous);
    // A pull request supersedes the branch scope of its head branch (e.g. an agent applied locally
    // before the PR existed): the PR scope inherits that ledger instead of being blocked by it.
    const predecessor = ctx.pr.number !== null ? scopeFor(ctx.git.branch, null) : null;
    try {
      for (const { scope, receipt } of await store.list(ctx.env)) {
        if (scope === ctx.scope) continue;
        if (scope === predecessor) {
          if (receipt.ledger.length) {
            this.predecessor = { scope, receipt };
            this.inherit(scope, receipt.ledger);
          }
          continue;
        }
        // Intents count: another run is creating that resource right now.
        for (const e of receipt.ledger) this.foreign.set(identity(e.adapter, e.provider, e.key), scope);
      }
    } catch {
      this.warnings.push("Could not list other scopes' receipts; resources they manage may be reported as unmanaged.");
    }
  }

  private inherit(scope: string, entries: LedgerEntry[]): void {
    let n = 0;
    for (const e of entries) {
      if (this.ledger.get(e.adapter, e.provider, e.key)) continue;
      // Hashes are keyed per scope; an inherited hash cannot be compared, so drift starts fresh for it.
      this.ledger.put({ ...e, hash: "", id: e.id });
      n++;
    }
    if (n) this.warnings.push(`Inherited ${n} resource${n > 1 ? "s" : ""} from scope \`${scope}\` (this pull request's head branch). Destroying this scope removes them.`);
  }

  /** Resolve every secret the active lines use, so all of them are masked before any output exists. */
  async resolveSecrets(prepared: Prepared): Promise<void> {
    for (const ref of prepared.secretRefs) {
      try {
        const value = await this.opts.registry.secretSource(ref).resolve(ref, this.env);
        this.redactor.register(value);
        this.secrets.values.set(ref, value);
        this.secrets.fingerprints.set(ref, this.ledger.keyed(sha256(value)));
      } catch (e) {
        this.secrets.failures.set(ref, this.redactor.redact((e as Error).message));
      }
    }
  }

  /** Every non-sensitive-looking output of a sensitive spec gets masked from here on. */
  guardOutputs(values: Record<string, unknown>, specs: Record<string, { sensitive?: boolean }>): void {
    for (const [k, v] of Object.entries(values)) if (specs[k]?.sensitive && typeof v === "string") this.redactor.register(v);
  }

  provider(adapter: string): Record<string, unknown> {
    return this.opts.plan.providers[adapter] ?? {};
  }

  foreignScopeOf(entry: Pick<LedgerEntry, "adapter" | "provider" | "key">): string | undefined {
    return this.foreign.get(identity(entry.adapter, entry.provider, entry.key));
  }

  adapterContext(adapter: string, provider: Record<string, unknown>, intend: (keys: string[]) => Promise<void> = async () => {}): AdapterContext {
    const log = this.opts.log ?? (() => {});
    return {
      ctx: this.opts.ctx,
      provider,
      env: this.env,
      log: (m) => log(this.redactor.redact(`[${adapter}] ${m}`)),
      intend,
      redact: (t) => this.redactor.redact(t),
    };
  }

  errorText(e: unknown): { message: string; code?: ErrorCode } {
    const message = this.redactor.redact(String((e as Error)?.message ?? e));
    return isSponsonError(e) ? { message, code: e.code } : { message };
  }
}
