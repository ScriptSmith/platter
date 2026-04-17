import { EventEmitter } from "node:events";
import type { ToolName } from "../security.js";

export interface InvocationRecord {
  id: number;
  tool: ToolName;
  sessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "ok" | "error";
  errorMessage?: string;
}

export interface ActivityMonitorEvents {
  change: () => void;
}

const RECENT_CAPACITY = 20;

/**
 * In-memory event bus + ring buffer tracking MCP session lifecycle and tool
 * invocations. The tray subscribes to a single `change` event and redraws
 * whatever it needs from the current snapshot. Kept intentionally simple:
 * no persistence, no per-event subscribers, no filtering — the tray owns
 * presentation.
 */
export class ActivityMonitor extends EventEmitter {
  private _sessionCount = 0;
  private _nextId = 1;
  private readonly active = new Map<number, InvocationRecord>();
  private readonly recent: InvocationRecord[] = [];

  get sessionCount(): number {
    return this._sessionCount;
  }

  /** Snapshot of currently-running invocations, oldest first. */
  getActive(): InvocationRecord[] {
    return [...this.active.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Snapshot of recent completed invocations, newest first. */
  getRecent(): InvocationRecord[] {
    return [...this.recent].reverse();
  }

  get activeCount(): number {
    return this.active.size;
  }

  sessionCreated(sessionId: string): void {
    this._sessionCount++;
    this.emit("session-created", sessionId);
    this.emit("change");
  }

  sessionDestroyed(sessionId: string): void {
    if (this._sessionCount > 0) this._sessionCount--;
    this.emit("session-destroyed", sessionId);
    this.emit("change");
  }

  invocationStarted(tool: ToolName, sessionId: string | null): number {
    const id = this._nextId++;
    const record: InvocationRecord = {
      id,
      tool,
      sessionId,
      startedAt: Date.now(),
      endedAt: null,
      status: "running",
    };
    this.active.set(id, record);
    this.emit("invocation-started", record);
    this.emit("change");
    return id;
  }

  invocationEnded(id: number, status: "ok" | "error", errorMessage?: string): void {
    const record = this.active.get(id);
    if (!record) return;
    this.active.delete(id);
    record.endedAt = Date.now();
    record.status = status;
    if (errorMessage) record.errorMessage = errorMessage;
    this.recent.push(record);
    while (this.recent.length > RECENT_CAPACITY) {
      this.recent.shift();
    }
    this.emit("invocation-ended", record);
    this.emit("change");
  }

  /** Reset counters (used on HTTP stop — sessions are all torn down). */
  reset(): void {
    this._sessionCount = 0;
    this.active.clear();
    this.emit("change");
  }
}
