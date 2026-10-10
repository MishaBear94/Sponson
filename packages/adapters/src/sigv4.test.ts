import { describe, expect, it } from "vitest";
import { amzDate, canonicalQuery, canonicalRequest, canonicalUri, signRequest, stringToSign, uriEncode } from "./sigv4.js";

/**
 * AWS's published SigV4 test suite (github.com/awslabs/aws-c-auth, tests/aws-signing-test-suite/v4; the same
 * vectors as the older aws-sig-v4-test-suite): every vector signs with these credentials, region, service and time.
 */
const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const DATE = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));
const SCOPE = { region: "us-east-1", service: "service", date: DATE, contentSha256Header: false };
const AUTH = (signed: string, sig: string) => `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=${signed}, Signature=${sig}`;

describe("SigV4 against AWS's test suite", () => {
  it("get-vanilla: canonical request, string to sign and signature", () => {
    const req = { method: "GET", url: "https://example.amazonaws.com/", headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" }, body: "" };
    const { request, signedHeaders } = canonicalRequest(req, "service");
    expect(request).toBe("GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(signedHeaders).toBe("host;x-amz-date");
    expect(stringToSign(request, SCOPE)).toBe("AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63");
    const out = signRequest({ method: "GET", url: "https://example.amazonaws.com/", headers: {}, body: "" }, CREDS, SCOPE);
    expect(out).toEqual({ "x-amz-date": "20150830T123600Z", authorization: AUTH("host;x-amz-date", "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31") });
  });

  it("get-vanilla-query-order-key-case: parameters are sorted", () => {
    const out = signRequest({ method: "GET", url: "https://example.amazonaws.com/?Param2=value2&Param1=value1", headers: {}, body: "" }, CREDS, SCOPE);
    expect(out.authorization).toBe(AUTH("host;x-amz-date", "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500"));
  });

  it("post-vanilla", () => {
    const out = signRequest({ method: "POST", url: "https://example.amazonaws.com/", headers: {}, body: "" }, CREDS, SCOPE);
    expect(out.authorization).toBe(AUTH("host;x-amz-date", "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b"));
  });

  it("post-x-www-form-urlencoded: a body and its content type are signed", () => {
    const req = { method: "POST", url: "https://example.amazonaws.com/", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "Param1=value1" };
    expect(signRequest(req, CREDS, SCOPE).authorization).toBe(AUTH("content-type;host;x-amz-date", "ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a"));
    // The aws-c-auth variant signs the body hash header and the content length too.
    const signed = signRequest({ ...req, headers: { ...req.headers, "content-length": "13" } }, CREDS, { ...SCOPE, contentSha256Header: true });
    expect(signed["x-amz-content-sha256"]).toBe("9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e");
    expect(signed.authorization).toBe(AUTH("content-length;content-type;host;x-amz-content-sha256;x-amz-date", "d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b"));
  });

  it("temporary credentials send and sign their session token; an incoming authorization header is never signed", () => {
    const out = signRequest({ method: "GET", url: "https://example.amazonaws.com/", headers: { authorization: "Bearer stale" }, body: "" }, { ...CREDS, sessionToken: "session-token-value" }, SCOPE);
    expect(out["x-amz-security-token"]).toBe("session-token-value");
    expect(out.authorization).toContain("SignedHeaders=host;x-amz-date;x-amz-security-token,");
  });
});

describe("SigV4 canonical forms", () => {
  it("encodes like RFC 3986 with upper-case hex", () => {
    expect(uriEncode("a b/c~d*e'(f)!")).toBe("a%20b%2Fc~d%2Ae%27%28f%29%21");
    expect(amzDate(DATE)).toBe("20150830T123600Z");
  });

  it("path segments are encoded once for S3 and twice for every other service", () => {
    expect(canonicalUri("/documents%20and%20settings/", "s3")).toBe("/documents%20and%20settings/");
    expect(canonicalUri("/documents%20and%20settings/", "amplify")).toBe("/documents%2520and%2520settings/");
    expect(canonicalUri("", "s3")).toBe("/");
  });

  it("query: a flag is name=, values are encoded, pairs sort by name then value", () => {
    expect(canonicalQuery("?cors")).toBe("cors=");
    expect(canonicalQuery("?b=2&a=z&a=y&c=%2F x")).toBe("a=y&a=z&b=2&c=%2F%20x");
    expect(canonicalQuery("")).toBe("");
  });
});
