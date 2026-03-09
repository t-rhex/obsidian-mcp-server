/**
 * create_task tool — Create a new task in the vault's task queue.
 *
 * Tasks are markdown notes with structured YAML frontmatter in the Tasks/ folder.
 * Agents and humans can create tasks for other agents to pick up and work on.
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
  TaskPriority,
  TaskType,
} from "../task-schema.js";
import { refreshDashboard } from "../task-dashboard.js";

export const createTaskSchema = {
  title: z.string().describe("Short, descriptive title for the task."),
  description: z.string().describe(
    "Detailed description of what needs to be done. Include context, constraints, and links to relevant notes.",
  ),
  priority: z.enum(["critical", "high", "medium", "low"]).optional().default("medium").describe(
    "Task priority. Default: medium.",
  ),
  type: z.enum(["code", "research", "writing", "maintenance", "other"]).optional().default("other").describe(
    "Type of work. Helps agents decide if they can handle it.",
  ),
  due: z.string().optional().describe(
    "Optional deadline in YYYY-MM-DD format.",
  ),
  depends_on: z.array(z.string()).optional().describe(
    "Task IDs that must complete before this task can start.",
  ),
  context_notes: z.array(z.string()).optional().describe(
    "Paths to vault notes that provide context for this task (e.g. 'Projects/my-api').",
  ),
  scope: z.array(z.string()).optional().describe(
    "Advisory: file paths this task intends to modify. Not enforced — agents should respect this to avoid conflicts.",
  ),
  acceptance_criteria: z.array(z.string()).optional().describe(
    "List of criteria that must be met for the task to be considered complete.",
  ),
  source: z.string().optional().default("manual").describe(
    "Where this task came from (e.g. 'manual', 'github-issue-42', 'agent-spawned').",
  ),
  parent_task: z.string().optional().describe(
    "ID of the parent task, if this is a sub-task.",
  ),
  timeout_minutes: z.number().optional().default(60).describe(
    "Max time in minutes before an agent is considered stuck. Default: 60.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Tags for categorization.",
  ),
  assignee: z.string().optional().describe(
    "Optionally pre-assign to a specific agent.",
  ),
};

export const createTaskHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: {
      title: string;
      description: string;
      priority?: TaskPriority;
      type?: TaskType;
      due?: string;
      depends_on?: string[];
      context_notes?: string[];
      scope?: string[];
      acceptance_criteria?: string[];
      source?: string;
      parent_task?: string;
      timeout_minutes?: number;
      tags?: string[];
      assignee?: string;
    }) => {
      const tasksFolder = config.tasksFolder;

      // Validate depends_on IDs exist (warn on missing, don't block creation)
      const warnings: string[] = [];
      if (input.depends_on && input.depends_on.length > 0) {
        const { scanTasks: scan } = await import("../task-dashboard.js");
        const existing = await scan(vault, tasksFolder);
        const existingIds = new Set(existing.map((t) => t.task.id));
        for (const depId of input.depends_on) {
          if (!existingIds.has(depId)) {
            warnings.push(`depends_on ID "${depId}" not found — task may stay blocked forever`);
          }
        }
      }

      // Build frontmatter
      const fm = buildTaskFrontmatter({
        title: input.title,
        priority: input.priority,
        type: input.type,
        due: input.due,
        depends_on: input.depends_on,
        context_notes: input.context_notes,
        scope: input.scope,
        source: input.source,
        parent_task: input.parent_task,
        timeout_minutes: input.timeout_minutes,
        tags: input.tags,
        assignee: input.assignee,
        // Dependencies take precedence: blocked > claimed > pending
        status: input.depends_on?.length ? "blocked" : (input.assignee ? "claimed" : "pending"),
      });

      // Build body
      const body = buildTaskBody(input.description, input.acceptance_criteria);

      // Build path
      const taskPath = buildTaskPath(tasksFolder, fm.id, fm.title);

      // Serialize and write — strip undefined values (js-yaml rejects them)
      const fmClean = Object.fromEntries(
        Object.entries(fm).filter(([, v]) => v !== undefined),
      ) as Record<string, unknown>;
      const content = serializeNote(fmClean, body);
      await vault.writeNote(taskPath, content, { overwrite: false });

      // Refresh dashboard
      const dashOk = await refreshDashboard(vault, tasksFolder);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            dashboard_refreshed: dashOk,
            task: {
              id: fm.id,
              title: fm.title,
              status: fm.status,
              priority: fm.priority,
              type: fm.type,
              path: taskPath,
            },
            warnings: warnings.length > 0 ? warnings : undefined,
            message: `Task created: ${fm.title} (${fm.id})`,
          }, null, 2),
        }],
      };
    },
  );
