import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { readChromeCandidates, selectChromeSession } from "../src/chrome/chrome.js";

function encryptLinuxV10(value: string, host: string): Buffer {
  const key = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const plaintext = Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]);
  return Buffer.concat([Buffer.from("v10"), cipher.update(plaintext), cipher.final()]);
}

test("discovers profiles and extracts only GitHub session cookies", async () => {
  const home = await mkdtemp(join(tmpdir(), "gh-image-chrome-"));
  const root = join(home, ".config", "google-chrome");
  const profile = join(root, "Default", "Network");
  await mkdir(profile, { recursive: true });
  await writeFile(
    join(root, "Local State"),
    JSON.stringify({ profile: { info_cache: { Default: { name: "Person 1" } } } }),
  );

  const database = new DatabaseSync(join(profile, "Cookies"));
  database.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta(key, value) VALUES ('version', '24');
    CREATE TABLE cookies(
      host_key TEXT,
      name TEXT,
      value TEXT,
      encrypted_value BLOB,
      expires_utc INTEGER
    );
  `);
  const insert = database.prepare(
    "INSERT INTO cookies(host_key, name, value, encrypted_value, expires_utc) VALUES (?, ?, '', ?, 0)",
  );
  insert.run(".github.com", "user_session", encryptLinuxV10("session", ".github.com"));
  insert.run(".github.com", "logged_in", encryptLinuxV10("yes", ".github.com"));
  insert.run("evilgithub.com", "user_session", encryptLinuxV10("evil", "evilgithub.com"));
  database.close();

  const options = {
    platform: "linux" as const,
    env: {},
    home,
    safeStorage: async () => {
      throw new Error("v10 extraction should not query the keyring");
    },
  };
  assert.deepEqual(await readChromeCandidates(options), [
    {
      value: "session",
      store: join(profile, "Cookies"),
      loggedIn: true,
    },
  ]);
  assert.equal(await selectChromeSession(undefined, options), "session");
});
