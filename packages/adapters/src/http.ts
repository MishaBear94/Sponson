/** Longest response excerpt an error carries. Error pages can be megabytes; receipts and PR comments must not. */
export const HTTP_ERROR_BODY_LIMIT = 500;

/** Thrown on any non-2xx response. Carries an excerpt of the response text for messages; never the request body. */
export class HttpError extends Error {
  public readonly body: string;

  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    body: string,
  ) {
    const excerpt = excerptOf(body);
    super(`${method} ${path} → ${status}${excerpt ? `: ${excerpt}` : ""}`);
    this.name = "HttpError";
    this.body = excerpt;
  }
}

function excerptOf(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > HTTP_ERROR_BODY_LIMIT ? `${flat.slice(0, HTTP_ERROR_BODY_LIMIT)}… (${flat.length} chars)` : flat;
}

export function isHttpError(e: unknown, status?: number): e is HttpError {
  return e instanceof HttpError && (status === undefined || e.status === status);
}

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  /** `bearer` sends `Authorization: Bearer <token>`; `header:<name>` sends the token in a custom header. */
  authHeader?: "bearer" | `header:${string}`;
}

export interface ApiClient {
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
}

/** Minimal JSON client over global fetch. 404 on delete is an error here; adapters decide it means "already gone". */
export function apiClient(opts: ApiClientOptions): ApiClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const auth = opts.authHeader ?? "bearer";
  const headers: Record<string, string> = { accept: "application/json" };
  if (auth === "bearer") headers.authorization = `Bearer ${opts.token}`;
  else headers[auth.slice("header:".length)] = opts.token;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    let res: Response;
    try {
      res = await fetch(base + path, init);
    } catch (e) {
      // `fetch failed` alone says nothing about which provider or endpoint; the cause (ECONNREFUSED, ENOTFOUND) does.
      const cause = (e as Error & { cause?: Error }).cause?.message ?? (e as Error).message;
      throw new Error(`${method} ${base}${path}: ${cause}`);
    }
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, method, path, text);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${method} ${path} → ${res.status}: response is not JSON: ${excerptOf(text)}`);
    }
  }

  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    patch: (path, body) => call("PATCH", path, body),
    delete: (path) => call("DELETE", path),
  };
}
