import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { digestChallenge, digestProblem, expectedSigV4, issueToken, sigV4Problem, tokenValid, type OAuthState } from "./auth.js";
import { Reply, type AuthRequest } from "./provider.js";

/** AWS's SigV4 test suite: credentials, scope and time every vector uses. */
const KEYS = { AKIDEXAMPLE: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const AT = Date.UTC(2015, 7, 30, 12, 36, 0);

function req(method: string, target: string, raw = ""): AuthRequest {
  return { method, target, raw, url: new URL(target, "https://example.amazonaws.com") };
}

describe("sim SigV4 verification (independent of the client signer)", () => {
  const getVanilla = { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" };
  const sig = "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31";
  const authz = (s: string, signed = "host;x-amz-date") => `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=${signed}, Signature=${s}`;
  const config = { keys: KEYS, region: "us-east-1", service: "service", now: () => AT };

  it("recomputes the published signatures of get-vanilla and post-x-www-form-urlencoded", () => {
    expect(expectedSigV4(req("GET", "/"), getVanilla, KEYS.AKIDEXAMPLE, { date: "20150830", region: "us-east-1", service: "service", signed: ["host", "x-amz-date"], amzDate: "20150830T123600Z" })).toBe(sig);
    const post = { ...getVanilla, "content-type": "application/x-www-form-urlencoded" };
    expect(expectedSigV4(req("POST", "/", "Param1=value1"), post, KEYS.AKIDEXAMPLE, { date: "20150830", region: "us-east-1", service: "service", signed: ["content-type", "host", "x-amz-date"], amzDate: "20150830T123600Z" })).toBe("ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a");
  });

  it("accepts a valid signature and names what is wrong with an invalid one", () => {
    expect(sigV4Problem({ ...getVanilla, authorization: authz(sig) }, req("GET", "/"), config)).toBeNull();
    expect(sigV4Problem({ ...getVanilla, authorization: authz(sig.replace("5", "6")) }, req("GET", "/"), config)).toBe("SignatureDoesNotMatch");
    expect(sigV4Problem({ ...getVanilla, authorization: authz(sig) }, req("GET", "/?x=1"), config)).toBe("SignatureDoesNotMatch");
    expect(sigV4Problem({ ...getVanilla }, req("GET", "/"), config)).toMatch(/missing or malformed/);
    expect(sigV4Problem({ ...getVanilla, authorization: authz(sig).replace("AKIDEXAMPLE", "AKIDOTHER") }, req("GET", "/"), config)).toBe("InvalidAccessKeyId");
    expect(sigV4Problem({ ...getVanilla, authorization: authz(sig) }, req("GET", "/"), { ...config, service: "s3" })).toMatch(/credential scope/);
    expect(sigV4Problem({ host: getVanilla.host, authorization: authz(sig) }, req("GET", "/"), config)).toMatch(/X-Amz-Date/);
    expect(sigV4Problem({ ...getVanilla, authorization: authz(sig) }, req("GET", "/"), { ...config, now: () => AT + 16 * 60_000 })).toBe("RequestTimeTooSkewed");
    expect(sigV4Problem({ ...getVanilla, authorization: authz(sig, "x-amz-date") }, req("GET", "/"), config)).toMatch(/must include host/);
    expect(sigV4Problem({ ...getVanilla, "x-amz-content-sha256": "0".repeat(64), authorization: authz(sig) }, req("GET", "/"), config)).toBe("XAmzContentSHA256Mismatch");
  });
});

describe("sim Digest challenges", () => {
  const config = { users: { mufasa: "Circle of Life" }, algorithm: "SHA-256" as const, realm: "r" };

  it("issues a challenge, then accepts the right answer and refuses others", () => {
    const state = { nonces: [] as string[] };
    const challenge = digestChallenge(config, state, 1);
    expect(challenge).toBeInstanceOf(Reply);
    expect(challenge.status).toBe(401);
    expect(challenge.headers["www-authenticate"]).toMatch(/^Digest realm="r", domain="", nonce="sim-nonce-1-[0-9a-f]{16}", algorithm=SHA-256, qop="auth", stale=FALSE$/);
    const nonce = state.nonces[0]!;
    const h = (s: string) => createHash("sha256").update(s).digest("hex");
    const answer = (over: Record<string, string> = {}) => {
      const p = { username: "mufasa", nonce, uri: "/x?y=1", nc: "00000001", cnonce: "c", qop: "auth", algorithm: "SHA-256", ...over };
      const response = h(`${h(`${p.username}:r:Circle of Life`)}:${p.nonce}:${p.nc}:${p.cnonce}:auth:${h(`GET:${p.uri}`)}`);
      return { authorization: `Digest ${Object.entries({ ...p, response: over.response ?? response }).map(([k, v]) => `${k}="${v}"`).join(", ")}` };
    };
    expect(digestProblem(answer(), req("GET", "/x?y=1"), config, state)).toBeNull();
    expect(digestProblem(answer({ response: "0" }), req("GET", "/x?y=1"), config, state)).toBe("wrong response");
    expect(digestProblem(answer(), req("POST", "/x?y=1"), config, state)).toBe("wrong response");
    expect(digestProblem(answer({ uri: "/other" }), req("GET", "/x?y=1"), config, state)).toBe("uri does not match the request");
    expect(digestProblem(answer({ nonce: "made-up" }), req("GET", "/x?y=1"), config, state)).toBe("unknown nonce");
    expect(digestProblem(answer({ username: "scar" }), req("GET", "/x?y=1"), config, state)).toBe("unknown user");
    expect(digestProblem(answer({ qop: "auth-int" }), req("GET", "/x?y=1"), config, state)).toMatch(/qop=auth/);
    expect(digestProblem(answer({ algorithm: "MD5" }), req("GET", "/x?y=1"), config, state)).toBe("wrong algorithm");
    expect(digestProblem({ authorization: "Bearer x" }, req("GET", "/x?y=1"), config, state)).toBe("no Digest credentials");
  });
});

describe("sim OAuth2 token endpoint", () => {
  const fresh = (): OAuthState => ({ clients: { "client-a": "secret-a-0042" }, ttlSeconds: 60, issued: [] });

  it("issues tokens to clients authenticated by form or by Basic, and they expire or can be revoked", () => {
    const s = fresh();
    const post = issueToken(s, {}, { grant_type: "client_credentials", client_id: "client-a", client_secret: "secret-a-0042", audience: "https://t/api/v2/", scope: "read" }, AT);
    expect(post.body).toEqual({ access_token: "oauth-access-token-1", token_type: "Bearer", expires_in: 60, scope: "read" });
    const basic = issueToken(s, { authorization: `Basic ${Buffer.from("client-a:secret-a-0042").toString("base64")}` }, { grant_type: "client_credentials" }, AT);
    expect(basic.status).toBe(200);
    expect(s.issued.map((t) => [t.method, t.audience])).toEqual([
      ["client_secret_post", "https://t/api/v2/"],
      ["client_secret_basic", undefined],
    ]);
    expect(tokenValid(s, "oauth-access-token-1", AT + 59_000)).toBe(true);
    expect(tokenValid(s, "oauth-access-token-1", AT + 61_000)).toBe(false);
    s.issued[1]!.revoked = true;
    expect(tokenValid(s, "oauth-access-token-2", AT)).toBe(false);
  });

  it("refuses other grants, unknown clients, wrong secrets and a client authenticated twice", () => {
    const s = fresh();
    expect(issueToken(s, {}, { grant_type: "password" }).body).toMatchObject({ error: "unsupported_grant_type" });
    expect(issueToken(s, {}, { grant_type: "client_credentials", client_id: "nope", client_secret: "x" }).status).toBe(401);
    expect(issueToken(s, {}, { grant_type: "client_credentials", client_id: "client-a", client_secret: "wrong" }).body).toMatchObject({ error: "invalid_client" });
    expect(issueToken(s, { authorization: "Basic eDp5" }, { grant_type: "client_credentials", client_id: "client-a" }).body).toMatchObject({ error: "invalid_request" });
    expect(issueToken(s, {}, null).status).toBe(400);
    expect(s.issued).toEqual([]);
  });
});
