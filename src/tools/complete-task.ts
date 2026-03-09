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
      const now = todayDate();

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
      const statusEmoji = finalStatus === "completed" ? "COMPLETED" :
                          finalStatus === "failed" ? "FAILED" :
                          "CANCELLED";
      let logEntry = `\n- **[${timestamp}] [${statusEmoji}]** ${input.summary}`;
      if (input.error_reason && finalStatus === "failed") {
        logEntry += `\n  - Error: ${input.error_reason}`;
      }

      updatedContent = appendToAgentLog(updatedContent, logEntry);

      // Add deliverables section if provided
      if (input.deliverables && input.deliverables.length > 0) {
        updatedContent = addDeliverablesSection(updatedContent, input.deliverables);
      }

      const newContent = serializeNote(updatedFm, updatedContent);
      await vault.writeNote(entry.path, newContent, { overwrite: true });

      // Unblock dependent tasks
      const unblockedTasks: string[] = [];
      for (const other of allTasks) {
        if (
          other.task.status === "blocked" &&
          other.task.depends_on.includes(task.id)
        ) {
          // Check if ALL dependencies are now completed
          const allDepsCompleted = other.task.depends_on.every((depId) => {
            if (depId === task.id) return true; // This task is now completing
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

      // Refresh dashboard
      await refreshDashboard(vault, tasksFolder);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
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

/**
 * Append an entry to the Agent Log section.
 * If no Agent Log section exists, one is created at the end.
 */
function appendToAgentLog(content: string, entry: string): string {
  const agentLogRegex = /^## Agent Log\s*$/m;
  const match = agentLogRegex.exec(content);

  if (match) {
    const afterLog = content.substring(match.index + match[0].length);
    const nextHeading = afterLog.search(/^## /m);

    if (nextHeading !== -1) {
      const insertAt = match.index + match[0].length + nextHeading;
      return (
        content.substring(0, insertAt).trimEnd() +
        "\n" + entry + "\n\n" +
        content.substring(insertAt)
      );
    } else {
      return content.trimEnd() + "\n" + entry + "\n";
    }
  } else {
    return content.trimEnd() + "\n\n## Agent Log\n" + entry + "\n";
  }
}

/**
 * Add or update a Deliverables section in the task note.
 */
function addDeliverablesSection(content: string, deliverables: string[]): string {
  const lines = deliverables.map((d) => `- ${d}`).join("\n");
  const section = `\n## Deliverables\n\n${lines}\n`;

  // Check if Deliverables section already exists
  const delivRegex = /^## Deliverables\s*$/m;
  const match = delivRegex.exec(content);

  if (match) {
    // Replace existing section
    const afterSection = content.substring(match.index + match[0].length);
    const nextHeading = afterSection.search(/^## /m);

    if (nextHeading !== -1) {
      return (
        content.substring(0, match.index) +
        `## Deliverables\n\n${lines}\n\n` +
        afterSection.substring(nextHeading)
      );
    } else {
      return content.substring(0, match.index) + `## Deliverables\n\n${lines}\n`;
    }
  } else {
    // Add before Agent Log if it exists, otherwise at end
    const agentLogRegex = /^## Agent Log\s*$/m;
    const logMatch = agentLogRegex.exec(content);
    if (logMatch) {
      return (
        content.substring(0, logMatch.index) +
        `## Deliverables\n\n${lines}\n\n` +
        content.substring(logMatch.index)
      );
    }
    return content.trimEnd() + section;
  }
}
