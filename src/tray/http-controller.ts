import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server as HttpsServer } from "node:http";
import type { Server } from "node:http";
import https from "node:https";
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { ProcessRegistry } from "../process-registry.js";
import type { SecurityConfig, ToolName } from "../security.js";
import { createServer, type CreateServerOpts } from "../server.js";
import type { JsRuntime } from "../tools/js.js";

interface SessionEntry {
  server: McpServer;
  registry: ProcessRegistry;
  runtime: JsRuntime | null;
  registeredTools: Map<ToolName, RegisteredTool>;
  transport: StreamableHTTPServerTransport;
  lastAccessed: number;
}

export interface HttpControllerOptions {
  cwd: string;
  security: SecurityConfig;
  serverOpts: CreateServerOpts;
  port: number;
  host: string;
  corsOrigin: string;
  /** Initial auth token. `null` disables auth entirely. */
  authToken: string | null;
  maxSessions?: number;
  tlsCert?: string;
  tlsKey?: string;
}

const LOCALHOST_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);
const SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * Owns the Express app and HTTP(S) server lifecycle, the session map, and
 * the shared MCP state. Exposes `start()`/`stop()`/`restart()` for the tray
 * plus `broadcastToolToggle()` and `setAuthToken()` so the tray can mutate
 * live sessions without tearing them down unnecessarily.
 */
export class HttpController {
  private readonly opts: HttpControllerOptions;
  private readonly sessions = new Map<string, SessionEntry>();
  private server: Server | HttpsServer | null = null;
  private ttlTimer: NodeJS.Timeout | null = null;
  private authToken: string | null;
  private starting: Promise<void> | null = null;

  constructor(opts: HttpControllerOptions) {
    this.opts = opts;
    this.authToken = opts.authToken;

    // Automatically fan out tool toggles to every live session. If the caller
    // already wired `onToolsChanged`, leave it alone.
    if (!opts.security.onToolsChanged) {
      opts.security.onToolsChanged = (tool, enabled) => {
        this.broadcastToolToggle(tool, enabled);
      };
    }
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  url(): string {
    const proto = this.opts.tlsCert && this.opts.tlsKey ? "https" : "http";
    return `${proto}://${this.opts.host}:${this.opts.port}/mcp`;
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  getAuthToken(): string | null {
    return this.authToken;
  }

  /**
   * Rotate the bearer token. Existing sessions remain live but will fail
   * their next request (401). They reconnect with the new token.
   */
  setAuthToken(token: string | null): void {
    this.authToken = token;
  }

  /**
   * Generate a fresh random bearer token and install it. Returns the new token.
   */
  regenerateAuthToken(): string {
    const token = crypto.randomBytes(32).toString("base64url");
    this.setAuthToken(token);
    return token;
  }

  /**
   * Iterate every active session and flip the named tool on/off, which
   * causes the MCP SDK to broadcast `tools/list_changed` to each client.
   */
  broadcastToolToggle(tool: ToolName, enabled: boolean): void {
    for (const session of this.sessions.values()) {
      const handle = session.registeredTools.get(tool);
      if (!handle) continue;
      if (enabled) handle.enable();
      else handle.disable();
    }
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (this.starting) return this.starting;
    this.starting = this.bind().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private bind(): Promise<void> {
    const app = express();
    const { host, corsOrigin } = this.opts;

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

    // Bearer token check reads `this.authToken` on every request so the tray
    // can rotate it without rebuilding middleware.
    app.use((req, res, next) => {
      const token = this.authToken;
      if (!token) {
        next();
        return;
      }
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

    app.use(express.json());

    app.post("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && this.sessions.has(sessionId)) {
        const session = this.sessions.get(sessionId)!;
        session.lastAccessed = Date.now();
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      if (sessionId && !this.sessions.has(sessionId)) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      if (this.opts.maxSessions !== undefined && this.sessions.size >= this.opts.maxSessions) {
        res.status(503).json({ error: "Too many sessions" });
        return;
      }

      const created = createServer(this.opts.cwd, this.opts.security, this.opts.serverOpts);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          this.sessions.set(id, {
            server: created.server,
            registry: created.registry,
            runtime: created.runtime,
            registeredTools: created.registeredTools,
            transport,
            lastAccessed: Date.now(),
          });
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          this.destroySession(transport.sessionId);
        }
      };

      await created.server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    app.get("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !this.sessions.has(sessionId)) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const session = this.sessions.get(sessionId)!;
      session.lastAccessed = Date.now();
      await session.transport.handleRequest(req, res);
    });

    app.delete("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !this.sessions.has(sessionId)) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const session = this.sessions.get(sessionId)!;
      session.lastAccessed = Date.now();
      await session.transport.handleRequest(req, res);
      this.destroySession(sessionId);
    });

    const useTls = Boolean(this.opts.tlsCert && this.opts.tlsKey);

    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      if (useTls) {
        const cert = readFileSync(this.opts.tlsCert!);
        const key = readFileSync(this.opts.tlsKey!);
        this.server = https
          .createServer({ cert, key }, app)
          .once("error", onError)
          .listen(this.opts.port, this.opts.host, () => {
            this.server?.off("error", onError);
            this.installTtlSweeper();
            resolve();
          });
      } else {
        this.server = app
          .listen(this.opts.port, this.opts.host, () => {
            this.server?.off("error", onError);
            this.installTtlSweeper();
            resolve();
          })
          .once("error", onError);
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    if (this.ttlTimer) {
      clearInterval(this.ttlTimer);
      this.ttlTimer = null;
    }
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    await this.destroyAllSessions();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  private installTtlSweeper(): void {
    this.ttlTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.sessions) {
        if (now - session.lastAccessed > SESSION_TTL_MS) {
          this.destroySession(id);
        }
      }
    }, 60_000);
    this.ttlTimer.unref();
  }

  private destroySession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    if (session.runtime) session.runtime.dispose();
    session.registry.killAll().then(() => session.registry.dispose());
    session.transport.close?.();
  }

  private async destroyAllSessions(): Promise<void> {
    const ids = [...this.sessions.keys()];
    const promises = ids.map((id) => {
      const session = this.sessions.get(id)!;
      this.sessions.delete(id);
      if (session.runtime) session.runtime.dispose();
      return session.registry.killAll().then(() => {
        session.registry.dispose();
        session.transport.close?.();
      });
    });
    await Promise.all(promises);
  }
}
