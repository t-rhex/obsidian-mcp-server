/**
 * update_task tool — Update a task's status, priority, or append to the agent log.
 *
 * Agents use this to:
 * - Move a task from "claimed" to "in_progress"
 * - Append progress updates to the Agent Log section
 * - Change priority or type if they discover new information
 * - Set a task to "failed" or "blocked" if something goes wrong
 *
 * For marking a task as completed with deliverables, use complete_task instead.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { Config } from "../config.js";
import { parseNote, serializeNote } from "../frontmatter.js";
import { safeToolHandler } from "../errors.js";
import {
  parseTaskFrontmatter,
  todayDate,
  nowISO,
  appendToAgentLog,
  VALID_STATUSES,
  VALID_PRIORITIES,
  VALID_TYPES,
  TaskStatus,
  TaskPriority,
  TaskType,
} from "../task-schema.js";
import { refreshDashboard, scanTasks } from "../task-dashboard.js";

export const updateTaskSchema = {
  task_id: z.string().describe(
    "The task ID to update (e.g. 'task-2026-03-09-abc123').",
  ),
  status: z.enum([
    "pending", "claimed", "in_progress", "completed", "failed", "blocked", "cancelled",
  ]).optional().describe(
    "New status for the task. Use complete_task for marking tasks as completed with deliverables.",
  ),
  priority: z.enum(["critical", "high", "medium", "low"]).optional().describe(
    "New priority for the task.",
  ),
  type: z.enum(["code", "research", "writing", "maintenance", "project", "other"]).optional().describe(
    "New task type.",
  ),
  assignee: z.string().optional().describe(
    "Update the assignee. Set to empty string to unassign.",
  ),
  log_entry: z.string().optional().describe(
    "Append a progress update to the Agent Log section. Timestamped automatically.",
  ),
  scope: z.array(z.string()).optional().describe(
    "Update the advisory scope (file paths this task intends to modify).",
  ),
  depends_on: z.array(z.string()).optional().describe(
    "Update the dependency list.",
  ),
};

export const updateTaskHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: {
      task_id: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      type?: TaskType;
      assignee?: string;
      log_entry?: string;
      scope?: string[];
      depends_on?: string[];
    }) => {
      const tasksFolder = config.tasksFolder;

      // Find the task file by ID
      const allTasks = await scanTasks(vault, tasksFolder);
      const entry = allTasks.find((t) => t.task.id === input.task_id);

      if (!entry) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "TASK_NOT_FOUND",
              message: `No task found with ID: ${input.task_id}`,
            }),
          }],
          isError: true,
        };
      }

      const { task } = entry;

      // Terminal tasks can only be retried (-> pending) or have logs appended.
      // Other field changes (priority, type, assignee) are blocked on terminal tasks.
      if (
        ["completed", "failed", "cancelled"].includes(task.status) &&
        (input.priority || input.type || input.assignee !== undefined) &&
        input.status !== "pending"
      ) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "TASK_TERMINAL",
              message: `Task "${task.title}" is ${task.status}. Use status: "pending" to retry, or append log entries only.`,
              task_id: task.id,
              current_status: task.status,
            }),
          }],
          isError: true,
        };
      }

      // Validate status transition
      if (input.status) {
        const valid = getValidTransitions(task.status);
        if (!valid.includes(input.status)) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "INVALID_TRANSITION",
                message: `Cannot transition from "${task.status}" to "${input.status}". Valid transitions: ${valid.join(", ")}`,
                task_id: task.id,
                current_status: task.status,
                requested_status: input.status,
                valid_transitions: valid,
              }),
            }],
            isError: true,
          };
        }
      }

      // Read and update the note
      const raw = await vault.readNote(entry.path);
      const parsed = parseNote(raw);

      // Update frontmatter fields
      const updatedFm: Record<string, unknown> = { ...parsed.frontmatter };
      updatedFm.updated = nowISO();

      if (input.status) {
        updatedFm.status = input.status;

        // Retry/reopen: reset assignee, clear completed_at, increment retry_count
        if (
          input.status === "pending" &&
          ["completed", "failed", "cancelled"].includes(task.status)
        ) {
          updatedFm.assignee = "";
          delete updatedFm.completed_at;
          const prevRetries = typeof updatedFm.retry_count === "number" ? updatedFm.retry_count : 0;
          updatedFm.retry_count = prevRetries + 1;
        }
      }
      if (input.priority) updatedFm.priority = input.priority;
      if (input.type) updatedFm.type = input.type;
      if (input.assignee !== undefined) updatedFm.assignee = input.assignee;
      if (input.scope) updatedFm.scope = input.scope;
      if (input.depends_on) updatedFm.depends_on = input.depends_on;

      // Append to agent log if provided
      let updatedContent = parsed.content;
      if (input.log_entry) {
        updatedContent = appendToAgentLog(updatedContent, input.log_entry);
      }

      const newContent = serializeNote(updatedFm, updatedContent);
      await vault.writeNote(entry.path, newContent, { overwrite: true });

      // Refresh dashboard
      const dashOk = await refreshDashboard(vault, tasksFolder);

      // Build list of changes for the response
      const changes: string[] = [];
      if (input.status) changes.push(`status: ${task.status} -> ${input.status}`);
      if (input.priority) changes.push(`priority: ${task.priority} -> ${input.priority}`);
      if (input.type) changes.push(`type: ${task.type} -> ${input.type}`);
      if (input.assignee !== undefined) changes.push(`assignee: ${task.assignee || "(none)"} -> ${input.assignee || "(none)"}`);
      if (input.scope) changes.push(`scope updated`);
      if (input.depends_on) changes.push(`depends_on updated`);
      if (input.log_entry) changes.push(`log entry appended`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            dashboard_refreshed: dashOk,
            task_id: task.id,
            title: task.title,
            changes,
            current_status: input.status ?? task.status,
            path: entry.path,
            message: `Task "${task.title}" updated: ${changes.join(", ")}`,
          }, null, 2),
        }],
      };
    },
  );

/**
 * Valid status transitions. Prevents nonsensical state changes.
 *
 * Terminal states (failed, cancelled) allow transition back to "pending"
 * for retry. Completed tasks can also be reopened to "pending".
 * Claimed tasks can be unclaimed back to "pending" (for reassignment).
 */
function getValidTransitions(current: TaskStatus): TaskStatus[] {
  switch (current) {
    case "pending":
      return ["claimed", "blocked", "cancelled"];
    case "claimed":
      return ["in_progress", "pending", "blocked", "cancelled"];
    case "in_progress":
      return ["completed", "failed", "blocked", "pending", "cancelled"];
    case "blocked":
      return ["pending", "cancelled"];
    case "completed":
      return ["pending"]; // Reopen
    case "failed":
      return ["pending"]; // Retry
    case "cancelled":
      return ["pending"]; // Reactivate
    default:
      return [];
  }
}

// appendToAgentLog is now imported from task-schema.ts
