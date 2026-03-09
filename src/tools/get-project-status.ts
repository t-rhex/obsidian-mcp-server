/**
 * get_project_status tool — Get rollup status of a project and all its sub-tasks.
 *
 * Shows:
 * - Overall progress (e.g. "3/7 tasks completed")
 * - Status breakdown (pending, in_progress, blocked, completed, failed)
 * - List of all sub-tasks with their current state
 * - Blockers and overdue tasks
 * - Active agents (who's working on what)
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { Config } from "../config.js";
import { safeToolHandler } from "../errors.js";
import { scanTasks } from "../task-dashboard.js";
import { PRIORITY_ORDER } from "../task-schema.js";

export const getProjectStatusSchema = {
  project_id: z.string().describe(
    "The project ID (e.g. 'proj-2026-03-09-abc123'). " +
    "Use list_tasks(type: 'project') to find project IDs.",
  ),
};

export const getProjectStatusHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: { project_id: string }) => {
      const tasksFolder = config.tasksFolder;
      const allTasks = await scanTasks(vault, tasksFolder);

      // Find the project note
      const projectEntry = allTasks.find(
        (t) => t.task.id === input.project_id && t.task.type === "project",
      );

      if (!projectEntry) {
        // Maybe it's an ID but not type=project, or doesn't exist
        const anyMatch = allTasks.find((t) => t.task.id === input.project_id);
        if (anyMatch) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "NOT_A_PROJECT",
                message: `Task "${anyMatch.task.title}" (${input.project_id}) is type "${anyMatch.task.type}", not a project. Use list_tasks(type: "project") to find projects.`,
              }),
            }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "PROJECT_NOT_FOUND",
              message: `No project found with ID: ${input.project_id}`,
            }),
          }],
          isError: true,
        };
      }

      // Find all sub-tasks belonging to this project
      const subTasks = allTasks.filter(
        (t) => t.task.project === input.project_id && t.task.id !== input.project_id,
      );

      // Sort by priority then created
      subTasks.sort((a, b) => {
        const pa = PRIORITY_ORDER[a.task.priority] ?? 99;
        const pb = PRIORITY_ORDER[b.task.priority] ?? 99;
        if (pa !== pb) return pa - pb;
        return a.task.created.localeCompare(b.task.created);
      });

      // Status counts
      const counts: Record<string, number> = {};
      for (const t of subTasks) {
        counts[t.task.status] = (counts[t.task.status] ?? 0) + 1;
      }

      const total = subTasks.length;
      const completed = counts.completed ?? 0;
      const failed = counts.failed ?? 0;
      const cancelled = counts.cancelled ?? 0;
      const inProgress = counts.in_progress ?? 0;
      const claimed = counts.claimed ?? 0;
      const pending = counts.pending ?? 0;
      const blocked = counts.blocked ?? 0;

      // Progress percentage
      const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

      // Is the project done? (all tasks in terminal state)
      const allDone = total > 0 && subTasks.every(
        (t) => ["completed", "failed", "cancelled"].includes(t.task.status),
      );

      // Active agents
      const activeAgents: Array<{ agent: string; task_id: string; task_title: string; status: string }> = [];
      for (const t of subTasks) {
        if (t.task.assignee && ["claimed", "in_progress"].includes(t.task.status)) {
          activeAgents.push({
            agent: t.task.assignee,
            task_id: t.task.id,
            task_title: t.task.title,
            status: t.task.status,
          });
        }
      }

      // Overdue tasks
      const overdueTasks: Array<{ task_id: string; title: string; claimed_at: string; timeout_minutes: number }> = [];
      for (const t of subTasks) {
        if (
          t.task.claimed_at &&
          ["claimed", "in_progress"].includes(t.task.status) &&
          t.task.timeout_minutes > 0
        ) {
          const claimedAt = new Date(t.task.claimed_at).getTime();
          const elapsed = (Date.now() - claimedAt) / 60_000;
          if (elapsed > t.task.timeout_minutes) {
            overdueTasks.push({
              task_id: t.task.id,
              title: t.task.title,
              claimed_at: t.task.claimed_at,
              timeout_minutes: t.task.timeout_minutes,
            });
          }
        }
      }

      // Blockers — blocked tasks with their blocking dependencies
      const blockers: Array<{ task_id: string; title: string; waiting_on: string[] }> = [];
      for (const t of subTasks) {
        if (t.task.status === "blocked") {
          const waitingOn = t.task.depends_on.filter((depId) => {
            const dep = allTasks.find((d) => d.task.id === depId);
            return !dep || dep.task.status !== "completed";
          });
          blockers.push({
            task_id: t.task.id,
            title: t.task.title,
            waiting_on: waitingOn,
          });
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            project: {
              id: projectEntry.task.id,
              title: projectEntry.task.title,
              priority: projectEntry.task.priority,
              status: projectEntry.task.status,
              created: projectEntry.task.created,
              path: projectEntry.path,
            },
            progress: {
              completed,
              total,
              percent: progress,
              all_done: allDone,
            },
            status_breakdown: {
              pending,
              claimed,
              in_progress: inProgress,
              blocked,
              completed,
              failed,
              cancelled,
            },
            active_agents: activeAgents,
            overdue: overdueTasks,
            blockers,
            tasks: subTasks.map((t) => ({
              id: t.task.id,
              title: t.task.title,
              status: t.task.status,
              priority: t.task.priority,
              type: t.task.type,
              assignee: t.task.assignee || null,
              depends_on: t.task.depends_on,
              is_overdue: overdueTasks.some((o) => o.task_id === t.task.id),
              path: t.path,
            })),
            message: `Project "${projectEntry.task.title}": ${completed}/${total} tasks completed (${progress}%). ${inProgress + claimed} active, ${pending} pending, ${blocked} blocked.${allDone ? " PROJECT COMPLETE." : ""}`,
          }, null, 2),
        }],
      };
    },
  );
