/**
 * list_tasks tool — Query tasks by status, priority, type, or assignee.
 *
 * Returns a filtered, sorted list of tasks from the vault's task queue.
 * Useful for agents to find work, and for humans to monitor progress.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { Config } from "../config.js";
import { safeToolHandler } from "../errors.js";
import { scanTasks } from "../task-dashboard.js";
import {
  PRIORITY_ORDER,
  TaskStatus,
  TaskPriority,
  TaskType,
} from "../task-schema.js";

export const listTasksSchema = {
  status: z.enum([
    "pending", "claimed", "in_progress", "completed", "failed", "blocked", "cancelled", "all",
  ]).optional().default("all").describe(
    "Filter by status. Default: all.",
  ),
  priority: z.enum(["critical", "high", "medium", "low", "all"]).optional().default("all").describe(
    "Filter by priority. Default: all.",
  ),
  type: z.enum(["code", "research", "writing", "maintenance", "project", "other", "all"]).optional().default("all").describe(
    "Filter by task type. Default: all.",
  ),
  assignee: z.string().optional().describe(
    "Filter by assignee. Leave empty to show all.",
  ),
  unassigned_only: z.boolean().optional().default(false).describe(
    "Only show tasks with no assignee (available for claiming).",
  ),
  limit: z.number().optional().default(50).describe(
    "Maximum number of tasks to return. Default: 50.",
  ),
  include_completed: z.boolean().optional().default(false).describe(
    "Include completed/failed/cancelled tasks. Default: false (only active + pending).",
  ),
  project: z.string().optional().describe(
    "Filter by project ID. Only show tasks belonging to this project.",
  ),
  exclude_projects: z.boolean().optional().default(false).describe(
    "Exclude project-type tasks from results (show only actionable sub-tasks). Default: false.",
  ),
};

export const listTasksHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: {
      status?: TaskStatus | "all";
      priority?: TaskPriority | "all";
      type?: TaskType | "all";
      assignee?: string;
      unassigned_only?: boolean;
      limit?: number;
      include_completed?: boolean;
      project?: string;
      exclude_projects?: boolean;
    }) => {
      const tasksFolder = config.tasksFolder;
      const allTasks = await scanTasks(vault, tasksFolder);

      // Apply filters
      let filtered = allTasks;

      if (input.status && input.status !== "all") {
        filtered = filtered.filter((t) => t.task.status === input.status);
      } else if (!input.include_completed) {
        // By default, exclude terminal states
        filtered = filtered.filter(
          (t) => !["completed", "failed", "cancelled"].includes(t.task.status),
        );
      }

      if (input.priority && input.priority !== "all") {
        filtered = filtered.filter((t) => t.task.priority === input.priority);
      }

      if (input.type && input.type !== "all") {
        filtered = filtered.filter((t) => t.task.type === input.type);
      }

      if (input.assignee) {
        filtered = filtered.filter((t) => t.task.assignee === input.assignee);
      }

      if (input.unassigned_only) {
        filtered = filtered.filter((t) => !t.task.assignee);
      }

      if (input.project) {
        filtered = filtered.filter((t) => t.task.project === input.project);
      }

      if (input.exclude_projects) {
        filtered = filtered.filter((t) => t.task.type !== "project");
      }

      // Sort: by priority (critical first), then by created date (oldest first)
      filtered.sort((a, b) => {
        const pa = PRIORITY_ORDER[a.task.priority] ?? 99;
        const pb = PRIORITY_ORDER[b.task.priority] ?? 99;
        if (pa !== pb) return pa - pb;
        return a.task.created.localeCompare(b.task.created);
      });

      // Apply limit
      const limited = filtered.slice(0, input.limit ?? 50);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            total: filtered.length,
            returned: limited.length,
            tasks: limited.map((entry) => {
              // Check if a claimed/in_progress task has exceeded its timeout
              let is_overdue = false;
              if (
                entry.task.claimed_at &&
                (entry.task.status === "claimed" || entry.task.status === "in_progress") &&
                entry.task.timeout_minutes > 0
              ) {
                const claimedAt = new Date(entry.task.claimed_at).getTime();
                const elapsed = (Date.now() - claimedAt) / 60_000;
                is_overdue = elapsed > entry.task.timeout_minutes;
              }

              return {
                id: entry.task.id,
                title: entry.task.title,
                status: entry.task.status,
                priority: entry.task.priority,
                type: entry.task.type,
                assignee: entry.task.assignee || null,
                created: entry.task.created,
                claimed_at: entry.task.claimed_at || null,
                due: entry.task.due || null,
                depends_on: entry.task.depends_on,
                timeout_minutes: entry.task.timeout_minutes,
                is_overdue,
                retry_count: entry.task.retry_count,
                project: entry.task.project || null,
                path: entry.path,
              };
            }),
          }, null, 2),
        }],
      };
    },
  );
