import { writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

function resolvePath(path: string, cwd: string): string {
  let p = path;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) p = homedir() + p.slice(1);
  return isAbsolute(p) ? p : resolve(cwd, p);
}

export async function writeTool(args: { path: string; content: string }, cwd: string): Promise<string> {
  const absolutePath = resolvePath(args.path, cwd);
  const dir = dirname(absolutePath);

  await mkdir(dir, { recursive: true });
  await fsWriteFile(absolutePath, args.content, "utf-8");

  return `Successfully wrote ${Buffer.byteLength(args.content, "utf-8")} bytes to ${args.path}`;
}
