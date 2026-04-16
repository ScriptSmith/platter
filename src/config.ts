import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ALL_TOOL_NAMES, type ToolName } from "./security.js";

export interface PlatterConfig {
  version: 1;
  authToken?: string;
  enabledTools: ToolName[];
  port: number;
  host: string;
  cwd: string;
}

export function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "platter");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function getStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "state");
  return join(base, "platter");
}

export function getLogPath(): string {
  return join(getStateDir(), "platter.log");
}

function defaultConfig(): PlatterConfig {
  return {
    version: 1,
    enabledTools: [...ALL_TOOL_NAMES],
    port: 3100,
    host: "127.0.0.1",
    cwd: homedir(),
  };
}

function validateTools(raw: unknown): ToolName[] {
  if (!Array.isArray(raw)) return [...ALL_TOOL_NAMES];
  const valid = new Set(ALL_TOOL_NAMES as readonly string[]);
  return raw.filter((t): t is ToolName => typeof t === "string" && valid.has(t));
}

function sanitize(raw: any): PlatterConfig {
  const d = defaultConfig();
  return {
    version: 1,
    // authToken may live in the keyring; only keep it if it was already in the file.
    ...(typeof raw?.authToken === "string" && raw.authToken.length > 0 ? { authToken: raw.authToken } : {}),
    enabledTools: validateTools(raw?.enabledTools),
    port: Number.isInteger(raw?.port) && raw.port > 0 && raw.port < 65536 ? raw.port : d.port,
    host: typeof raw?.host === "string" && raw.host.length > 0 ? raw.host : d.host,
    cwd: typeof raw?.cwd === "string" && raw.cwd.length > 0 ? raw.cwd : d.cwd,
  };
}

export function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function loadConfig(): { config: PlatterConfig; created: boolean } {
  const path = getConfigPath();
  if (!existsSync(path)) {
    const config = defaultConfig();
    saveConfig(config);
    return { config, created: true };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return { config: sanitize(raw), created: false };
  } catch (err: any) {
    console.error(`Warning: failed to parse ${path} (${err.message}); using defaults.`);
    const config = defaultConfig();
    return { config, created: false };
  }
}

export function saveConfig(config: PlatterConfig): void {
  ensureConfigDir();
  const path = getConfigPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function ensureStateDir(): void {
  const dir = getStateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Rotate the log file: rename platter.log → platter.log.1 on start.
 * Best-effort; errors are swallowed.
 */
export function rotateLog(): string {
  try {
    ensureStateDir();
    const path = getLogPath();
    if (existsSync(path)) {
      const prev = `${path}.1`;
      try {
        renameSync(path, prev);
      } catch {
        // ignore
      }
    }
    return path;
  } catch {
    return getLogPath();
  }
}
