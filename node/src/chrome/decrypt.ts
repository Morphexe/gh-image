import {
  createDecipheriv,
  createHash,
  hkdfSync,
  pbkdf2Sync,
  timingSafeEqual,
} from "node:crypto";

export interface ChromeDecryptionSecrets {
  safeStorage?: Buffer;
  portal?: Buffer;
}

const saltySalt = Buffer.from("saltysalt");
const cbcIv = Buffer.alloc(16, 0x20);
const linuxFallback = Buffer.from("peanuts");

function removeHostDigest(plaintext: Buffer, host: string, databaseVersion: number): Buffer {
  if (databaseVersion < 24) {
    return plaintext;
  }
  if (plaintext.length < 32) {
    throw new Error("decrypted cookie is missing its host digest");
  }
  const actual = plaintext.subarray(0, 32);
  const expected = createHash("sha256").update(host).digest();
  if (!timingSafeEqual(actual, expected)) {
    throw new Error("decrypted cookie host digest does not match");
  }
  return plaintext.subarray(32);
}

function decryptCbc(
  encrypted: Buffer,
  password: Buffer,
  iterations: number,
  host: string,
  databaseVersion: number,
): Buffer {
  const ciphertext = encrypted.subarray(3);
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error("invalid AES-CBC cookie payload");
  }
  const key = pbkdf2Sync(password, saltySalt, iterations, 16, "sha1");
  const decipher = createDecipheriv("aes-128-cbc", key, cbcIv);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return removeHostDigest(plaintext, host, databaseVersion);
}

function decryptV12(
  encrypted: Buffer,
  portalSecret: Buffer,
  host: string,
  databaseVersion: number,
): Buffer {
  if (encrypted.length < 3 + 12 + 16) {
    throw new Error("invalid v12 AES-GCM cookie payload");
  }
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      portalSecret,
      Buffer.from("fdo_portal_secret_salt"),
      Buffer.from("HKDF-SHA-256 AES-256-GCM"),
      32,
    ),
  );
  const nonce = encrypted.subarray(3, 15);
  const ciphertext = encrypted.subarray(15, -16);
  const tag = encrypted.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return removeHostDigest(plaintext, host, databaseVersion);
}

export function decryptChromeCookie(
  encryptedValue: Uint8Array,
  host: string,
  databaseVersion: number,
  platform: NodeJS.Platform,
  secrets: ChromeDecryptionSecrets,
): string {
  const encrypted = Buffer.from(encryptedValue);
  if (encrypted.length < 4) {
    throw new Error("encrypted cookie value is too short");
  }
  const version = encrypted.subarray(0, 3).toString("ascii");

  if (platform === "darwin") {
    if (!secrets.safeStorage) {
      throw new Error("Chrome Safe Storage password is unavailable");
    }
    return decryptCbc(encrypted, secrets.safeStorage, 1003, host, databaseVersion).toString();
  }

  if (platform !== "linux") {
    throw new Error(`unsupported platform: ${platform}`);
  }
  if (version === "v12") {
    if (!secrets.portal) {
      throw new Error("Chrome Secret Portal key is unavailable");
    }
    return decryptV12(encrypted, secrets.portal, host, databaseVersion).toString();
  }
  if (version === "v11") {
    const passwords = secrets.safeStorage
      ? [secrets.safeStorage, linuxFallback]
      : [linuxFallback];
    let lastError: unknown;
    for (const password of passwords) {
      try {
        return decryptCbc(encrypted, password, 1, host, databaseVersion).toString();
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error("unable to decrypt Linux v11 Chrome cookie", { cause: lastError });
  }
  if (version === "v10") {
    return decryptCbc(encrypted, linuxFallback, 1, host, databaseVersion).toString();
  }
  throw new Error(`unsupported Chrome cookie encryption version ${JSON.stringify(version)}`);
}
