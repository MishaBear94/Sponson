/**
 * The one output contract. Every command, every failure path and every MCP tool answers with one envelope:
 *
 *   { ok: true,  command, ...data }
 *   { ok: false, command, error: { code, message, ...details } }
 *
 * JSON is redacted field by field (`redactDeep`) and only then serialized; text goes through `redact`.
 * Serialized JSON is never string-replaced: that is how a secret equal to "true" once corrupted `"ok": true`.
 */
import { CommanderError } from "commander";
import { LockHeldError, LockLostError, SponsonError, isSponsonError, type Redactor } from "@sponson/core";

/** Fields whose string values are enums; a secret that equals one of their values must not rewrite them. */
export const STRUCTURAL_KEYS: ReadonlySet<string> = new Set(["status", "kind", "state", "code", "errorCode", "createdBy", "command", "available"]);

export interface ErrorEnvelope {
  ok: false;
  command: string | null;
  error: { code: string; message: string; [detail: string]: unknown };
}

/** Redact every string leaf, then serialize. The only way JSON leaves the process. */
export function serialize(payload: unknown, redactor: Redactor, pretty = true): string {
  const safe = redactor.redactDeep(payload, { skipKeys: STRUCTURAL_KEYS });
  return pretty ? JSON.stringify(safe, null, 2) : JSON.stringify(safe);
}

/** Every throwable becomes a SponsonError with a stable code. */
export function toSponsonError(e: unknown): SponsonError {
  if (isSponsonError(e)) return e;
  if (e instanceof CommanderError) return new SponsonError("USAGE", e.message.replace(/^error: /, ""), { reason: e.code });
  if (e instanceof LockHeldError) return new SponsonError("LOCK_HELD", e.message, { lock: e.lock });
  if (e instanceof LockLostError) return new SponsonError("LOCK_LOST", e.message, { holder: e.holder, current: e.current });
  const message = e instanceof Error ? e.message : String(e);
  return new SponsonError("INTERNAL", message || "unexpected error", e instanceof Error ? { name: e.name } : {});
}

export function errorEnvelope(command: string | null, e: unknown): ErrorEnvelope {
  const err = toSponsonError(e);
  return { ok: false, command, error: { ...err.details, code: err.code, message: err.message } };
}

/**
 * Exit codes: 0 ok (including partial), 1 failed, 2 the invocation / plan / reference / environment /
 * parameter is wrong, 3 the scope's lock is held or was lost (wait, do not force).
 */
export function exitCodeFor(e: SponsonError): number {
  if (e.code === "LOCK_HELD" || e.code === "LOCK_LOST") return 3;
  if (/^(PLAN_|REF_|ENV_)/.test(e.code)) return 2;
  if (["USAGE", "PARAM_INVALID", "CTX_NULL", "SECRET_LITERAL", "ADAPTER_UNKNOWN", "OP_UNKNOWN"].includes(e.code)) return 2;
  return 1;
}

/** The redactor's "could not mask a short secret" warning, appended once. */
export function withRedactorWarnings(warnings: string[], redactor: Redactor): string[] {
  const w = redactor.shortWarning();
  return w && !warnings.includes(w) ? [...warnings, w] : warnings;
}
