/**
 * Event system — typed event bus for vault mutations.
 *
 * Every task/project/context mutation emits a typed event.
 * Consumers:
 *   1. MCP logging notifications (in-session, via sendLoggingMessage)
 *   2. Outbound HTTP webhooks (optional, fire-and-forget)
 *   3. Internal listeners (auto-sync, future extensions)
 */

import { EventEmitter } from "node:events";

// ─── Event Types ────────────────────────────────────────────────────

export interface VaultEvent {
  event: string;
  timestamp: string;
  task_id?: string;
  project_id?: string;
  title?: string;
  status?: string;
  assignee?: string;
  summary?: string;
  unblocked?: string[];
  metadata?: Record<string, unknown>;
}

export type VaultEventType =
  | "task.created"
  | "task.claimed"
  | "task.updated"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.unblocked"
  | "task.retried"
  | "task.escalated"
  | "task.timed_out"
  | "task.review_requested"
  | "task.review_completed"
  | "task.routed"
  | "project.created"
  | "project.appended"
  | "project.completed"
  | "decision.logged"
  | "discovery.logged"
  | "agent.registered"
  | "agent.updated"
  | "note.written"
  | "note.deleted";

// ─── EventBus ───────────────────────────────────────────────────────

export class EventBus extends EventEmitter {
  /**
   * Emit a typed vault event.
   */
  emitEvent(event: VaultEventType, data: Omit<VaultEvent, "event" | "timestamp">): void {
    const payload: VaultEvent = {
      event,
      timestamp: new Date().toISOString(),
      ...data,
    };
    this.emit("vault_event", payload);
    this.emit(event, payload);
  }

  /**
   * Listen for all vault events.
   */
  onEvent(handler: (event: VaultEvent) => void): void {
    this.on("vault_event", handler);
  }

  /**
   * Listen for a specific event type.
   */
  onEventType(type: VaultEventType, handler: (event: VaultEvent) => void): void {
    this.on(type, handler);
  }
}
