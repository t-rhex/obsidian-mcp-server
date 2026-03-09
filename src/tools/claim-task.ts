/**
 * claim_task tool — Atomically claim a pending task for an agent.
 *
 * Sets the task status to "claimed" and records the assignee.
 * Fails if the task is already claimed, in progress, or in a terminal state.
 * This prevents two agents from claiming the same task.
 *
 * After claiming, the agent should:
 * 1. Read the task note and all linked context_notes
 * 2. Call update_task to set status to "in_progress"
 * 3. Do the work
 * 4. Call complete_task when done
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { Config } from "../config.js";
import { parseNote, serializeNote } from "../frontmatter.js";
import { safeToolHandler } from "../errors.js";
import {
  parseTaskFrontmatter,
  nowISO,
} from "../task-schema.js";
import { refreshDashboard, scanTasks } from "../task-dashboard.js";

export const claimTaskSchema = {
  task_id: z.string().describe(
    "The task ID to claim (e.g. 'task-2026-03-09-abc123').",
  ),
  assignee: z.string().describe(
    "Identifier for the agent claiming this task (e.g. 'claude-code-1', 'agent-research').",
  ),
};

export const claimTaskHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: { task_id: string; assignee: string }) => {
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

      // Check if claimable
      const { task } = entry;
      if (task.status === "claimed" || task.status === "in_progress") {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "TASK_ALREADY_CLAIMED",
              message: `Task "${task.title}" is already ${task.status} by ${task.assignee || "unknown"}`,
              task_id: task.id,
              current_status: task.status,
              current_assignee: task.assignee,
            }),
          }],
          isError: true,
        };
      }

      if (["completed", "failed", "cancelled"].includes(task.status)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "TASK_TERMINAL",
              message: `Task "${task.title}" is already ${task.status} and cannot be claimed.`,
              task_id: task.id,
              current_status: task.status,
            }),
          }],
          isError: true,
        };
      }

      // Check dependencies — if blocked, verify deps are completed
      if (task.depends_on.length > 0) {
        const unfinished = task.depends_on.filter((depId) => {
          const dep = allTasks.find((t) => t.task.id === depId);
          return !dep || dep.task.status !== "completed";
        });
        if (unfinished.length > 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "TASK_BLOCKED",
                message: `Task "${task.title}" is blocked by unfinished dependencies: ${unfinished.join(", ")}`,
                task_id: task.id,
                blocked_by: unfinished,
              }),
            }],
            isError: true,
          };
        }
      }

      // Claim the task — update frontmatter
      const raw = await vault.readNote(entry.path);
      const parsed = parseNote(raw);

      const now = nowISO();
      const updatedFm = {
        ...parsed.frontmatter,
        status: "claimed",
        assignee: input.assignee,
        claimed_at: now,
        updated: now,
      };

      const newContent = serializeNote(updatedFm, parsed.content);
      await vault.writeNote(entry.path, newContent, { overwrite: true });

      // Refresh dashboard (re-scan since we mutated a task)
      const dashOk = await refreshDashboard(vault, tasksFolder);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            dashboard_refreshed: dashOk,
            task_id: task.id,
            title: task.title,
            assignee: input.assignee,
            status: "claimed",
            claimed_at: updatedFm.claimed_at,
            path: entry.path,
            context_notes: task.context_notes,
            scope: task.scope,
            timeout_minutes: task.timeout_minutes,
            message: `Task "${task.title}" claimed by ${input.assignee}. Read the task note and context_notes to begin work.`,
          }, null, 2),
        }],
      };
    },
  );
