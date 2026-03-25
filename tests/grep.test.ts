import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepTool } from "../src/tools/grep.js";

describe("grepTool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "platter-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("finds matching files (files_with_matches mode)", async () => {
    await writeFile(join(dir, "a.txt"), "hello world\n");
    await writeFile(join(dir, "b.txt"), "goodbye world\n");

    const result = await grepTool({ pattern: "hello" }, dir);
    expect(result).toContain("a.txt");
    expect(result).not.toContain("b.txt");
  });

  it("shows matching lines in content mode", async () => {
    await writeFile(join(dir, "test.txt"), "line 1\nhello world\nline 3\n");

    const result = await grepTool({ pattern: "hello", output_mode: "content" }, dir);
    expect(result).toContain("hello world");
    expect(result).toContain("2"); // line number
  });

  it("shows match counts in count mode", async () => {
    await writeFile(join(dir, "test.txt"), "foo\nfoo\nbar\n");

    const result = await grepTool({ pattern: "foo", output_mode: "count" }, dir);
    expect(result).toContain("2");
  });

  it("filters by glob pattern", async () => {
    await writeFile(join(dir, "code.ts"), "const x = 1;\n");
    await writeFile(join(dir, "notes.md"), "const y = 2;\n");

    const result = await grepTool({ pattern: "const", glob: "*.ts" }, dir);
    expect(result).toContain("code.ts");
    expect(result).not.toContain("notes.md");
  });

  it("supports case-insensitive search", async () => {
    await writeFile(join(dir, "test.txt"), "Hello World\n");

    const result = await grepTool({ pattern: "hello", case_insensitive: true }, dir);
    expect(result).toContain("test.txt");
  });

  it("returns no-match message when nothing found", async () => {
    await writeFile(join(dir, "test.txt"), "hello\n");

    const result = await grepTool({ pattern: "zzzznotfound" }, dir);
    expect(result).toContain("No matches found");
  });

  it("shows context lines", async () => {
    await writeFile(join(dir, "test.txt"), "aaa\nbbb\nccc\nddd\neee\n");

    const result = await grepTool({ pattern: "ccc", output_mode: "content", context: 1 }, dir);
    expect(result).toContain("bbb");
    expect(result).toContain("ccc");
    expect(result).toContain("ddd");
  });

  it("errors on non-existent path", async () => {
    expect(grepTool({ pattern: "x", path: "/nonexistent-xyz" }, dir)).rejects.toThrow("not found");
  });

  it("searches within a specific file", async () => {
    await writeFile(join(dir, "a.txt"), "target\n");
    await writeFile(join(dir, "b.txt"), "target\n");

    const result = await grepTool({ pattern: "target", path: "a.txt" }, dir);
    expect(result).toContain("a.txt");
    expect(result).not.toContain("b.txt");
  });

  it("supports fixed string search", async () => {
    await writeFile(join(dir, "test.txt"), "foo.bar\nfooXbar\n");

    const result = await grepTool({ pattern: "foo.bar", fixed_strings: true, output_mode: "content" }, dir);
    expect(result).toContain("foo.bar");
    // regex . would match X too, but fixed_strings should only match literal
    expect(result).not.toContain("fooXbar");
  });

  it("searches subdirectories recursively", async () => {
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "deep.txt"), "needle\n");

    const result = await grepTool({ pattern: "needle" }, dir);
    expect(result).toContain("deep.txt");
  });
});
