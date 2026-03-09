/**
 * check_timeouts tool — Scan for overdue and failed tasks, applying
 * retry and escalation policies automatically.
 *
 * Three cases are handled:
 * 1. Overdue tasks (claimed/in_progress past timeout_minutes) → released back to pending
 * 2. Failed tasks eligible for retry (retry_count < max_retries) → reset to pending
 * 3. Failed tasks at max retries with escalation configured → escalated
 *
 * Supports dry_run mode to preview actions without making changes.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { Config } from "../config.js";
import { parseNote, serializeNote } from "../frontmatter.js";
import { safeToolHandler } from "../errors.js";
import { parseTaskFrontmatter, nowISO, appendToAgentLog } from "../task-schema.js";
import { refreshDashboard, scanTasks } from "../task-dashboard.js";

export const checkTimeoutsSchema = {
  dry_run: z.boolean().optional().default(false).describe(
    "If true, report what would happen without making changes.",
  ),
};

interface ActionResult {
  task_id: string;
  title: string;
  action: string;
  details: string;
}

export const checkTimeoutsHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: { dry_run?: boolean }) => {
      const tasksFolder = config.tasksFolder;
      const dryRun = input.dry_run ?? false;

      const allTasks = await scanTasks(vault, tasksFolder);

      const timedOut: ActionResult[] = [];
      const retried: ActionResult[] = [];
      const escalated: ActionResult[] = [];

      for (const entry of allTasks) {
        const { task } = entry;

        // ── Case 1: Overdue tasks (claimed/in_progress past timeout) ──
        if (
          (task.status === "claimed" || task.status === "in_progress") &&
          task.claimed_at &&
          task.timeout_minutes > 0
        ) {
          const elapsed = (Date.now() - new Date(task.claimed_at).getTime()) / 60_000;

          if (elapsed > task.timeout_minutes) {
            timedOut.push({
              task_id: task.id,
              title: task.title,
              action: "timed_out",
              details: `Elapsed ${Math.round(elapsed)}m > timeout ${task.timeout_minutes}m. Released to pending.`,
            });

            if (!dryRun) {
              const raw = await vault.readNote(entry.path);
              const parsed = parseNote(raw);

              const updatedFm: Record<string, unknown> = {
                ...parsed.frontmatter,
                status: "pending",
                assignee: "",
                updated: nowISO(),
                retry_count: (typeof parsed.frontmatter.retry_count === "number"
                  ? parsed.frontmatter.retry_count : 0) + 1,
              };
              delete updatedFm.claimed_at;

              const updatedContent = appendToAgentLog(
                parsed.content,
                `Auto-released: timed out after ${Math.round(elapsed)} minutes`,
              );

              // Strip undefined values before serializing (js-yaml crash)
              const fmClean = Object.fromEntries(
                Object.entries(updatedFm).filter(([, v]) => v !== undefined),
              ) as Record<string, unknown>;

              const newContent = serializeNote(fmClean, updatedContent);
              await vault.writeNote(entry.path, newContent, { overwrite: true });
            }

            continue;
          }
        }

        // ── Case 2: Failed tasks eligible for retry ──
        if (
          task.status === "failed" &&
          task.retry_count < task.max_retries
        ) {
          const nextRetry = task.retry_count + 1;

          retried.push({
            task_id: task.id,
            title: task.title,
            action: "retried",
            details: `Auto-retry #${nextRetry} of ${task.max_retries}.`,
          });

          if (!dryRun) {
            const raw = await vault.readNote(entry.path);
            const parsed = parseNote(raw);

            const updatedFm: Record<string, unknown> = {
              ...parsed.frontmatter,
              status: "pending",
              assignee: "",
              updated: nowISO(),
              retry_count: nextRetry,
            };
            delete updatedFm.claimed_at;
            delete updatedFm.completed_at;

            const updatedContent = appendToAgentLog(
              parsed.content,
              `Auto-retry #${nextRetry} of ${task.max_retries}`,
            );

            // Strip undefined values before serializing (js-yaml crash)
            const fmClean = Object.fromEntries(
              Object.entries(updatedFm).filter(([, v]) => v !== undefined),
            ) as Record<string, unknown>;

            const newContent = serializeNote(fmClean, updatedContent);
            await vault.writeNote(entry.path, newContent, { overwrite: true });
          }

          continue;
        }

        // ── Case 3: Failed tasks at max retries with escalation ──
        if (
          task.status === "failed" &&
          task.retry_count >= task.max_retries &&
          task.escalate_to &&
          task.escalation_status === "none"
        ) {
          escalated.push({
            task_id: task.id,
            title: task.title,
            action: "escalated",
            details: `Escalated to ${task.escalate_to} after ${task.max_retries} failed attempts.`,
          });

          if (!dryRun) {
            const raw = await vault.readNote(entry.path);
            const parsed = parseNote(raw);

            const updatedFm: Record<string, unknown> = {
              ...parsed.frontmatter,
              escalation_status: "escalated",
              updated: nowISO(),
            };

            if (task.escalate_to === "human") {
              updatedFm.status = "needs_review";
            } else {
              updatedFm.assignee = task.escalate_to;
              updatedFm.status = "pending";
            }

            const updatedContent = appendToAgentLog(
              parsed.content,
              `Escalated to ${task.escalate_to} after ${task.max_retries} failed attempts`,
            );

            // Strip undefined values before serializing (js-yaml crash)
            const fmClean = Object.fromEntries(
              Object.entries(updatedFm).filter(([, v]) => v !== undefined),
            ) as Record<string, unknown>;

            const newContent = serializeNote(fmClean, updatedContent);
            await vault.writeNote(entry.path, newContent, { overwrite: true });
          }
        }
      }

      // Refresh dashboard after all mutations
      let dashOk = false;
      const totalActions = timedOut.length + retried.length + escalated.length;
      if (!dryRun && totalActions > 0) {
        dashOk = await refreshDashboard(vault, tasksFolder);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            timed_out: timedOut,
            retried,
            escalated,
            total_actions: totalActions,
            dry_run: dryRun,
            ...(dryRun ? {} : { dashboard_refreshed: dashOk }),
          }, null, 2),
        }],
      };
    },
  );
