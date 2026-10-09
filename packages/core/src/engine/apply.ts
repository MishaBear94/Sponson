import { randomUUID } from "node:crypto";
import { dependentsOf } from "../graph.js";
import { dependenciesOf } from "../plan.js";
import { resolveParams, type LineOutputs } from "../resolve.js";
import type { ApplyResult, Change, LedgerEntry, LiveState, Literal, Receipt, ReceiptLine, ResourceRecord, RunStatus } from "../types.js";
import { scopeDrift } from "./drift.js";
import { staleness } from "./history.js";
import { identity } from "./ledger.js";
import { inspectLine, waitingOn, type Inspection } from "./inspect.js";
import { Lease } from "./lease.js";
import { hasExternalOutputs, publicOutputs } from "./outputs.js";
import { prepare, requireApproval, type Prepared } from "./prepare.js";
import { RunContext } from "./run-context.js";
import type { ApplyResultSummary, RunOptions } from "./types.js";

export async function applyRun(opts: RunOptions): Promise<ApplyResultSummary> {
  const prepared = prepare(opts);
  const approvedBy = requireApproval(opts, prepared);
  const rc = new RunContext(opts);
  const lease = await Lease.acquire(opts, `run-${randomUUID().slice(0, 8)}`);
  try {
    if (lease.preempted) rc.warnings.push(`Took over an expired lock held by ${lease.preempted.holder} since ${lease.preempted.acquiredAt}.`);
    await rc.load();
    const run = new ApplyRun(rc, prepared, lease, approvedBy);
    const st = await staleness(rc.previous?.history ?? [], opts.ctx.git.sha, opts.isAncestor);
    if (st.stale) return run.stale(st.last!, st.reason!);
    await rc.resolveSecrets(prepared);
    return await run.execute();
  } finally {
    await lease.release();
  }
}

/** One apply: walks the lines in order, keeps the ledger truthful at every step, rolls back what it created on failure. */
class ApplyRun {
  private readonly now: () => Date;
  private readonly receipt: Receipt;
  private readonly outputs = new Map<string, LineOutputs>();
  private readonly inspections = new Map<string, Inspection>();
  /** Resolved params (secrets included) of every line inspected, for rollback re-reads. */
  private readonly lineParams = new Map<string, Record<string, unknown>>();
  /** Keys created by this run, per line, in creation order: the rollback set. */
  private readonly created: Array<{ line: Change; keys: Set<string> }> = [];
  /** Keys this run announced it would create, per line. */
  private readonly intents = new Map<string, Set<string>>();
  /** Keys each processed line now manages. */
  private readonly claimed = new Map<string, Set<string>>();
  private readonly dead = new Set<string>();
  private readonly waiting = new Set<string>();
  private failed = false;
  /** A deploy failed or never came within --wait: nothing to roll back, but the plan was not realised. */
  private externalFailed = false;

  constructor(
    private readonly rc: RunContext,
    private readonly prepared: Prepared,
    private readonly lease: Lease,
    approvedBy: string | undefined,
  ) {
    const opts = rc.opts;
    this.now = opts.now ?? (() => new Date());
    this.receipt = {
      version: 2,
      runId: lease.holder,
      environment: opts.ctx.env,
      scope: opts.ctx.scope,
      status: "complete",
      startedAt: this.now().toISOString(),
      finishedAt: "",
      plan: { hash: opts.plan.hash, ...(opts.plan.path ? { path: opts.plan.path } : {}) },
      ctx: opts.ctx,
      lines: {},
      ledger: [],
      history: rc.previous?.history ?? [],
      hashKey: rc.ledger.hashKey,
      ...(approvedBy ? { approvedBy } : {}),
      ...(lease.preempted ? { lockPreempted: lease.preempted.holder } : {}),
    };
  }

  /** A commit older than the last applied one changes nothing (late deployment events, re-run jobs). */
  stale(last: string, reason: "superseded" | "ancestor"): ApplyResultSummary {
    const why = reason === "ancestor" ? "is an ancestor of" : "was superseded by";
    this.receipt.stale = true;
    this.receipt.ledger = this.rc.ledger.toJSON();
    this.receipt.finishedAt = this.now().toISOString();
    for (const c of this.prepared.ordered) this.receipt.lines[c.id] = this.line(c, { status: "skipped", error: `stale: this commit ${why} ${last.slice(0, 7)}, already applied`, errorCode: "STALE" });
    this.rc.warnings.push(`Skipped: commit ${this.rc.opts.ctx.git.short_sha} ${why} the last applied commit ${last.slice(0, 7)}. Nothing was changed.`);
    return { receipt: this.receipt, drift: [], warnings: this.rc.warnings };
  }

  async execute(): Promise<ApplyResultSummary> {
    for (const c of this.prepared.ordered) {
      const done = await this.processLine(c);
      if (!done) break;
      await this.rc.opts.onLineDone?.(c.id, this.receipt);
    }
    if (this.failed) {
      this.skipRemaining();
      await this.rollback();
    }
    this.settleOrphans();

    const inspected = [...this.inspections.values()];
    const uninspected = new Set(this.prepared.ordered.map((c) => c.id).filter((id) => !this.inspections.has(id)));
    const drift = [...inspected.flatMap((i) => i.drift), ...(await scopeDrift(this.rc, inspected, uninspected).catch(() => []))];

    this.receipt.status = this.status();
    this.receipt.finishedAt = this.now().toISOString();
    this.receipt.ledger = this.rc.ledger.toJSON();
    const sha = this.rc.opts.ctx.git.sha;
    if (this.receipt.history[this.receipt.history.length - 1]?.sha !== sha) {
      this.receipt.history = [...this.receipt.history.filter((h) => h.sha !== sha), { sha, at: this.receipt.finishedAt }];
    }
    await this.lease.write(this.receipt);
    await this.handOver();
    return { receipt: this.receipt, drift, warnings: this.rc.warnings };
  }

  /**
   * Finish a scope succession: the predecessor's receipt releases what this scope now owns,
   * so destroying the old branch scope can never delete the pull request's resources.
   */
  private async handOver(): Promise<void> {
    const pred = this.rc.predecessor;
    if (!pred) return;
    const { store, ctx } = this.rc.opts;
    const holder = `handover-${this.lease.holder}`;
    try {
      await store.acquireLock(ctx.env, pred.scope, holder, 60_000);
    } catch {
      this.rc.warnings.push(`Scope \`${pred.scope}\` is busy; its resources will be handed over to \`${ctx.scope}\` on the next run.`);
      return;
    }
    try {
      const mine = new Set(this.rc.ledger.all().map((e) => identity(e.adapter, e.provider, e.key)));
      const kept = pred.receipt.ledger.filter((e) => !mine.has(identity(e.adapter, e.provider, e.key)));
      await store.write({ ...pred.receipt, runId: holder, finishedAt: this.now().toISOString(), ledger: kept, supersededBy: ctx.scope }, { holder });
    } finally {
      await store.releaseLock(ctx.env, pred.scope, holder).catch(() => {});
    }
  }

  /** Returns false when the run must stop (a line failed). */
  private async processLine(c: Change): Promise<boolean> {
    const deps = dependenciesOf(c);
    const deadDep = deps.find((d) => this.dead.has(d));
    if (deadDep) {
      this.receipt.lines[c.id] = this.line(c, { status: "skipped", error: `skipped: depends on \`${deadDep}\``, errorCode: "DEPENDENCY_BLOCKED" });
      this.dead.add(c.id);
      return true;
    }
    const waitingDep = deps.find((d) => this.waiting.has(d));
    if (waitingDep) {
      this.receipt.lines[c.id] = this.line(c, { status: "waiting", waitingFor: this.receipt.lines[waitingDep]?.waitingFor ?? waitingDep });
      this.waiting.add(c.id);
      return true;
    }

    const op = this.prepared.ops.get(c.id)!;
    const params = this.prepared.params.get(c.id)!;
    try {
      this.lease.assertHeld();
      let insp = await inspectLine(this.rc, c, op, params, this.outputs);
      const wait = waitingOn(insp, this.prepared.ops);
      if (wait) {
        const ready = await this.awaitExternal(wait.line);
        if (ready !== true) {
          if (ready.failed) {
            this.receipt.lines[c.id] = this.line(c, { status: "skipped", error: `skipped: \`${wait.line}\` ${ready.failed}`, errorCode: "EXTERNAL_FAILED" });
            this.dead.add(c.id);
            this.externalFailed = true;
          } else {
            this.receipt.lines[c.id] = this.line(c, {
              status: "waiting",
              waitingFor: wait.event ?? ready.event,
              ...(ready.timedOut ? { error: `timed out waiting for ${ready.event} on \`${wait.line}\``, errorCode: "WAIT_TIMEOUT" } : {}),
            });
            this.waiting.add(c.id);
            if (ready.timedOut) this.externalFailed = true;
          }
          return true;
        }
        insp = await inspectLine(this.rc, c, op, params, this.outputs);
      }
      this.inspections.set(c.id, insp);
      this.lineParams.set(c.id, insp.resolved.params);

      if (insp.refusal) {
        this.receipt.lines[c.id] = this.line(c, { status: "blocked", error: insp.refusal.message, errorCode: insp.refusal.code });
        this.dead.add(c.id);
        this.failed = true;
        return false;
      }

      const line = this.line(c, { status: "applied" });
      this.receipt.lines[c.id] = line;
      const fingerprints = this.fingerprints(insp);
      if (Object.keys(fingerprints).length) line.secretFingerprints = fingerprints;

      let result: ApplyResult;
      if (insp.diffs.every((d) => d.kind === "unchanged") && (insp.live || insp.diffs.length === 0)) {
        line.status = "unchanged";
        result = { resources: insp.live?.resources ?? [], outputs: insp.live?.outputs ?? {}, created: [] };
      } else {
        const actx = this.rc.adapterContext(c.adapter, insp.provider, (keys) => this.intend(c, insp.provider, keys));
        actx.log(`apply ${c.id}`);
        result = await op.apply(actx, insp.resolved.params, insp.live);
        if (this.rc.opts.reconcile && insp.drift.some((d) => d.kind === "changed")) line.notes = { ...(line.notes ?? {}), reconciled: true };
      }
      if (result.notes) line.notes = { ...(line.notes ?? {}), ...result.notes };
      this.rc.guardOutputs(result.outputs, op.outputs);
      this.record(c, insp, result);

      const values: Record<string, unknown> = { ...result.outputs };
      if (op.awaitExternal && hasExternalOutputs(op.outputs)) {
        // Record external outputs (preview_url) as soon as they exist, even when no line reads them.
        const live: LiveState = { resources: result.resources, outputs: result.outputs as Record<string, Literal> };
        const ext = await op.awaitExternal(this.rc.adapterContext(c.adapter, insp.provider), insp.resolved.params, live).catch(() => null);
        if (ext) Object.assign(values, ext);
      }
      this.setOutputs(c, values);
      return true;
    } catch (e) {
      const err = this.rc.errorText(e);
      if (err.code === "LOCK_LOST") throw e;
      this.receipt.lines[c.id] = { ...(this.receipt.lines[c.id] ?? this.line(c, { status: "failed" })), status: "failed", error: err.message, ...(err.code ? { errorCode: err.code } : {}) };
      this.dead.add(c.id);
      this.failed = true;
      return false;
    }
  }

  /** Persist the intent before the adapter sends the create, so nothing created can be forgotten. */
  private async intend(c: Change, provider: Record<string, unknown>, keys: string[]): Promise<void> {
    this.lease.assertHeld();
    const mine = this.intents.get(c.id) ?? new Set<string>();
    this.intents.set(c.id, mine);
    for (const key of keys) {
      mine.add(key);
      // A create makes a new object; whatever the ledger said about a previous one with this key no longer applies.
      this.rc.ledger.put({ adapter: c.adapter, op: c.op, provider, key, id: "", hash: "", createdBy: "intent", line: c.id });
    }
    await this.checkpoint(c);
  }

  /** A receipt that is correct if the process dies right now. */
  private async checkpoint(current: Change): Promise<void> {
    const snapshot: Receipt = {
      ...this.receipt,
      status: "failed",
      finishedAt: this.now().toISOString(),
      lines: { ...this.receipt.lines, [current.id]: this.line(current, { status: "failed", error: "interrupted: the run did not finish", errorCode: "INTERRUPTED" }) },
      ledger: this.rc.ledger.toJSON(),
    };
    await this.lease.write(snapshot);
  }

  /** Bring the ledger in line with what this line now manages. */
  private record(c: Change, insp: Inspection, result: ApplyResult): void {
    const keys = new Set<string>();
    const createdNow = new Set(result.created);
    for (const r of result.resources) {
      keys.add(r.key);
      const prev = this.rc.ledger.get(c.adapter, insp.provider, r.key);
      const replaced = prev && prev.createdBy !== "intent" && prev.id && prev.id !== r.id;
      const foreign = this.rc.foreignScopeOf({ adapter: c.adapter, provider: insp.provider, key: r.key });
      const createdBy: LedgerEntry["createdBy"] =
        createdNow.has(r.key) || prev?.createdBy === "intent" ? "sponson" : prev?.createdBy === "sponson" && !replaced && !foreign ? "sponson" : "adopted";
      this.rc.ledger.put({ adapter: c.adapter, op: c.op, provider: insp.provider, key: r.key, id: r.id, hash: this.rc.ledger.keyed(r.hash), ...(r.label ? { label: r.label } : {}), createdBy, line: c.id });
      if (createdNow.has(r.key) || prev?.createdBy === "intent") {
        const entry = this.created.find((x) => x.line.id === c.id) ?? { line: c, keys: new Set<string>() };
        if (!this.created.includes(entry)) this.created.push(entry);
        entry.keys.add(r.key);
      }
    }
    // Intents this line announced but that did not materialise were never created.
    for (const k of this.intents.get(c.id) ?? []) {
      if (keys.has(k)) continue;
      const e = this.rc.ledger.get(c.adapter, insp.provider, k);
      if (e?.createdBy === "intent") this.rc.ledger.delete(e);
    }
    this.claimed.set(c.id, keys);
    const line = this.receipt.lines[c.id]!;
    line.resources = this.resourcesOf(c.id);
    line.createdBy = line.resources.some((r) => r.createdBy === "sponson") ? "sponson" : "adopted";
  }

  private setOutputs(c: Change, values: Record<string, unknown>): void {
    const op = this.prepared.ops.get(c.id)!;
    this.rc.guardOutputs(values, op.outputs);
    this.outputs.set(c.id, { values: values as LineOutputs["values"], specs: op.outputs });
    const pub = publicOutputs(values, op.outputs);
    const line = this.receipt.lines[c.id];
    if (line) line.outputs = pub;
    for (const e of this.rc.ledger.all()) if (e.line === c.id && e.createdBy !== "intent") e.outputs = pub;
  }

  private fingerprints(insp: Inspection): Record<string, string> {
    const out: Record<string, string> = {};
    const prev = this.rc.previous?.lines[insp.change.id]?.secretFingerprints ?? {};
    for (const s of insp.resolved.secrets) {
      const fp = this.rc.secrets.fingerprints.get(s.ref);
      if (!fp) continue;
      out[s.ref] = fp;
      if (prev[s.ref] && prev[s.ref] !== fp) this.rc.warnings.push(`\`${insp.change.id}\`: secret ${s.ref} changed since the last apply; using the new value.`);
    }
    return out;
  }

  /** Make the external outputs of `lineId` available, waiting only with --wait. */
  private async awaitExternal(lineId: string): Promise<true | { event: string; failed?: string; timedOut?: boolean }> {
    const op = this.prepared.ops.get(lineId)!;
    const have = this.outputs.get(lineId);
    const insp = this.inspections.get(lineId);
    const missing = Object.entries(op.outputs).filter(([k, o]) => o.available === "external" && !(k in (have?.values ?? {})));
    if (!have || !insp) return { event: "apply" };
    if (missing.length === 0) return true;
    const event = missing[0]![1].event ?? "external event";
    if (!op.awaitExternal) return { event, failed: `has no way to observe ${event}` };
    const live: LiveState = { resources: this.resourcesOf(lineId), outputs: have.values };
    const deadline = Date.now() + (this.rc.opts.waitTimeoutMs ?? 10 * 60 * 1000);
    for (;;) {
      let ext: Record<string, Literal> | null;
      try {
        ext = await op.awaitExternal(this.rc.adapterContext(insp.change.adapter, insp.provider), insp.resolved.params, live);
      } catch (e) {
        return { event, failed: this.rc.errorText(e).message };
      }
      if (ext) {
        this.setOutputs(insp.change, { ...have.values, ...ext });
        return true;
      }
      if (!this.rc.opts.wait) return { event };
      if (Date.now() > deadline) return { event, timedOut: true };
      await new Promise((r) => setTimeout(r, this.rc.opts.pollIntervalMs ?? 2000));
    }
  }

  private skipRemaining(): void {
    const deadIds = [...this.dead];
    for (const c of this.prepared.ordered) {
      if (this.receipt.lines[c.id]) continue;
      const via = deadIds.find((d) => dependentsOf(d, this.prepared.ordered).has(c.id));
      this.receipt.lines[c.id] = this.line(c, via ? { status: "skipped", error: `skipped: depends on \`${via}\``, errorCode: "DEPENDENCY_BLOCKED" } : { status: "skipped", error: "skipped: an earlier line failed" });
    }
  }

  /**
   * Undo what this run created, newest first. Intents whose outcome is unknown (the create
   * threw) are re-read: if the resource exists, it was ours and is destroyed too.
   */
  private async rollback(): Promise<void> {
    for (const [lineId, keys] of this.intents) {
      const unresolved = [...keys].filter((k) => this.rc.ledger.get(this.lineAdapter(lineId), this.rc.provider(this.lineAdapter(lineId)), k)?.createdBy === "intent");
      if (unresolved.length === 0) continue;
      const c = this.prepared.ordered.find((x) => x.id === lineId)!;
      const op = this.prepared.ops.get(lineId)!;
      const provider = this.rc.provider(c.adapter);
      try {
        const live = await op.read(this.rc.adapterContext(c.adapter, provider), this.lineParams.get(lineId) ?? resolveParams(this.prepared.params.get(lineId)!, this.outputs, this.rc.secrets.values).params);
        const found = new Map((live?.resources ?? []).map((r) => [r.key, r]));
        for (const k of unresolved) {
          const r = found.get(k);
          const e = this.rc.ledger.get(c.adapter, provider, k)!;
          if (!r) {
            this.rc.ledger.delete(e);
            continue;
          }
          this.rc.ledger.put({ ...e, id: r.id, hash: this.rc.ledger.keyed(r.hash), ...(r.label ? { label: r.label } : {}), createdBy: "sponson" });
          const entry = this.created.find((x) => x.line.id === lineId) ?? { line: c, keys: new Set<string>() };
          if (!this.created.includes(entry)) this.created.push(entry);
          entry.keys.add(k);
        }
      } catch {
        /* outcome still unknown: the intent stays in the ledger and the next run resolves it */
      }
    }

    for (const { line: c, keys } of [...this.created].reverse()) {
      const provider = this.rc.provider(c.adapter);
      const entries = [...keys].map((k) => this.rc.ledger.get(c.adapter, provider, k)).filter((e): e is LedgerEntry => !!e);
      const rl = this.receipt.lines[c.id]!;
      try {
        await this.prepared.ops.get(c.id)!.destroy(this.rc.adapterContext(c.adapter, provider), entries.map(toRecord));
        for (const e of entries) this.rc.ledger.delete(e);
        if (rl.status !== "failed" && rl.status !== "blocked") rl.status = "rolled_back";
      } catch (e) {
        rl.status = "rollback_failed";
        rl.error = `rollback failed, resources left behind: ${entries.map((x) => x.label ?? x.key).join(", ")} (${this.rc.errorText(e).message})`;
        rl.errorCode = this.rc.errorText(e).code ?? "ROLLBACK_FAILED";
      }
      rl.resources = this.resourcesOf(c.id);
    }
  }

  /** Entries no current line declares become orphans; adopted ones are simply forgotten. */
  private settleOrphans(): void {
    const active = new Set(this.prepared.ordered.map((c) => c.id));
    const claimedBy = new Map<string, string>();
    for (const [lineId, keys] of this.claimed) for (const k of keys) claimedBy.set(`${this.lineAdapter(lineId)}|${k}`, lineId);
    for (const e of this.rc.ledger.all()) {
      if (e.createdBy === "intent") continue;
      const owner = claimedBy.get(`${e.adapter}|${e.key}`);
      // Lines that did not run this time (skipped/waiting/failed) keep their claims untouched.
      const judged = !active.has(e.line) || this.claimed.has(e.line) || owner !== undefined;
      if (!judged) continue;
      if (owner) {
        e.orphan = false;
        e.line = owner;
      } else if (e.createdBy === "adopted") this.rc.ledger.delete(e);
      else e.orphan = true;
    }
  }

  private status(): RunStatus {
    const statuses = Object.values(this.receipt.lines).map((l) => l.status);
    if (this.failed || this.externalFailed || statuses.some((s) => s === "rollback_failed")) return "failed";
    if (statuses.includes("waiting")) return "partial";
    return "complete";
  }

  private lineAdapter(id: string): string {
    return this.prepared.ordered.find((c) => c.id === id)?.adapter ?? "";
  }

  private resourcesOf(lineId: string): ResourceRecord[] {
    return this.rc.ledger
      .all()
      .filter((e) => e.line === lineId && e.createdBy !== "intent")
      .map((e) => ({ ...toRecord(e), createdBy: e.createdBy as "sponson" | "adopted" }));
  }

  private line(c: Change, fields: Partial<ReceiptLine> & Pick<ReceiptLine, "status">): ReceiptLine {
    const previous = this.resourcesOf(c.id);
    return {
      id: c.id,
      adapter: c.adapter,
      op: c.op,
      createdBy: previous.some((r) => r.createdBy === "sponson") ? "sponson" : "adopted",
      resources: previous,
      outputs: this.rc.ledger.all().find((e) => e.line === c.id && e.outputs)?.outputs ?? {},
      ...fields,
    };
  }
}

function toRecord(e: LedgerEntry): ResourceRecord {
  return { key: e.key, id: e.id, hash: e.hash, ...(e.label ? { label: e.label } : {}) };
}
