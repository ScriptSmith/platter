#!/usr/bin/env bun

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import packageJson from "../package.json";
import type { ProcessRegistry } from "./process-registry.js";
import { ALL_TOOL_NAMES, type SandboxFsMode, type SecurityConfig, type ToolName } from "./security.js";
import { createServer } from "./server.js";

const USAGE = `platter v${packageJson.version}

Your computer, served on a platter.

Usage: platter [options]

Options:
  -t, --transport <stdio|http>   Transport mode (default: stdio)
  -p, --port <number>            HTTP port (default: 3100)
      --host <address>           HTTP bind address (default: 127.0.0.1)
      --cwd <path>               Working directory for tools (default: current directory)
      --cors-origin <origin>     Allowed CORS origin (default: *)
      --auth-token <token>       Bearer token for HTTP auth (auto-generated if omitted)
      --no-auth                  Disable bearer token authentication
      --tls-cert <path>          TLS certificate file (PEM) — enables HTTPS
      --tls-key <path>           TLS private key file (PEM)

Process management:
      --soft-timeout <seconds>   Soft timeout for bash commands (default: 30)
      --no-soft-timeout          Disable soft timeouts (original blocking behavior)
      --max-processes <number>   Max concurrent bash processes per session (default: 20)

Restrictions:
      --tools <list>             Comma-separated tools to enable (default: all)
                                 Valid: ${ALL_TOOL_NAMES.join(", ")}
      --allow-path <path>        Restrict file tools to this path (repeatable)
      --allow-command <regex>    Allow bash commands matching this pattern (repeatable)
                                 Pattern must match the entire command string

Sandbox:
      --sandbox                  Use just-bash sandbox instead of native bash
      --sandbox-fs <mode>        Filesystem backend: memory, overlay, readwrite (default: readwrite)
      --sandbox-allow-url <url>  Allow network access to URL prefix (repeatable)

  -h, --help                     Show this help message
  -v, --version                  Show version number`;

// Handle --help/-h and --version/-v before parseArgs
const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
  console.log(packageJson.version);
  process.exit(0);
}

const { values } = parseArgs({
  options: {
    transport: { type: "string", short: "t", default: "stdio" },
    port: { type: "string", short: "p", default: "3100" },
    host: { type: "string", default: "127.0.0.1" },
    cwd: { type: "string", default: process.cwd() },
    "cors-origin": { type: "string", default: "*" },
    "auth-token": { type: "string" },
    "no-auth": { type: "boolean", default: false },
    tools: { type: "string" },
    "allow-path": { type: "string", multiple: true },
    "allow-command": { type: "string", multiple: true },
    sandbox: { type: "boolean", default: false },
    "sandbox-fs": { type: "string", default: "readwrite" },
    "sandbox-allow-url": { type: "string", multiple: true },
    "tls-cert": { type: "string" },
    "tls-key": { type: "string" },
    "soft-timeout": { type: "string", default: "30" },
    "no-soft-timeout": { type: "boolean", default: false },
    "max-processes": { type: "string", default: "20" },
  },
});

if (values.transport !== "stdio" && values.transport !== "http") {
  console.error(`Error: invalid transport "${values.transport}". Must be "stdio" or "http".\n`);
  console.error(USAGE);
  process.exit(1);
}

if (values["auth-token"] && values["no-auth"]) {
  console.error("Error: --auth-token and --no-auth are mutually exclusive.\n");
  console.error(USAGE);
  process.exit(1);
}

if ((values["tls-cert"] && !values["tls-key"]) || (!values["tls-cert"] && values["tls-key"])) {
  console.error("Error: --tls-cert and --tls-key must be used together.\n");
  console.error(USAGE);
  process.exit(1);
}

// --- Process management ---

const noSoftTimeout = values["no-soft-timeout"] as boolean;
const softTimeoutMs = noSoftTimeout ? undefined : parseInt(values["soft-timeout"]!, 10) * 1000;
const maxProcesses = parseInt(values["max-processes"]!, 10);

if (!noSoftTimeout && (Number.isNaN(softTimeoutMs!) || softTimeoutMs! <= 0)) {
  console.error(`Error: invalid --soft-timeout value "${values["soft-timeout"]}". Must be a positive number.\n`);
  process.exit(1);
}

if (Number.isNaN(maxProcesses) || maxProcesses <= 0) {
  console.error(`Error: invalid --max-processes value "${values["max-processes"]}". Must be a positive number.\n`);
  process.exit(1);
}

// --- Security restrictions ---

const security: SecurityConfig = {};

if (values.tools) {
  const names = values.tools.split(",").map((t) => t.trim().toLowerCase());
  for (const name of names) {
    if (!(ALL_TOOL_NAMES as readonly string[]).includes(name)) {
      console.error(`Error: unknown tool "${name}". Valid tools: ${ALL_TOOL_NAMES.join(", ")}\n`);
      console.error(USAGE);
      process.exit(1);
    }
  }
  security.allowedTools = new Set(names as ToolName[]);
}

if (values["allow-path"]?.length) {
  security.allowedPaths = values["allow-path"].map((p) => resolve(p));
}

if (values["allow-command"]?.length) {
  security.allowedCommands = [];
  for (const pattern of values["allow-command"]) {
    try {
      security.allowedCommands.push(new RegExp(`^(?:${pattern})$`));
    } catch (e: any) {
      console.error(`Error: invalid --allow-command regex "${pattern}": ${e.message}\n`);
      process.exit(1);
    }
  }
}

const VALID_SANDBOX_FS_MODES = ["memory", "overlay", "readwrite"];
if (values.sandbox) {
  const fsMode = values["sandbox-fs"]!;
  if (!VALID_SANDBOX_FS_MODES.includes(fsMode)) {
    console.error(`Error: invalid --sandbox-fs "${fsMode}". Must be one of: ${VALID_SANDBOX_FS_MODES.join(", ")}\n`);
    console.error(USAGE);
    process.exit(1);
  }
  security.sandbox = {
    enabled: true,
    fsMode: fsMode as SandboxFsMode,
    allowedUrls: values["sandbox-allow-url"]?.length ? values["sandbox-allow-url"] : undefined,
  };
}

const bashEnabled = !security.allowedTools || security.allowedTools.has("bash");
if (security.allowedPaths && bashEnabled && !security.allowedCommands && !security.sandbox?.enabled) {
  console.error(
    "Warning: bash tool is enabled with --allow-path but no --allow-command restrictions.\n" +
      "  Bash commands can access paths outside the allowed list.\n" +
      "  Consider --tools (without bash) or adding --allow-command to restrict commands.\n",
  );
}

const cwd = values.cwd!;
const serverOpts = { softTimeoutMs, maxProcesses };

function logRestrictions() {
  if (security.allowedTools) {
    console.error(`Tools: ${[...security.allowedTools].join(", ")}`);
  }
  if (security.allowedPaths) {
    console.error(`Allowed paths: ${security.allowedPaths.join(", ")}`);
  }
  if (security.allowedCommands) {
    console.error(`Allowed commands: ${values["allow-command"]!.join(", ")}`);
  }
  if (security.sandbox?.enabled) {
    console.error(`Sandbox: enabled (fs: ${security.sandbox.fsMode})`);
    if (security.sandbox.allowedUrls) {
      console.error(`Sandbox allowed URLs: ${security.sandbox.allowedUrls.join(", ")}`);
    }
  }
}

async function runStdio() {
  const { server, registry } = createServer(cwd, security, serverOpts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`platter MCP server running on stdio (cwd: ${cwd})`);
  logRestrictions();

  const cleanup = () => {
    registry.killAll().finally(() => {
      registry.dispose();
      process.exit(0);
    });
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
}

interface SessionEntry {
  server: ReturnType<typeof createServer>["server"];
  registry: ProcessRegistry;
  transport: StreamableHTTPServerTransport;
  lastAccessed: number;
}

const LOCALHOST_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

async function runHttp() {
  const port = parseInt(values.port!, 10);
  const host = values.host!;
  const corsOrigin = values["cors-origin"]!;

  // Resolve auth token
  const noAuth = values["no-auth"] as boolean;
  const token = noAuth ? null : values["auth-token"] || crypto.randomBytes(32).toString("base64url");

  const app = express();

  // Host header validation — DNS rebinding protection
  // Wildcard binds (0.0.0.0, ::) accept connections on all interfaces, so
  // the Host header can be anything (localhost, an IP, a hostname, etc.).
  // Skip host validation for these — auth token still protects the server.
  if (LOCALHOST_HOSTS.has(host)) {
    app.use(localhostHostValidation());
  } else if (WILDCARD_HOSTS.has(host)) {
    console.error(
      `Warning: Server is binding to ${host} without DNS rebinding protection. ` +
        "Use authentication to protect your server.",
    );
  } else {
    app.use(hostHeaderValidation([host]));
  }

  // CORS — allow browser-based agents to connect
  app.use((req, res, next) => {
    const origin = corsOrigin === "*" ? req.headers.origin || "*" : corsOrigin;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, Authorization");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (corsOrigin !== "*") {
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Origin validation — actively reject requests with non-matching Origin header
  if (corsOrigin !== "*") {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && origin !== corsOrigin) {
        res.status(403).json({ error: "Origin not allowed" });
        return;
      }
      next();
    });
  }

  // Bearer token authentication (RFC 6750)
  if (token) {
    app.use((req, res, next) => {
      const auth = req.headers.authorization;
      if (!auth) {
        res.setHeader("WWW-Authenticate", "Bearer");
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (auth !== `Bearer ${token}`) {
        res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    });
  }

  app.use(express.json());

  const sessions = new Map<string, SessionEntry>();

  const SESSION_TTL_MS = 30 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastAccessed > SESSION_TTL_MS) {
        session.registry.killAll().then(() => session.registry.dispose());
        session.transport.close?.();
        sessions.delete(id);
      }
    }
  }, 60_000).unref();

  // POST /mcp - main MCP endpoint (handles both initialization and messages)
  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      session.lastAccessed = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId && !sessions.has(sessionId)) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // New session — create server + transport
    const { server, registry } = createServer(cwd, security, serverOpts);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, registry, transport, lastAccessed: Date.now() });
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        const session = sessions.get(transport.sessionId);
        if (session) {
          session.registry.killAll().then(() => session.registry.dispose());
        }
        sessions.delete(transport.sessionId);
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // GET /mcp - SSE notifications stream
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const session = sessions.get(sessionId)!;
    session.lastAccessed = Date.now();
    await session.transport.handleRequest(req, res);
  });

  // DELETE /mcp - close session
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const session = sessions.get(sessionId)!;
    session.lastAccessed = Date.now();
    await session.transport.handleRequest(req, res);
    await session.registry.killAll();
    session.registry.dispose();
    sessions.delete(sessionId);
  });

  const useTls = values["tls-cert"] && values["tls-key"];
  const protocol = useTls ? "https" : "http";

  const onListening = () => {
    console.error(`platter MCP server running on ${protocol}://${host}:${port}/mcp (cwd: ${cwd})`);
    if (token) {
      if (values["auth-token"]) {
        console.error("Auth: bearer token (provided via --auth-token)");
      } else {
        console.error(`Auth token: ${token}`);
      }
    } else {
      console.error("Auth: disabled (--no-auth)");
    }
    logRestrictions();
  };

  // Process-level cleanup for HTTP mode
  const cleanupAllSessions = () => {
    const promises: Promise<void>[] = [];
    for (const session of sessions.values()) {
      promises.push(session.registry.killAll().then(() => session.registry.dispose()));
    }
    Promise.all(promises).finally(() => process.exit(0));
  };
  process.on("SIGTERM", cleanupAllSessions);
  process.on("SIGINT", cleanupAllSessions);

  if (useTls) {
    const cert = readFileSync(values["tls-cert"]!);
    const key = readFileSync(values["tls-key"]!);
    https.createServer({ cert, key }, app).listen(port, host, onListening);
  } else {
    app.listen(port, host, onListening);
  }
}

if (values.transport === "http") {
  runHttp().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
} else {
  runStdio().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
