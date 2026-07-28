import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { openUploadFile } from "../src/files.js";
import { multipartFile } from "../src/multipart.js";

async function makeTempDirectory(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

test("opens regular files without following symlinks", async (t) => {
  const directory = await makeTempDirectory("gh-image-node-");
  const target = join(directory, "secret.txt");
  const link = join(directory, "shot.txt");
  await writeFile(target, "secret");
  await symlink(target, link);

  await assert.rejects(openUploadFile(link), /symbolic link|ELOOP/);
  const file = await openUploadFile(target);
  t.after(() => file.handle.close());
  assert.equal(file.size, 6);
});

test("rejects symlinked directories below the working directory", async (t) => {
  const directory = await mkdtemp(join(process.cwd(), ".gh-image-test-"));
  const outside = await makeTempDirectory("gh-image-outside-");
  t.after(async () => {
    await rm(directory, { recursive: true });
    await rm(outside, { recursive: true });
  });
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(directory, "linked"), "dir");

  await assert.rejects(
    openUploadFile(join(directory, "linked", "secret.txt")),
    /symbolic link/,
  );
});

test("rejects symlinked directories in absolute paths outside the workspace", async (t) => {
  const directory = await makeTempDirectory("gh-image-node-");
  const outside = await makeTempDirectory("gh-image-outside-");
  t.after(async () => {
    await rm(directory, { recursive: true });
    await rm(outside, { recursive: true });
  });
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(directory, "linked"), "dir");

  await assert.rejects(
    openUploadFile(join(directory, "linked", "secret.txt")),
    /symbolic link/,
  );
});

test("streams a multipart file with an exact content length", async (t) => {
  const directory = await makeTempDirectory("gh-image-node-");
  const path = join(directory, "shot.txt");
  await writeFile(path, "file-data");
  const file = await openUploadFile(path);
  t.after(() => file.handle.close());

  const payload = multipartFile([["key", "value"]], file, "text/plain");
  assert.ok(payload.body instanceof Readable);
  const chunks: Buffer[] = [];
  for await (const chunk of payload.body) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  assert.equal(body.length, payload.contentLength);
  assert.match(body.toString(), /name="key"\r\n\r\nvalue/);
  assert.match(body.toString(), /name="file"; filename="shot.txt"/);
  assert.match(body.toString(), /file-data\r\n--/);
});
