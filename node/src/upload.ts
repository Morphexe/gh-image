import { detectContentType } from "./content-type.js";
import { openUploadFile, type UploadFile } from "./files.js";
import {
  GitHubHttp,
  responseJsonLimited,
  responseTextLimited,
  type GitHubHttpOptions,
} from "./http.js";
import { renderMarkdown, validateAttachmentUrl } from "./markdown.js";
import { multipartFields, multipartFile, type MultipartPayload } from "./multipart.js";
import type { RepoInfo } from "./repo.js";
import { userAgent } from "./session.js";

interface Policy {
  uploadUrl: string;
  form: Record<string, string>;
  assetId: number;
  assetUploadUrl: string;
  authenticityToken: string;
  contentType: string;
}

export interface UploadResult {
  url: string;
  name: string;
  markdown: string;
}

export interface UploadClientOptions extends GitHubHttpOptions {
  s3Fetch?: typeof fetch;
}

function streamRequestInit(
  method: string,
  payload: MultipartPayload,
  headers: HeadersInit,
  timeoutMs: number,
): RequestInit {
  return {
    method,
    body: payload.body as unknown as BodyInit,
    headers: {
      ...Object.fromEntries(new Headers(headers)),
      "Content-Type": payload.contentType,
      "Content-Length": String(payload.contentLength),
    },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    // Required by Node fetch for a streaming request body.
    duplex: "half",
  } as RequestInit;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTrustedUploadHost(hostname: string): boolean {
  return /^github-production-user-asset-[a-z0-9-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(
    hostname,
  );
}

function parsePolicy(value: unknown): Policy {
  if (!isObject(value) || !isObject(value.asset) || !isObject(value.form)) {
    throw new Error("policy response has an invalid shape");
  }
  const uploadUrl = value.upload_url;
  const assetUploadUrl = value.asset_upload_url;
  const authenticityToken = value.asset_upload_authenticity_token;
  const assetId = value.asset.id;
  const contentType = value.asset.content_type;
  if (
    typeof uploadUrl !== "string" ||
    typeof assetUploadUrl !== "string" ||
    typeof authenticityToken !== "string" ||
    typeof assetId !== "number" ||
    typeof contentType !== "string" ||
    uploadUrl === "" ||
    authenticityToken === "" ||
    !Number.isSafeInteger(assetId) ||
    assetId <= 0 ||
    contentType === ""
  ) {
    throw new Error("policy response is missing required fields");
  }
  const destination = new URL(uploadUrl);
  if (
    destination.protocol !== "https:" ||
    destination.username ||
    destination.password ||
    !isTrustedUploadHost(destination.hostname)
  ) {
    throw new Error("policy response contains an untrusted upload URL");
  }
  if (!/^\/upload\/(?:assets|repository-files)\/\d+$/.test(assetUploadUrl)) {
    throw new Error("policy response contains an invalid finalize path");
  }
  const form: Record<string, string> = {};
  for (const [key, item] of Object.entries(value.form)) {
    if (typeof item !== "string") throw new Error("policy form contains a non-string value");
    form[key] = item;
  }
  if (Object.keys(form).length === 0) throw new Error("policy response contains no form fields");
  return {
    uploadUrl: destination.toString(),
    form,
    assetId,
    assetUploadUrl,
    authenticityToken,
    contentType,
  };
}

export class UploadClient {
  readonly #http: GitHubHttp;
  readonly #s3Fetch: typeof fetch;

  constructor(token: string, options: UploadClientOptions = {}) {
    this.#http = new GitHubHttp(token, options);
    this.#s3Fetch = options.s3Fetch ?? options.fetch ?? fetch;
  }

  async upload(repo: RepoInfo, path: string): Promise<UploadResult> {
    const file = await openUploadFile(path);
    try {
      const contentType = detectContentType(file.name);
      const uploadToken = await this.#getUploadToken(repo);
      const policy = await this.#requestPolicy(repo, file, contentType, uploadToken);
      await this.#uploadToS3(policy, file, contentType);
      return await this.#finalize(repo, policy);
    } finally {
      await file.handle.close();
    }
  }

  async #getUploadToken(repo: RepoInfo): Promise<string> {
    const path = `/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
    const response = await this.#http.request(
      path,
      { headers: { "User-Agent": userAgent } },
      { followSameOriginGetRedirects: true },
    );
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`repo page returned ${response.status}`);
    }
    const body = await responseTextLimited(response, 2 * 1024 * 1024);
    const token = /"uploadToken":"([^"]+)"/.exec(body)?.[1];
    if (!token) {
      const owner = repo.owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const ssoLink = new RegExp(`/orgs/${owner}/sso`, "i").test(body);
      const ssoTitle = new RegExp(`<title>\\s*Sign in to ${owner}\\b`, "i").test(body);
      if (ssoLink || ssoTitle) {
        throw new Error(
          `${repo.owner} enforces SAML SSO and your session is not authorized for it — ` +
            `authorize in a browser at https://github.com/orgs/${encodeURIComponent(repo.owner)}/sso ` +
            "(lasts ~24h), then retry. Write access alone is not enough",
        );
      }
      throw new Error(
        `uploadToken not found on repo page — do you have write access to ${repo.owner}/${repo.name}? ` +
          `(or, if ${repo.owner} enforces SAML SSO, authorize at ` +
          `https://github.com/orgs/${encodeURIComponent(repo.owner)}/sso)`,
      );
    }
    return token;
  }

  #githubUploadHeaders(repo: RepoInfo): HeadersInit {
    return {
      Accept: "application/json",
      Origin: this.#http.origin,
      Referer: `${this.#http.origin}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
      "User-Agent": userAgent,
      "X-Requested-With": "XMLHttpRequest",
    };
  }

  async #requestPolicy(
    repo: RepoInfo,
    file: UploadFile,
    contentType: string,
    uploadToken: string,
  ): Promise<Policy> {
    const payload = multipartFields([
      ["name", file.name],
      ["size", String(file.size)],
      ["content_type", contentType],
      ["authenticity_token", uploadToken],
      ["repository_id", String(repo.id)],
    ]);
    const response = await this.#http.request(
      "/upload/policies/assets",
      streamRequestInit("POST", payload, this.#githubUploadHeaders(repo), 30_000),
    );
    if (response.status !== 201) {
      const body = await responseTextLimited(response, 4096);
      throw new Error(`policy request returned ${response.status}: ${JSON.stringify(body)}`);
    }
    return parsePolicy(await responseJsonLimited(response, 256 * 1024));
  }

  async #uploadToS3(policy: Policy, file: UploadFile, contentType: string): Promise<void> {
    const preferredOrder = [
      "key",
      "acl",
      "policy",
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Signature",
      "Content-Type",
      "Cache-Control",
      "x-amz-meta-Surrogate-Control",
    ];
    const entries = Object.entries(policy.form);
    const order = new Map(preferredOrder.map((name, index) => [name, index]));
    entries.sort(
      ([left], [right]) =>
        (order.get(left) ?? preferredOrder.length) - (order.get(right) ?? preferredOrder.length) ||
        left.localeCompare(right),
    );
    const payload = multipartFile(entries, file, contentType);
    const response = await this.#s3Fetch(
      policy.uploadUrl,
      streamRequestInit(
        "POST",
        payload,
        { Origin: "https://github.com", "User-Agent": userAgent },
        120_000,
      ),
    );
    if (![200, 201, 204].includes(response.status)) {
      const body = await responseTextLimited(response, 4096);
      throw new Error(`S3 returned ${response.status}: ${JSON.stringify(body)}`);
    }
    await response.body?.cancel();
  }

  async #finalize(repo: RepoInfo, policy: Policy): Promise<UploadResult> {
    const payload = multipartFields([["authenticity_token", policy.authenticityToken]]);
    const response = await this.#http.request(
      policy.assetUploadUrl,
      streamRequestInit("PUT", payload, this.#githubUploadHeaders(repo), 30_000),
    );
    if (response.status !== 200) {
      const body = await responseTextLimited(response, 4096);
      throw new Error(`finalize request returned ${response.status}: ${JSON.stringify(body)}`);
    }
    const value = await responseJsonLimited(response, 256 * 1024);
    if (!isObject(value) || typeof value.href !== "string" || typeof value.name !== "string") {
      throw new Error("finalize response has an invalid shape");
    }
    const url = validateAttachmentUrl(value.href);
    const markdown = renderMarkdown(value.name, url, policy.contentType);
    return { url, name: value.name, markdown };
  }
}
