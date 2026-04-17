import { createWriteStream, type WriteStream } from "node:fs";
import { ensureStateDir, rotateLog } from "../config.js";
import type { ActivityMonitor, InvocationRecord } from "./activity-monitor.js";

/**
 * Append-only file logger for session + tool invocation events.
 *
 * On start, rotates platter.log to platter.log.1 and opens a fresh file.
 * Subscribes to the ActivityMonitor's typed events and writes one line per
 * event. Format is human-readable, not JSON — it's meant to be tailed, not
 * parsed, and stays terse enough that busy sessions don't explode the file.
 */
export class ActivityLog {
  private readonly stream: WriteStream;
  private readonly activity: ActivityMonitor;
  private readonly onSessionCreated: (id: string) => void;
  private readonly onSessionDestroyed: (id: string) => void;
  private readonly onInvocationStarted: (r: InvocationRecord) => void;
  private readonly onInvocationEnded: (r: InvocationRecord) => void;

  constructor(activity: ActivityMonitor) {
    ensureStateDir();
    const path = rotateLog();
    this.stream = createWriteStream(path, { flags: "a", mode: 0o600 });
    this.activity = activity;

    this.write("log-opened", { path });

    this.onSessionCreated = (id) => this.write("session-created", { id: short(id) });
    this.onSessionDestroyed = (id) => this.write("session-destroyed", { id: short(id) });
    this.onInvocationStarted = (r) => this.write("tool-call", { tool: r.tool, session: short(r.sessionId), id: r.id });
    this.onInvocationEnded = (r) => {
      const duration = r.endedAt ? r.endedAt - r.startedAt : 0;
      const fields: Record<string, unknown> = {
        tool: r.tool,
        session: short(r.sessionId),
        id: r.id,
        status: r.status,
        duration_ms: duration,
      };
      if (r.errorMessage) fields.error = truncate(r.errorMessage, 200);
      this.write("tool-done", fields);
    };

    activity.on("session-created", this.onSessionCreated);
    activity.on("session-destroyed", this.onSessionDestroyed);
    activity.on("invocation-started", this.onInvocationStarted);
    activity.on("invocation-ended", this.onInvocationEnded);
  }

  dispose(): void {
    this.activity.off("session-created", this.onSessionCreated);
    this.activity.off("session-destroyed", this.onSessionDestroyed);
    this.activity.off("invocation-started", this.onInvocationStarted);
    this.activity.off("invocation-ended", this.onInvocationEnded);
    this.write("log-closed", {});
    this.stream.end();
  }

  private write(event: string, fields: Record<string, unknown>): void {
    const parts: string[] = [new Date().toISOString(), event.padEnd(18)];
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === undefined) continue;
      parts.push(`${k}=${formatValue(v)}`);
    }
    this.stream.write(`${parts.join(" ")}\n`);
  }
}

function short(id: string | null): string {
  if (!id) return "-";
  return id.length > 8 ? id.slice(0, 8) : id;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function formatValue(v: unknown): string {
  if (typeof v === "string") {
    // Quote strings with spaces or special chars so the log stays greppable.
    return /[\s"=]/.test(v) ? JSON.stringify(v) : v;
  }
  return String(v);
}
