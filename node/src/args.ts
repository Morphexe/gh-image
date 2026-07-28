export type Command = "upload" | "extract-token" | "check-token" | "help" | "version";

export interface ParsedArgs {
  command: Command;
  repo?: { owner: string; name: string };
  token?: string;
  paths: string[];
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

function parseRepo(value: string): { owner: string; name: string } {
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`--repo must be in owner/repo format, got: ${value}`);
  }
  return { owner: parts[0], name: parts[1] };
}

export function parseArgs(args: string[]): ParsedArgs {
  let repo: { owner: string; name: string } | undefined;
  let token: string | undefined;
  const paths: string[] = [];
  let flagsDone = false;
  let firstPositionalAfterDoubleDash = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (flagsDone) {
      if (paths.length === 0) firstPositionalAfterDoubleDash = true;
      paths.push(arg);
      continue;
    }
    if (arg === "--") {
      flagsDone = true;
    } else if (arg === "--repo" || arg.startsWith("--repo=")) {
      if (repo) throw new Error("--repo specified more than once");
      const value = arg === "--repo" ? requireValue(args, index, "--repo") : arg.slice(7);
      if (arg === "--repo") index++;
      repo = parseRepo(value);
    } else if (arg === "--token" || arg.startsWith("--token=")) {
      if (token !== undefined) throw new Error("--token specified more than once");
      const value = (arg === "--token" ? requireValue(args, index, "--token") : arg.slice(8)).trim();
      if (arg === "--token") index++;
      if (value === "") throw new Error("--token value cannot be empty");
      token = value;
    } else if (arg === "--help" || arg === "-h") {
      return { command: "help", paths: [] };
    } else if (arg === "--version") {
      return { command: "version", paths: [] };
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new Error(`unknown flag ${arg}`);
    } else {
      paths.push(arg);
    }
  }

  if (!firstPositionalAfterDoubleDash && paths[0] === "extract-token") {
    if (paths.length !== 1) throw new Error("extract-token does not take positional arguments");
    if (token !== undefined) throw new Error("--token cannot be combined with extract-token");
    if (repo) throw new Error("--repo cannot be combined with extract-token");
    return { command: "extract-token", paths: [] };
  }
  if (!firstPositionalAfterDoubleDash && paths[0] === "check-token") {
    if (paths.length !== 1) throw new Error("check-token does not take positional arguments");
    if (repo) throw new Error("--repo cannot be combined with check-token");
    return {
      command: "check-token",
      ...(token === undefined ? {} : { token }),
      paths: [],
    };
  }
  if (paths.length === 0) throw new Error("at least one file path is required");
  return {
    command: "upload",
    ...(repo === undefined ? {} : { repo }),
    ...(token === undefined ? {} : { token }),
    paths,
  };
}
