/**
 * Every user-facing failure is a SponsonError with a stable code. The codes are data: each one says
 * which exit code the CLI uses for it and, when the remedy is a CLI flag, the hint the CLI prints.
 * The engine never names CLI flags itself; it speaks in run options (`approvedBy`, `reconcile`).
 *
 * Exit codes: 0 ok (including partial), 1 failed, 2 the invocation / plan / reference / environment /
 * parameter is wrong, 3 the scope's lock is held or was lost (wait, do not force).
 */
export type ExitCode = 0 | 1 | 2 | 3;

/**
 * The entry `ERROR_CODES` keeps per code: its exit code, one line of documentation, and the CLI's remedy when
 * there is one.
 */
export interface ErrorCodeSpec {
  exit: ExitCode;
  /** What the code means, for docs and agents. */
  doc?: string;
  /** How to act on it from the command line; the CLI appends it to the message. */
  cliHint?: string;
}

/**
 * Every error code Sponson can report, the single table that agents, the CLI and the docs read. Adding a code
 * means adding it here.
 */
export const ERROR_CODES = {
  PLAN_PARSE: { exit: 2, doc: "The plan file cannot be read or is not valid YAML." },
  PLAN_INVALID: { exit: 2, doc: "The plan does not match the schema." },
  REF_UNKNOWN: { exit: 2, doc: "A `from:` reference names a line that does not exist." },
  REF_CYCLE: { exit: 2, doc: "References form a cycle." },
  REF_FILTERED: { exit: 2, doc: "A reference crosses an environment filter." },
  REF_OUTPUT_UNKNOWN: { exit: 2, doc: "A `from:` reference names an output the op does not declare." },
  CTX_NULL: { exit: 2, doc: "A `${ctx.*}` interpolation is unknown or null in this context." },
  ENV_UNKNOWN: { exit: 2, doc: "The environment is not declared by the plan." },
  ENV_NOT_APPROVED: {
    exit: 2,
    doc: "The run writes to production and no approver was given (approvedBy).",
    cliHint: "Pass --approved-by <who> or set SPONSON_APPROVED_BY from an approval workflow.",
  },
  SECRET_LITERAL: { exit: 2, doc: "A parameter that looks like a secret is written as a literal." },
  SECRET_UNRESOLVED: { exit: 1, doc: "A secret source could not resolve a reference." },
  ADAPTER_UNKNOWN: { exit: 2, doc: "No adapter of that name is registered." },
  OP_UNKNOWN: { exit: 2, doc: "The adapter has no op of that name." },
  PARAM_INVALID: { exit: 2, doc: "An adapter rejected a parameter." },
  USAGE: { exit: 2, doc: "The command line is wrong." },
  DRIFT_CHANGED: {
    exit: 1,
    doc: "A resource was changed or replaced outside Sponson; the line is refused unless the run reconciles.",
    cliHint: "Re-run with --reconcile to take the live resource over, or update the plan.",
  },
  LOCK_HELD: { exit: 3, doc: "Another run holds the scope's lock.", cliHint: "Wait for it, or pass --wait." },
  LOCK_LOST: { exit: 3, doc: "The run lost the scope's lock to another run and stopped." },
  RECEIPT_CORRUPT: { exit: 1, doc: "The receipt cannot be parsed." },
  RECEIPT_VERSION: { exit: 1, doc: "The receipt was written by a newer Sponson." },
  STORE_PERMISSION: { exit: 1, doc: "The receipt store cannot be read or written." },
  STORE_CONTENDED: { exit: 1, doc: "The receipt store stayed contended past the retry budget." },
  STORE_REJECTED: { exit: 1, doc: "The receipt store kept rejecting the receipt; a fallback copy was kept." },
  WAIT_TIMEOUT: { exit: 1, doc: "An external event did not happen within the wait timeout." },
  OWNED_BY_OTHER_SCOPE: { exit: 1, doc: "Another scope in this environment manages the resource." },
  OUTPUT_UNAVAILABLE: {
    exit: 1,
    doc: "A line needs an output its provider reveals only when the resource is created (a password), that resource was created in an earlier run, and the line cannot be shown to hold the value; nothing is re-created to get it back unless asked.",
    cliHint: "Pass --recreate <line> to create the producing line's resource again (its new value reaches every dependent in that run), or keep the value in a secret manager and reference it with `{ secret: … }`.",
  },
  INTERNAL: { exit: 1, doc: "An unexpected error." },
  PROVIDER_TRANSIENT: { exit: 1, doc: "The provider failed transiently (after retries)." },
  PROVIDER_CONFLICT: { exit: 1, doc: "The provider reported a conflict." },
  PROVIDER_NOT_FOUND: { exit: 1, doc: "The provider reported that something does not exist." },
  PROVIDER_AUTH: { exit: 1, doc: "Credentials are missing or rejected." },
  PROVIDER_INVALID: { exit: 1, doc: "The provider rejected the request as invalid." },
  PROVIDER_TIMEOUT: { exit: 1, doc: "The provider did not answer in time." },
  PROVIDER_RESPONSE: { exit: 1, doc: "The provider answered with an unexpected shape." },
  DEPENDENCY_BLOCKED: { exit: 1, doc: "A line this one depends on failed or is blocked." },
  EXTERNAL_FAILED: { exit: 1, doc: "The external event a line waits for failed." },
  INTERRUPTED: { exit: 1, doc: "The run did not finish (checkpoint written before a create)." },
  INTENT_UNRESOLVED: { exit: 1, doc: "An interrupted create cannot be located; check the provider by hand." },
  ROLLBACK_FAILED: { exit: 1, doc: "Rolling back what the run created failed; resources were left behind." },
  DESTROY_FAILED: { exit: 1, doc: "Destroying a resource failed." },
  STALE: { exit: 1, doc: "The commit is older than the last applied one; nothing was changed." },
} as const satisfies Record<string, ErrorCodeSpec>;

/** A stable machine-readable error code; branch on it rather than on messages. */
export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * Codes of non-fatal findings (parse warnings). They never fail a run and have no exit code.
 */
export const WARNING_CODES = {
  YAML_ANCHOR: { doc: "The plan uses YAML anchors/aliases; allowed, but hard to read." },
} as const satisfies Record<string, { doc: string }>;

/** A stable code for a parse warning. */
export type WarningCode = keyof typeof WARNING_CODES;

/** The process exit code for an error code (1 for one that is not in the table). */
export function exitCodeFor(code: ErrorCode): ExitCode {
  return (ERROR_CODES[code] as ErrorCodeSpec | undefined)?.exit ?? 1;
}

/** The CLI remedy for an error code, if it has one. Library callers word their own remedies. */
export function cliHintFor(code: ErrorCode): string | undefined {
  return (ERROR_CODES[code] as ErrorCodeSpec | undefined)?.cliHint;
}

/**
 * The error every Sponson layer throws on purpose: a stable `code` from `ERROR_CODES`, a message that says what
 * happened, and structured `details`. Adapters throw it too.
 */
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

/** Type guard for `SponsonError`; anything else that was thrown is unexpected. */
export function isSponsonError(e: unknown): e is SponsonError {
  return e instanceof SponsonError;
}
