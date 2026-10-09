/**
 * Every user-facing failure is a SponsonError with a stable code.
 * The CLI maps codes to exit codes; the JSON output includes them verbatim
 * so agents can branch on them without parsing prose.
 */
export type ErrorCode =
  | "PLAN_PARSE"
  | "PLAN_INVALID"
  | "REF_UNKNOWN"
  | "REF_CYCLE"
  | "REF_FILTERED"
  | "CTX_NULL"
  | "ENV_UNKNOWN"
  | "ENV_NOT_APPROVED"
  | "SECRET_LITERAL"
  | "SECRET_UNRESOLVED"
  | "ADAPTER_UNKNOWN"
  | "OP_UNKNOWN"
  | "DRIFT_CHANGED"
  | "LOCK_HELD"
  | "RECEIPT_CORRUPT"
  | "RECEIPT_VERSION"
  | "STORE_PERMISSION"
  | "APPLY_FAILED"
  | "WAIT_TIMEOUT"
  | "LOCK_LOST"
  | "STORE_CONTENDED"
  | "STORE_REJECTED"
  | "OWNED_BY_OTHER_SCOPE"
  | "REF_OUTPUT_UNKNOWN"
  | "USAGE"
  | "INTERNAL"
  // Provider errors, classified by the HTTP layer so agents can branch on them.
  | "PROVIDER_TRANSIENT"
  | "PROVIDER_CONFLICT"
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_AUTH"
  | "PROVIDER_INVALID"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_RESPONSE"
  | "PARAM_INVALID"
  | "DEPENDENCY_BLOCKED"
  | "EXTERNAL_FAILED"
  | "INTERRUPTED"
  | "INTENT_UNRESOLVED"
  | "ROLLBACK_FAILED"
  | "DESTROY_FAILED"
  | "STALE";

export class SponsonError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SponsonError";
  }

  toJSON() {
    return { code: this.code, message: this.message, ...this.details };
  }
}

export function isSponsonError(e: unknown): e is SponsonError {
  return e instanceof SponsonError;
}
