/**
 * The one output contract. Every command, every failure path and every MCP tool answers with one envelope:
 *
 *   { ok: true,  command, ...data }
 *   { ok: false, command, error: { code, message, hint?, ...details } }
 *
 * `hint` is the command-line remedy for the code (core's ERROR_CODES `cliHint`): the engine's messages speak in
 * run options (`approvedBy`, `reconcile`), the CLI tells people which flag that is.
 *
 * JSON is redacted field by field (`redactDeep`) and only then serialized; text goes through `redact`.
 * Serialized JSON is never string-replaced: that is how a secret equal to "true" once corrupted `"ok": true`.
 */
import { CommanderError } from "commander";
import { LockHeldError, LockLostError, SponsonError, cliHintFor, exitCodeFor as exitCodeOf, isSponsonError, type ErrorCode, type Redactor } from "@sponson/core";

/** Fields whose string values are enums; a secret that equals one of their values must not rewrite them. */
export const STRUCTURAL_KEYS: ReadonlySet<string> = new Set(["status", "kind", "state", "code", "errorCode", "createdBy", "command", "available"]);

export interface ErrorEnvelope {
  ok: false;
  command: string | null;
  error: { code: string; message: string; hint?: string; [detail: string]: unknown };
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
  const hint = cliHintFor(err.code);
  return { ok: false, command, error: { ...err.details, code: err.code, message: err.message, ...(hint ? { hint } : {}) } };
}

/** The CLI remedy for an error code (e.g. which flag gives approval), appended to text output; "" when there is none. */
export function cliHint(code: ErrorCode | undefined): string {
  return code ? (cliHintFor(code) ?? "") : "";
}

/** Exit code for an error: data in core's ERROR_CODES (0 ok, 1 failed, 2 wrong invocation/plan/ref/env/param, 3 lock). */
export function exitCodeFor(e: SponsonError): number {
  return exitCodeOf(e.code);
}

/** The redactor's "could not mask a short secret" warning, appended once. */
export function withRedactorWarnings(warnings: string[], redactor: Redactor): string[] {
  const w = redactor.shortWarning();
  return w && !warnings.includes(w) ? [...warnings, w] : warnings;
}
