import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
