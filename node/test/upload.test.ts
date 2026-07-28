import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { UploadClient } from "../src/upload.js";

async function makeTempDirectory(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "gh-image-node-")));
}

async function consumeBody(body: BodyInit | null | undefined): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test("runs the complete upload flow without sending cookies to S3", async () => {
  const directory = await makeTempDirectory();
  const path = join(directory, "shot.png");
  await writeFile(path, "png-data");
  const calls: Array<{ url: string; cookie: string | null; body: Buffer }> = [];

  const mockFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = await consumeBody(init?.body);
    calls.push({ url, cookie: headers.get("cookie"), body });
    if (url === "https://github.com/octo/hello") {
      return new Response(`x={"uploadToken":"TOKEN"}`, {
        status: 200,
        headers: { "Set-Cookie": "_gh_sess=rotated; Secure; HttpOnly; Path=/" },
      });
    }
    if (url === "https://github.com/upload/policies/assets") {
      return Response.json(
        {
          upload_url: "https://github-production-user-asset-1.s3.amazonaws.com/upload",
          asset: { id: 99, name: "shot.png", content_type: "image/png" },
          form: { key: "k", policy: "p" },
          asset_upload_url: "/upload/assets/99",
          asset_upload_authenticity_token: "AUTH",
        },
        { status: 201 },
      );
    }
    if (url === "https://github-production-user-asset-1.s3.amazonaws.com/upload") {
      return new Response(null, { status: 204 });
    }
    if (url === "https://github.com/upload/assets/99") {
      return Response.json({
        href: "https://github.com/user-attachments/assets/uuid",
        name: "shot.png",
      });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;

  const client = new UploadClient("session-token", { fetch: mockFetch });
  const result = await client.upload({ owner: "octo", name: "hello", id: 42 }, path);
  assert.equal(
    result.markdown,
    "![shot.png](https://github.com/user-attachments/assets/uuid)",
  );
  assert.equal(calls.length, 4);
  assert.match(calls[1]!.cookie ?? "", /_gh_sess=rotated/);
  assert.equal(calls[2]!.cookie, null);
  assert.match(calls[2]!.body.toString(), /png-data\r\n--/);
});

test("rejects a non-HTTPS policy upload destination", async () => {
  const directory = await makeTempDirectory();
  const path = join(directory, "shot.png");
  await writeFile(path, "png-data");
  const mockFetch = (async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.endsWith("/octo/hello")) return new Response(`{"uploadToken":"TOKEN"}`);
    return Response.json(
      {
        upload_url: "http://s3.example/upload",
        asset: { id: 1, content_type: "image/png" },
        form: { key: "k" },
        asset_upload_url: "/upload/assets/1",
        asset_upload_authenticity_token: "AUTH",
      },
      { status: 201 },
    );
  }) as typeof fetch;
  const client = new UploadClient("session-token", { fetch: mockFetch });
  await assert.rejects(
    client.upload({ owner: "octo", name: "hello", id: 1 }, path),
    /untrusted upload URL/,
  );
});

test("rejects an HTTPS policy upload destination outside GitHub's S3 buckets", async () => {
  const directory = await makeTempDirectory();
  const path = join(directory, "shot.png");
  await writeFile(path, "png-data");
  const mockFetch = (async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.endsWith("/octo/hello")) return new Response(`{"uploadToken":"TOKEN"}`);
    return Response.json(
      {
        upload_url: "https://evil.example/upload",
        asset: { id: 1, content_type: "image/png" },
        form: { key: "k" },
        asset_upload_url: "/upload/assets/1",
        asset_upload_authenticity_token: "AUTH",
      },
      { status: 201 },
    );
  }) as typeof fetch;
  const client = new UploadClient("session-token", { fetch: mockFetch });
  await assert.rejects(
    client.upload({ owner: "octo", name: "hello", id: 1 }, path),
    /untrusted upload URL/,
  );
});

test("reports an actionable SAML SSO error", async () => {
  const directory = await makeTempDirectory();
  const path = join(directory, "shot.png");
  await writeFile(path, "png-data");
  const mockFetch = (async () =>
    new Response(
      `<title>Sign in to Acme</title><a href="/orgs/Acme/sso">Authorize</a>`,
    )) as typeof fetch;
  const client = new UploadClient("session-token", { fetch: mockFetch });
  await assert.rejects(
    client.upload({ owner: "Acme", name: "hello", id: 1 }, path),
    /SAML SSO.*orgs\/Acme\/sso.*Write access alone is not enough/,
  );
});
