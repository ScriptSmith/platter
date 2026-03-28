import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";

// Runtime script executed as a CJS file in a Bun/Node subprocess.
// Reads NDJSON requests from stdin, evaluates code, writes NDJSON responses to stdout.
// Uses indirect eval for global scope persistence (var, function, and undeclared assignments
// all persist across evaluations). CJS mode ensures sloppy-mode eval semantics.
//
// TypeScript transpilation via Bun.Transpiler is used as a SyntaxError fallback only,
// to avoid the transpiler's dead-code elimination stripping useful expression results.
const RUNTIME_SCRIPT = String.raw`
var util = require("util");
var readline = require("readline");

var rl = readline.createInterface({ input: process.stdin, terminal: false });
var geval = eval;

// Helper to load packages from URLs or npm package names.
// Bare specifiers (e.g. "lodash") are fetched from unpkg.com.
// CJS modules (module.exports) are wrapped automatically; plain scripts are eval'd directly.
globalThis.load = async function(specifier) {
  var url = specifier.startsWith("http") ? specifier : "https://unpkg.com/" + specifier;
  var resp = await fetch(url);
  if (!resp.ok) throw new Error("Failed to load " + specifier + ": HTTP " + resp.status);
  var code = await resp.text();
  // Detect CJS/UMD patterns and use module wrapper
  if (/\bmodule\.exports\b/.test(code) || /\bexports\.\w/.test(code)) {
    var mod = { exports: {} };
    new Function("module", "exports", code)(mod, mod.exports);
    return mod.exports.default !== undefined ? mod.exports.default : mod.exports;
  }
  // Plain script / IIFE — eval directly (may set globals)
  return geval(code);
};

// TypeScript transpilation (Bun only) — called only on SyntaxError fallback
var tsTranspiler = null;
function maybeTranspile(code) {
  try {
    if (typeof Bun === "undefined" || typeof Bun.Transpiler !== "function") return code;
    if (!tsTranspiler) tsTranspiler = new Bun.Transpiler({ loader: "tsx" });
    var result = tsTranspiler.transformSync(code);
    return typeof result === "string" ? result.trim() : code;
  } catch (e) {
    return code;
  }
}

// Console output capture — redirect to array so stdout stays clean for protocol
var consoleLogs = [];
globalThis.console = {
  log: function() { consoleLogs.push(util.format.apply(null, arguments)); },
  error: function() { consoleLogs.push(util.format.apply(null, arguments)); },
  warn: function() { consoleLogs.push(util.format.apply(null, arguments)); },
  info: function() { consoleLogs.push(util.format.apply(null, arguments)); },
  debug: function() { consoleLogs.push(util.format.apply(null, arguments)); },
  dir: function(obj, opts) { consoleLogs.push(util.inspect(obj, Object.assign({ colors: false }, opts || {}))); },
  table: function(data) { consoleLogs.push(util.inspect(data, { colors: false, depth: 2 })); },
  trace: function() { consoleLogs.push(new Error(util.format.apply(null, arguments)).stack || ""); },
  assert: function(cond) { if (!cond) { var a = [].slice.call(arguments, 1); consoleLogs.push("Assertion failed: " + util.format.apply(null, a)); } },
  clear: function() {}, count: function() {}, countReset: function() {},
  group: function() {}, groupEnd: function() {},
  time: function() {}, timeEnd: function() {}, timeLog: function() {},
};

function serialize(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "function") return String(value);
  if (typeof value === "symbol") return String(value);
  try {
    return util.inspect(value, { depth: 4, colors: false, maxArrayLength: 100, maxStringLength: 10000 });
  } catch (e) {
    return String(value);
  }
}

// For async blocks: wrap the last expression-like line in "return (...)"
function autoReturn(code) {
  var lines = code.trimEnd().split("\n");
  for (var i = lines.length - 1; i >= 0; i--) {
    var trimmed = lines[i].trim();
    if (!trimmed || trimmed.indexOf("//") === 0) continue;
    if (/^(var|let|const|function|class|if|for|while|do|switch|try|throw|return|import|export|break|continue|debugger)\b/.test(trimmed)) break;
    if (/^[}\])]/.test(trimmed)) break;
    lines[i] = "return (" + lines[i].replace(/;\s*$/, "") + ")";
    break;
  }
  return lines.join("\n");
}

function evalSync(code) {
  var isDecl = /^(async\s+)?(function|class|var|let|const)\b/.test(code.trim());

  // Try raw code first (no transpilation)
  if (!isDecl) {
    try { return geval("(\n" + code + "\n)"); } catch (e) { /* not an expression */ }
  }

  try {
    return geval(code);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    // SyntaxError — might be TypeScript, try transpiling
    var tc = maybeTranspile(code);
    if (tc === code) throw e;
    if (!isDecl) {
      try { return geval("(\n" + tc.replace(/;\s*$/, "") + "\n)"); } catch (e2) { /* not an expression */ }
    }
    return geval(tc);
  }
}

async function evalAsync(code) {
  // Try as single async expression
  try { return await geval("(async()=>(\n" + code + "\n))()"); } catch (e) { /* not a single expression */ }

  // Try as block with auto-return
  try { return await geval("(async()=>{\n" + autoReturn(code) + "\n})()"); } catch (e) { /* auto-return failed */ }

  // Try as block without return (side-effect code)
  try { return await geval("(async()=>{\n" + code + "\n})()"); } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    // SyntaxError — might be TypeScript
    var tc = maybeTranspile(code);
    if (tc === code) throw e;
    try { return await geval("(async()=>(\n" + tc.replace(/;\s*$/, "") + "\n))()"); } catch (e2) { /* */ }
    try { return await geval("(async()=>{\n" + autoReturn(tc) + "\n})()"); } catch (e3) { /* */ }
    return await geval("(async()=>{\n" + tc + "\n})()");
  }
}

rl.on("line", async function(line) {
  if (!line.trim()) return;
  var msg;
  try { msg = JSON.parse(line); } catch (e) { return; }

  consoleLogs = [];

  try {
    var result;
    var hasAwait = /\bawait\b/.test(msg.code);

    if (hasAwait) {
      result = await evalAsync(msg.code);
    } else {
      result = evalSync(msg.code);
    }

    var response = { id: msg.id, result: serialize(result) };
    if (consoleLogs.length > 0) response.logs = consoleLogs.slice();
    process.stdout.write(JSON.stringify(response) + "\n");
  } catch (err) {
    var errMsg = err && err.stack ? err.stack : String(err);
    var response2 = { id: msg.id, error: errMsg };
    if (consoleLogs.length > 0) response2.logs = consoleLogs.slice();
    process.stdout.write(JSON.stringify(response2) + "\n");
  }
});
`;

interface EvalResponse {
  id: number;
  result?: string;
  error?: string;
  logs?: string[];
}

export class JsRuntime {
  private child: ChildProcess | null = null;
  private rl: Interface | null = null;
  private nextId = 1;
  private generation = 0;
  private pending = new Map<number, { resolve: (resp: EvalResponse) => void }>();
  private disposed = false;
  private scriptPath: string | null = null;
  private static cachedRuntime: string | null = null;

  private ensureRunning(): void {
    if (this.disposed) throw new Error("Runtime has been disposed");
    if (this.child && this.child.exitCode === null && !this.child.killed) return;

    // Clean up dead process if any
    this.teardown();

    // Write runtime script to temp file (.cjs for CommonJS / sloppy mode)
    const id = randomBytes(8).toString("hex");
    this.scriptPath = join(tmpdir(), `platter-js-${id}.cjs`);
    writeFileSync(this.scriptPath, RUNTIME_SCRIPT);

    const runtime = JsRuntime.findRuntime();
    this.child = spawn(runtime, [this.scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    // Drain stderr to prevent buffer blocking
    this.child.stderr?.resume();

    // Generation counter prevents stale handlers from old child processes
    // from interfering with new ones after teardown + respawn.
    this.generation++;
    const gen = this.generation;

    this.rl = createInterface({ input: this.child.stdout!, terminal: false });

    this.rl.on("line", (line) => {
      if (gen !== this.generation) return;
      try {
        const msg: EvalResponse = JSON.parse(line);
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
      } catch {
        // Ignore malformed output
      }
    });

    this.child.on("exit", () => {
      if (gen !== this.generation) return;
      for (const [, p] of this.pending) {
        p.resolve({ id: 0, error: "Runtime process exited unexpectedly" });
      }
      this.pending.clear();
    });
  }

  private static findRuntime(): string {
    if (JsRuntime.cachedRuntime) return JsRuntime.cachedRuntime;
    const bunPath = Bun.which("bun");
    if (bunPath) {
      JsRuntime.cachedRuntime = bunPath;
      return bunPath;
    }
    const nodePath = Bun.which("node");
    if (nodePath) {
      JsRuntime.cachedRuntime = nodePath;
      return nodePath;
    }
    throw new Error("Cannot find 'bun' or 'node' on PATH. Install Bun or Node.js to use the js tool.");
  }

  async evaluate(code: string, timeoutMs = 30000, signal?: AbortSignal): Promise<string> {
    if (!code.trim()) return "undefined";

    this.ensureRunning();

    const id = this.nextId++;

    return new Promise<string>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Cancelled"));
        return;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn();
      };

      this.pending.set(id, {
        resolve: (resp) =>
          settle(() => {
            let output = "";
            if (resp.logs?.length) {
              output += `${resp.logs.join("\n")}\n\n`;
            }
            if (resp.error) {
              output += resp.error;
              reject(new Error(output));
            } else {
              output += resp.result ?? "undefined";
              resolve(output);
            }
          }),
      });

      try {
        this.child!.stdin!.write(`${JSON.stringify({ id, code })}\n`);
      } catch (err) {
        this.pending.delete(id);
        settle(() => reject(new Error(`Failed to send code to runtime: ${String(err)}`)));
        return;
      }

      // Timeout — kills the runtime (all state is lost)
      timer = setTimeout(() => {
        this.pending.delete(id);
        settle(() => {
          this.teardown();
          reject(new Error(`Execution timed out after ${timeoutMs / 1000} seconds. Runtime state has been reset.`));
        });
      }, timeoutMs);

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            this.pending.delete(id);
            settle(() => {
              this.teardown();
              reject(new Error("Cancelled"));
            });
          },
          { once: true },
        );
      }
    });
  }

  private teardown(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // Already dead
      }
      this.child = null;
    }
    if (this.scriptPath) {
      try {
        unlinkSync(this.scriptPath);
      } catch {
        // Already gone
      }
      this.scriptPath = null;
    }
    for (const [, p] of this.pending) {
      p.resolve({ id: 0, error: "Runtime was shut down" });
    }
    this.pending.clear();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.teardown();
  }
}
