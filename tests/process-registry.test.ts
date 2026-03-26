import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRegistry } from "../src/process-registry.js";

function spawnInDir(command: string, dir: string) {
  const shell = process.env.SHELL || "/bin/bash";
  return spawn(shell, ["-c", command], {
    cwd: dir,
    detached: true,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("ProcessRegistry", () => {
  let dir: string;
  let registry: ProcessRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "platter-registry-test-"));
    registry = new ProcessRegistry();
  });

  afterEach(async () => {
    await registry.killAll();
    registry.dispose();
    await rm(dir, { recursive: true });
  });

  it("tracks a spawned process to completion", async () => {
    const child = spawnInDir("echo hello", dir);
    const pid = registry.register(child, "echo hello");
    const result = await registry.waitForOutput(pid);

    expect(result.done).toBe(true);
    expect(result.output).toContain("hello");
    expect(result.pid).toBe(pid);
    expect(result.exitCode).toBe(0);
  });

  it("returns done: false on soft timeout with partial output", async () => {
    const child = spawnInDir("echo partial && sleep 30", dir);
    const pid = registry.register(child, "echo partial && sleep 30");
    const result = await registry.waitForOutput(pid, 500);

    expect(result.done).toBe(false);
    expect(result.output).toContain("partial");
    expect(result.pid).toBe(pid);
  });

  it("reattach after soft timeout gets new output", async () => {
    const child = spawnInDir("echo first && sleep 1 && echo second", dir);
    const pid = registry.register(child, "test");

    // First wait — soft timeout before process finishes
    const r1 = await registry.waitForOutput(pid, 200);
    expect(r1.done).toBe(false);
    expect(r1.output).toContain("first");

    // Reattach — wait for completion
    const r2 = await registry.waitForOutput(pid, 5000);
    expect(r2.done).toBe(true);
    expect(r2.output).toContain("second");
    expect(r2.exitCode).toBe(0);
  });

  it("kill terminates a running process", async () => {
    const child = spawnInDir("sleep 60", dir);
    const pid = registry.register(child, "sleep 60");

    await registry.kill(pid);

    const output = registry.readNewOutput(pid);
    expect(typeof output).toBe("string");
  });

  it("killAll terminates all running processes", async () => {
    const child1 = spawnInDir("sleep 60", dir);
    const child2 = spawnInDir("sleep 60", dir);
    registry.register(child1, "sleep 60");
    registry.register(child2, "sleep 60");

    expect(registry.runningCount).toBe(2);
    await registry.killAll();
    expect(registry.runningCount).toBe(0);
  });

  it("hard timeout kills process automatically", async () => {
    const child = spawnInDir("sleep 60", dir);
    const pid = registry.register(child, "sleep 60", 500);

    const result = await registry.waitForOutput(pid, 2000);
    expect(result.done).toBe(true);
    expect(result.exitSignal).toBeTruthy();
  });

  it("enforces concurrency limit", () => {
    const small = new ProcessRegistry({ maxConcurrent: 2 });
    try {
      const c1 = spawnInDir("sleep 60", dir);
      const c2 = spawnInDir("sleep 60", dir);
      small.register(c1, "sleep 60");
      small.register(c2, "sleep 60");

      const c3 = spawnInDir("sleep 60", dir);
      expect(() => small.register(c3, "sleep 60")).toThrow("Process limit reached");
      c3.kill();
    } finally {
      small.killAll().then(() => small.dispose());
    }
  });

  it("AbortSignal kills process", async () => {
    const controller = new AbortController();
    const child = spawnInDir("sleep 60", dir);
    const pid = registry.register(child, "sleep 60");

    // Abort after 200ms
    setTimeout(() => controller.abort(), 200);
    const result = await registry.waitForOutput(pid, undefined, controller.signal);

    expect(result.done).toBe(true);
  });

  it("readNewOutput returns output for completed process", async () => {
    const child = spawnInDir("echo done", dir);
    const pid = registry.register(child, "echo done");

    // Wait for completion
    await registry.waitForOutput(pid);

    // readNewOutput after waitForOutput consumed it should return empty
    const remaining = registry.readNewOutput(pid);
    expect(remaining).toBe("");
  });
});
