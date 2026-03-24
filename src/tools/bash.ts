import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function getShellConfig(): { shell: string; args: string[] } {
  const shell = process.env.SHELL || "/bin/bash";
  // Use login + interactive-like shell to pick up user PATH/env
  return { shell, args: ["-c"] };
}

function killProcessTree(pid: number): void {
  try {
    // Kill entire process group
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already dead
    }
  }
}

/**
 * Truncate from the tail (keep last N lines/bytes), suitable for bash
 * output where errors/final results appear at the end.
 */
function truncateTail(content: string): {
  content: string;
  truncated: boolean;
  totalLines: number;
  outputLines: number;
} {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(content, "utf-8");

  if (totalLines <= MAX_LINES && totalBytes <= MAX_BYTES) {
    return { content, truncated: false, totalLines, outputLines: totalLines };
  }

  // Work backwards
  const outputLinesArr: string[] = [];
  let outputBytes = 0;

  for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < MAX_LINES; i--) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0);

    if (outputBytes + lineBytes > MAX_BYTES) break;

    outputLinesArr.unshift(line);
    outputBytes += lineBytes;
  }

  return {
    content: outputLinesArr.join("\n"),
    truncated: true,
    totalLines,
    outputLines: outputLinesArr.length,
  };
}

export async function bashTool(args: { command: string; timeout?: number }, cwd: string): Promise<string> {
  if (!existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }

  const { shell, args: shellArgs } = getShellConfig();

  return new Promise<string>((resolve, reject) => {
    const child = spawn(shell, [...shellArgs, args.command], {
      cwd,
      detached: true,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    if (args.timeout !== undefined && args.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (child.pid) killProcessTree(child.pid);
      }, args.timeout * 1000);
    }

    const chunks: Buffer[] = [];

    child.stdout?.on("data", (data: Buffer) => chunks.push(data));
    child.stderr?.on("data", (data: Buffer) => chunks.push(data));

    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    });

    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const fullOutput = Buffer.concat(chunks).toString("utf-8");

      if (timedOut) {
        let output = fullOutput;
        if (output) output += "\n\n";
        output += `Command timed out after ${args.timeout} seconds`;
        reject(new Error(output));
        return;
      }

      const truncation = truncateTail(fullOutput);
      let outputText = truncation.content || "(no output)";

      if (truncation.truncated) {
        const startLine = truncation.totalLines - truncation.outputLines + 1;
        const endLine = truncation.totalLines;
        outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(MAX_BYTES)} limit)]`;
      }

      if (code !== 0 && code !== null) {
        outputText += `\n\nCommand exited with code ${code}`;
        reject(new Error(outputText));
      } else {
        resolve(outputText);
      }
    });
  });
}
