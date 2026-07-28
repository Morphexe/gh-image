#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { parseArgs } from "./args.js";
import { resolveRepo } from "./repo.js";
import { checkSession } from "./session.js";
import { UploadClient } from "./upload.js";

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as unknown;
if (
  typeof packageMetadata !== "object" ||
  packageMetadata === null ||
  !("version" in packageMetadata) ||
  typeof packageMetadata.version !== "string"
) {
  throw new Error("package.json does not contain a valid version");
}
const version = packageMetadata.version;
const usage = `Usage:
  gh-image [--repo owner/repo] [--token <value>] <file-path>...
  gh-image extract-token
  gh-image check-token [--token <value>]
  gh-image --version`;

function help(): string {
  return `${usage}

Upload images and files to GitHub and print markdown references.

Flags:
  --repo owner/repo   GitHub repository (optional; inferred from git origin)
  --token <value>     GitHub session token (default: extracted from Chrome)
                      Prefer GH_SESSION_TOKEN because flags appear in process lists.
  --version           Print version and exit

Subcommands:
  extract-token       Extract the Chrome session token and print it to stdout
  check-token         Verify a session token and print its GitHub username

Chrome extraction supports Google Chrome on Linux and macOS only.
Use -- before filenames beginning with a dash.`;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const messages = [error.message];
  let cause = error.cause;
  while (cause instanceof Error && !messages.includes(cause.message)) {
    messages.push(cause.message);
    cause = cause.cause;
  }
  return messages.join(": ");
}

async function resolveToken(tokenFlag?: string): Promise<{ value: string; source: string }> {
  if (tokenFlag !== undefined) return { value: tokenFlag, source: "--token flag" };
  const environment = process.env.GH_SESSION_TOKEN?.trim();
  if (environment) return { value: environment, source: "GH_SESSION_TOKEN" };
  const { selectChromeSession } = await import("./chrome/chrome.js");
  const value = await selectChromeSession(async (candidate) => {
    try {
      return (await checkSession(candidate)).valid;
    } catch {
      return false;
    }
  });
  return { value, source: "Chrome cookies" };
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    console.error(`Error: ${errorMessage(error)}`);
    console.error(usage);
    return 1;
  }

  if (parsed.command === "help") {
    console.log(help());
    return 0;
  }
  if (parsed.command === "version") {
    console.log(`gh-image ${version}`);
    return 0;
  }

  try {
    if (parsed.command === "extract-token") {
      const { selectChromeSession } = await import("./chrome/chrome.js");
      const token = await selectChromeSession();
      console.error("Extracted session token from Chrome cookies");
      console.log(token);
      return 0;
    }

    if (parsed.command === "check-token") {
      const session = await resolveToken(parsed.token);
      const result = await checkSession(session.value);
      if (!result.valid) throw new Error("token is invalid or expired");
      console.error(`Token is valid (source: ${session.source})`);
      if (result.username) console.log(result.username);
      return 0;
    }

    const repo = await resolveRepo(parsed.repo?.owner, parsed.repo?.name);
    const session = await resolveToken(parsed.token);
    const uploader = new UploadClient(session.value);
    let failed = false;
    for (const path of parsed.paths) {
      try {
        console.log((await uploader.upload(repo, path)).markdown);
      } catch (error) {
        console.error(`Error uploading ${JSON.stringify(path)}: ${errorMessage(error)}`);
        failed = true;
      }
    }
    return failed ? 1 : 0;
  } catch (error) {
    console.error(`Error: ${errorMessage(error)}`);
    return 1;
  }
}

process.exitCode = await main();
