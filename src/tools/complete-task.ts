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
  RoutingRule,
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

      // HITL: If task requires review and agent is trying to complete it,
      // redirect to needs_review instead of completed
      const needsReview = finalStatus === "completed" && (
        task.review_required === true ||
        (task.risk_level === "high" || task.risk_level === "critical")
      );
      const effectiveStatus = needsReview ? "needs_review" : finalStatus;

      // Read and update the note
      const raw = await vault.readNote(entry.path);
      const parsed = parseNote(raw);
      const now = nowISO();

      // Update frontmatter
      const updatedFm: Record<string, unknown> = {
        ...parsed.frontmatter,
        status: effectiveStatus,
        updated: now,
        ...(effectiveStatus === "needs_review" ? {} : { completed_at: now }),
      };

      // Build the completion log entry + deliverables
      let updatedContent = parsed.content;
      const timestamp = new Date().toISOString().replace("T", " ").split(".")[0];

      // Append completion entry to Agent Log
      const statusLabel = effectiveStatus === "needs_review" ? "SUBMITTED FOR REVIEW" :
                          finalStatus === "completed" ? "COMPLETED" :
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

      // Unblock dependent tasks — only when this task is actually completed
      // (not failed/cancelled, and not redirected to needs_review)
      const unblockedTasks: string[] = [];
      const cancelledTasks: string[] = [];

      if (effectiveStatus === "completed") {
        // Check for routing rules on this task
        const routingRules: RoutingRule[] = task.routing_rules ?? [];
        const hasRouting = routingRules.length > 0;
        let routedActivate: Set<string> | null = null;
        let routedDeactivate: Set<string> | null = null;

        if (hasRouting) {
          routedActivate = new Set<string>();
          routedDeactivate = new Set<string>();

          for (const rule of routingRules) {
            let matched = false;
            if (rule.condition === "output_contains") {
              matched = input.summary.toLowerCase().includes(rule.value.toLowerCase());
            } else if (rule.condition === "output_matches") {
              try {
                matched = new RegExp(rule.value, "i").test(input.summary);
              } catch {
                // Invalid regex — skip
              }
            } else if (rule.condition === "status_is") {
              matched = finalStatus === rule.value;
            }

            if (matched) {
              for (const id of rule.activate) routedActivate.add(id);
              if (rule.deactivate) {
                for (const id of rule.deactivate) routedDeactivate.add(id);
              }
            }
          }
        }

        for (const other of allTasks) {
          // Handle routing-based cancellation
          if (routedDeactivate?.has(other.task.id) && other.task.status !== "completed") {
            try {
              const depRaw = await vault.readNote(other.path);
              const depParsed = parseNote(depRaw);
              const depFm: Record<string, unknown> = {
                ...depParsed.frontmatter,
                status: "cancelled",
                updated: now,
              };
              const depContent = serializeNote(depFm, depParsed.content);
              await vault.writeNote(other.path, depContent, { overwrite: true });
              cancelledTasks.push(other.task.id);
            } catch {
              console.error(`Failed to cancel task ${other.task.id}`);
            }
            continue;
          }

          if (
            other.task.status === "blocked" &&
            other.task.depends_on.includes(task.id)
          ) {
            // If routing rules are active, only unblock tasks in the activate set
            if (hasRouting && routedActivate && !routedActivate.has(other.task.id)) {
              continue; // Skip — not activated by routing
            }

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
                console.error(`Failed to unblock task ${other.task.id}`);
              }
            }
          }
        }
      } // end if (effectiveStatus === "completed")

      // Refresh dashboard
      const dashOk = await refreshDashboard(vault, tasksFolder);

      const messageParts = [`Task "${task.title}" ${effectiveStatus}.`];
      if (needsReview) messageParts.push("Sent to review queue (review_required or high risk).");
      if (unblockedTasks.length > 0) messageParts.push(`Unblocked: ${unblockedTasks.join(", ")}`);
      if (cancelledTasks.length > 0) messageParts.push(`Cancelled by routing: ${cancelledTasks.join(", ")}`);
      if (task.worktree_branch && effectiveStatus === "completed") {
        messageParts.push(`Branch \`${task.worktree_branch}\` is ready for PR.`);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            dashboard_refreshed: dashOk,
            task_id: task.id,
            title: task.title,
            status: effectiveStatus,
            review_redirected: needsReview,
            completed_at: effectiveStatus === "needs_review" ? undefined : now,
            deliverables: input.deliverables ?? [],
            unblocked_tasks: unblockedTasks,
            cancelled_tasks: cancelledTasks.length > 0 ? cancelledTasks : undefined,
            worktree_branch: task.worktree_branch ?? null,
            path: entry.path,
            message: messageParts.join(" "),
          }, null, 2),
        }],
      };
    },
  );

// appendRawToAgentLog and addDeliverables are imported from task-schema.ts
