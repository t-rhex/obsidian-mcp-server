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
  type: z.enum(["code", "research", "writing", "maintenance", "other"]).optional().describe(
    "New task type.",
  ),
  assignee: z.string().optional().describe(
    "Update the assignee. Set to empty string to unassign.",
  ),
  log_entry: z.string().optional().describe(
    "Append a progress update to the Agent Log section. Timestamped automatically.",
  ),
  scope: z.array(z.string()).optional().describe(
    "Update the scope (file paths this task can modify).",
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

      // Cannot update terminal tasks (except to append logs)
      if (
        ["completed", "failed", "cancelled"].includes(task.status) &&
        (input.status || input.priority || input.type || input.assignee !== undefined)
      ) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "TASK_TERMINAL",
              message: `Task "${task.title}" is ${task.status}. Only log entries can be appended to terminal tasks.`,
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
      updatedFm.updated = todayDate();

      if (input.status) updatedFm.status = input.status;
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
      await refreshDashboard(vault, tasksFolder);

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
    case "failed":
    case "cancelled":
      return []; // Terminal states — no transitions
    default:
      return [];
  }
}

/**
 * Append a timestamped entry to the Agent Log section of a task note.
 * If no Agent Log section exists, one is created at the end.
 */
function appendToAgentLog(content: string, logEntry: string): string {
  const timestamp = new Date().toISOString().replace("T", " ").split(".")[0];
  const entry = `\n- **[${timestamp}]** ${logEntry}`;

  // Find the Agent Log section
  const agentLogRegex = /^## Agent Log\s*$/m;
  const match = agentLogRegex.exec(content);

  if (match) {
    // Find the next ## heading or end of content
    const afterLog = content.substring(match.index + match[0].length);
    const nextHeading = afterLog.search(/^## /m);

    if (nextHeading !== -1) {
      // Insert before the next heading
      const insertAt = match.index + match[0].length + nextHeading;
      return (
        content.substring(0, insertAt).trimEnd() +
        "\n" + entry + "\n\n" +
        content.substring(insertAt)
      );
    } else {
      // Append at end of content
      return content.trimEnd() + "\n" + entry + "\n";
    }
  } else {
    // No Agent Log section — create one at the end
    return (
      content.trimEnd() +
      "\n\n## Agent Log\n" +
      entry + "\n"
    );
  }
}
