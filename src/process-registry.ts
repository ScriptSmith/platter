import type { ChildProcess } from "node:child_process";
import { killProcessTree, MAX_BYTES } from "./utils.js";

const MAX_BUFFER_BYTES = 2 * MAX_BYTES; // 100KB buffer cap

interface TrackedProcess {
  pid: number;
  child: ChildProcess;
  command: string;
  startedAt: number;
  completedAt: number | null;
  state: "running" | "completed" | "killed";
  exitCode: number | null;
  exitSignal: string | null;
  outputChunks: Buffer[];
  totalBytesWritten: number;
  bufferStartOffset: number;
  currentBufferBytes: number;
  lastReadOffset: number;
  completionPromise: Promise<void>;
}

export interface WaitResult {
  done: boolean;
  output: string;
  pid: number;
  exitCode?: number | null;
  exitSignal?: string | null;
  elapsed: number;
}

const STALE_KEEP_MS = 5 * 60 * 1000;

export class ProcessRegistry {
  private processes = new Map<number, TrackedProcess>();
  private maxConcurrent: number;
  private cleanupInterval: NodeJS.Timeout;

  constructor(opts?: { maxConcurrent?: number }) {
    this.maxConcurrent = opts?.maxConcurrent ?? 20;
    this.cleanupInterval = setInterval(() => this.evictStale(), 60_000);
    this.cleanupInterval.unref();
  }

  get runningCount(): number {
    let count = 0;
    for (const p of this.processes.values()) {
      if (p.state === "running") count++;
    }
    return count;
  }

  register(child: ChildProcess, command: string): number {
    const pid = child.pid!;

    // Evict stale entry on PID collision
    const existing = this.processes.get(pid);
    if (existing && existing.state !== "running") {
      this.processes.delete(pid);
    }

    if (this.runningCount >= this.maxConcurrent) {
      throw new Error(
        `Process limit reached (${this.maxConcurrent} concurrent processes). Kill a running process first.`,
      );
    }

    let resolveCompletion!: () => void;
    const completionPromise = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    const tracked: TrackedProcess = {
      pid,
      child,
      command,
      startedAt: Date.now(),
      completedAt: null,
      state: "running",
      exitCode: null,
      exitSignal: null,
      outputChunks: [],
      totalBytesWritten: 0,
      bufferStartOffset: 0,
      currentBufferBytes: 0,
      lastReadOffset: 0,
      completionPromise,
    };

    const collectOutput = (data: Buffer) => {
      tracked.outputChunks.push(data);
      tracked.totalBytesWritten += data.length;
      tracked.currentBufferBytes += data.length;

      while (tracked.currentBufferBytes > MAX_BUFFER_BYTES && tracked.outputChunks.length > 1) {
        const dropped = tracked.outputChunks.shift()!;
        tracked.currentBufferBytes -= dropped.length;
        tracked.bufferStartOffset += dropped.length;
      }
    };

    child.stdout?.on("data", collectOutput);
    child.stderr?.on("data", collectOutput);

    child.on("close", (code, signal) => {
      if (tracked.state === "running") {
        tracked.state = "completed";
      }
      tracked.completedAt = Date.now();
      tracked.exitCode = code;
      tracked.exitSignal = signal;
      resolveCompletion();
    });

    child.on("error", () => {
      if (tracked.state === "running") {
        tracked.state = "completed";
      }
      tracked.completedAt = Date.now();
      resolveCompletion();
    });

    this.processes.set(pid, tracked);
    return pid;
  }

  async waitForOutput(pid: number, softTimeoutMs?: number, signal?: AbortSignal): Promise<WaitResult> {
    const tracked = this.processes.get(pid);
    if (!tracked) {
      throw new Error(`No tracked process with pid ${pid}`);
    }

    if (tracked.state !== "running") {
      return this.buildResult(tracked);
    }

    const racers: Promise<string>[] = [tracked.completionPromise.then(() => "completed")];

    if (softTimeoutMs !== undefined && softTimeoutMs > 0) {
      racers.push(new Promise((resolve) => setTimeout(() => resolve("timeout"), softTimeoutMs)));
    }

    if (signal) {
      if (signal.aborted) {
        await this.kill(pid);
        return this.buildResult(tracked);
      }
      racers.push(
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("aborted"), { once: true });
        }),
      );
    }

    const reason = await Promise.race(racers);

    if (reason === "aborted") {
      await this.kill(pid);
      return this.buildResult(tracked);
    }

    return this.buildResult(tracked);
  }

  readNewOutput(pid: number): string {
    const tracked = this.processes.get(pid);
    if (!tracked) {
      throw new Error(`No tracked process with pid ${pid}`);
    }
    return this.getOutputSinceLastRead(tracked);
  }

  async kill(pid: number): Promise<void> {
    const tracked = this.processes.get(pid);
    if (!tracked) {
      throw new Error(`No tracked process with pid ${pid}`);
    }

    if (tracked.state !== "running") return;

    tracked.state = "killed";
    killProcessTree(pid);

    const fallback = setTimeout(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead
      }
    }, 5000);

    await tracked.completionPromise;
    clearTimeout(fallback);
  }

  async killAll(): Promise<void> {
    const running = [...this.processes.values()].filter((p) => p.state === "running");
    await Promise.all(running.map((p) => this.kill(p.pid)));
  }

  dispose(): void {
    clearInterval(this.cleanupInterval);
  }

  private getOutputSinceLastRead(tracked: TrackedProcess): string {
    const buffer = Buffer.concat(tracked.outputChunks);
    const readStart = Math.max(0, tracked.lastReadOffset - tracked.bufferStartOffset);
    const newOutput = buffer.subarray(readStart);
    tracked.lastReadOffset = tracked.bufferStartOffset + buffer.length;
    return newOutput.toString("utf-8");
  }

  private buildResult(tracked: TrackedProcess): WaitResult {
    const output = this.getOutputSinceLastRead(tracked);
    return {
      done: tracked.state !== "running",
      output,
      pid: tracked.pid,
      exitCode: tracked.exitCode,
      exitSignal: tracked.exitSignal,
      elapsed: Date.now() - tracked.startedAt,
    };
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [pid, tracked] of this.processes) {
      if (tracked.state !== "running" && tracked.completedAt && now - tracked.completedAt > STALE_KEEP_MS) {
        this.processes.delete(pid);
      }
    }
  }
}
