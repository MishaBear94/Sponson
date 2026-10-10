/** What a masked value is replaced with. */
export const MASK = "[REDACTED]";
/** Values shorter than this are not masked (they would match ordinary words and JSON tokens). */
export const MIN_REDACT_LENGTH = 4;
/** Head/tail length used to catch a long value cut off by truncation. */
const FRAGMENT_LENGTH = 16;
/** A base64 run shorter than this is too likely to occur by chance in unrelated text. */
const MIN_BASE64_LENGTH = 8;
/** A line of a multi-line value is masked on its own (whitespace flattening) when at least this long. */
const MIN_LINE_LENGTH = 8;

/** Options for `Redactor.redactDeep`. */
export interface RedactDeepOptions {
  /**
   * Object keys whose string values are structural (enums such as `status`, `kind`, `code`) and must
   * not be rewritten: a secret that happens to equal "applied" must not turn a status into `[REDACTED]`.
   */
  skipKeys?: ReadonlySet<string>;
}

/**
 * The single redaction choke point. One instance lives for a whole command: the engine registers every
 * resolved secret, every sensitive output and every provider credential; every byte Sponson prints, logs
 * or writes to a receipt passes through it.
 *
 * A registered value is masked in every form a provider or a serializer is likely to turn it into:
 * raw, JSON-string-escaped, URL-encoded (percent and form encoding), base64 / base64url at any byte
 * alignment, whitespace-flattened and line by line for multi-line values, and, for URLs and DSNs,
 * the password inside them. A long value is also masked when only its head or tail survives
 * truncation. Values shorter than 4 characters cannot be masked without destroying ordinary text;
 * they are counted so the CLI can warn (never echoing the value).
 *
 * Use one per command and pass it as `RunOptions.redactor`, so text you print yourself is masked with
 * everything the engine registered.
 *
 * @example
 * ```ts
 * const redactor = new Redactor();
 * const result = await planRun({ plan, ctx, registry, store, redactor });
 * process.stdout.write(redactor.redact(myRendering(result)));      // text
 * process.stdout.write(JSON.stringify(redactor.redactDeep(result))); // JSON: redact values, then serialize
 * ```
 */
export class Redactor {
  /** Every masked form → the raw value it came from (for `leaks`). */
  private readonly forms = new Map<string, string>();
  /** Forms long enough to be recognised by their head or tail alone. */
  private readonly fragmentForms = new Set<string>();
  private readonly raw = new Set<string>();
  private readonly tooShort = new Set<string>();
  private sorted: string[] | null = null;

  /** Mask `value` (in all its encodings) from now on. Null, undefined and empty values are ignored. */
  register(value: string | number | boolean | null | undefined): void {
    if (value === null || value === undefined) return;
    const v = String(value);
    if (v.length === 0) return;
    if (v.length < MIN_REDACT_LENGTH) {
      this.tooShort.add(v);
      return;
    }
    if (this.raw.has(v)) return;
    this.raw.add(v);
    this.sorted = null;

    const bases = new Set<string>([v]);
    if (/\s/.test(v)) {
      const flat = v.replace(/\s+/g, " ").trim();
      if (flat.length >= MIN_REDACT_LENGTH) bases.add(flat);
      for (const line of v.split(/\r\n|\r|\n/)) {
        const t = line.trim();
        if (t.length >= MIN_LINE_LENGTH) bases.add(t);
      }
    }
    for (const b of bases) this.addEncodings(b, v);

    // Credentials embedded in URLs and DSNs: a provider may echo the password in another shape.
    for (const part of credentialParts(v)) {
      if (part.length < MIN_REDACT_LENGTH || this.raw.has(part)) continue;
      this.raw.add(part);
      this.addEncodings(part, part);
    }
  }

  private addEncodings(form: string, origin: string): void {
    const add = (s: string, fragment = false) => {
      if (s.length < MIN_REDACT_LENGTH) return;
      if (!this.forms.has(s)) this.forms.set(s, origin);
      if (fragment && s.length > FRAGMENT_LENGTH) this.fragmentForms.add(s);
    };
    add(form, true);
    const json = JSON.stringify(form).slice(1, -1);
    add(json, true);
    add(JSON.stringify(json).slice(1, -1));
    const pct = encodeURIComponent(form);
    add(pct);
    add(pct.replace(/%20/g, "+"));
    add(pct.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
    for (const b64 of base64Forms(form)) if (b64.length >= MIN_BASE64_LENGTH) add(b64);
  }

  private ordered(): string[] {
    this.sorted ??= [...this.forms.keys()].sort((a, b) => b.length - a.length);
    return this.sorted;
  }

  /** Mask every registered value in every registered form, longest first. */
  redact(text: string): string {
    if (this.forms.size === 0 || text.length === 0) return text;
    let out = text;
    for (const f of this.ordered()) if (out.includes(f)) out = out.split(f).join(MASK);
    if (this.fragmentForms.size > 0) out = this.maskFragments(out);
    return out;
  }

  /**
   * A value cut off by truncation survives as a head (or a tail) of the whole. Mask any run of
   * at least FRAGMENT_LENGTH characters that matches the start or the end of a long registered form.
   */
  private maskFragments(text: string): string {
    let out = text;
    for (const f of this.fragmentForms) {
      const head = f.slice(0, FRAGMENT_LENGTH);
      let i = out.indexOf(head);
      while (i >= 0) {
        let n = FRAGMENT_LENGTH;
        while (n < f.length && i + n < out.length && out[i + n] === f[n]) n++;
        out = out.slice(0, i) + MASK + out.slice(i + n);
        i = out.indexOf(head, i + MASK.length);
      }
      const tail = f.slice(-FRAGMENT_LENGTH);
      let j = out.indexOf(tail);
      while (j >= 0) {
        const end = j + FRAGMENT_LENGTH;
        let n = FRAGMENT_LENGTH;
        while (n < f.length && end - n - 1 >= 0 && out[end - n - 1] === f[f.length - n - 1]) n++;
        out = out.slice(0, end - n) + MASK + out.slice(end);
        j = out.indexOf(tail, end - n + MASK.length);
      }
    }
    return out;
  }

  /**
   * A copy of a JSON value with every string leaf redacted. Object keys, numbers, booleans and null are
   * untouched, so redaction can never change the structure or the meaning of a document. Serialize the
   * result; never string-replace serialized JSON.
   */
  redactDeep<T>(value: T, opts: RedactDeepOptions = {}): T {
    return this.deep(value, opts.skipKeys, false) as T;
  }

  private deep(value: unknown, skip: ReadonlySet<string> | undefined, structural: boolean): unknown {
    if (typeof value === "string") return structural ? value : this.redact(value);
    if (value === null || typeof value !== "object") return value;
    const withJson = value as { toJSON?: () => unknown };
    if (typeof withJson.toJSON === "function") return this.deep(withJson.toJSON(), skip, structural);
    if (Array.isArray(value)) return value.map((x) => this.deep(x, skip, false));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = this.deep(v, skip, skip?.has(k) === true && typeof v === "string");
    }
    return out;
  }

  /** For assertions in tests: the registered values found in `text` in any of their forms. */
  leaks(text: string): string[] {
    const found = new Set<string>();
    for (const [form, origin] of this.forms) if (text.includes(form)) found.add(origin);
    return [...found];
  }

  /** Number of distinct registered values (including credential parts). */
  size(): number {
    return this.raw.size;
  }

  /** Number of distinct secret values that were too short to mask. */
  shortCount(): number {
    return this.tooShort.size;
  }

  /** The one warning to print when some secret could not be masked, or null. Never contains the value. */
  shortWarning(): string | null {
    const n = this.tooShort.size;
    if (n === 0) return null;
    return `secret shorter than ${MIN_REDACT_LENGTH} characters cannot be redacted reliably (${n} value${n === 1 ? "" : "s"}); use a longer secret`;
  }
}

/**
 * base64 and base64url of `s` as it would appear inside a longer encoded payload (e.g. `user:` + secret in
 * a Basic auth header): for each of the three byte alignments, the run of characters that depends only on `s`.
 */
function base64Forms(s: string): string[] {
  const bytes = Buffer.from(s, "utf8");
  const out = new Set<string>();
  const full = bytes.toString("base64");
  out.add(full);
  out.add(full.replace(/={1,2}$/, "")); // base64 pads with at most two `=`
  for (let shift = 0; shift < 3; shift++) {
    const enc = Buffer.concat([Buffer.alloc(shift), bytes]).toString("base64");
    const start = Math.ceil((shift * 8) / 6);
    const end = Math.floor(((shift + bytes.length) * 8) / 6);
    if (end > start) out.add(enc.slice(start, end));
  }
  for (const b of [...out]) out.add(b.replace(/\+/g, "-").replace(/\//g, "_"));
  return [...out];
}

/** The password of a URL with userinfo, and `password=` values of libpq-style DSNs / query strings. */
function credentialParts(v: string): string[] {
  const parts = new Set<string>();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      if (u.password) {
        parts.add(u.password);
        parts.add(safeDecode(u.password));
      }
      for (const [k, val] of u.searchParams) if (/^(password|pass|pwd)$/i.test(k) && val) parts.add(val);
    } catch {
      /* not a parseable URL */
    }
  }
  for (const m of v.matchAll(/(?:^|[\s?&;])(?:password|pwd)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s&;'"]+))/gi)) {
    const val = m[1] ?? m[2] ?? m[3];
    if (val) {
      parts.add(val);
      parts.add(safeDecode(val));
    }
  }
  parts.delete(v);
  return [...parts];
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
