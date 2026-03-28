import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export const ALL_TOOL_NAMES = ["read", "write", "edit", "bash", "glob", "grep", "js"] as const;
export type ToolName = (typeof ALL_TOOL_NAMES)[number];

export type SandboxFsMode = "memory" | "overlay" | "readwrite";

export interface SandboxConfig {
  enabled: boolean;
  fsMode: SandboxFsMode;
  allowedUrls?: string[];
}

export interface SecurityConfig {
  allowedTools?: Set<ToolName>;
  allowedPaths?: string[];
  allowedCommands?: RegExp[];
  sandbox?: SandboxConfig;
}

/**
 * Resolve a path to its real (symlink-resolved) location.
 * For non-existing paths (e.g. write targets), walks up to the nearest
 * existing ancestor, resolves it, then appends the remaining segments.
 */
async function resolveRealPath(targetPath: string): Promise<string> {
  const absolute = resolve(targetPath);

  if (existsSync(absolute)) {
    return realpath(absolute);
  }

  let current = absolute;
  const remaining: string[] = [];

  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    remaining.unshift(current.slice(parent.length + 1));
    current = parent;
  }

  const realAncestor = await realpath(current);
  return resolve(realAncestor, ...remaining);
}

/**
 * Validate that an absolute path falls within one of the allowed paths.
 * Resolves symlinks on both sides to prevent escaping via symlinked directories.
 */
export async function validatePath(absolutePath: string, allowedPaths: string[]): Promise<void> {
  const realTarget = await resolveRealPath(absolutePath);

  for (const allowed of allowedPaths) {
    const realAllowed = await resolveRealPath(allowed);
    if (realTarget === realAllowed || realTarget.startsWith(realAllowed + sep)) {
      return;
    }
  }

  throw new Error(`Access denied: "${absolutePath}" is outside allowed paths`);
}

/**
 * Validate that a bash command matches at least one allowed pattern.
 * Patterns are fully anchored — the entire command string must match.
 */
export function validateCommand(command: string, allowedCommands: RegExp[]): void {
  for (const pattern of allowedCommands) {
    if (pattern.test(command)) {
      return;
    }
  }
  throw new Error("Command not allowed. Must match one of the allowed command patterns.");
}
