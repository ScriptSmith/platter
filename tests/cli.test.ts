import { describe, expect, it } from "bun:test";

describe("CLI", () => {
  it("--help prints usage and exits 0", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("platter v");
    expect(stdout).toContain("Usage:");
  });

  it("-h prints usage and exits 0", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "-h"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  it("--version prints version and exits 0", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("-v prints version and exits 0", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "-v"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("invalid transport prints error and exits 1", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "-t", "invalid"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("invalid transport");
  });
});
