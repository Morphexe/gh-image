import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface RepoInfo {
  owner: string;
  name: string;
  id: number;
}

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const repoPattern = /^[A-Za-z0-9._-]+$/;

export function validateRepo(owner: string, name: string): void {
  if (!ownerPattern.test(owner) || !repoPattern.test(name)) {
    throw new Error(`invalid GitHub repository ${owner}/${name}`);
  }
}

export function parseRemote(remote: string): { owner: string; name: string } {
  const value = remote.trim();
  const match =
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(value) ??
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new Error(`could not parse GitHub owner/repo from remote URL: ${JSON.stringify(value)}`);
  }
  validateRepo(match[1], match[2]);
  return { owner: match[1], name: match[2] };
}

async function command(name: string, args: string[]): Promise<string> {
  try {
    const result = await execFile(name, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`${name} command failed`, { cause: error });
  }
}

export async function resolveRepo(owner?: string, name?: string): Promise<RepoInfo> {
  let resolvedOwner = owner;
  let resolvedName = name;
  if (!resolvedOwner || !resolvedName) {
    const parsed = parseRemote(await command("git", ["remote", "get-url", "origin"]));
    resolvedOwner = parsed.owner;
    resolvedName = parsed.name;
  }
  validateRepo(resolvedOwner, resolvedName);
  const rawId = await command("gh", [
    "api",
    `repos/${resolvedOwner}/${resolvedName}`,
    "--jq",
    ".id",
  ]);
  const id = Number.parseInt(rawId, 10);
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== rawId) {
    throw new Error(`unexpected repository ID: ${rawId}`);
  }
  return { owner: resolvedOwner, name: resolvedName, id };
}
