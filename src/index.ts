#!/usr/bin/env bun

import crypto from "node:crypto";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import packageJson from "../package.json";
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
  },
});

if (values.transport !== "stdio" && values.transport !== "http") {
  console.error(`Error: invalid transport "${values.transport}". Must be "stdio" or "http".\n`);
  console.error(USAGE);
  process.exit(1);
}

const cwd = values.cwd!;

async function runStdio() {
  const server = createServer(cwd);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`platter MCP server running on stdio (cwd: ${cwd})`);
}

interface SessionEntry {
  server: ReturnType<typeof createServer>;
  transport: StreamableHTTPServerTransport;
  lastAccessed: number;
}

async function runHttp() {
  const port = parseInt(values.port!, 10);
  const host = values.host!;
  const corsOrigin = values["cors-origin"]!;

  const app = express();

  // CORS — allow browser-based agents to connect
  app.use((req, res, next) => {
    const origin = corsOrigin === "*" ? req.headers.origin || "*" : corsOrigin;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
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

  app.use(express.json());

  const sessions = new Map<string, SessionEntry>();

  const SESSION_TTL_MS = 30 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastAccessed > SESSION_TTL_MS) {
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
    const server = createServer(cwd);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport, lastAccessed: Date.now() });
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
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
    sessions.delete(sessionId);
  });

  app.listen(port, host, () => {
    console.error(`platter MCP server running on http://${host}:${port}/mcp (cwd: ${cwd})`);
  });
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
