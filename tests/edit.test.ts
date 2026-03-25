import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool } from "../src/tools/edit.js";

describe("editTool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "platter-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("performs exact match replacement", async () => {
    await writeFile(join(dir, "test.txt"), "hello world\n");
    const result = await editTool({ path: "test.txt", old_text: "hello", new_text: "goodbye" }, dir);
    expect(result).toContain("Successfully edited");
    const content = await readFile(join(dir, "test.txt"), "utf-8");
    expect(content).toBe("goodbye world\n");
  });

  it("fuzzy match does not corrupt unrelated file content", async () => {
    const content = "Line 1   \nHe said \u201Chello\u201D\nLine 3\n";
    await writeFile(join(dir, "test.txt"), content);
    await editTool({ path: "test.txt", old_text: 'He said "hello"', new_text: 'He said "goodbye"' }, dir);
    const result = await readFile(join(dir, "test.txt"), "utf-8");
    // Line 1 should still have trailing spaces
    expect(result).toContain("Line 1   ");
    // The edit should have been applied
    expect(result).toContain('He said "goodbye"');
    // Line 3 should be unchanged
    expect(result).toContain("Line 3");
  });

  it("fuzzy match handles trailing whitespace differences", async () => {
    const content = "function foo() {   \n  return 1;\n}\n";
    await writeFile(join(dir, "test.txt"), content);
    await editTool(
      { path: "test.txt", old_text: "function foo() {\n  return 1;", new_text: "function foo() {\n  return 2;" },
      dir,
    );
    const result = await readFile(join(dir, "test.txt"), "utf-8");
    expect(result).toContain("return 2;");
  });

  it("rejects non-unique exact matches", async () => {
    await writeFile(join(dir, "test.txt"), "foo bar foo\n");
    expect(editTool({ path: "test.txt", old_text: "foo", new_text: "baz" }, dir)).rejects.toThrow("occurrences");
  });

  it("exact uniqueness check does not false-positive from fuzzy duplicates", async () => {
    // File has "hello" in smart quotes and "hello" in ASCII quotes
    // Exact search for "hello" (with ASCII quotes) finds 1 match — should succeed
    const content = 'He said \u201Chello\u201D and then "hello"\n';
    await writeFile(join(dir, "test.txt"), content);
    const result = await editTool({ path: "test.txt", old_text: '"hello"', new_text: '"goodbye"' }, dir);
    expect(result).toContain("Successfully edited");
    const updated = await readFile(join(dir, "test.txt"), "utf-8");
    expect(updated).toContain('"goodbye"');
    expect(updated).toContain("\u201Chello\u201D");
  });

  it("preserves BOM", async () => {
    await writeFile(join(dir, "test.txt"), "\uFEFFhello world\n");
    await editTool({ path: "test.txt", old_text: "hello", new_text: "goodbye" }, dir);
    const raw = await readFile(join(dir, "test.txt"), "utf-8");
    expect(raw.startsWith("\uFEFF")).toBe(true);
  });

  it("preserves CRLF line endings", async () => {
    await writeFile(join(dir, "test.txt"), "hello world\r\nline 2\r\n");
    await editTool({ path: "test.txt", old_text: "hello", new_text: "goodbye" }, dir);
    const raw = await readFile(join(dir, "test.txt"), "utf-8");
    expect(raw).toContain("\r\n");
    expect(raw).toContain("goodbye world");
  });

  it("replace_all replaces all occurrences", async () => {
    await writeFile(join(dir, "test.txt"), "foo bar foo baz foo\n");
    const result = await editTool({ path: "test.txt", old_text: "foo", new_text: "qux", replace_all: true }, dir);
    expect(result).toContain("Successfully edited");
    const content = await readFile(join(dir, "test.txt"), "utf-8");
    expect(content).toBe("qux bar qux baz qux\n");
  });

  it("replace_all works with single occurrence", async () => {
    await writeFile(join(dir, "test.txt"), "hello world\n");
    const result = await editTool({ path: "test.txt", old_text: "hello", new_text: "goodbye", replace_all: true }, dir);
    expect(result).toContain("Successfully edited");
    const content = await readFile(join(dir, "test.txt"), "utf-8");
    expect(content).toBe("goodbye world\n");
  });

  it("replace_all with no match throws error", async () => {
    await writeFile(join(dir, "test.txt"), "hello world\n");
    expect(editTool({ path: "test.txt", old_text: "xyz", new_text: "abc", replace_all: true }, dir)).rejects.toThrow(
      "Could not find",
    );
  });
});
