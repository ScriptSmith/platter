import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRegistry } from "../src/process-registry.js";
import { bashTool } from "../src/tools/bash.js";

describe("bashTool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "platter-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("runs a basic command", async () => {
    const result = await bashTool({ command: "echo hello" }, dir);
    expect(result).toContain("hello");
  });

  it("returns non-zero exit codes as errors", async () => {
    expect(bashTool({ command: "exit 42" }, dir)).rejects.toThrow("exited with code 42");
  });

  it("times out long commands", async () => {
    expect(bashTool({ command: "sleep 60", timeout: 1 }, dir)).rejects.toThrow("timed out");
  });

  it("uses specified cwd", async () => {
    const result = await bashTool({ command: "pwd" }, dir);
    expect(result).toContain(dir);
  });

  it("truncates large output", async () => {
    const result = await bashTool({ command: "seq 1 5000" }, dir);
    expect(result).toContain("Showing lines");
  });
});

describe("bashTool with registry", () => {
  let dir: string;
  let registry: ProcessRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "platter-test-"));
    registry = new ProcessRegistry();
  });

  afterEach(async () => {
    await registry.killAll();
    registry.dispose();
    await rm(dir, { recursive: true });
  });

  it("pid reattach workflow", async () => {
    // Start a long command with short soft timeout
    const result1 = await bashTool({ command: "echo start && sleep 1 && echo done" }, dir, {
      registry,
      softTimeoutMs: 200,
    });

    expect(result1).toContain("start");
    expect(result1).toContain("Process still running");

    // Extract pid from the message
    const pidMatch = result1.match(/pid: (\d+)/);
    expect(pidMatch).toBeTruthy();
    const pid = parseInt(pidMatch![1], 10);

    // Reattach and wait for completion
    const result2 = await bashTool({ pid }, dir, { registry, softTimeoutMs: 5000 });
    expect(result2).toContain("done");
  });

  it("pid kill workflow", async () => {
    // Start a long command
    const result1 = await bashTool({ command: "sleep 60" }, dir, {
      registry,
      softTimeoutMs: 200,
    });

    expect(result1).toContain("Process still running");
    const pidMatch = result1.match(/pid: (\d+)/);
    const pid = parseInt(pidMatch![1], 10);

    // Kill it
    const result2 = await bashTool({ pid, kill: true }, dir, { registry });
    expect(result2).toContain("terminated");
  });

  it("validates command xor pid", async () => {
    await expect(bashTool({}, dir)).rejects.toThrow("Provide 'command'");
    await expect(bashTool({ command: "echo hi", pid: 1 }, dir)).rejects.toThrow("not both");
  });

  it("kill requires pid", async () => {
    await expect(bashTool({ command: "echo hi", kill: true }, dir)).rejects.toThrow("'kill' requires 'pid'");
  });

  it("spawn with registry completes normally for fast commands", async () => {
    const result = await bashTool({ command: "echo fast" }, dir, { registry, softTimeoutMs: 5000 });
    expect(result).toContain("fast");
    expect(result).not.toContain("Process still running");
  });
});
