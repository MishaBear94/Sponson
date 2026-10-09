/**
 * Every resolved secret is registered here; every byte of output passes through `redact`.
 * Equivalent to GitHub Actions' `::add-mask::`.
 */
export class Redactor {
  private readonly values = new Set<string>();

  register(value: string): void {
    if (value.length >= 4) this.values.add(value);
  }

  redact(text: string): string {
    let out = text;
    // Longest first so a secret that contains another is masked whole.
    for (const v of [...this.values].sort((a, b) => b.length - a.length)) {
      out = out.split(v).join("[REDACTED]");
    }
    return out;
  }

  /** For assertions in tests. */
  leaks(text: string): string[] {
    return [...this.values].filter((v) => text.includes(v));
  }

  size(): number {
    return this.values.size;
  }
}

export const MASK = "[REDACTED]";
