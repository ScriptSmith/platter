import { stat } from "node:fs/promises";
import { Glob } from "bun";
import { resolvePath } from "../utils.js";

const MAX_RESULTS = 500;

export async function globTool(args: { pattern: string; path?: string }, cwd: string): Promise<string> {
  const searchDir = args.path ? resolvePath(args.path, cwd) : cwd;

  // Verify directory exists
  try {
    const s = await stat(searchDir);
    if (!s.isDirectory()) {
      throw new Error(`Not a directory: ${searchDir}`);
    }
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error(`Directory not found: ${searchDir}`);
    }
    throw err;
  }

  const glob = new Glob(args.pattern);
  const matches: string[] = [];

  for await (const match of glob.scan({ cwd: searchDir, dot: true })) {
    matches.push(match);
    if (matches.length >= MAX_RESULTS + 1) break;
  }

  matches.sort();

  const truncated = matches.length > MAX_RESULTS;
  if (truncated) {
    matches.length = MAX_RESULTS;
  }

  if (matches.length === 0) {
    return `No files matched pattern: ${args.pattern}`;
  }

  // Return paths relative to searchDir
  let result = matches.join("\n");

  if (truncated) {
    result += `\n\n[Results truncated at ${MAX_RESULTS} matches. Narrow your pattern for complete results.]`;
  }

  return result;
}
