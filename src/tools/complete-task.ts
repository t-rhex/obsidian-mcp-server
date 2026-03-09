/**
 * complete_task tool — Mark a task as completed with deliverables.
 *
 * This is the preferred way to finish a task. It:
 * - Sets status to "completed"
 * - Records completed_at timestamp
 * - Optionally links deliverables (file paths, URLs, etc.)
 * - Appends a completion entry to the Agent Log
 * - Unblocks dependent tasks (sets them from "blocked" to "pending")
 * - Refreshes the dashboard
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
  appendRawToAgentLog,
  addDeliverables,
  TaskStatus,
} from "../task-schema.js";
import { refreshDashboard, scanTasks } from "../task-dashboard.js";

export const completeTaskSchema = {
  task_id: z.string().describe(
    "The task ID to complete (e.g. 'task-2026-03-09-abc123').",
  ),
  summary: z.string().describe(
    "Summary of what was accomplished. Appended to the Agent Log.",
  ),
  deliverables: z.array(z.string()).optional().describe(
    "Paths to files created/modified, or URLs to PRs, docs, etc. Added to a Deliverables section.",
  ),
  status: z.enum(["completed", "failed", "cancelled"]).optional().default("completed").describe(
    "Terminal status. Usually 'completed', but use 'failed' or 'cancelled' if the task couldn't be done.",
  ),
  error_reason: z.string().optional().describe(
    "If status is 'failed', explain what went wrong. Helps future agents retry.",
  ),
};

export const completeTaskHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: {
      task_id: string;
      summary: string;
      deliverables?: string[];
      status?: "completed" | "failed" | "cancelled";
      error_reason?: string;
    }) => {
      const tasksFolder = config.tasksFolder;
      const finalStatus = input.status ?? "completed";

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

      // Only active tasks can be completed
      if (["completed", "failed", "cancelled"].includes(task.status)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "TASK_ALREADY_TERMINAL",
              message: `Task "${task.title}" is already ${task.status}. Cannot complete again.`,
              task_id: task.id,
              current_status: task.status,
            }),
          }],
          isError: true,
        };
      }

      // Read and update the note
      const raw = await vault.readNote(entry.path);
      const parsed = parseNote(raw);
      const now = nowISO();

      // Update frontmatter
      const updatedFm: Record<string, unknown> = {
        ...parsed.frontmatter,
        status: finalStatus,
        updated: now,
        completed_at: now,
      };

      // Build the completion log entry + deliverables
      let updatedContent = parsed.content;
      const timestamp = new Date().toISOString().replace("T", " ").split(".")[0];

      // Append completion entry to Agent Log
      const statusLabel = finalStatus === "completed" ? "COMPLETED" :
                          finalStatus === "failed" ? "FAILED" :
                          "CANCELLED";
      let logEntry = `\n- **[${timestamp}] [${statusLabel}]** ${input.summary}`;
      if (input.error_reason && finalStatus === "failed") {
        logEntry += `\n  - Error: ${input.error_reason}`;
      }

      updatedContent = appendRawToAgentLog(updatedContent, logEntry);

      // Add deliverables section if provided (appends to existing)
      if (input.deliverables && input.deliverables.length > 0) {
        updatedContent = addDeliverables(updatedContent, input.deliverables);
      }

      const newContent = serializeNote(updatedFm, updatedContent);
      await vault.writeNote(entry.path, newContent, { overwrite: true });

      // Unblock dependent tasks — only when this task is completed (not failed/cancelled)
      const unblockedTasks: string[] = [];
      if (finalStatus === "completed") {
      for (const other of allTasks) {
        if (
          other.task.status === "blocked" &&
          other.task.depends_on.includes(task.id)
        ) {
          // Check if ALL dependencies are now completed
          const allDepsCompleted = other.task.depends_on.every((depId) => {
            if (depId === task.id) return true; // This task is now completed
            const dep = allTasks.find((t) => t.task.id === depId);
            return dep && dep.task.status === "completed";
          });

          if (allDepsCompleted) {
            // Unblock this task
            try {
              const depRaw = await vault.readNote(other.path);
              const depParsed = parseNote(depRaw);
              const depFm: Record<string, unknown> = {
                ...depParsed.frontmatter,
                status: "pending",
                updated: now,
              };
              const depContent = serializeNote(depFm, depParsed.content);
              await vault.writeNote(other.path, depContent, { overwrite: true });
              unblockedTasks.push(other.task.id);
            } catch {
              // Best effort — don't fail the completion
              console.error(`Failed to unblock task ${other.task.id}`);
            }
          }
        }
      }
      } // end if (finalStatus === "completed")

      // Refresh dashboard
      const dashOk = await refreshDashboard(vault, tasksFolder);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            dashboard_refreshed: dashOk,
            task_id: task.id,
            title: task.title,
            status: finalStatus,
            completed_at: now,
            deliverables: input.deliverables ?? [],
            unblocked_tasks: unblockedTasks,
            path: entry.path,
            message: `Task "${task.title}" ${finalStatus}. ${unblockedTasks.length > 0 ? `Unblocked: ${unblockedTasks.join(", ")}` : ""}`.trim(),
          }, null, 2),
        }],
      };
    },
  );

// appendRawToAgentLog and addDeliverables are imported from task-schema.ts
