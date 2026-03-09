/**
 * create_project tool — Create a project with multiple sub-tasks in one call.
 *
 * A project is a container task (type: "project") that groups related work.
 * Sub-tasks reference the project via their `project` field and can have
 * inter-task dependencies via `depends_on`.
 *
 * This enables multi-agent workflows: create a project, and multiple agents
 * can claim and work on independent sub-tasks in parallel.
 *
 * Example:
 *   create_project(
 *     title: "Auth Rewrite",
 *     tasks: [
 *       { title: "Design API", type: "research" },
 *       { title: "Implement JWT", type: "code", depends_on_indices: [0] },
 *       { title: "Write tests", type: "code", depends_on_indices: [1] },
 *       { title: "Update docs", type: "writing" },  // parallel with code tasks
 *     ]
 *   )
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { Config } from "../config.js";
import { parseNote, serializeNote } from "../frontmatter.js";
import { safeToolHandler } from "../errors.js";
import {
  buildTaskFrontmatter,
  buildTaskBody,
  buildTaskPath,
  buildProjectPath,
  buildProjectFolder,
  generateProjectId,
  generateTaskId,
  nowISO,
  parseTaskFrontmatter,
  RoutingRule,
  slugify,
  TaskPriority,
  TaskType,
} from "../task-schema.js";
import { refreshDashboard, scanTasks } from "../task-dashboard.js";

const subTaskSchema = z.object({
  title: z.string().describe("Short title for this sub-task."),
  description: z.string().optional().describe("What needs to be done."),
  priority: z.enum(["critical", "high", "medium", "low"]).optional().describe(
    "Priority. Inherits from project if not specified.",
  ),
  type: z.enum(["code", "research", "writing", "maintenance", "other"]).optional().default("other").describe(
    "Type of work.",
  ),
  depends_on_indices: z.array(z.number()).optional().describe(
    "Indices (0-based) of other tasks in this array that must complete first. " +
    "E.g. [0, 2] means this task depends on tasks[0] and tasks[2].",
  ),
  depends_on_existing: z.array(z.string()).optional().describe(
    "Task IDs of existing tasks (from the same project) that this task depends on. " +
    "Used in append mode (when project_id is provided) to depend on tasks already in the project.",
  ),
  scope: z.array(z.string()).optional().describe(
    "Advisory: file paths this task intends to modify.",
  ),
  context_notes: z.array(z.string()).optional().describe(
    "Vault notes with relevant context.",
  ),
  acceptance_criteria: z.array(z.string()).optional().describe(
    "Criteria for this sub-task to be considered complete.",
  ),
  timeout_minutes: z.number().optional().describe(
    "Max time in minutes before agent is considered stuck.",
  ),
  assignee: z.string().optional().describe(
    "Optionally pre-assign to a specific agent.",
  ),
  routing_rules: z.array(z.object({
    condition: z.enum(["output_contains", "output_matches", "status_is"]),
    value: z.string(),
    activate: z.array(z.string()).describe(
      "Task IDs or 'idx:N' references (0-based index into this tasks array) to unblock when this rule matches.",
    ),
    deactivate: z.array(z.string()).optional().describe(
      "Task IDs or 'idx:N' references to cancel when this rule matches.",
    ),
  })).optional().describe(
    "Conditional workflow rules. Use 'idx:N' to reference other tasks in this batch by index. " +
    "Resolved to real task IDs automatically.",
  ),
});

export const createProjectSchema = {
  project_id: z.string().optional().describe(
    "Append mode: provide an existing project ID to add new sub-tasks to it. " +
    "When set, title and description are optional (inherited from existing project). " +
    "New tasks are appended to the project's Sub-Tasks section.",
  ),
  title: z.string().optional().describe("Project title (e.g. 'Auth Rewrite', 'API v2 Migration'). Required for new projects."),
  description: z.string().optional().describe(
    "Project description with goals, context, and constraints. Required for new projects.",
  ),
  priority: z.enum(["critical", "high", "medium", "low"]).optional().default("medium").describe(
    "Default priority for the project and its tasks (individual tasks can override).",
  ),
  tasks: z.array(subTaskSchema).min(1).describe(
    "Array of sub-tasks to create. Use depends_on_indices to wire up dependencies between them. " +
    "In append mode, use depends_on_existing to reference tasks already in the project.",
  ),
  context_notes: z.array(z.string()).optional().describe(
    "Vault notes that provide context for the entire project.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Tags applied to the project and all sub-tasks.",
  ),
  due: z.string().optional().describe(
    "Optional deadline for the whole project (YYYY-MM-DD).",
  ),
  source: z.string().optional().default("manual").describe(
    "Where this project came from.",
  ),
};

export const createProjectHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: {
      project_id?: string;
      title?: string;
      description?: string;
      priority?: TaskPriority;
      tasks: Array<{
        title: string;
        description?: string;
        priority?: TaskPriority;
        type?: TaskType;
        depends_on_indices?: number[];
        depends_on_existing?: string[];
        scope?: string[];
        context_notes?: string[];
        acceptance_criteria?: string[];
        timeout_minutes?: number;
        assignee?: string;
        routing_rules?: Array<{
          condition: "output_contains" | "output_matches" | "status_is";
          value: string;
          activate: string[];
          deactivate?: string[];
        }>;
      }>;
      context_notes?: string[];
      tags?: string[];
      due?: string;
      source?: string;
    }) => {
      const tasksFolder = config.tasksFolder;
      const now = nowISO();
      const warnings: string[] = [];
      const isAppendMode = !!input.project_id;

      // ── Validate required fields based on mode ──
      if (!isAppendMode) {
        if (!input.title) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "MISSING_TITLE",
                message: "title is required when creating a new project (no project_id provided).",
              }),
            }],
            isError: true,
          };
        }
        if (!input.description) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "MISSING_DESCRIPTION",
                message: "description is required when creating a new project (no project_id provided).",
              }),
            }],
            isError: true,
          };
        }
      }

      // ── Append mode: look up existing project ──
      let projectId: string;
      let projectTitle: string;
      let projectPriority: TaskPriority;
      let projectPath: string | undefined;
      let projectFolder: string | undefined;
      let existingProjectContent: string | undefined;

      if (isAppendMode) {
        // Find the project note in the tasks folder
        const allTasks = await scanTasks(vault, tasksFolder);
        const projectEntry = allTasks.find(
          (t) => t.task.id === input.project_id && t.task.type === "project",
        );
        if (!projectEntry) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "PROJECT_NOT_FOUND",
                message: `Project "${input.project_id}" not found in ${tasksFolder}.`,
              }),
            }],
            isError: true,
          };
        }

        projectId = projectEntry.task.id;
        projectTitle = input.title ?? projectEntry.task.title;
        projectPriority = input.priority ?? projectEntry.task.priority;
        projectPath = projectEntry.path;
        // Derive the project folder from the existing project note's path
        // e.g. "Tasks/auth-rewrite/proj-xxx-auth-rewrite.md" → "Tasks/auth-rewrite"
        const pathParts = projectEntry.path.split(/[/\\]/);
        if (pathParts.length >= 3) {
          // Has subfolder structure — use the parent directory
          projectFolder = pathParts.slice(0, -1).join("/");
        }
        // Legacy flat structure (pathParts.length < 3): projectFolder stays
        // undefined, so new tasks go to tasksFolder root — same as existing tasks.
        existingProjectContent = await vault.readNote(projectEntry.path);

        // Validate depends_on_existing references exist in the project
        const projectTaskIds = new Set(
          allTasks
            .filter((t) => t.task.project === projectId && t.task.id !== projectId)
            .map((t) => t.task.id),
        );
        for (let i = 0; i < input.tasks.length; i++) {
          const existingDeps = input.tasks[i].depends_on_existing;
          if (existingDeps) {
            for (const depId of existingDeps) {
              if (!projectTaskIds.has(depId)) {
                return {
                  content: [{
                    type: "text" as const,
                    text: JSON.stringify({
                      error: "INVALID_EXISTING_DEPENDENCY",
                      message: `Task "${input.tasks[i].title}" references depends_on_existing "${depId}" but that task ID is not part of project "${projectId}".`,
                    }),
                  }],
                  isError: true,
                };
              }
            }
          }
        }
      } else {
        projectId = generateProjectId();
        projectTitle = input.title!;
        projectPriority = input.priority ?? "medium";
        projectFolder = buildProjectFolder(tasksFolder, projectTitle);
      }

      // ── Validate depends_on_indices are in range ──
      for (let i = 0; i < input.tasks.length; i++) {
        const deps = input.tasks[i].depends_on_indices;
        if (deps) {
          for (const idx of deps) {
            if (idx < 0 || idx >= input.tasks.length) {
              return {
                content: [{
                  type: "text" as const,
                  text: JSON.stringify({
                    error: "INVALID_DEPENDENCY_INDEX",
                    message: `Task "${input.tasks[i].title}" has depends_on_indices [${deps}] but index ${idx} is out of range (0-${input.tasks.length - 1}).`,
                  }),
                }],
                isError: true,
              };
            }
            if (idx === i) {
              return {
                content: [{
                  type: "text" as const,
                  text: JSON.stringify({
                    error: "SELF_DEPENDENCY",
                    message: `Task "${input.tasks[i].title}" cannot depend on itself (index ${i}).`,
                  }),
                }],
                isError: true,
              };
            }
          }
        }
      }

      // ── Phase 1: Generate all task IDs up front ──
      const taskIds: string[] = input.tasks.map(() => generateTaskId());

      // ── Phase 2: Create the project note (new mode only) ──
      if (!isAppendMode) {
        const projectFm = buildTaskFrontmatter({
          id: projectId,
          title: projectTitle,
          status: "in_progress", // Project is active once created
          priority: projectPriority,
          type: "project" as TaskType,
          due: input.due,
          context_notes: input.context_notes,
          tags: input.tags,
          source: input.source,
          created: now,
          updated: now,
        });

        const projectBody = buildProjectBody(input.description!, taskIds, input.tasks);
        const projectFmClean = Object.fromEntries(
          Object.entries(projectFm).filter(([, v]) => v !== undefined),
        ) as Record<string, unknown>;
        const projectContent = serializeNote(projectFmClean, projectBody);
        projectPath = buildProjectPath(tasksFolder, projectId, projectTitle);
        await vault.writeNote(projectPath, projectContent, { overwrite: false });
      }

      // ── Phase 3: Create all sub-tasks ──
      const createdTasks: Array<{ id: string; title: string; status: string; path: string }> = [];

      for (let i = 0; i < input.tasks.length; i++) {
        const taskDef = input.tasks[i];
        const taskId = taskIds[i];

        // Resolve depends_on_indices to actual task IDs
        const dependsOn: string[] = [];
        if (taskDef.depends_on_indices) {
          for (const idx of taskDef.depends_on_indices) {
            dependsOn.push(taskIds[idx]);
          }
        }
        // Merge depends_on_existing (append mode — references to existing tasks)
        if (taskDef.depends_on_existing) {
          for (const existingId of taskDef.depends_on_existing) {
            if (!dependsOn.includes(existingId)) {
              dependsOn.push(existingId);
            }
          }
        }

        // Resolve idx:N references in routing_rules to actual task IDs
        let resolvedRules: RoutingRule[] | undefined;
        if (taskDef.routing_rules && taskDef.routing_rules.length > 0) {
          resolvedRules = taskDef.routing_rules.map((rule) => {
            const resolved: RoutingRule = {
              condition: rule.condition,
              value: rule.value,
              activate: rule.activate.map((ref) => resolveIdxRef(ref, taskIds)),
            };
            if (rule.deactivate) {
              resolved.deactivate = rule.deactivate.map((ref) => resolveIdxRef(ref, taskIds));
            }
            return resolved;
          });
        }

        const hasBlockingDeps = dependsOn.length > 0;
        const isClaimed = !hasBlockingDeps && !!taskDef.assignee;
        const status = hasBlockingDeps ? "blocked" : (isClaimed ? "claimed" : "pending");

        const taskFm = buildTaskFrontmatter({
          id: taskId,
          title: taskDef.title,
          status,
          priority: taskDef.priority ?? projectPriority,
          type: taskDef.type ?? "other",
          project: projectId,
          parent_task: projectId,
          depends_on: dependsOn,
          scope: taskDef.scope,
          context_notes: [
            ...(input.context_notes ?? []),
            ...(taskDef.context_notes ?? []),
          ],
          tags: input.tags,
          source: input.source,
          due: input.due,
          timeout_minutes: taskDef.timeout_minutes,
          assignee: hasBlockingDeps ? undefined : taskDef.assignee,
          claimed_at: isClaimed ? now : undefined,
          routing_rules: resolvedRules,
          created: now,
          updated: now,
        });

        const taskBody = buildTaskBody(
          taskDef.description ?? `Sub-task of project: ${projectTitle}`,
          taskDef.acceptance_criteria,
        );

        const taskFmClean = Object.fromEntries(
          Object.entries(taskFm).filter(([, v]) => v !== undefined),
        ) as Record<string, unknown>;
        const taskContent = serializeNote(taskFmClean, taskBody);
        const taskPath = buildTaskPath(tasksFolder, taskId, taskDef.title, projectFolder);

        await vault.writeNote(taskPath, taskContent, { overwrite: false });
        createdTasks.push({ id: taskId, title: taskDef.title, status, path: taskPath });
      }

      // ── Phase 4: Update existing project note (append mode) ──
      if (isAppendMode && existingProjectContent && projectPath) {
        const newSubTaskLines = buildSubTaskLines(taskIds, input.tasks);
        const updatedContent = appendToSubTasksSection(existingProjectContent, newSubTaskLines);
        await vault.writeNote(projectPath, updatedContent, { overwrite: true });
      }

      // ── Phase 5: Refresh dashboard ──
      const dashOk = await refreshDashboard(vault, tasksFolder);

      // Summary
      const pendingCount = createdTasks.filter((t) => t.status === "pending").length;
      const blockedCount = createdTasks.filter((t) => t.status === "blocked").length;
      const claimedCount = createdTasks.filter((t) => t.status === "claimed").length;

      const modeLabel = isAppendMode ? "appended to" : "created";

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            mode: isAppendMode ? "append" : "create",
            dashboard_refreshed: dashOk,
            project: {
              id: projectId,
              title: projectTitle,
              priority: projectPriority,
              path: projectPath,
              task_count: createdTasks.length,
            },
            tasks: createdTasks,
            summary: {
              total: createdTasks.length,
              pending: pendingCount,
              blocked: blockedCount,
              claimed: claimedCount,
            },
            warnings: warnings.length > 0 ? warnings : undefined,
            message: `${createdTasks.length} tasks ${modeLabel} project "${projectTitle}" (${pendingCount} ready to claim, ${blockedCount} blocked).`,
          }, null, 2),
        }],
      };
    },
  );

/**
 * Build the markdown body for a new project note.
 */
function buildProjectBody(
  description: string,
  taskIds: string[],
  tasks: Array<{ title: string; depends_on_indices?: number[] }>,
): string {
  const parts: string[] = [];

  parts.push("## Description");
  parts.push("");
  parts.push(description);
  parts.push("");

  parts.push("## Sub-Tasks");
  parts.push("");
  const lines = buildSubTaskLines(taskIds, tasks);
  parts.push(lines);
  parts.push("");

  parts.push("## Agent Log");
  parts.push("");
  parts.push("<!-- Project-level progress updates -->");
  parts.push("");

  return parts.join("\n");
}

/**
 * Build markdown lines for sub-task entries in a project note.
 */
function buildSubTaskLines(
  taskIds: string[],
  tasks: Array<{ title: string; depends_on_indices?: number[] }>,
): string {
  const lines: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const deps = tasks[i].depends_on_indices;
    const depStr = deps && deps.length > 0
      ? ` (depends on: ${deps.map((d) => tasks[d].title).join(", ")})`
      : "";
    lines.push(`- [ ] ${taskIds[i]} — ${tasks[i].title}${depStr}`);
  }
  return lines.join("\n");
}

/**
 * Resolve an `idx:N` reference to a real task ID.
 * If the string matches `idx:N` pattern, returns `taskIds[N]`.
 * Otherwise returns the string as-is (already a task ID).
 */
function resolveIdxRef(ref: string, taskIds: string[]): string {
  const match = /^idx:(\d+)$/.exec(ref);
  if (match) {
    const idx = parseInt(match[1], 10);
    if (idx >= 0 && idx < taskIds.length) {
      return taskIds[idx];
    }
    // Out of range — return as-is (will be a broken reference but won't crash)
    return ref;
  }
  return ref;
}

/**
 * Append new sub-task lines to the existing ## Sub-Tasks section.
 * If the section doesn't exist, creates it before ## Agent Log.
 */
function appendToSubTasksSection(content: string, newLines: string): string {
  // Find ## Sub-Tasks heading
  const subTasksMatch = /^## Sub-Tasks\b.*$/mi.exec(content);

  if (subTasksMatch) {
    // Find the end of the Sub-Tasks section (next ## heading or end of content)
    const afterHeading = subTasksMatch.index + subTasksMatch[0].length;
    const remaining = content.substring(afterHeading);
    const nextH2 = remaining.search(/^## /m);
    const sectionEnd = nextH2 !== -1 ? afterHeading + nextH2 : content.length;

    // Insert new lines at the end of the section (before the next heading)
    const beforeSection = content.substring(0, sectionEnd).trimEnd();
    const afterSection = content.substring(sectionEnd);

    return beforeSection + "\n" + newLines + "\n\n" + afterSection;
  } else {
    // No Sub-Tasks section — create one before Agent Log if it exists
    const agentLogMatch = /^## Agent Log\b.*$/mi.exec(content);
    const section = `## Sub-Tasks\n\n${newLines}\n`;

    if (agentLogMatch) {
      return (
        content.substring(0, agentLogMatch.index) +
        section + "\n" +
        content.substring(agentLogMatch.index)
      );
    }
    return content.trimEnd() + "\n\n" + section;
  }
}
