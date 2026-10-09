import { randomUUID } from "node:crypto";
import { interpolate } from "./ctx.js";
import { SponsonError, isSponsonError } from "./errors.js";
import { dependentsOf, orderChanges } from "./graph.js";
import { changesFor, dependenciesOf } from "./plan.js";
import { Redactor } from "./redact.js";
import type { Registry } from "./registry.js";
import { resolveParams, type LineOutputs } from "./resolve.js";
import {
  LockHeldError,
  type AdapterContext,
  type Change,
  type Ctx,
  type Drift,
  type LiveState,
  type OpSpec,
  type Plan,
  type Receipt,
  type ReceiptLine,
  type ReceiptStore,
  type ResolvedValue,
  type ResourceDiff,
  type ResourceRecord,
  type RunStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunOptions {
  plan: Plan;
  ctx: Ctx;
  registry: Registry;
  store: ReceiptStore;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  redactor?: Redactor;
  /** Required to apply to `production`. */
  approvedBy?: string;
  /** Overwrite values changed outside Sponson. */
  reconcile?: boolean;
  /** Poll for external events and locks instead of stopping. */
  wait?: boolean;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  lockTtlMs?: number;
  /** Test hook: called between lines so a scenario can crash the process mid-run. */
  onLineDone?: (id: string, receipt: Receipt) => Promise<void> | void;
  now?: () => Date;
}

export type PlanLineStatus = "create" | "update" | "unchanged" | "pending" | "blocked" | "error";

export interface PlanLine {
  id: string;
  adapter: string;
  op: string;
  status: PlanLineStatus;
  diffs: ResourceDiff[];
  inputs: Record<string, ResolvedValue>;
  /** Display-safe outputs known right now. */
  outputs: Record<string, string>;
  waitingOn?: string;
  error?: string;
  errorCode?: string;
}

export interface PlanResult {
  environment: string;
  scope: string;
  planHash: string;
  lines: PlanLine[];
  drift: Drift[];
  warnings: string[];
  previous: Receipt | null;
}

// ---------------------------------------------------------------------------
// Shared preparation
// ---------------------------------------------------------------------------

interface Prepared {
  ordered: Change[];
  ops: Map<string, OpSpec>;
  params: Map<string, Record<string, unknown>>;
}

function prepare(opts: RunOptions): Prepared {
  const { plan, ctx, registry } = opts;
  if (!plan.environments.includes(ctx.env)) {
    throw new SponsonError("ENV_UNKNOWN", `Unknown environment \`${ctx.env}\`. Declared: ${plan.environments.join(", ")}`, {
      environment: ctx.env,
      known: plan.environments,
    });
  }
  const active = changesFor(plan, ctx.env);
  const ordered = orderChanges(active, plan.changes);
  const ops = new Map<string, OpSpec>();
  const params = new Map<string, Record<string, unknown>>();
  for (const c of ordered) {
    const op = registry.op(c.adapter, c.op);
    ops.set(c.id, op);
    let p = interpolate(c.params, ctx, `line \`${c.id}\``) as Record<string, unknown>;
    if (op.defaults) p = op.defaults(p, ctx);
    params.set(c.id, p);
  }
  return { ordered, ops, params };
}

function adapterContext(opts: RunOptions, adapter: string, redactor: Redactor): AdapterContext {
  const log = opts.log ?? (() => {});
  return {
    ctx: opts.ctx,
    provider: opts.plan.providers[adapter] ?? {},
    env: opts.env ?? process.env,
    log: (m) => log(redactor.redact(`[${adapter}] ${m}`)),
  };
}

function liveByKey(live: LiveState | null): Map<string, ResourceRecord> {
  return new Map((live?.resources ?? []).map((r) => [r.key, r]));
}

/** Receipt lines that still describe something real (not destroyed or rolled back). */
function activeReceiptLines(receipt: Receipt | null): ReceiptLine[] {
  if (!receipt) return [];
  return Object.values(receipt.lines).filter((l) => ["applied", "unchanged", "waiting", "failed", "destroy_failed", "rollback_failed"].includes(l.status));
}

async function loadPrevious(opts: RunOptions, warnings: string[]): Promise<Receipt | null> {
  try {
    return await opts.store.read(opts.ctx.env, opts.ctx.scope);
  } catch (e) {
    if (isSponsonError(e) && e.code === "RECEIPT_CORRUPT") {
      warnings.push(`${e.message}. Continuing as if there were no receipt: drift detection is disabled for this run.`);
      return null;
    }
    throw e;
  }
}

/** Sensitive outputs become redaction targets the moment they are known, so no adapter can leak them through a diff or an error. */
function guardOutputs(values: Record<string, unknown>, specs: Record<string, { sensitive?: boolean }>, redactor: Redactor): void {
  for (const [k, v] of Object.entries(values)) if (specs[k]?.sensitive && typeof v === "string") redactor.register(v);
}

function redactDiffs(diffs: ResourceDiff[], redactor: Redactor): ResourceDiff[] {
  return diffs.map((d) => ({ ...d, ...(d.before !== undefined ? { before: redactor.redact(d.before) } : {}), ...(d.after !== undefined ? { after: redactor.redact(d.after) } : {}) }));
}

function maskOutputs(values: Record<string, unknown>, specs: Record<string, { sensitive?: boolean }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) out[k] = specs[k]?.sensitive ? "(secret)" : String(v);
  return out;
}

function publicOutputs(values: Record<string, unknown>, specs: Record<string, { sensitive?: boolean }>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(values)) if (!specs[k]?.sensitive) out[k] = v as string | number | boolean;
  return out;
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

async function detectDrift(
  opts: RunOptions,
  prepared: Prepared,
  previous: Receipt | null,
  lives: Map<string, LiveState | null>,
  desiredKeys: Map<string, Set<string>>,
  redactor: Redactor,
): Promise<Drift[]> {
  const drift: Drift[] = [];
  const prevLines = activeReceiptLines(previous);
  const activeIds = new Set(prepared.ordered.map((c) => c.id));

  // orphan: receipt remembers a line the plan no longer has
  for (const pl of prevLines) {
    if (!activeIds.has(pl.id) && pl.resources.some((r) => r.createdBy !== "adopted")) {
      for (const r of pl.resources) {
        drift.push({
          kind: "orphan",
          adapter: pl.adapter,
          line: pl.id,
          resource: { key: r.key, id: r.id, label: r.label },
          message: `Line \`${pl.id}\` was removed from the plan but ${r.label ?? r.key} still exists. It is left alone; \`sponson apply --destroy\` removes it.`,
        });
      }
    }
  }

  // changed / missing: compare receipt hashes to live
  for (const c of prepared.ordered) {
    const pl = previous?.lines[c.id];
    if (!pl || !["applied", "unchanged"].includes(pl.status)) continue;
    const live = liveByKey(lives.get(c.id) ?? null);
    for (const r of pl.resources) {
      const now = live.get(r.key);
      if (!now) {
        drift.push({ kind: "missing", adapter: c.adapter, line: c.id, resource: { key: r.key, id: r.id, label: r.label }, message: `${r.label ?? r.key} was applied by Sponson but no longer exists. It will be recreated.` });
      } else if (now.hash !== r.hash) {
        drift.push({ kind: "changed", adapter: c.adapter, line: c.id, resource: { key: r.key, id: now.id, label: r.label }, message: `${r.label ?? r.key} was changed outside Sponson since the last apply. Apply will refuse this line unless --reconcile is given.` });
      }
    }
  }

  // unmanaged: things in the same target scope that no line and no receipt mentions
  const seenScopes = new Set<string>();
  for (const c of prepared.ordered) {
    const op = prepared.ops.get(c.id)!;
    if (!op.listScope) continue;
    const p = prepared.params.get(c.id)!;
    let scoped: ResourceRecord[];
    try {
      scoped = await op.listScope(adapterContext(opts, c.adapter, redactor), p);
    } catch {
      continue; // listing is best-effort; a failure here must not block plan
    }
    const planned = new Set<string>();
    for (const [id, keys] of desiredKeys) if (prepared.ordered.find((x) => x.id === id)?.adapter === c.adapter) for (const k of keys) planned.add(k);
    const remembered = new Set(prevLines.filter((l) => l.adapter === c.adapter).flatMap((l) => l.resources.map((r) => r.key)));
    for (const r of scoped) {
      const scopeKey = `${c.adapter}:${r.key}`;
      if (seenScopes.has(scopeKey)) continue;
      seenScopes.add(scopeKey);
      if (!planned.has(r.key) && !remembered.has(r.key)) {
        drift.push({ kind: "unmanaged", adapter: c.adapter, resource: { key: r.key, id: r.id, label: r.label }, message: `${r.label ?? r.key} exists but is not in the plan. Sponson will not touch it. Run \`sponson init\` to adopt it.` });
      }
    }
  }
  return drift;
}

/**
 * `plan` never resolves secrets, so an adapter sees a pending marker and reports `update`.
 * When the receipt proves we wrote this key, the secret's fingerprint has not changed since,
 * and nobody touched the live value, the honest answer is `unchanged`.
 */
async function settleSecretDiffs(
  opts: RunOptions,
  id: string,
  secrets: Array<{ path: string; ref: string }>,
  previous: Receipt | null,
  live: LiveState | null,
  line: PlanLine,
): Promise<void> {
  const prev = previous?.lines[id];
  if (secrets.length === 0 || !prev || !["applied", "unchanged"].includes(prev.status) || !live) return;
  const env = opts.env ?? process.env;
  for (const s of secrets) {
    const before = prev.secretFingerprints?.[s.ref];
    if (!before) return;
    const now = await opts.registry.secretSource(s.ref).fingerprint(s.ref, env).catch(() => null);
    if (now !== before) return;
  }
  const liveHash = liveByKey(live);
  const prevHash = new Map(prev.resources.map((r) => [r.key, r.hash]));
  line.diffs = line.diffs.map((d) =>
    d.kind === "update" && d.after?.startsWith("(secret ←") && liveHash.get(d.key)?.hash === prevHash.get(d.key) ? { key: d.key, kind: "unchanged", label: d.label } : d,
  );
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

export async function planRun(opts: RunOptions): Promise<PlanResult> {
  const redactor = opts.redactor ?? new Redactor();
  const warnings: string[] = [];
  const prepared = prepare(opts);
  const previous = await loadPrevious(opts, warnings);
  const outputs = new Map<string, LineOutputs>();
  const lives = new Map<string, LiveState | null>();
  const desiredKeys = new Map<string, Set<string>>();
  const lines: PlanLine[] = [];
  const broken = new Set<string>();

  for (const c of prepared.ordered) {
    const op = prepared.ops.get(c.id)!;
    const actx = adapterContext(opts, c.adapter, redactor);
    const resolved = resolveParams(prepared.params.get(c.id)!, outputs);
    const line: PlanLine = { id: c.id, adapter: c.adapter, op: c.op, status: "unchanged", diffs: [], inputs: resolved.inputs, outputs: {} };
    lines.push(line);

    const blockedBy = dependenciesOf(c).find((d) => broken.has(d));
    if (blockedBy) {
      line.status = "blocked";
      line.error = `depends on \`${blockedBy}\`, which cannot be planned`;
      broken.add(c.id);
      continue;
    }

    try {
      const live = await op.read(actx, resolved.params);
      lives.set(c.id, live);
      let values = { ...(live?.outputs ?? {}) };
      guardOutputs(values, op.outputs, redactor);
      line.diffs = redactDiffs(op.diff(live, resolved.params), redactor);
      await settleSecretDiffs(opts, c.id, resolved.secrets, previous, live, line);
      desiredKeys.set(c.id, new Set(line.diffs.map((d) => d.key)));

      // External outputs: see if the event already happened (read-only check).
      if (live && op.awaitExternal && Object.values(op.outputs).some((o) => o.available === "external")) {
        try {
          const ext = await op.awaitExternal(actx, resolved.params, live);
          if (ext) values = { ...values, ...ext };
        } catch (e) {
          warnings.push(`\`${c.id}\`: ${(e as Error).message}`);
        }
      }
      outputs.set(c.id, { values, specs: op.outputs });
      line.outputs = maskOutputs(values, op.outputs);

      if (resolved.pending.length > 0) {
        line.status = "pending";
        line.waitingOn = resolved.pending[0]!.line;
      } else if (line.diffs.some((d) => d.kind === "create")) {
        line.status = "create";
      } else if (line.diffs.some((d) => d.kind === "update")) {
        line.status = "update";
      }
    } catch (e) {
      line.status = "error";
      line.error = redactor.redact(isSponsonError(e) ? e.message : String((e as Error).message ?? e));
      if (isSponsonError(e)) line.errorCode = e.code;
      broken.add(c.id);
    }
  }

  const drift = await detectDrift(opts, prepared, previous, lives, desiredKeys, redactor);
  return { environment: opts.ctx.env, scope: opts.ctx.scope, planHash: opts.plan.hash, lines, drift, warnings, previous };
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export interface ApplyResultSummary {
  receipt: Receipt;
  drift: Drift[];
  warnings: string[];
}

export async function applyRun(opts: RunOptions): Promise<ApplyResultSummary> {
  const redactor = opts.redactor ?? new Redactor();
  const now = opts.now ?? (() => new Date());
  const warnings: string[] = [];
  const prepared = prepare(opts);
  requireApproval(opts);

  const holder = `run-${randomUUID().slice(0, 8)}`;
  const preempted = await acquireLock(opts, holder);
  if (preempted) warnings.push(`Took over an expired lock held by ${preempted.holder} since ${preempted.acquiredAt}.`);

  const previous = await loadPrevious(opts, warnings);
  const receipt: Receipt = {
    version: 1,
    runId: holder,
    environment: opts.ctx.env,
    scope: opts.ctx.scope,
    status: "complete",
    startedAt: now().toISOString(),
    finishedAt: "",
    plan: { hash: opts.plan.hash, ...(opts.plan.path ? { path: opts.plan.path } : {}) },
    ctx: opts.ctx,
    lines: {},
    ...(preempted ? { lockPreempted: preempted.holder } : {}),
  };
  // Carry forward lines the plan no longer has, so destroy and orphan detection still see them.
  const activeIds = new Set(prepared.ordered.map((c) => c.id));
  for (const pl of activeReceiptLines(previous)) if (!activeIds.has(pl.id)) receipt.lines[pl.id] = { ...pl, orphan: true } as ReceiptLine;

  const outputs = new Map<string, LineOutputs>();
  const lives = new Map<string, LiveState | null>();
  const desiredKeys = new Map<string, Set<string>>();
  /** Resources created in this run, in creation order, for rollback. */
  const createdThisRun: Array<{ line: Change; resources: ResourceRecord[] }> = [];
  const dead = new Set<string>(); // failed or skipped: dependents are skipped
  const waiting = new Set<string>(); // waiting: dependents wait
  let failure: Error | null = null;
  let externalFailed = false; // a deploy failed: nothing to roll back, but the plan was not realized

  try {
    for (const c of prepared.ordered) {
      const op = prepared.ops.get(c.id)!;
      const actx = adapterContext(opts, c.adapter, redactor);
      const prev = previous?.lines[c.id];
      const base: ReceiptLine = { id: c.id, adapter: c.adapter, op: c.op, status: "applied", createdBy: "adopted", resources: [], outputs: {} };
      receipt.lines[c.id] = base;

      const deadDep = dependenciesOf(c).find((d) => dead.has(d));
      if (deadDep) {
        base.status = "skipped";
        base.error = `skipped: depends on \`${deadDep}\``;
        dead.add(c.id);
        continue;
      }
      const waitingDep = dependenciesOf(c).find((d) => waiting.has(d));
      if (waitingDep) {
        base.status = "waiting";
        base.waitingFor = receipt.lines[waitingDep]?.waitingFor ?? waitingDep;
        waiting.add(c.id);
        continue;
      }

      // Resolve references. Pending ones may be external outputs we can now check for.
      let resolved = resolveParams(prepared.params.get(c.id)!, outputs);
      if (resolved.pending.length > 0) {
        const ready = await resolveExternal(opts, prepared, outputs, lives, resolved.pending.map((p) => p.line), redactor, warnings);
        if (ready !== true) {
          const { line, event, failed } = ready;
          if (failed) {
            base.status = "skipped";
            base.error = `skipped: \`${line}\` ${failed}`;
            dead.add(c.id);
            externalFailed = true;
          } else {
            base.status = "waiting";
            base.waitingFor = event;
            waiting.add(c.id);
          }
          continue;
        }
        resolved = resolveParams(prepared.params.get(c.id)!, outputs);
      }

      try {
        // Secrets: resolve only now, register for redaction, remember fingerprints.
        const secretValues = new Map<string, string>();
        const fingerprints: Record<string, string> = {};
        for (const s of resolved.secrets) {
          const source = opts.registry.secretSource(s.ref);
          const value = await source.resolve(s.ref, actx.env);
          redactor.register(value);
          secretValues.set(s.ref, value);
          fingerprints[s.ref] = await source.fingerprint(s.ref, actx.env);
          const before = prev?.secretFingerprints?.[s.ref];
          if (before && before !== fingerprints[s.ref]) warnings.push(`\`${c.id}\`: secret ${s.ref} changed since the last apply; using the new value.`);
        }
        if (Object.keys(fingerprints).length > 0) base.secretFingerprints = fingerprints;
        const withSecrets = resolveParams(prepared.params.get(c.id)!, outputs, secretValues);

        const live = await op.read(actx, withSecrets.params);
        lives.set(c.id, live);
        if (live) guardOutputs(live.outputs, op.outputs, redactor);
        const diffs = op.diff(live, withSecrets.params);
        desiredKeys.set(c.id, new Set(diffs.map((d) => d.key)));

        // Refuse to overwrite something a human changed since our last apply.
        if (prev && ["applied", "unchanged"].includes(prev.status) && !opts.reconcile) {
          const byKey = liveByKey(live);
          for (const r of prev.resources) {
            const current = byKey.get(r.key);
            const wantsChange = diffs.find((d) => d.key === r.key && d.kind !== "unchanged");
            if (current && current.hash !== r.hash && wantsChange) {
              throw new SponsonError("DRIFT_CHANGED", `${r.label ?? r.key} was changed outside Sponson since the last apply. Re-run with --reconcile to overwrite it, or update the plan to match.`, {
                line: c.id,
                key: r.key,
              });
            }
          }
        }

        let result: { resources: ResourceRecord[]; outputs: Record<string, unknown>; created: string[]; notes?: Record<string, unknown> };
        if (diffs.length === 0 || (diffs.every((d) => d.kind === "unchanged") && live)) {
          base.status = "unchanged";
          result = { resources: live?.resources ?? [], outputs: live?.outputs ?? {}, created: [] };
        } else {
          actx.log(`apply ${c.id}`);
          result = await op.apply(actx, withSecrets.params, live);
          base.status = "applied";
          if (opts.reconcile && prev) base.notes = { ...(base.notes ?? {}), reconciled: true, previousHashes: Object.fromEntries(prev.resources.map((r) => [r.key, r.hash])) };
        }
        if (result.notes) base.notes = { ...(base.notes ?? {}), ...result.notes };

        // createdBy: new in this run, or remembered as ours, else adopted.
        const prevBy = new Map((prev?.resources ?? []).map((r) => [r.key, r.createdBy]));
        base.resources = result.resources.map((r) => ({
          ...r,
          createdBy: result.created.includes(r.key) ? "sponson" : prevBy.get(r.key) === "sponson" ? "sponson" : "adopted",
        }));
        base.createdBy = base.resources.some((r) => r.createdBy === "sponson") ? "sponson" : "adopted";
        const created = base.resources.filter((r) => result.created.includes(r.key));
        if (created.length > 0) createdThisRun.push({ line: c, resources: created });

        guardOutputs(result.outputs, op.outputs, redactor);
        outputs.set(c.id, { values: result.outputs as Record<string, string | number | boolean>, specs: op.outputs });
        base.outputs = publicOutputs(result.outputs, op.outputs);
      } catch (e) {
        base.status = "failed";
        base.error = redactor.redact(isSponsonError(e) ? e.message : String((e as Error).message ?? e));
        if (isSponsonError(e)) base.errorCode = e.code;
        dead.add(c.id);
        failure = e as Error;
        break; // one failure stops the run; the rest are skipped below
      }
      await opts.onLineDone?.(c.id, receipt);
    }

    if (failure) {
      const deadIds = [...dead];
      for (const c of prepared.ordered) {
        if (receipt.lines[c.id]) continue;
        const via = deadIds.find((d) => d === c.id || dependentsOf(d, prepared.ordered).has(c.id));
        receipt.lines[c.id] = { id: c.id, adapter: c.adapter, op: c.op, status: "skipped", createdBy: "adopted", resources: [], outputs: {}, error: via ? `skipped: depends on \`${via}\`` : "skipped: earlier line failed" };
      }
      await rollback(opts, createdThisRun, receipt, redactor);
    }

    receipt.status = externalFailed ? "failed" : overallStatus(receipt);
    receipt.finishedAt = now().toISOString();
    await opts.store.write(receipt);
  } finally {
    await opts.store.releaseLock(opts.ctx.env, opts.ctx.scope, holder).catch(() => {});
  }

  const drift = await detectDrift(opts, prepared, previous, lives, desiredKeys, redactor).catch(() => []);
  return { receipt, drift, warnings };
}

function overallStatus(receipt: Receipt): RunStatus {
  const statuses = Object.values(receipt.lines).filter((l) => !(l as ReceiptLine & { orphan?: boolean }).orphan).map((l) => l.status);
  if (statuses.some((s) => s === "failed" || s === "rollback_failed" || s === "destroy_failed")) return "failed";
  if (statuses.some((s) => s === "waiting")) return "partial";
  return "complete";
}

function requireApproval(opts: RunOptions): void {
  if (opts.ctx.env !== "production") return;
  const approvedBy = opts.approvedBy ?? opts.env?.SPONSON_APPROVED_BY ?? process.env.SPONSON_APPROVED_BY;
  if (!approvedBy) {
    throw new SponsonError("ENV_NOT_APPROVED", "Applying to production requires approval. Pass --approved-by <who> or set SPONSON_APPROVED_BY from an approval workflow.", {
      environment: "production",
    });
  }
}

async function acquireLock(opts: RunOptions, holder: string) {
  const ttl = opts.lockTtlMs ?? 15 * 60 * 1000;
  const deadline = Date.now() + (opts.waitTimeoutMs ?? 10 * 60 * 1000);
  for (;;) {
    try {
      return await opts.store.acquireLock(opts.ctx.env, opts.ctx.scope, holder, ttl);
    } catch (e) {
      if (!(e instanceof LockHeldError)) throw e;
      if (!opts.wait || Date.now() > deadline) {
        throw new SponsonError("LOCK_HELD", `Another apply (${e.lock.holder}) holds the lock for ${opts.ctx.env}/${opts.ctx.scope} until ${e.lock.expiresAt}. Wait for it, or pass --wait.`, { lock: e.lock });
      }
      await sleep(opts.pollIntervalMs ?? 2000);
    }
  }
}

/**
 * Try to make the external outputs of `lineIds` available.
 * Returns true when all are resolved, or a description of the first one that is not.
 */
async function resolveExternal(
  opts: RunOptions,
  prepared: Prepared,
  outputs: Map<string, LineOutputs>,
  lives: Map<string, LiveState | null>,
  lineIds: string[],
  redactor: Redactor,
  warnings: string[],
): Promise<true | { line: string; event: string; failed?: string }> {
  for (const id of new Set(lineIds)) {
    const op = prepared.ops.get(id)!;
    const c = prepared.ordered.find((x) => x.id === id)!;
    const external = Object.entries(op.outputs).filter(([, o]) => o.available === "external");
    const have = outputs.get(id);
    if (!have) return { line: id, event: "apply" }; // not applied yet (should not happen in topo order)
    const missing = external.filter(([k]) => !(k in have.values));
    if (missing.length === 0) {
      // Pending but not external: the output simply does not exist on this op.
      const unknown = Object.keys(have.specs).length ? null : "no outputs";
      return { line: id, event: "output", failed: `does not produce the referenced output${unknown ? ` (${unknown})` : ""}` };
    }
    const event = missing[0]![1].event ?? "external event";
    if (!op.awaitExternal) return { line: id, event, failed: `has no way to observe ${event}` };
    const actx = adapterContext(opts, c.adapter, redactor);
    const live = lives.get(id) ?? (await op.read(actx, resolveParams(prepared.params.get(id)!, outputs).params));
    if (!live) return { line: id, event };
    const deadline = Date.now() + (opts.waitTimeoutMs ?? 10 * 60 * 1000);
    for (;;) {
      let ext: Record<string, string | number | boolean> | null;
      try {
        ext = await op.awaitExternal(actx, resolveParams(prepared.params.get(id)!, outputs).params, live);
      } catch (e) {
        return { line: id, event, failed: redactor.redact((e as Error).message) };
      }
      if (ext) {
        outputs.set(id, { values: { ...have.values, ...ext }, specs: have.specs });
        break;
      }
      if (!opts.wait) return { line: id, event };
      if (Date.now() > deadline) {
        warnings.push(`Timed out waiting for ${event} on \`${id}\`.`);
        throw new SponsonError("WAIT_TIMEOUT", `Timed out waiting for ${event} on \`${id}\`.`, { line: id, event });
      }
      await sleep(opts.pollIntervalMs ?? 2000);
    }
  }
  return true;
}

async function rollback(opts: RunOptions, created: Array<{ line: Change; resources: ResourceRecord[] }>, receipt: Receipt, redactor: Redactor): Promise<void> {
  for (const { line, resources } of [...created].reverse()) {
    const op = opts.registry.op(line.adapter, line.op);
    const actx = adapterContext(opts, line.adapter, redactor);
    const rl = receipt.lines[line.id]!;
    try {
      actx.log(`rollback ${line.id}`);
      await op.destroy(actx, resources);
      rl.status = "rolled_back";
      rl.resources = rl.resources.filter((r) => !resources.some((x) => x.key === r.key));
    } catch (e) {
      rl.status = "rollback_failed";
      rl.error = `rollback failed, resources left behind: ${resources.map((r) => r.label ?? r.key).join(", ")} (${redactor.redact((e as Error).message)})`;
    }
  }
}

// ---------------------------------------------------------------------------
// destroy
// ---------------------------------------------------------------------------

export async function destroyRun(opts: RunOptions): Promise<ApplyResultSummary> {
  const redactor = opts.redactor ?? new Redactor();
  const now = opts.now ?? (() => new Date());
  const warnings: string[] = [];
  requireApproval(opts);
  const holder = `destroy-${randomUUID().slice(0, 8)}`;
  const preempted = await acquireLock(opts, holder);
  if (preempted) warnings.push(`Took over an expired lock held by ${preempted.holder}.`);
  try {
    const previous = await loadPrevious(opts, warnings);
    const receipt: Receipt = {
      version: 1,
      runId: holder,
      environment: opts.ctx.env,
      scope: opts.ctx.scope,
      status: "complete",
      startedAt: now().toISOString(),
      finishedAt: "",
      plan: { hash: opts.plan.hash },
      ctx: opts.ctx,
      lines: {},
      destroy: true,
    };
    const lines = activeReceiptLines(previous);
    if (lines.length === 0) {
      warnings.push("Nothing to destroy: no receipt for this scope.");
      receipt.finishedAt = now().toISOString();
      return { receipt, drift: [], warnings };
    }
    // Reverse dependency order: receipts are stored in apply order, so reverse that.
    const order = previous ? Object.keys(previous.lines).reverse() : [];
    for (const id of order) {
      const pl = lines.find((l) => l.id === id);
      if (!pl) continue;
      const ours = pl.resources.filter((r) => r.createdBy === "sponson");
      const theirs = pl.resources.filter((r) => r.createdBy !== "sponson");
      const out: ReceiptLine = { ...pl, status: "destroyed", resources: theirs, error: undefined };
      receipt.lines[id] = out;
      if (ours.length === 0) {
        out.status = "skipped";
        out.error = theirs.length ? "skipped: adopted resources are never destroyed" : "skipped: nothing created by Sponson";
        continue;
      }
      try {
        const op = opts.registry.op(pl.adapter, pl.op);
        const actx = adapterContext(opts, pl.adapter, redactor);
        actx.log(`destroy ${id}`);
        await op.destroy(actx, ours);
        if (theirs.length) out.notes = { ...(out.notes ?? {}), adoptedKept: theirs.map((r) => r.key) };
      } catch (e) {
        out.status = "destroy_failed";
        out.resources = pl.resources;
        out.error = redactor.redact((e as Error).message);
      }
    }
    receipt.status = overallStatus(receipt);
    receipt.finishedAt = now().toISOString();
    await opts.store.write(receipt);
    return { receipt, drift: [], warnings };
  } finally {
    await opts.store.releaseLock(opts.ctx.env, opts.ctx.scope, holder).catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
