import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { formatSize, resolvePath } from "../src/utils.js";

describe("resolvePath", () => {
  it("returns absolute paths as-is", () => {
    expect(resolvePath("/foo/bar", "/cwd")).toBe("/foo/bar");
  });

  it("resolves relative paths against cwd", () => {
    expect(resolvePath("foo/bar", "/cwd")).toBe(resolve("/cwd", "foo/bar"));
  });

  it("expands ~ to home directory", () => {
    expect(resolvePath("~", "/cwd")).toBe(homedir());
  });

  it("expands ~/ to home directory prefix", () => {
    expect(resolvePath("~/foo", "/cwd")).toBe(`${homedir()}/foo`);
  });
});

describe("formatSize", () => {
  it("formats bytes", () => {
    expect(formatSize(500)).toBe("500B");
  });

  it("formats kilobytes", () => {
    expect(formatSize(2048)).toBe("2.0KB");
  });

  it("formats megabytes", () => {
    expect(formatSize(1024 * 1024 * 3)).toBe("3.0MB");
  });
});
