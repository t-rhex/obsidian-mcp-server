/**
 * review_task tool — Human-in-the-loop approval gate for tasks.
 *
 * Allows a human reviewer to approve, reject, or request changes on
 * tasks that are in `needs_review` status. This enables approval gates
 * before agent work is considered complete.
 *
 * Actions:
 * - "approve"          → marks the task as completed, unblocks dependents
 * - "reject"           → marks the task as revision_requested with feedback
 * - "request_changes"  → marks the task as revision_requested with feedback
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { Config } from "../config.js";
import { parseNote, serializeNote } from "../frontmatter.js";
import { safeToolHandler } from "../errors.js";
import {
  parseTaskFrontmatter,
  nowISO,
  appendRawToAgentLog,
} from "../task-schema.js";
import { refreshDashboard, scanTasks } from "../task-dashboard.js";

export const reviewTaskSchema = {
  task_id: z.string().describe(
    "The task ID to review (e.g. 'task-2026-03-09-abc123').",
  ),
  action: z.enum(["approve", "reject", "request_changes"]).describe(
    "Review action: 'approve' to complete the task, 'reject' or 'request_changes' to send it back for revision.",
  ),
  feedback: z.string().optional().describe(
    "Reviewer feedback. Required for 'reject' and 'request_changes' actions.",
  ),
  reviewer: z.string().optional().describe(
    "Who is performing the review (e.g. 'human', 'lead-dev').",
  ),
};

export const reviewTaskHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: {
      task_id: string;
      action: "approve" | "reject" | "request_changes";
      feedback?: string;
      reviewer?: string;
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

      // Task must be in needs_review status
      if (task.status !== "needs_review") {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "TASK_NOT_IN_REVIEW",
              message: `Task "${task.title}" is in "${task.status}" status, not "needs_review". Only tasks awaiting review can be reviewed.`,
              task_id: task.id,
              current_status: task.status,
            }),
          }],
          isError: true,
        };
      }

      // Read and parse the note
      const raw = await vault.readNote(entry.path);
      const parsed = parseNote(raw);
      const now = nowISO();
      const timestamp = new Date().toISOString().replace("T", " ").split(".")[0];

      if (input.action === "approve") {
        // ─── Approve: complete the task ──────────────────────────────

        const updatedFm: Record<string, unknown> = {
          ...parsed.frontmatter,
          status: "completed",
          updated: now,
          completed_at: now,
        };
        if (input.reviewer) {
          updatedFm.reviewer = input.reviewer;
        }

        // Strip undefined values before serializing
        for (const key of Object.keys(updatedFm)) {
          if (updatedFm[key] === undefined) delete updatedFm[key];
        }

        // Build Agent Log entry
        let logEntry = `\n- **[${timestamp}] [APPROVED]**`;
        if (input.reviewer) {
          logEntry += ` by ${input.reviewer}`;
        }
        if (input.feedback) {
          logEntry += ` — ${input.feedback}`;
        }

        let updatedContent = appendRawToAgentLog(parsed.content, logEntry);

        const newContent = serializeNote(updatedFm, updatedContent);
        await vault.writeNote(entry.path, newContent, { overwrite: true });

        // Unblock dependent tasks (same logic as complete-task.ts)
        const unblockedTasks: string[] = [];
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
                // Best effort — don't fail the review
                console.error(`Failed to unblock task ${other.task.id}`);
              }
            }
          }
        }

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
              action: "approve",
              status: "completed",
              completed_at: now,
              reviewer: input.reviewer,
              unblocked_tasks: unblockedTasks,
              path: entry.path,
              message: `Task "${task.title}" approved and completed. ${unblockedTasks.length > 0 ? `Unblocked: ${unblockedTasks.join(", ")}` : ""}`.trim(),
            }, null, 2),
          }],
        };
      } else {
        // ─── Reject or Request Changes ──────────────────────────────

        // Feedback is required for reject/request_changes
        if (!input.feedback) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "FEEDBACK_REQUIRED",
                message: `Feedback is required when action is "${input.action}". Explain what needs to change.`,
                task_id: task.id,
                action: input.action,
              }),
            }],
            isError: true,
          };
        }

        const prevReviewCount = typeof parsed.frontmatter.review_count === "number"
          ? parsed.frontmatter.review_count
          : 0;

        const updatedFm: Record<string, unknown> = {
          ...parsed.frontmatter,
          status: "revision_requested",
          updated: now,
          feedback: input.feedback,
          review_count: prevReviewCount + 1,
        };
        if (input.reviewer) {
          updatedFm.reviewer = input.reviewer;
        }

        // Strip undefined values before serializing
        for (const key of Object.keys(updatedFm)) {
          if (updatedFm[key] === undefined) delete updatedFm[key];
        }

        // Build Agent Log entry
        const label = input.action === "reject" ? "REJECTED" : "REVISION REQUESTED";
        let logEntry = `\n- **[${timestamp}] [${label}]**`;
        if (input.reviewer) {
          logEntry += ` by ${input.reviewer}`;
        }
        logEntry += ` — ${input.feedback}`;

        let updatedContent = appendRawToAgentLog(parsed.content, logEntry);

        const newContent = serializeNote(updatedFm, updatedContent);
        await vault.writeNote(entry.path, newContent, { overwrite: true });

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
              action: input.action,
              status: "revision_requested",
              feedback: input.feedback,
              review_count: prevReviewCount + 1,
              reviewer: input.reviewer,
              path: entry.path,
              message: `Task "${task.title}" — ${label.toLowerCase()}. Feedback: ${input.feedback}`,
            }, null, 2),
          }],
        };
      }
    },
  );
