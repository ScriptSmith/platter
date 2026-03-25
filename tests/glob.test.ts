import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globTool } from "../src/tools/glob.js";

describe("globTool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "platter-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("matches files with a simple pattern", async () => {
    await writeFile(join(dir, "foo.ts"), "");
    await writeFile(join(dir, "bar.ts"), "");
    await writeFile(join(dir, "baz.js"), "");

    const result = await globTool({ pattern: "*.ts" }, dir);
    expect(result).toContain("foo.ts");
    expect(result).toContain("bar.ts");
    expect(result).not.toContain("baz.js");
  });

  it("matches files recursively with **", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "index.ts"), "");
    await writeFile(join(dir, "readme.md"), "");

    const result = await globTool({ pattern: "**/*.ts" }, dir);
    expect(result).toContain("src/index.ts");
    expect(result).not.toContain("readme.md");
  });

  it("returns no-match message for empty results", async () => {
    const result = await globTool({ pattern: "*.xyz" }, dir);
    expect(result).toContain("No files matched");
  });

  it("searches within a specified subdirectory", async () => {
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "a.txt"), "");
    await writeFile(join(dir, "root.txt"), "");

    const result = await globTool({ pattern: "*.txt", path: "sub" }, dir);
    expect(result).toContain("a.txt");
    expect(result).not.toContain("root.txt");
  });

  it("errors on non-existent directory", async () => {
    expect(globTool({ pattern: "*", path: "/nonexistent-dir-xyz" }, dir)).rejects.toThrow("not found");
  });
});
