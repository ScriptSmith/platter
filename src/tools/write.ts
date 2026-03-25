import { writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { resolvePath } from "../utils.js";

export async function writeTool(args: { path: string; content: string }, cwd: string): Promise<string> {
  const absolutePath = resolvePath(args.path, cwd);
  const dir = dirname(absolutePath);

  await mkdir(dir, { recursive: true });
  await fsWriteFile(absolutePath, args.content, "utf-8");

  return `Successfully wrote ${Buffer.byteLength(args.content, "utf-8")} bytes to ${args.path}`;
}
