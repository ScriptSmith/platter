import { spawn } from "node:child_process";

type Candidate = { cmd: string; args: string[] };

const CANDIDATES: Candidate[] = [
  { cmd: "wl-copy", args: [] },
  { cmd: "xclip", args: ["-selection", "clipboard"] },
  { cmd: "xsel", args: ["-ib"] },
];

/**
 * Copy `text` to the system clipboard by piping to wl-copy, xclip, or xsel.
 * Tries each candidate in order; returns the name of the tool that worked.
 * Throws an aggregated error if none are available.
 */
export async function copyToClipboard(text: string): Promise<string> {
  const errors: string[] = [];
  for (const { cmd, args } of CANDIDATES) {
    try {
      await run(cmd, args, text);
      return cmd;
    } catch (err: any) {
      errors.push(`${cmd}: ${err.message}`);
    }
  }
  throw new Error(
    `No clipboard helper available. Install one of wl-clipboard, xclip, or xsel.\n  ${errors.join("\n  ")}`,
  );
}

function run(cmd: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
    } catch (err: any) {
      reject(err);
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
    child.stdin?.end(input);
  });
}
