import { type ChildProcess, spawn } from "node:child_process";

const ATTRS = ["service", "platter", "account", "auth-token"];

/**
 * Retrieve the auth token from the system keyring via `secret-tool`.
 * Returns `null` if the secret doesn't exist or the tool isn't available.
 */
export async function loadFromKeyring(): Promise<string | null> {
  try {
    const value = await run("secret-tool", ["lookup", ...ATTRS]);
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Store the auth token in the system keyring via `secret-tool`.
 * Throws if `secret-tool` isn't available or the keyring is locked.
 */
export async function saveToKeyring(token: string): Promise<void> {
  await run("secret-tool", ["store", "--label=Platter auth token", ...ATTRS], token);
}

/**
 * Remove the auth token from the system keyring.
 */
export async function clearFromKeyring(): Promise<void> {
  try {
    await run("secret-tool", ["clear", ...ATTRS]);
  } catch {
    // Ignore — the secret may not exist.
  }
}

function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err: any) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.trimEnd());
      else reject(new Error(`secret-tool exit ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
  });
}
