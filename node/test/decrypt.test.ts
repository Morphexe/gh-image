import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
  hkdfSync,
  pbkdf2Sync,
} from "node:crypto";
import test from "node:test";

import { decryptChromeCookie } from "../src/chrome/decrypt.js";

function hostBound(value: string, host: string, version: number): Buffer {
  const payload = Buffer.from(value);
  return version >= 24
    ? Buffer.concat([createHash("sha256").update(host).digest(), payload])
    : payload;
}

function encryptCbc(
  value: string,
  host: string,
  version: number,
  password: Buffer,
  iterations: number,
  prefix = "v10",
): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([
    Buffer.from(prefix),
    cipher.update(hostBound(value, host, version)),
    cipher.final(),
  ]);
}

function encryptV12(value: string, host: string, version: number, secret: Buffer): Buffer {
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      "fdo_portal_secret_salt",
      "HKDF-SHA-256 AES-256-GCM",
      32,
    ),
  );
  const nonce = Buffer.from("0123456789ab");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(hostBound(value, host, version)), cipher.final()]);
  return Buffer.concat([Buffer.from("v12"), nonce, encrypted, cipher.getAuthTag()]);
}

test("decrypts Linux v10 and v11 Chrome cookies", () => {
  const host = ".github.com";
  const v10 = encryptCbc("session-10", host, 23, Buffer.from("peanuts"), 1);
  assert.equal(decryptChromeCookie(v10, host, 23, "linux", {}), "session-10");

  const safeStorage = Buffer.from("safe-storage");
  const v11 = encryptCbc("session-11", host, 24, safeStorage, 1, "v11");
  assert.equal(
    decryptChromeCookie(v11, host, 24, "linux", { safeStorage }),
    "session-11",
  );
});

test("decrypts Linux v12 Secret Portal cookies", () => {
  const portal = Buffer.from("portal secret bytes");
  const encrypted = encryptV12("session-12", "github.com", 24, portal);
  assert.equal(
    decryptChromeCookie(encrypted, "github.com", 24, "linux", { portal }),
    "session-12",
  );
});

test("decrypts macOS Chrome cookies and verifies host binding", () => {
  const safeStorage = Buffer.from("mac-safe-storage");
  const encrypted = encryptCbc("mac-session", ".github.com", 24, safeStorage, 1003);
  assert.equal(
    decryptChromeCookie(encrypted, ".github.com", 24, "darwin", { safeStorage }),
    "mac-session",
  );
  assert.throws(
    () => decryptChromeCookie(encrypted, "evil.example", 24, "darwin", { safeStorage }),
    /host digest/,
  );
});
