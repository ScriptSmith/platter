import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTool } from "../src/tools/write.js";

describe("writeTool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "platter-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("creates a new file", async () => {
    const result = await writeTool({ path: "new.txt", content: "hello" }, dir);
    expect(result).toContain("Successfully wrote");
    const content = await readFile(join(dir, "new.txt"), "utf-8");
    expect(content).toBe("hello");
  });

  it("overwrites an existing file", async () => {
    await writeTool({ path: "file.txt", content: "old" }, dir);
    await writeTool({ path: "file.txt", content: "new" }, dir);
    const content = await readFile(join(dir, "file.txt"), "utf-8");
    expect(content).toBe("new");
  });

  it("auto-creates parent directories", async () => {
    await writeTool({ path: "a/b/c.txt", content: "deep" }, dir);
    const content = await readFile(join(dir, "a/b/c.txt"), "utf-8");
    expect(content).toBe("deep");
  });
});
