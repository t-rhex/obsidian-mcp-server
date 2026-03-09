/**
 * Task Dashboard — auto-generates a DASHBOARD.md in the tasks folder
 * with a summary of all tasks grouped by status and sorted by priority.
 */

import { Vault } from "./vault.js";
import { parseNote } from "./frontmatter.js";
import {
  TaskFrontmatter,
  parseTaskFrontmatter,
  PRIORITY_ORDER,
  TaskStatus,
} from "./task-schema.js";

export interface TaskEntry {
  path: string;
  task: TaskFrontmatter;
}

/**
 * Scan the tasks folder and return all parsed task entries.
 */
export async function scanTasks(
  vault: Vault,
  tasksFolder: string,
): Promise<TaskEntry[]> {
  const entries = await vault.list(tasksFolder, {
    recursive: false,
    extensionFilter: [".md", ".markdown"],
  });

  const tasks: TaskEntry[] = [];

  for (const entry of entries) {
    if (entry.type !== "file") continue;
    // Skip DASHBOARD.md
    if (entry.path.toLowerCase().endsWith("dashboard.md")) continue;

    try {
      const raw = await vault.readNote(entry.path);
      const parsed = parseNote(raw);
      const task = parseTaskFrontmatter(parsed.frontmatter);
      if (task) {
        tasks.push({ path: entry.path, task });
      }
    } catch {
      // Skip unreadable files
    }
  }

  return tasks;
}

/**
 * Sort tasks by priority (critical first) then by created date (oldest first).
 */
function sortByPriority(a: TaskEntry, b: TaskEntry): number {
  const pa = PRIORITY_ORDER[a.task.priority] ?? 99;
  const pb = PRIORITY_ORDER[b.task.priority] ?? 99;
  if (pa !== pb) return pa - pb;
  return a.task.created.localeCompare(b.task.created);
}

/**
 * Generate the DASHBOARD.md content.
 */
export function generateDashboard(tasks: TaskEntry[]): string {
  const now = new Date().toISOString().split("T")[0];
  const lines: string[] = [];

  lines.push(`# Task Dashboard`);
  lines.push("");
  lines.push(`> Auto-generated on ${now}. Do not edit manually.`);
  lines.push("");

  // Summary table — exclude project containers from task counts
  const actionableTasks = tasks.filter((t) => t.task.type !== "project");
  const statusCounts: Record<string, number> = {};
  for (const entry of actionableTasks) {
    statusCounts[entry.task.status] = (statusCounts[entry.task.status] ?? 0) + 1;
  }

  lines.push("## Summary");
  lines.push("");
  lines.push("| Status | Count |");
  lines.push("|--------|-------|");

  const statusOrder: TaskStatus[] = [
    "in_progress", "claimed", "pending", "needs_review", "revision_requested",
    "blocked", "completed", "failed", "cancelled",
  ];
  for (const status of statusOrder) {
    const count = statusCounts[status] ?? 0;
    if (count > 0) {
      lines.push(`| ${status} | ${count} |`);
    }
  }
  lines.push(`| **Total** | **${actionableTasks.length}** |`);
  lines.push("");

  // Projects section
  const projects = tasks.filter((t) => t.task.type === "project");
  if (projects.length > 0) {
    lines.push("## Projects");
    lines.push("");
    for (const proj of projects) {
      const subTasks = tasks.filter(
        (t) => t.task.project === proj.task.id && t.task.id !== proj.task.id,
      );
      const completed = subTasks.filter((t) => t.task.status === "completed").length;
      const total = subTasks.length;
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
      const pathNoExt = proj.path.replace(/\.md$/, "");
      lines.push(
        `- [[${pathNoExt}|${proj.task.title}]] — ${completed}/${total} tasks (${pct}%) — ${proj.task.priority}`,
      );
    }
    lines.push("");
  }

  // Active tasks (in_progress + claimed), excluding project containers
  const active = tasks
    .filter((t) => (t.task.status === "in_progress" || t.task.status === "claimed") && t.task.type !== "project")
    .sort(sortByPriority);

  if (active.length > 0) {
    lines.push("## Active");
    lines.push("");
    for (const entry of active) {
      const assignee = entry.task.assignee ? ` (${entry.task.assignee})` : "";
      const pathNoExt = entry.path.replace(/\.md$/, "");
      lines.push(
        `- [[${pathNoExt}|${entry.task.title}]] — ${entry.task.priority} ${entry.task.type}${assignee}`,
      );
    }
    lines.push("");
  }

  // Needs Review tasks
  const needsReview = tasks
    .filter((t) => t.task.status === "needs_review" && t.task.type !== "project")
    .sort(sortByPriority);

  if (needsReview.length > 0) {
    lines.push("## Needs Review");
    lines.push("");
    for (const entry of needsReview) {
      const reviewer = entry.task.reviewer ? ` (reviewer: ${entry.task.reviewer})` : "";
      const pathNoExt = entry.path.replace(/\.md$/, "");
      lines.push(
        `- [[${pathNoExt}|${entry.task.title}]] — ${entry.task.priority}${reviewer}`,
      );
    }
    lines.push("");
  }

  // Revision Requested tasks
  const revisionRequested = tasks
    .filter((t) => t.task.status === "revision_requested" && t.task.type !== "project")
    .sort(sortByPriority);

  if (revisionRequested.length > 0) {
    lines.push("## Revision Requested");
    lines.push("");
    for (const entry of revisionRequested) {
      const assignee = entry.task.assignee ? ` (${entry.task.assignee})` : "";
      const pathNoExt = entry.path.replace(/\.md$/, "");
      lines.push(
        `- [[${pathNoExt}|${entry.task.title}]] — ${entry.task.priority}${assignee}`,
      );
    }
    lines.push("");
  }

  // Pending tasks
  const pending = tasks
    .filter((t) => t.task.status === "pending")
    .sort(sortByPriority);

  if (pending.length > 0) {
    lines.push("## Pending Queue");
    lines.push("");
    for (const entry of pending) {
      const due = entry.task.due ? ` (due: ${entry.task.due})` : "";
      // Only show depends_on for deps that are NOT completed (actual blockers)
      const unfinishedDeps = entry.task.depends_on.filter((depId) => {
        const dep = tasks.find((t) => t.task.id === depId);
        return !dep || dep.task.status !== "completed";
      });
      const deps = unfinishedDeps.length > 0
        ? ` [waiting on: ${unfinishedDeps.join(", ")}]`
        : "";
      const pathNoExt = entry.path.replace(/\.md$/, "");
      lines.push(
        `- [[${pathNoExt}|${entry.task.title}]] — ${entry.task.priority}${due}${deps}`,
      );
    }
    lines.push("");
  }

  // Blocked tasks
  const blocked = tasks
    .filter((t) => t.task.status === "blocked")
    .sort(sortByPriority);

  if (blocked.length > 0) {
    lines.push("## Blocked");
    lines.push("");
    for (const entry of blocked) {
      const deps = entry.task.depends_on.join(", ");
      const pathNoExt = entry.path.replace(/\.md$/, "");
      lines.push(`- [[${pathNoExt}|${entry.task.title}]] — waiting on: ${deps}`);
    }
    lines.push("");
  }

  // Recently completed
  const completed = tasks
    .filter((t) => t.task.status === "completed")
    .sort((a, b) => (b.task.completed_at ?? b.task.updated).localeCompare(
      a.task.completed_at ?? a.task.updated,
    ))
    .slice(0, 10);

  if (completed.length > 0) {
    lines.push("## Recently Completed");
    lines.push("");
    for (const entry of completed) {
      const when = entry.task.completed_at ?? entry.task.updated;
      const pathNoExt = entry.path.replace(/\.md$/, "");
      lines.push(`- [[${pathNoExt}|${entry.task.title}]] — ${when}`);
    }
    lines.push("");
  }

  // Failed tasks
  const failed = tasks
    .filter((t) => t.task.status === "failed")
    .sort((a, b) => b.task.updated.localeCompare(a.task.updated))
    .slice(0, 5);

  if (failed.length > 0) {
    lines.push("## Failed (needs attention)");
    lines.push("");
    for (const entry of failed) {
      const pathNoExt = entry.path.replace(/\.md$/, "");
      lines.push(`- [[${pathNoExt}|${entry.task.title}]] — ${entry.task.updated}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Regenerate DASHBOARD.md in the tasks folder.
 * This is called after every task mutation.
 * Returns true if dashboard was refreshed successfully, false otherwise.
 * Accepts optional pre-scanned tasks to avoid redundant filesystem reads.
 */
export async function refreshDashboard(
  vault: Vault,
  tasksFolder: string,
  preScannedTasks?: TaskEntry[],
): Promise<boolean> {
  try {
    const tasks = preScannedTasks ?? await scanTasks(vault, tasksFolder);
    const content = generateDashboard(tasks);
    const dashboardPath = `${tasksFolder}/DASHBOARD.md`;

    await vault.writeNote(dashboardPath, content, { overwrite: true });
    return true;
  } catch (err) {
    // Dashboard generation is best-effort — don't fail the tool call
    console.error(
      "Dashboard refresh failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
