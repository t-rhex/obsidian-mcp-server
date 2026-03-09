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
import { serializeNote } from "../frontmatter.js";
import { safeToolHandler } from "../errors.js";
import {
  buildTaskFrontmatter,
  buildTaskBody,
  buildTaskPath,
  buildProjectPath,
  generateProjectId,
  generateTaskId,
  nowISO,
  TaskPriority,
  TaskType,
} from "../task-schema.js";
import { refreshDashboard } from "../task-dashboard.js";

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
});

export const createProjectSchema = {
  title: z.string().describe("Project title (e.g. 'Auth Rewrite', 'API v2 Migration')."),
  description: z.string().describe(
    "Project description with goals, context, and constraints.",
  ),
  priority: z.enum(["critical", "high", "medium", "low"]).optional().default("medium").describe(
    "Default priority for the project and its tasks (individual tasks can override).",
  ),
  tasks: z.array(subTaskSchema).min(1).describe(
    "Array of sub-tasks to create. Use depends_on_indices to wire up dependencies between them.",
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
      title: string;
      description: string;
      priority?: TaskPriority;
      tasks: Array<{
        title: string;
        description?: string;
        priority?: TaskPriority;
        type?: TaskType;
        depends_on_indices?: number[];
        scope?: string[];
        context_notes?: string[];
        acceptance_criteria?: string[];
        timeout_minutes?: number;
        assignee?: string;
      }>;
      context_notes?: string[];
      tags?: string[];
      due?: string;
      source?: string;
    }) => {
      const tasksFolder = config.tasksFolder;
      const projectPriority = input.priority ?? "medium";
      const projectId = generateProjectId();
      const now = nowISO();
      const warnings: string[] = [];

      // Validate depends_on_indices are in range
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

      // Phase 1: Generate all task IDs up front so we can wire depends_on
      const taskIds: string[] = input.tasks.map(() => generateTaskId());

      // Phase 2: Create the project note
      const projectFm = buildTaskFrontmatter({
        id: projectId,
        title: input.title,
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

      const projectBody = buildProjectBody(input.description, taskIds, input.tasks);
      const projectFmClean = Object.fromEntries(
        Object.entries(projectFm).filter(([, v]) => v !== undefined),
      ) as Record<string, unknown>;
      const projectContent = serializeNote(projectFmClean, projectBody);
      const projectPath = buildProjectPath(tasksFolder, projectId, input.title);
      await vault.writeNote(projectPath, projectContent, { overwrite: false });

      // Phase 3: Create all sub-tasks
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
          created: now,
          updated: now,
        });

        const taskBody = buildTaskBody(
          taskDef.description ?? `Sub-task of project: ${input.title}`,
          taskDef.acceptance_criteria,
        );

        const taskFmClean = Object.fromEntries(
          Object.entries(taskFm).filter(([, v]) => v !== undefined),
        ) as Record<string, unknown>;
        const taskContent = serializeNote(taskFmClean, taskBody);
        const taskPath = buildTaskPath(tasksFolder, taskId, taskDef.title);

        await vault.writeNote(taskPath, taskContent, { overwrite: false });
        createdTasks.push({ id: taskId, title: taskDef.title, status, path: taskPath });
      }

      // Phase 4: Refresh dashboard
      const dashOk = await refreshDashboard(vault, tasksFolder);

      // Summary
      const pendingCount = createdTasks.filter((t) => t.status === "pending").length;
      const blockedCount = createdTasks.filter((t) => t.status === "blocked").length;
      const claimedCount = createdTasks.filter((t) => t.status === "claimed").length;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            dashboard_refreshed: dashOk,
            project: {
              id: projectId,
              title: input.title,
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
            message: `Project "${input.title}" created with ${createdTasks.length} tasks (${pendingCount} ready to claim, ${blockedCount} blocked).`,
          }, null, 2),
        }],
      };
    },
  );

/**
 * Build the markdown body for a project note.
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
  for (let i = 0; i < tasks.length; i++) {
    const deps = tasks[i].depends_on_indices;
    const depStr = deps && deps.length > 0
      ? ` (depends on: ${deps.map((d) => tasks[d].title).join(", ")})`
      : "";
    parts.push(`- [ ] ${taskIds[i]} — ${tasks[i].title}${depStr}`);
  }
  parts.push("");

  parts.push("## Agent Log");
  parts.push("");
  parts.push("<!-- Project-level progress updates -->");
  parts.push("");

  return parts.join("\n");
}
