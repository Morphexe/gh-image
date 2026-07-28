const cookieName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function validateCookieValue(value: string): void {
  if (value === "" || /[\u0000-\u0020\u007f;,]/.test(value)) {
    throw new Error("session token contains characters that are unsafe in a Cookie header");
  }
}

export async function responseTextLimited(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new Error(`response body exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function responseJsonLimited(response: Response, limit: number): Promise<unknown> {
  const text = await responseTextLimited(response, limit);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("response is not valid JSON", { cause: error });
  }
}

class OriginCookieJar {
  readonly #cookies = new Map<string, string>();

  constructor(sessionToken: string) {
    validateCookieValue(sessionToken);
    this.#cookies.set("user_session", sessionToken);
    this.#cookies.set("__Host-user_session_same_site", sessionToken);
  }

  header(): string {
    return [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  capture(headers: Headers): void {
    const values = headers.getSetCookie();
    for (const header of values) {
      const segments = header.split(";");
      const pair = segments[0];
      if (!pair) continue;
      const equals = pair.indexOf("=");
      if (equals <= 0) continue;
      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1).trim();
      if (!cookieName.test(name)) continue;
      const attributes = segments.slice(1).map((segment) => segment.trim().toLowerCase());
      if (attributes.some((attribute) => attribute === "max-age=0")) {
        this.#cookies.delete(name);
        continue;
      }
      if (/[\u0000-\u0020\u007f;]/.test(value)) continue;
      this.#cookies.set(name, value);
    }
  }
}

export interface GitHubHttpOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  allowInsecureBaseUrl?: boolean;
}

export class GitHubHttp {
  readonly #base: URL;
  readonly #fetch: typeof fetch;
  readonly #jar: OriginCookieJar;

  constructor(sessionToken: string, options: GitHubHttpOptions = {}) {
    this.#base = new URL(options.baseUrl ?? "https://github.com");
    if (
      !options.allowInsecureBaseUrl &&
      (this.#base.protocol !== "https:" || this.#base.hostname !== "github.com")
    ) {
      throw new Error("authenticated GitHub base URL must be https://github.com");
    }
    this.#fetch = options.fetch ?? fetch;
    this.#jar = new OriginCookieJar(sessionToken);
  }

  get origin(): string {
    return this.#base.origin;
  }

  async request(
    path: string,
    init: RequestInit = {},
    options: { followSameOriginGetRedirects?: boolean; timeoutMs?: number } = {},
  ): Promise<Response> {
    let target = new URL(path, this.#base);
    if (target.origin !== this.#base.origin) {
      throw new Error("refusing to send GitHub session cookie across origins");
    }
    const method = init.method?.toUpperCase() ?? "GET";
    const follow = options.followSameOriginGetRedirects === true && method === "GET";
    for (let redirect = 0; redirect <= 5; redirect++) {
      const headers = new Headers(init.headers);
      headers.set("Cookie", this.#jar.header());
      const response = await this.#fetch(target, {
        ...init,
        headers,
        redirect: "manual",
        signal: init.signal ?? AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
      this.#jar.capture(response.headers);
      if (!follow || ![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      const next = new URL(location, target);
      if (next.origin !== this.#base.origin) {
        await response.body?.cancel();
        throw new Error("refusing to follow authenticated redirect across origins");
      }
      await response.body?.cancel();
      target = next;
    }
    throw new Error("too many GitHub redirects");
  }
}
