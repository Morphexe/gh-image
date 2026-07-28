import { extname } from "node:path";
import { lookup } from "mime-types";

const githubTypes = new Map<string, string>([
  [".apng", "image/apng"],
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".webp", "image/webp"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".wav", "audio/wav"],
  [".pdf", "application/pdf"],
  [".zip", "application/zip"],
  [".gz", "application/gzip"],
  [".tgz", "application/gzip"],
  [".json", "application/json"],
  [".jsonc", "application/json"],
  [".sql", "application/sql"],
  [".ipynb", "application/x-ipynb+json"],
  [".yaml", "application/x-yaml"],
  [".yml", "application/x-yaml"],
  [".txt", "text/plain"],
  [".log", "text/x-log"],
  [".md", "text/markdown"],
  [".js", "text/javascript"],
  [".ts", "text/typescript"],
  [".tsx", "text/tsx"],
  [".css", "text/css"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".csv", "text/csv"],
  [".cpp", "text/x-c++"],
  [".cs", "text/x-csharp"],
  [".php", "text/x-php"],
  [".py", "text/x-python"],
  [".patch", "text/x-patch"],
  [".cpuprofile", "application/json"],
  [".pdb", "application/octet-stream"],
]);

export function detectContentType(path: string): string {
  const override = githubTypes.get(extname(path).toLowerCase());
  if (override) return override;
  return lookup(path) || "application/octet-stream";
}
