import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export function resolvePath(path: string, cwd: string): string {
  let p = path;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) p = homedir() + p.slice(1);
  return isAbsolute(p) ? p : resolve(cwd, p);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
