import { describe, expect, it } from "vitest";
import { MASK, Redactor } from "./redact.js";

function redactorWith(...values: string[]): Redactor {
  const r = new Redactor();
  for (const v of values) r.register(v);
  return r;
}

describe("Redactor encodings", () => {
  const secret = 'Zq9"Top/Secret+Middle=Part&\\Tail 0042';

  it("masks the raw value", () => {
    expect(redactorWith(secret).redact(`a ${secret} b`)).toBe(`a ${MASK} b`);
  });

  it("masks the JSON-escaped form (as inside JSON.stringify output)", () => {
    const text = JSON.stringify({ echoed: secret });
    const out = redactorWith(secret).redact(text);
    expect(out).toBe(`{"echoed":"${MASK}"}`);
  });

  it("masks percent-encoded and form-encoded forms", () => {
    const r = redactorWith(secret);
    expect(r.redact(`q=${encodeURIComponent(secret)}&x=1`)).toBe(`q=${MASK}&x=1`);
    expect(r.redact(`q=${encodeURIComponent(secret).replace(/%20/g, "+")}`)).toBe(`q=${MASK}`);
    expect(r.redact(`q=${encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())}`)).toBe(`q=${MASK}`);
  });

  it("masks base64 and base64url, also inside a longer encoded payload at any alignment", () => {
    const r = redactorWith(secret);
    for (const prefix of ["", "u", "us", "user:"]) {
      const b64 = Buffer.from(`${prefix}${secret}`).toString("base64");
      const b64url = Buffer.from(`${prefix}${secret}`).toString("base64url");
      for (const enc of [b64, b64url]) {
        const out = r.redact(`Authorization: Basic ${enc}`);
        expect(out).toContain(MASK);
        // At most a couple of boundary characters survive.
        expect(out.replace(`Authorization: Basic `, "").replace(MASK, "").replace(/=+$/, "").length).toBeLessThanOrEqual(prefix.length + 3);
      }
    }
  });

  it("masks multi-line values whole, flattened, JSON-escaped and line by line", () => {
    const pem = ["-----BEGIN PRIVATE KEY-----", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj", "MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu", "-----END PRIVATE KEY-----"].join("\n");
    const r = redactorWith(pem);
    for (const text of [pem, pem.replace(/\n/g, " "), JSON.stringify(pem), pem.split("\n")[1]!, pem.replace(/\n/g, "\r\n")]) {
      const out = r.redact(`x ${text} y`);
      expect(out).not.toContain("MIIEvQIBADANBgkq");
      expect(out).not.toContain("MzEfYyjiWA4R4");
    }
  });

  it("masks the password of a URL and of a libpq DSN built from a registered connection string", () => {
    const conn = "postgres://app_user:pw-Xy7%21secret@ep-1.neon.tech/app?sslmode=require";
    const r = redactorWith(conn);
    expect(r.redact(conn)).toBe(MASK);
    expect(r.redact("host=ep-1.neon.tech user=app_user password=pw-Xy7!secret dbname=app")).toBe(`host=ep-1.neon.tech user=app_user password=${MASK} dbname=app`);
    expect(r.redact("password: pw-Xy7%21secret")).toBe(`password: ${MASK}`);
    const dsn = redactorWith("host=db user=u password='s3cr3t-pass' dbname=x");
    expect(dsn.redact("echo s3cr3t-pass")).toBe(`echo ${MASK}`);
  });

  it("masks overlapping values longest first, with regex metacharacters taken literally", () => {
    const short = "a.b*c+d?(e)";
    const long = "a.b*c+d?(e)[f]$^|x: {y}";
    const r = redactorWith(short, long);
    expect(r.redact(`<${short}> <${long}>`)).toBe(`<${MASK}> <${MASK}>`);
  });

  it("masks the head or the tail of a long value cut off by truncation", () => {
    const secret = "fake_lv_PREFIXLEAKS0123456789_SUFFIXisCUT";
    const r = redactorWith(secret);
    const truncated = `${"x".repeat(20)} value=${secret.slice(0, 22)}`;
    expect(r.redact(truncated)).toBe(`${"x".repeat(20)} value=${MASK}`);
    expect(r.redact(`…${secret.slice(-20)} end`)).toBe(`…${MASK} end`);
  });

  it("leaks() detects any registered form", () => {
    const r = redactorWith(secret);
    expect(r.leaks(encodeURIComponent(secret))).toEqual([secret]);
    expect(r.leaks(Buffer.from(secret).toString("base64"))).toEqual([secret]);
    expect(r.leaks("nothing here")).toEqual([]);
  });
});

describe("short values", () => {
  it("are not masked but counted, and the warning never contains the value", () => {
    const r = redactorWith("917", "ab", "917");
    expect(r.redact("pin 917")).toBe("pin 917");
    expect(r.shortCount()).toBe(2);
    const w = r.shortWarning()!;
    expect(w).toContain("secret shorter than 4 characters cannot be redacted reliably");
    expect(w).not.toContain("917");
  });

  it("no warning when every value is long enough; empty values are ignored", () => {
    const r = redactorWith("abcd", "");
    expect(r.shortWarning()).toBeNull();
  });
});

describe("redactDeep", () => {
  it("redacts string leaves only, returning a copy", () => {
    const r = redactorWith("true", "hunter2-secret");
    const input = { ok: true, n: 4, nil: null, msg: "token hunter2-secret", list: ["true", { deep: "x hunter2-secret" }], true: "key untouched" };
    const out = r.redactDeep(input);
    expect(out).toEqual({ ok: true, n: 4, nil: null, msg: `token ${MASK}`, list: [MASK, { deep: `x ${MASK}` }], true: "key untouched" });
    expect(input.msg).toBe("token hunter2-secret");
    expect(JSON.parse(JSON.stringify(out)).ok).toBe(true);
  });

  it("leaves structural keys alone when asked, so a secret equal to `applied` cannot rewrite a status", () => {
    const r = redactorWith("applied");
    const out = r.redactDeep({ status: "applied", error: "value applied rejected", lines: { a: { status: "applied" } } }, { skipKeys: new Set(["status"]) });
    expect(out).toEqual({ status: "applied", error: `value ${MASK} rejected`, lines: { a: { status: "applied" } } });
  });

  it("serializes objects with toJSON (errors, dates) before redacting", () => {
    const r = redactorWith("s3cret-value");
    const err = { toJSON: () => ({ code: "X", message: "bad s3cret-value" }) };
    expect(r.redactDeep({ error: err })).toEqual({ error: { code: "X", message: `bad ${MASK}` } });
  });
});
