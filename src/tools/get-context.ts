/**
 * get_context tool — The "catch me up" tool for new sessions.
 *
 * Assembles a structured briefing from the vault's current state:
 * - Active projects with progress
 * - Recent task completions (configurable window)
 * - Unresolved blockers and failed tasks
 * - Recent decisions
 * - Recent discoveries
 * - Pinned context notes (from a configurable frontmatter field)
 *
 * This should be an agent's FIRST call in any new session.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { Config } from "../config.js";
import { parseNote } from "../frontmatter.js";
import { safeToolHandler } from "../errors.js";
import { scanTasks, TaskEntry } from "../task-dashboard.js";
import { PRIORITY_ORDER, TaskFrontmatter } from "../task-schema.js";

export const getContextSchema = {
  project_id: z.string().optional().describe(
    "Focus on a specific project. If omitted, shows all active work.",
  ),
  hours: z.number().optional().default(48).describe(
    "How far back to look for recent activity (hours). Default: 48.",
  ),
  include_completed: z.boolean().optional().default(true).describe(
    "Include recently completed tasks in the briefing. Default: true.",
  ),
};

/**
 * Scan a folder for notes with frontmatter, sorted by created date descending.
 * Returns parsed frontmatter + path for each note.
 */
async function scanFolder(
  vault: Vault,
  folder: string,
  sinceISO?: string,
): Promise<Array<{ path: string; frontmatter: Record<string, unknown>; content: string }>> {
  const results: Array<{ path: string; frontmatter: Record<string, unknown>; content: string }> = [];

  try {
    const entries = await vault.list(folder, {
      recursive: false,
      extensionFilter: [".md", ".markdown"],
    });

    for (const entry of entries) {
      if (entry.type !== "file") continue;
      // Skip dashboard and index files
      const lower = entry.path.toLowerCase();
      if (lower.endsWith("dashboard.md") || lower.endsWith("index.md")) continue;

      try {
        const raw = await vault.readNote(entry.path);
        const parsed = parseNote(raw);

        // Filter by date if requested
        if (sinceISO && parsed.frontmatter.created) {
          const created = String(parsed.frontmatter.created);
          if (created < sinceISO) continue;
        }

        results.push({
          path: entry.path,
          frontmatter: parsed.frontmatter,
          content: parsed.content,
        });
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Folder doesn't exist yet — that's fine
  }

  // Sort by created date descending (most recent first)
  results.sort((a, b) => {
    const ac = String(a.frontmatter.created ?? "");
    const bc = String(b.frontmatter.created ?? "");
    return bc.localeCompare(ac);
  });

  return results;
}

export const getContextHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: {
      project_id?: string;
      hours?: number;
      include_completed?: boolean;
    }) => {
      const hours = input.hours ?? 48;
      const includeCompleted = input.include_completed ?? true;
      const sinceDate = new Date(Date.now() - hours * 60 * 60 * 1000);
      const sinceISO = sinceDate.toISOString();

      // ── 1. Scan all tasks ──────────────────────────────────────────
      const allTasks = await scanTasks(vault, config.tasksFolder);

      // Filter to project if specified
      const relevantTasks = input.project_id
        ? allTasks.filter(
            (t) => t.task.project === input.project_id || t.task.id === input.project_id,
          )
        : allTasks;

      // ── 2. Active projects ─────────────────────────────────────────
      const projects = allTasks.filter((t) => t.task.type === "project");
      const activeProjects = projects.map((proj) => {
        const subTasks = allTasks.filter(
          (t) => t.task.project === proj.task.id && t.task.id !== proj.task.id,
        );
        const completed = subTasks.filter((t) => t.task.status === "completed").length;
        const total = subTasks.length;
        const activeAgents = subTasks
          .filter((t) => t.task.assignee && ["claimed", "in_progress"].includes(t.task.status))
          .map((t) => ({ agent: t.task.assignee, task: t.task.title, status: t.task.status }));

        return {
          id: proj.task.id,
          title: proj.task.title,
          priority: proj.task.priority,
          progress: `${completed}/${total}`,
          percent: total > 0 ? Math.round((completed / total) * 100) : 0,
          active_agents: activeAgents.length > 0 ? activeAgents : undefined,
          path: proj.path,
        };
      });

      // ── 3. Current work (in_progress + claimed) ───────────────────
      const activeWork = relevantTasks
        .filter((t) => ["in_progress", "claimed"].includes(t.task.status) && t.task.type !== "project")
        .sort((a, b) => (PRIORITY_ORDER[a.task.priority] ?? 99) - (PRIORITY_ORDER[b.task.priority] ?? 99))
        .map((t) => ({
          id: t.task.id,
          title: t.task.title,
          status: t.task.status,
          priority: t.task.priority,
          assignee: t.task.assignee || null,
          project: t.task.project || null,
          path: t.path,
        }));

      // ── 4. Pending work (ready to claim), grouped by project ───────
      const pendingRaw = relevantTasks
        .filter((t) => t.task.status === "pending" && t.task.type !== "project")
        .sort((a, b) => (PRIORITY_ORDER[a.task.priority] ?? 99) - (PRIORITY_ORDER[b.task.priority] ?? 99))
        .slice(0, 15);

      // Build project title lookup
      const projectTitles = new Map<string, string>();
      for (const p of allTasks) {
        if (p.task.type === "project") {
          projectTitles.set(p.task.id, p.task.title);
        }
      }

      // Group by project
      const pendingByProject = new Map<string, typeof pendingRaw>();
      for (const t of pendingRaw) {
        const key = t.task.project || "_standalone";
        if (!pendingByProject.has(key)) pendingByProject.set(key, []);
        pendingByProject.get(key)!.push(t);
      }

      const pendingWork: Array<{
        project?: string;
        project_title?: string;
        tasks: Array<{ id: string; title: string; priority: string; type: string }>;
      }> = [];

      // Standalone tasks first
      const standalone = pendingByProject.get("_standalone");
      if (standalone) {
        pendingWork.push({
          tasks: standalone.map((t) => ({
            id: t.task.id,
            title: t.task.title,
            priority: t.task.priority,
            type: t.task.type,
          })),
        });
      }

      // Then grouped by project
      for (const [projId, tasks] of pendingByProject) {
        if (projId === "_standalone") continue;
        pendingWork.push({
          project: projId,
          project_title: projectTitles.get(projId) ?? projId,
          tasks: tasks.map((t) => ({
            id: t.task.id,
            title: t.task.title,
            priority: t.task.priority,
            type: t.task.type,
          })),
        });
      }

      // ── 4b. Needs review queue ─────────────────────────────────────
      const reviewQueue = relevantTasks
        .filter((t) => t.task.status === "needs_review" && t.task.type !== "project")
        .map((t) => ({
          id: t.task.id,
          title: t.task.title,
          priority: t.task.priority,
          reviewer: t.task.reviewer || null,
          project: t.task.project || null,
          path: t.path,
        }));

      // ── 4c. Revision requested ────────────────────────────────────
      const revisionRequested = relevantTasks
        .filter((t) => t.task.status === "revision_requested" && t.task.type !== "project")
        .map((t) => ({
          id: t.task.id,
          title: t.task.title,
          priority: t.task.priority,
          assignee: t.task.assignee || null,
          feedback: t.task.feedback || null,
          project: t.task.project || null,
          path: t.path,
        }));

      // ── 5. Blockers and failures ───────────────────────────────────
      // Build task title lookup for resolving IDs
      const taskTitles = new Map<string, string>();
      for (const t of allTasks) {
        taskTitles.set(t.task.id, t.task.title);
      }

      const blockers = relevantTasks
        .filter((t) => t.task.status === "blocked")
        .map((t) => ({
          id: t.task.id,
          title: t.task.title,
          waiting_on: t.task.depends_on.map((depId) => ({
            id: depId,
            title: taskTitles.get(depId) ?? depId,
          })),
          project: t.task.project || null,
        }));

      const failures = relevantTasks
        .filter((t) => t.task.status === "failed")
        .map((t) => ({
          id: t.task.id,
          title: t.task.title,
          retry_count: t.task.retry_count,
          project: t.task.project || null,
          path: t.path,
        }));

      // ── 6. Recent completions ──────────────────────────────────────
      let recentCompletions: Array<{
        id: string;
        title: string;
        completed_at: string;
        project: string | null;
      }> | undefined;

      if (includeCompleted) {
        recentCompletions = relevantTasks
          .filter((t) => t.task.status === "completed" && (t.task.completed_at ?? t.task.updated) >= sinceISO)
          .sort((a, b) =>
            (b.task.completed_at ?? b.task.updated).localeCompare(a.task.completed_at ?? a.task.updated),
          )
          .slice(0, 15)
          .map((t) => ({
            id: t.task.id,
            title: t.task.title,
            completed_at: t.task.completed_at ?? t.task.updated,
            project: t.task.project || null,
          }));
      }

      // ── 7. Overdue tasks ───────────────────────────────────────────
      const overdue: Array<{ id: string; title: string; assignee: string; minutes_over: number }> = [];
      for (const t of relevantTasks) {
        if (
          t.task.claimed_at &&
          ["claimed", "in_progress"].includes(t.task.status) &&
          t.task.timeout_minutes > 0
        ) {
          const claimedAt = new Date(t.task.claimed_at).getTime();
          const elapsed = (Date.now() - claimedAt) / 60_000;
          if (elapsed > t.task.timeout_minutes) {
            overdue.push({
              id: t.task.id,
              title: t.task.title,
              assignee: t.task.assignee,
              minutes_over: Math.round(elapsed - t.task.timeout_minutes),
            });
          }
        }
      }

      // ── 8. Recent decisions (with inline summary) ──────────────────
      const recentDecisions = await scanFolder(vault, config.decisionsFolder, sinceISO);
      const decisions = recentDecisions.slice(0, 10).map((d) => ({
        title: String(d.frontmatter.title ?? d.path.split("/").pop()?.replace(/\.md$/, "") ?? ""),
        decision: d.frontmatter.decision ? String(d.frontmatter.decision) : undefined,
        status: String(d.frontmatter.status ?? "accepted"),
        tags: Array.isArray(d.frontmatter.tags) ? d.frontmatter.tags : [],
        path: d.path,
      }));

      // ── 9. Recent discoveries (with inline summary) ────────────────
      const recentDiscoveries = await scanFolder(vault, config.discoveriesFolder, sinceISO);
      const discoveries = recentDiscoveries.slice(0, 10).map((d) => ({
        title: String(d.frontmatter.title ?? d.path.split("/").pop()?.replace(/\.md$/, "") ?? ""),
        discovery: d.frontmatter.discovery ? String(d.frontmatter.discovery) : undefined,
        recommendation: d.frontmatter.recommendation ? String(d.frontmatter.recommendation) : undefined,
        impact: String(d.frontmatter.impact ?? "medium"),
        tags: Array.isArray(d.frontmatter.tags) ? d.frontmatter.tags : [],
        path: d.path,
      }));

      // ── 10. Pinned context notes ───────────────────────────────────
      // Search for notes with `pinned: true` in frontmatter across common folders
      const pinned: Array<{ title: string; path: string }> = [];
      const foldersToCheck = ["Projects", config.tasksFolder, ""];
      for (const folder of foldersToCheck) {
        try {
          const entries = await vault.list(folder || ".", {
            recursive: false,
            extensionFilter: [".md", ".markdown"],
          });

          for (const entry of entries) {
            if (entry.type !== "file") continue;
            try {
              const raw = await vault.readNote(entry.path);
              const parsed = parseNote(raw);
              if (parsed.frontmatter.pinned === true) {
                pinned.push({
                  title: String(parsed.frontmatter.title ?? entry.path.split("/").pop()?.replace(/\.md$/, "")),
                  path: entry.path,
                });
              }
            } catch {
              // Skip
            }
          }
        } catch {
          // Folder doesn't exist
        }
      }

      // ── Build the briefing ─────────────────────────────────────────
      const briefing: Record<string, unknown> = {
        generated_at: new Date().toISOString(),
        window_hours: hours,
      };

      if (input.project_id) {
        briefing.focused_project = input.project_id;
      }

      if (activeProjects.length > 0) {
        briefing.active_projects = activeProjects;
      }

      if (activeWork.length > 0) {
        briefing.active_work = activeWork;
      }

      if (pendingWork.length > 0) {
        briefing.pending_work = pendingWork;
      }

      if (reviewQueue.length > 0) {
        briefing.needs_review = reviewQueue;
      }

      if (revisionRequested.length > 0) {
        briefing.revision_requested = revisionRequested;
      }

      if (blockers.length > 0) {
        briefing.blockers = blockers;
      }

      if (failures.length > 0) {
        briefing.failures = failures;
      }

      if (overdue.length > 0) {
        briefing.overdue = overdue;
      }

      if (recentCompletions && recentCompletions.length > 0) {
        briefing.recent_completions = recentCompletions;
      }

      if (decisions.length > 0) {
        briefing.recent_decisions = decisions;
      }

      if (discoveries.length > 0) {
        briefing.recent_discoveries = discoveries;
      }

      if (pinned.length > 0) {
        briefing.pinned_context = pinned;
      }

      // Summary line
      const parts: string[] = [];
      if (activeProjects.length > 0) parts.push(`${activeProjects.length} active project(s)`);
      if (activeWork.length > 0) parts.push(`${activeWork.length} task(s) in progress`);
      const pendingCount = pendingWork.reduce((sum, g) => sum + g.tasks.length, 0);
      if (pendingCount > 0) parts.push(`${pendingCount} task(s) ready to claim`);
      if (reviewQueue.length > 0) parts.push(`${reviewQueue.length} awaiting review`);
      if (revisionRequested.length > 0) parts.push(`${revisionRequested.length} need revision`);
      if (blockers.length > 0) parts.push(`${blockers.length} blocked`);
      if (failures.length > 0) parts.push(`${failures.length} failed`);
      if (overdue.length > 0) parts.push(`${overdue.length} overdue`);
      if (decisions.length > 0) parts.push(`${decisions.length} recent decision(s)`);
      if (discoveries.length > 0) parts.push(`${discoveries.length} recent discovery(ies)`);

      briefing.summary = parts.length > 0
        ? parts.join(", ") + "."
        : "No active work or recent activity found.";

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(briefing, null, 2),
        }],
      };
    },
  );
