import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool } from "../src/tools/read.js";

describe("readTool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "platter-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("reads a basic file", async () => {
    await writeFile(join(dir, "test.txt"), "hello\nworld\n");
    const result = await readTool({ path: "test.txt" }, dir);
    expect(result).toContain("hello");
    expect(result).toContain("world");
  });

  it("reads with offset and limit", async () => {
    await writeFile(join(dir, "test.txt"), "line1\nline2\nline3\nline4\n");
    const result = await readTool({ path: "test.txt", offset: 2, limit: 2 }, dir);
    expect(result).toContain("line2");
    expect(result).toContain("line3");
    expect(result).not.toContain("line1");
  });

  it("detects image files", async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(100).fill(0)]);
    await writeFile(join(dir, "image.png"), buf);
    const result = await readTool({ path: "image.png" }, dir);
    expect(result).toContain("image/png");
  });

  it("handles small buffers in image detection without error", async () => {
    const buf = Buffer.from([0x01, 0x02]);
    await writeFile(join(dir, "tiny.bin"), buf);
    const result = await readTool({ path: "tiny.bin" }, dir);
    expect(result).toBeDefined();
  });

  it("truncates large output", async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");
    await writeFile(join(dir, "big.txt"), lines);
    const result = await readTool({ path: "big.txt" }, dir);
    expect(result).toContain("Use offset=");
  });
});
