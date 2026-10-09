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
  | "WAIT_TIMEOUT";

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
