import { describe, expect, it } from "vitest";
import { digestAuthorization, digestResponse, parseChallenges, pickChallenge, type DigestChallenge } from "./digest.js";

/** RFC 7616 §3.9.1: the worked example, with its published responses for MD5 and SHA-256. */
const RFC = {
  header:
    'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=SHA-256, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS", Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=MD5, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"',
  input: { username: "Mufasa", password: "Circle of Life", method: "GET", uri: "/dir/index.html", nc: 1, cnonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ" },
};

function picked(header: string): DigestChallenge {
  const c = pickChallenge(header);
  if ("problem" in c) throw new Error(c.problem);
  return c;
}

describe("HTTP Digest (RFC 7616)", () => {
  it("answers the RFC's example with its published SHA-256 and MD5 responses", () => {
    const sha = picked(RFC.header);
    expect(sha).toMatchObject({ algorithm: "SHA-256", realm: "http-auth@example.org", qop: ["auth", "auth-int"], opaque: "FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS", stale: false });
    expect(digestResponse({ ...RFC.input, challenge: sha })).toBe("753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1");
    expect(digestResponse({ ...RFC.input, challenge: { ...sha, algorithm: "MD5" } })).toBe("8ca523f5e9506fed4657c9700eebdbec");
  });

  it("writes the Authorization header with every parameter the server needs", () => {
    const header = digestAuthorization({ ...RFC.input, challenge: picked(RFC.header) });
    expect(header).toBe(
      'Digest username="Mufasa", realm="http-auth@example.org", uri="/dir/index.html", algorithm=SHA-256, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", nc=00000001, cnonce="f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ", qop=auth, response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"',
    );
    // A random client nonce when none is given, and quotes escaped in a user name.
    expect(digestAuthorization({ ...RFC.input, username: 'a"b', cnonce: undefined, challenge: picked(RFC.header) })).toMatch(/^Digest username="a\\"b", .*cnonce="[0-9a-f]{32}"/);
  });

  it("-sess variants hash the client nonce into HA1", () => {
    const c = { ...picked(RFC.header), algorithm: "MD5-sess" as const };
    expect(digestResponse({ ...RFC.input, challenge: c })).not.toBe("8ca523f5e9506fed4657c9700eebdbec");
    expect(digestResponse({ ...RFC.input, challenge: c })).toMatch(/^[0-9a-f]{32}$/);
  });

  it("parses several challenges, other schemes and stale; MD5 is the default algorithm (MongoDB Atlas)", () => {
    expect(parseChallenges('Bearer realm="x", Digest realm="MMS Public API", domain="", nonce="abc", algorithm=MD5, qop="auth", stale=false').map((c) => c.scheme)).toEqual(["bearer", "digest"]);
    expect(picked('Digest realm="r", nonce="n", qop="auth", stale=TRUE')).toMatchObject({ algorithm: "MD5", stale: true });
  });

  it("refuses what it cannot answer: no challenge, auth-int only, the RFC 2069 form, unknown algorithms", () => {
    expect(pickChallenge(null)).toEqual({ problem: expect.stringMatching(/no WWW-Authenticate/) });
    expect(pickChallenge('Basic realm="x"')).toEqual({ problem: expect.stringMatching(/no Digest challenge/) });
    expect(pickChallenge('Digest realm="r", nonce="n", algorithm=SHA-512-256, qop="auth"')).toEqual({ problem: expect.stringMatching(/no Digest challenge/) });
    expect(pickChallenge('Digest realm="r", nonce="n", qop="auth-int"')).toEqual({ problem: expect.stringMatching(/qop=auth/) });
    expect(pickChallenge('Digest realm="r", nonce="n"')).toEqual({ problem: expect.stringMatching(/qop=auth/) });
  });
});
