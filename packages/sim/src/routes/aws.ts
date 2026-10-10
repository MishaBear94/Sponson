/**
 * Simulated AWS APIs signed with SigV4: S3 bucket CORS configuration (XML) and Amplify branch environment
 * variables (JSON). They exist to test the generic `http` adapter's `auth: { aws_sigv4 }` and `encoding: xml`
 * against something that checks both: every request's signature is recomputed (../auth.ts) and refused when wrong.
 *
 * Path-style, under `/aws`: `/aws/s3/<bucket>/?cors` stands for `https://<bucket>.s3.<region>.amazonaws.com/?cors`,
 * `/aws/amplify/apps/<app>/branches/<branch>` for `https://amplify.<region>.amazonaws.com/apps/<app>/branches/<branch>`.
 *
 * Assumptions (docs/api-verification.md, "AWS through the generic adapter"):
 *   A1. Requests are signed with SigV4 for the path's service (`s3`, `amplify`) and the seeded region; S3 requests
 *       carry `x-amz-content-sha256`. Verified: IAM "Create a signed AWS API request"; S3 "Common request headers".
 *   A2. `PUT /?cors` takes a `CORSConfiguration` of 1 to 100 `CORSRule`s (each with at least one `AllowedOrigin` and
 *       one `AllowedMethod`) and requires `Content-MD5` (or an x-amz-checksum); it replaces the whole configuration
 *       and answers 200 with no body. An empty configuration is `MalformedXML`. Verified: S3 API Reference
 *       PutBucketCors; botocore `requestChecksumRequired`.
 *   A3. `GET /?cors` answers the configuration as XML; a bucket without one answers 404 `NoSuchCORSConfiguration`.
 *       Unverified (the 404 code from memory); `DELETE /?cors` answers 204. Verified: DeleteBucketCors.
 *   A4. Amplify `GetBranch` (`GET`) and `UpdateBranch` (`POST`) on `/apps/{appId}/branches/{branchName}` answer
 *       `{ branch: { …, environmentVariables } }`; `environmentVariables` in an update replaces the whole map.
 *       Verified: Amplify API Reference UpdateBranch, GetBranch. Errors are JSON `{ message }` with
 *       `x-amzn-ErrorType`; unknown app or branch is 404 `NotFoundException`.
 */
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { sigV4Problem } from "../auth.js";
import { Reply, route, router, type AuthRequest, type ProviderSim } from "../provider.js";

/** One S3 CORS rule as stored. */
export interface AwsCorsRule {
  ID?: string;
  AllowedOrigin: string[];
  AllowedMethod: string[];
  AllowedHeader: string[];
  ExposeHeader: string[];
  MaxAgeSeconds?: string;
}

/** Simulated AWS state: buckets with their CORS configuration, Amplify apps with their branches. */
export interface AwsState {
  /** Access key id → secret access key. */
  keys: Record<string, string>;
  region: string;
  buckets: Record<string, { cors: AwsCorsRule[] | null }>;
  amplify: Record<string, { branches: Record<string, { environmentVariables: Record<string, string> }> }>;
}

/** Initial AWS state. Buckets are listed by name; Amplify apps by id, with their branches' variables. */
export interface AwsSeed {
  keys?: Record<string, string>;
  region?: string;
  buckets?: Record<string, { cors?: AwsCorsRule[] | null }>;
  amplify?: Record<string, { branches: Record<string, { environmentVariables?: Record<string, string> }> }>;
}

/** The access key id the sim's default seed accepts (`AWS_SIM_ACCESS_KEY_ID` in `simEnv`). */
export const AWS_SIM_ACCESS_KEY_ID = "AKIASIMEXAMPLE0042";
/** Its secret (`AWS_SIM_SECRET_ACCESS_KEY` in `simEnv`). */
export const AWS_SIM_SECRET_ACCESS_KEY = "sim/aws-secret-access-key-0042";

/** Simulated AWS (S3 bucket CORS, Amplify branch variables); see the assumptions at the top of this file. */
export const awsSim: ProviderSim<AwsState, AwsSeed> = {
  env: { token: "AWS_SIM_SECRET_ACCESS_KEY", url: "AWS_SIM_URL", testToken: AWS_SIM_SECRET_ACCESS_KEY, more: { AWS_SIM_ACCESS_KEY_ID: AWS_SIM_ACCESS_KEY_ID } },
  defaultSeed: { buckets: { assets: { cors: null } }, amplify: { d1demo: { branches: { "pr-42": {} } } } },

  reset(_core, seed) {
    const buckets: AwsState["buckets"] = {};
    for (const [name, b] of Object.entries(seed?.buckets ?? {})) buckets[name] = { cors: b.cors ? structuredClone(b.cors) : null };
    const amplify: AwsState["amplify"] = {};
    for (const [app, a] of Object.entries(seed?.amplify ?? {})) {
      amplify[app] = { branches: Object.fromEntries(Object.entries(a.branches).map(([n, b]) => [n, { environmentVariables: { ...(b.environmentVariables ?? {}) } }])) };
    }
    return { keys: seed?.keys ?? { [AWS_SIM_ACCESS_KEY_ID]: AWS_SIM_SECRET_ACCESS_KEY }, region: seed?.region ?? "us-east-1", buckets, amplify };
  },

  /**
   * `s3.<bucket>.cors`: "delete" removes the configuration; "remove:<ID>" one rule.
   * `amplify.<app>.<branch>.<NAME>`: a new value, or "delete".
   */
  drift(_core, state, { key, rest, value, only }) {
    if (only !== undefined) return false;
    const [kind, a, b, c] = rest.split(".");
    if (kind === "s3" && a && b === "cors") return driftCors(state, a, value, key);
    if (kind === "amplify" && a && b && c) {
      const branch = state.amplify[a]?.branches[b];
      if (!branch) throw new Error(`drift ${key}: no branch ${a}/${b}`);
      if (value === "delete") delete branch.environmentVariables[c];
      else branch.environmentVariables[c] = value;
      return true;
    }
    return false;
  },

  authorized(headers, req, state) {
    return authorized(headers, req, state);
  },

  routes(core, state, req) {
    return routes(core, state, req);
  },
};

function driftCors(state: AwsState, bucket: string, value: string, key: string): boolean {
  const b = state.buckets[bucket];
  if (!b) throw new Error(`drift ${key}: no bucket ${bucket}`);
  if (value === "delete") b.cors = null;
  else if (value.startsWith("remove:")) b.cors = (b.cors ?? []).filter((r) => r.ID !== value.slice(7));
  else throw new Error(`drift ${key}: "delete" or "remove:<ID>"`);
  return true;
}

/** A1: the signature must be valid for the service the path belongs to. */
function authorized(headers: IncomingHttpHeaders, req: AuthRequest, state: AwsState): boolean | Reply {
  const service = /^\/aws\/(s3|amplify)\//.exec(req.url.pathname)?.[1];
  if (!service) return false;
  if (service === "s3" && headers["x-amz-content-sha256"] === undefined) return s3Error(400, "InvalidRequest", "Missing required header for this request: x-amz-content-sha256");
  const problem = sigV4Problem(headers, req, { keys: state.keys, region: state.region, service });
  if (problem === null) return true;
  return service === "s3" ? s3Error(403, problem === "InvalidAccessKeyId" ? problem : "SignatureDoesNotMatch", problem) : amplifyError(401, "UnauthorizedException", problem);
}

// ---------------------------------------------------------------------------
// S3 CORS (XML)
// ---------------------------------------------------------------------------

const XML = { "content-type": "application/xml" };

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function s3Error(status: number, code: string, message: string): Reply {
  return new Reply(status, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${escape(message)}</Message></Error>`, XML);
}

function corsXml(rules: AwsCorsRule[]): string {
  const el = (name: string, values: string[]) => values.map((v) => `<${name}>${escape(v)}</${name}>`).join("");
  const body = rules
    .map((r) => `<CORSRule>${r.ID !== undefined ? el("ID", [r.ID]) : ""}${el("AllowedHeader", r.AllowedHeader)}${el("AllowedMethod", r.AllowedMethod)}${el("AllowedOrigin", r.AllowedOrigin)}${el("ExposeHeader", r.ExposeHeader)}${r.MaxAgeSeconds !== undefined ? el("MaxAgeSeconds", [r.MaxAgeSeconds]) : ""}</CORSRule>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${body}</CORSConfiguration>`;
}

/** The rules of a `CORSConfiguration` document; a reason when it is not one S3 accepts (A2). */
function parseCors(xml: string): AwsCorsRule[] | string {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return "DTDs are not accepted";
  if (!/<CORSConfiguration(\s[^>]*)?>[\s\S]*<\/CORSConfiguration>\s*$/.test(xml.replace(/^<\?xml[^>]*\?>\s*/, ""))) return "the root element must be CORSConfiguration";
  const rules: AwsCorsRule[] = [];
  for (const m of xml.matchAll(/<CORSRule>([\s\S]*?)<\/CORSRule>/g)) {
    const values = (name: string) => [...m[1]!.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g"))].map((x) => unescape(x[1]!));
    const rule: AwsCorsRule = { AllowedOrigin: values("AllowedOrigin"), AllowedMethod: values("AllowedMethod"), AllowedHeader: values("AllowedHeader"), ExposeHeader: values("ExposeHeader") };
    const id = values("ID")[0];
    const age = values("MaxAgeSeconds")[0];
    if (id !== undefined) rule.ID = id;
    if (age !== undefined) rule.MaxAgeSeconds = age;
    if (rule.AllowedOrigin.length === 0 || rule.AllowedMethod.length === 0) return "every CORSRule needs an AllowedOrigin and an AllowedMethod";
    if (rule.AllowedMethod.some((x) => !["GET", "PUT", "POST", "DELETE", "HEAD"].includes(x))) return "AllowedMethod must be GET, PUT, POST, DELETE or HEAD";
    rules.push(rule);
  }
  if (rules.length === 0 || rules.length > 100) return "a CORSConfiguration holds 1 to 100 CORSRules";
  return rules;
}

function putCors(bucket: { cors: AwsCorsRule[] | null }, headers: Record<string, string>, body: unknown): Reply {
  const xml = typeof body === "string" ? body : "";
  const md5 = headers["content-md5"];
  if (md5 === undefined) return s3Error(400, "InvalidRequest", "Missing required header for this request: Content-Md5");
  if (md5 !== createHash("md5").update(xml, "utf8").digest("base64")) return s3Error(400, "BadDigest", "The Content-MD5 you specified did not match what we received.");
  const rules = parseCors(xml);
  if (typeof rules === "string") return s3Error(400, "MalformedXML", rules);
  bucket.cors = rules;
  return new Reply(200, "", XML);
}

// ---------------------------------------------------------------------------
// Amplify branches (JSON)
// ---------------------------------------------------------------------------

function amplifyError(status: number, type: string, message: string): Reply {
  return new Reply(status, { message }, { "x-amzn-errortype": type });
}

function branchView(app: string, name: string, b: { environmentVariables: Record<string, string> }): Reply {
  return new Reply(200, { branch: { branchArn: `arn:aws:amplify:us-east-1:000000000000:apps/${app}/branches/${name}`, branchName: name, stage: "PULL_REQUEST", environmentVariables: { ...b.environmentVariables } } });
}

function updateBranch(app: string, name: string, b: { environmentVariables: Record<string, string> }, body: unknown): Reply {
  if (typeof body !== "object" || body === null) return amplifyError(400, "BadRequestException", "body must be a JSON object");
  const vars = (body as Record<string, unknown>).environmentVariables;
  if (vars !== undefined) {
    if (typeof vars !== "object" || vars === null || !Object.values(vars).every((v) => typeof v === "string")) return amplifyError(400, "BadRequestException", "environmentVariables must map names to strings");
    b.environmentVariables = { ...(vars as Record<string, string>) };
  }
  return branchView(app, name, b);
}

const routes = router<AwsState>(
  [
    route("GET", "/s3/:bucket/", ({ state, params, url }) => {
      const b = state.buckets[params.bucket];
      if (!b) return s3Error(404, "NoSuchBucket", "The specified bucket does not exist");
      if (!url.searchParams.has("cors")) return s3Error(501, "NotImplemented", "only ?cors is simulated");
      return b.cors ? new Reply(200, corsXml(b.cors), XML) : s3Error(404, "NoSuchCORSConfiguration", "The CORS configuration does not exist");
    }),
    route("PUT", "/s3/:bucket/", ({ state, params, url, headers, body }) => {
      const b = state.buckets[params.bucket];
      if (!b) return s3Error(404, "NoSuchBucket", "The specified bucket does not exist");
      if (!url.searchParams.has("cors")) return s3Error(501, "NotImplemented", "only ?cors is simulated");
      return putCors(b, headers, body);
    }),
    route("DELETE", "/s3/:bucket/", ({ state, params, url }) => {
      const b = state.buckets[params.bucket];
      if (!b) return s3Error(404, "NoSuchBucket", "The specified bucket does not exist");
      if (!url.searchParams.has("cors")) return s3Error(501, "NotImplemented", "only ?cors is simulated");
      b.cors = null;
      return new Reply(204, null);
    }),
    route("GET", "/amplify/apps/:app/branches/:branch", ({ state, params }) => {
      const b = state.amplify[params.app]?.branches[params.branch];
      return b ? branchView(params.app, params.branch, b) : amplifyError(404, "NotFoundException", "branch not found");
    }),
    route("POST", "/amplify/apps/:app/branches/:branch", ({ state, params, body }) => {
      const b = state.amplify[params.app]?.branches[params.branch];
      return b ? updateBranch(params.app, params.branch, b, body) : amplifyError(404, "NotFoundException", "branch not found");
    }),
  ],
  () => s3Error(404, "NotFound", "not simulated"),
);
