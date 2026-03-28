import { afterEach, describe, expect, it } from "bun:test";
import { JsRuntime } from "../src/tools/js.js";

describe("JsRuntime", () => {
  let runtime: JsRuntime;

  afterEach(async () => {
    await runtime.dispose();
  });

  it("evaluates simple expressions", async () => {
    runtime = new JsRuntime();
    const result = await runtime.evaluate("2 + 2");
    expect(result).toBe("4");
  });

  it("returns undefined for empty code", async () => {
    runtime = new JsRuntime();
    const result = await runtime.evaluate("  ");
    expect(result).toBe("undefined");
  });

  it("persists var declarations across calls", async () => {
    runtime = new JsRuntime();
    await runtime.evaluate("var x = 42");
    const result = await runtime.evaluate("x");
    expect(result).toBe("42");
  });

  it("persists direct assignments across calls", async () => {
    runtime = new JsRuntime();
    await runtime.evaluate("y = 'hello'");
    const result = await runtime.evaluate("y");
    expect(result).toBe("'hello'");
  });

  it("persists function declarations across calls", async () => {
    runtime = new JsRuntime();
    await runtime.evaluate("function add(a, b) { return a + b; }");
    const result = await runtime.evaluate("add(3, 4)");
    expect(result).toBe("7");
  });

  it("handles multi-line code", async () => {
    runtime = new JsRuntime();
    const result = await runtime.evaluate("var a = 10;\nvar b = 20;\na + b");
    expect(result).toBe("30");
  });

  it("captures console output", async () => {
    runtime = new JsRuntime();
    const result = await runtime.evaluate('console.log("hello"); 42');
    expect(result).toContain("hello");
    expect(result).toContain("42");
  });

  it("reports errors with stack traces", async () => {
    runtime = new JsRuntime();
    await expect(runtime.evaluate("nonexistent")).rejects.toThrow("not defined");
  });

  it("handles async/await code", async () => {
    runtime = new JsRuntime();
    const result = await runtime.evaluate("await Promise.resolve(99)");
    expect(result).toBe("99");
  });

  it("persists values from async code via assignment", async () => {
    runtime = new JsRuntime();
    await runtime.evaluate("val = await Promise.resolve('async-value')");
    const result = await runtime.evaluate("val");
    expect(result).toBe("'async-value'");
  });

  it("handles objects and arrays", async () => {
    runtime = new JsRuntime();
    const result = await runtime.evaluate("({ a: 1, b: [2, 3] })");
    expect(result).toContain("a");
    expect(result).toContain("1");
    expect(result).toContain("2");
    expect(result).toContain("3");
  });

  it("times out on infinite loops", async () => {
    runtime = new JsRuntime();
    await expect(runtime.evaluate("while(true){}", 1000)).rejects.toThrow("timed out");
  });

  it("recovers after timeout by respawning", async () => {
    runtime = new JsRuntime();
    await expect(runtime.evaluate("while(true){}", 1000)).rejects.toThrow("timed out");
    // Should work after respawn (state is lost)
    const result = await runtime.evaluate("1 + 1");
    expect(result).toBe("2");
  });
});
