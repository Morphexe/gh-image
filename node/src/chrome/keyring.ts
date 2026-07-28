import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function stripCommandNewline(value: Buffer): Buffer {
  let end = value.length;
  if (end > 0 && value[end - 1] === 0x0a) end--;
  if (end > 0 && value[end - 1] === 0x0d) end--;
  return value.subarray(0, end);
}

async function runSecretCommand(command: string, args: string[]): Promise<Buffer> {
  const result = await execFile(command, args, {
    encoding: "buffer",
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
    windowsHide: true,
  });
  const value = stripCommandNewline(result.stdout);
  if (value.length === 0) {
    throw new Error(`${command} returned an empty secret`);
  }
  return value;
}

export async function getChromeSafeStorage(platform: NodeJS.Platform): Promise<Buffer> {
  if (platform === "darwin") {
    return runSecretCommand("/usr/bin/security", [
      "find-generic-password",
      "-s",
      "Chrome Safe Storage",
      "-wa",
      "Chrome",
    ]);
  }
  if (platform === "linux") {
    return runSecretCommand("secret-tool", ["lookup", "application", "chrome"]);
  }
  throw new Error(`Chrome cookie extraction is unsupported on ${platform}`);
}

export async function getChromePortalSecret(platform: NodeJS.Platform): Promise<Buffer> {
  if (platform !== "linux") {
    throw new Error("Chrome Secret Portal keys are Linux-only");
  }
  const lookups = [
    ["lookup", "xdg:schema", "org.freedesktop.portal.portal", "app-id", "com.google.Chrome"],
    ["lookup", "app-id", "com.google.Chrome"],
  ];
  const errors: string[] = [];
  for (const args of lookups) {
    try {
      return await runSecretCommand("secret-tool", args);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`Chrome Secret Portal key not found: ${errors.join("; ")}`);
}
