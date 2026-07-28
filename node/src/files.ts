import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { basename, join, parse, relative, resolve, sep } from "node:path";

export interface UploadFile {
  handle: FileHandle;
  path: string;
  name: string;
  size: number;
}

async function rejectSymlinkComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  const components = relative(root, absolute).split(sep);
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`upload path traverses a symbolic link: ${current}`);
    }
  }
}

export async function openUploadFile(path: string): Promise<UploadFile> {
  if (path === "") throw new Error("file path cannot be empty");
  await rejectSymlinkComponents(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("upload path must be a regular file");
    }
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw new Error("file size is outside Node.js safe integer range");
    }
    return { handle, path, name: basename(path), size: stat.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
