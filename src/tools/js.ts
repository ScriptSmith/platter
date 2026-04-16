import { format, inspect } from "node:util";
import vm from "node:vm";

function serialize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "function") return String(value);
  if (typeof value === "symbol") return String(value);
  try {
    return inspect(value, { depth: 4, colors: false, maxArrayLength: 100, maxStringLength: 10000 });
  } catch {
    return String(value);
  }
}

/** Wrap the last expression-like line in `return (...)` for async blocks. */
function autoReturn(code: string): string {
  const lines = code.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    if (
      /^(var|let|const|function|class|if|for|while|do|switch|try|throw|return|import|export|break|continue|debugger)\b/.test(
        trimmed,
      )
    )
      break;
    if (/^[}\])]/.test(trimmed)) break;
    lines[i] = `return (${lines[i].replace(/;\s*$/, "")})`;
    break;
  }
  return lines.join("\n");
}

export class JsRuntime {
  private context: vm.Context;
  private logs: string[] = [];
  private transpiler: InstanceType<typeof Bun.Transpiler> | null = null;
  private disposed = false;

  constructor() {
    this.context = this.buildContext();
  }

  private buildContext(): vm.Context {
    const ctx = vm.createContext({
      // Console — captures output into self.logs
      console: {
        log: (...args: unknown[]) => this.logs.push(format(...args)),
        error: (...args: unknown[]) => this.logs.push(format(...args)),
        warn: (...args: unknown[]) => this.logs.push(format(...args)),
        info: (...args: unknown[]) => this.logs.push(format(...args)),
        debug: (...args: unknown[]) => this.logs.push(format(...args)),
        dir: (obj: unknown, opts?: object) => this.logs.push(inspect(obj, { colors: false, ...opts })),
        table: (data: unknown) => this.logs.push(inspect(data, { colors: false, depth: 2 })),
        trace: (...args: unknown[]) => this.logs.push(new Error(format(...args)).stack ?? ""),
        assert: (cond: unknown, ...args: unknown[]) => {
          if (!cond) this.logs.push(`Assertion failed: ${format(...args)}`);
        },
        clear() {},
        count() {},
        countReset() {},
        group() {},
        groupEnd() {},
        time() {},
        timeEnd() {},
        timeLog() {},
      },
      // Standard globals
      setTimeout,
      setInterval,
      clearTimeout,
      clearInterval,
      queueMicrotask,
      fetch,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      Buffer,
      atob,
      btoa,
      AbortController,
      AbortSignal,
      Headers,
      Request,
      Response,
      Blob,
      structuredClone,
    });

    // Package loader — needs reference to ctx, so added after creation.
    // Bare specifiers are fetched from unpkg.com; CJS modules are wrapped automatically.
    ctx.load = async (specifier: string) => {
      const url = specifier.startsWith("http") ? specifier : `https://unpkg.com/${specifier}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Failed to load ${specifier}: HTTP ${resp.status}`);
      const code = await resp.text();
      if (/\bmodule\.exports\b/.test(code) || /\bexports\.\w/.test(code)) {
        const fn = vm.runInContext(`(function(module, exports) {\n${code}\n})`, ctx) as (
          m: { exports: Record<string, unknown> },
          e: Record<string, unknown>,
        ) => void;
        const mod: { exports: Record<string, unknown> } = { exports: {} };
        fn(mod, mod.exports);
        return mod.exports.default !== undefined ? mod.exports.default : mod.exports;
      }
      return vm.runInContext(code, ctx);
    };

    return ctx;
  }

  async evaluate(code: string, timeoutMs = 30000, signal?: AbortSignal): Promise<string> {
    if (this.disposed) throw new Error("Runtime has been disposed");
    if (!code.trim()) return "undefined";
    if (signal?.aborted) throw new Error("Cancelled");

    this.logs = [];

    try {
      const hasAwait = /\bawait\b/.test(code);
      const result = hasAwait ? await this.evalAsync(code, timeoutMs, signal) : this.evalSync(code, timeoutMs);

      let output = "";
      if (this.logs.length > 0) output += `${this.logs.join("\n")}\n\n`;
      output += serialize(result);
      return output;
    } catch (err: any) {
      let output = "";
      if (this.logs.length > 0) output += `${this.logs.join("\n")}\n\n`;
      output += err?.stack || String(err);
      throw new Error(output);
    }
  }

  private evalSync(code: string, timeoutMs: number): unknown {
    const isDecl = /^(async\s+)?(function|class|var|let|const)\b/.test(code.trim());

    // Try as expression first (for things like "2 + 2", "x.foo()")
    if (!isDecl) {
      try {
        return vm.runInContext(`(\n${code}\n)`, this.context, { timeout: timeoutMs });
      } catch {
        // Not a valid expression, fall through to statement
      }
    }

    // Try as statement(s)
    try {
      return vm.runInContext(code, this.context, { timeout: timeoutMs });
    } catch (e: any) {
      // vm errors are cross-realm — instanceof SyntaxError fails, check by name
      if (e?.name !== "SyntaxError") throw e;
      // SyntaxError — might be TypeScript, try transpiling
      const tc = this.transpile(code);
      if (tc === code) throw e;
      if (!isDecl) {
        try {
          return vm.runInContext(`(\n${tc.replace(/;\s*$/, "")}\n)`, this.context, { timeout: timeoutMs });
        } catch {
          // Not an expression after transpilation either
        }
      }
      return vm.runInContext(tc, this.context, { timeout: timeoutMs });
    }
  }

  private async evalAsync(code: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const run = (wrapped: string): Promise<unknown> => {
      const promise = vm.runInContext(wrapped, this.context) as Promise<unknown>;
      const racers: Promise<unknown>[] = [promise];
      racers.push(
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Execution timed out after ${timeoutMs / 1000} seconds`)), timeoutMs),
        ),
      );
      if (signal) {
        racers.push(
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
          }),
        );
      }
      return Promise.race(racers);
    };

    // Try as single async expression
    try {
      return await run(`(async()=>(\n${code}\n))()`);
    } catch {
      // Not a single expression
    }

    // Try as block with auto-return on last expression
    try {
      return await run(`(async()=>{\n${autoReturn(code)}\n})()`);
    } catch {
      // auto-return failed
    }

    // Try as block without return (side-effect code)
    try {
      return await run(`(async()=>{\n${code}\n})()`);
    } catch (e: any) {
      if (e?.name !== "SyntaxError") throw e;
      // SyntaxError — might be TypeScript, try transpiling
      const tc = this.transpile(code);
      if (tc === code) throw e;
      try {
        return await run(`(async()=>(\n${tc.replace(/;\s*$/, "")}\n))()`);
      } catch {
        /* not an expression */
      }
      try {
        return await run(`(async()=>{\n${autoReturn(tc)}\n})()`);
      } catch {
        /* auto-return failed */
      }
      return await run(`(async()=>{\n${tc}\n})()`);
    }
  }

  private transpile(code: string): string {
    try {
      if (!this.transpiler) {
        this.transpiler = new Bun.Transpiler({ loader: "tsx" });
      }
      const result = this.transpiler.transformSync(code);
      return typeof result === "string" ? result.trim() : code;
    } catch {
      return code;
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}
