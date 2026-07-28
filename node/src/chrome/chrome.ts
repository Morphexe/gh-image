import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { decryptChromeCookie, type ChromeDecryptionSecrets } from "./decrypt.js";
import { getChromePortalSecret, getChromeSafeStorage } from "./keyring.js";

export interface SessionCandidate {
  value: string;
  store: string;
  loggedIn: boolean;
}

interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
}

export interface ChromeDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  safeStorage?: () => Promise<Buffer>;
  portalSecret?: () => Promise<Buffer>;
}

function chromeRoots(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  if (platform === "darwin") {
    const base = join(home, "Library", "Application Support", "Google");
    return [join(base, "Chrome"), join(base, "Chrome Beta"), join(base, "Chrome Canary")];
  }
  if (platform === "linux") {
    const configBase = env.CHROME_CONFIG_HOME ?? env.XDG_CONFIG_HOME ?? join(home, ".config");
    return [
      join(configBase, "google-chrome"),
      join(configBase, "google-chrome-beta"),
      join(configBase, "google-chrome-unstable"),
      join(home, ".var", "app", "com.google.Chrome", "config", "google-chrome"),
    ];
  }
  throw new Error(`Chrome cookie extraction supports Linux and macOS only, not ${platform}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function profileDirectories(root: string): Promise<string[]> {
  const profiles = new Set<string>(["Default"]);
  try {
    const state = JSON.parse(await readFile(join(root, "Local State"), "utf8")) as {
      profile?: { info_cache?: Record<string, unknown> };
    };
    for (const name of Object.keys(state.profile?.info_cache ?? {})) {
      profiles.add(name);
    }
  } catch {
    // Fall back to directory discovery when Local State is absent or malformed.
  }
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === "Default" || /^Profile \d+$/.test(entry.name))) {
        profiles.add(entry.name);
      }
    }
  } catch {
    return [];
  }
  return [...profiles].sort();
}

async function cookieStores(options: Required<Pick<ChromeDiscoveryOptions, "platform" | "env" | "home">>): Promise<string[]> {
  const stores: string[] = [];
  for (const root of chromeRoots(options.platform, options.env, options.home)) {
    for (const profile of await profileDirectories(root)) {
      const modern = join(root, profile, "Network", "Cookies");
      const legacy = join(root, profile, "Cookies");
      if (await exists(modern)) stores.push(modern);
      else if (await exists(legacy)) stores.push(legacy);
    }
  }
  return stores.sort();
}

function readRows(path: string): { databaseVersion: number; rows: CookieRow[] } {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const meta = database.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
      | { value: string }
      | undefined;
    const databaseVersion = Number.parseInt(meta?.value ?? "0", 10);
    if (!Number.isSafeInteger(databaseVersion) || databaseVersion <= 0) {
      throw new Error("Chrome cookie database has no valid schema version");
    }
    const rows = database
      .prepare(
        `SELECT host_key, name, value, encrypted_value
           FROM cookies
          WHERE host_key IN ('github.com', '.github.com')
            AND name IN ('user_session', 'logged_in')
            AND (expires_utc = 0 OR
                 expires_utc > CAST(strftime('%s', 'now') AS INTEGER) * 1000000
                               + 11644473600000000)`,
      )
      .all() as unknown as CookieRow[];
    return { databaseVersion, rows };
  } finally {
    database.close();
  }
}

async function loadSecrets(
  rows: CookieRow[],
  platform: NodeJS.Platform,
  safeStorage: () => Promise<Buffer>,
  portalSecret: () => Promise<Buffer>,
): Promise<{ secrets: ChromeDecryptionSecrets; errors: string[] }> {
  const prefixes = new Set(
    rows
      .filter((row) => row.value === "" && row.encrypted_value.length >= 3)
      .map((row) => Buffer.from(row.encrypted_value).subarray(0, 3).toString("ascii")),
  );
  const secrets: ChromeDecryptionSecrets = {};
  const errors: string[] = [];
  if (platform === "darwin" || prefixes.has("v11")) {
    try {
      secrets.safeStorage = await safeStorage();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (platform === "linux" && prefixes.has("v12")) {
    try {
      secrets.portal = await portalSecret();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { secrets, errors };
}

export async function readChromeCandidates(
  options: ChromeDiscoveryOptions = {},
): Promise<SessionCandidate[]> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const stores = await cookieStores({ platform, env, home });
  if (stores.length === 0) {
    throw new Error("no Google Chrome cookie database found");
  }

  let safeStoragePromise: Promise<Buffer> | undefined;
  let portalSecretPromise: Promise<Buffer> | undefined;
  const safeStorage =
    options.safeStorage ??
    (() => (safeStoragePromise ??= getChromeSafeStorage(platform)));
  const portalSecret =
    options.portalSecret ??
    (() => (portalSecretPromise ??= getChromePortalSecret(platform)));
  const candidates: SessionCandidate[] = [];
  const errors: string[] = [];
  for (const store of stores) {
    try {
      const { databaseVersion, rows } = readRows(store);
      const loaded = await loadSecrets(
        rows,
        platform,
        safeStorage,
        portalSecret,
      );
      errors.push(...loaded.errors.map((message) => `${store}: ${message}`));
      const values = new Map<string, string>();
      for (const row of rows) {
        try {
          const value =
            row.value !== ""
              ? row.value
              : decryptChromeCookie(
                  row.encrypted_value,
                  row.host_key,
                  databaseVersion,
                  platform,
                  loaded.secrets,
                );
          values.set(row.name, value);
        } catch (error) {
          errors.push(`${store}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const session = values.get("user_session");
      if (session) {
        candidates.push({
          value: session,
          store,
          loggedIn: values.get("logged_in") === "yes",
        });
      }
    } catch (error) {
      errors.push(`${store}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (candidates.length === 0) {
    const detail = errors.length > 0 ? `: ${errors.join("; ")}` : "";
    throw new Error(`no usable github.com user_session cookie found in Chrome${detail}`);
  }
  return candidates;
}

export async function selectChromeSession(
  validate?: (value: string) => Promise<boolean>,
  options: ChromeDiscoveryOptions = {},
): Promise<string> {
  const candidates = await readChromeCandidates(options);
  const loggedIn = candidates.filter((candidate) => candidate.loggedIn);
  const pool = (loggedIn.length > 0 ? loggedIn : candidates).toSorted((a, b) =>
    a.store.localeCompare(b.store),
  );
  if (pool.length === 1 || !validate) return pool[0]!.value;
  for (const candidate of pool) {
    if (await validate(candidate.value)) return candidate.value;
  }
  return pool[0]!.value;
}
