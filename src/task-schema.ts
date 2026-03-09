/**
 * Task schema — types, validation, ID generation, and parsing for
 * vault-driven agent task orchestration.
 *
 * Tasks are markdown notes in the Tasks/ folder with structured YAML
 * frontmatter. Agents read, claim, update, and complete tasks through
 * the MCP tools. The vault is the single source of truth.
 */

export type TaskStatus =
  | "pending"
  | "claimed"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export type TaskPriority = "critical" | "high" | "medium" | "low";

export type TaskType = "code" | "research" | "writing" | "maintenance" | "other";

export interface TaskFrontmatter {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  type: TaskType;
  assignee: string;
  created: string;
  updated: string;
  due?: string;
  completed_at?: string;
  source: string;
  parent_task?: string;
  depends_on: string[];
  scope: string[];
  context_notes: string[];
  timeout_minutes: number;
  tags: string[];
}

export const VALID_STATUSES: TaskStatus[] = [
  "pending", "claimed", "in_progress", "completed", "failed", "blocked", "cancelled",
];

export const VALID_PRIORITIES: TaskPriority[] = [
  "critical", "high", "medium", "low",
];

export const VALID_TYPES: TaskType[] = [
  "code", "research", "writing", "maintenance", "other",
];

/**
 * Priority sort order — lower number = higher priority.
 */
export const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Generate a unique task ID based on date and a random suffix.
 */
export function generateTaskId(): string {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const rand = Math.random().toString(36).substring(2, 8);
  return `task-${date}-${rand}`;
}

/**
 * Get today's date in YYYY-MM-DD format.
 */
export function todayDate(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Build default frontmatter for a new task.
 */
export function buildTaskFrontmatter(
  overrides: Partial<TaskFrontmatter> & { title: string },
): TaskFrontmatter {
  const now = todayDate();
  return {
    id: overrides.id ?? generateTaskId(),
    title: overrides.title,
    status: overrides.status ?? "pending",
    priority: overrides.priority ?? "medium",
    type: overrides.type ?? "other",
    assignee: overrides.assignee ?? "",
    created: overrides.created ?? now,
    updated: overrides.updated ?? now,
    due: overrides.due,
    source: overrides.source ?? "manual",
    parent_task: overrides.parent_task,
    depends_on: overrides.depends_on ?? [],
    scope: overrides.scope ?? [],
    context_notes: overrides.context_notes ?? [],
    timeout_minutes: overrides.timeout_minutes ?? 60,
    tags: overrides.tags ?? [],
  };
}

/**
 * Parse raw frontmatter into a TaskFrontmatter, with lenient defaults
 * for missing fields. Returns null if the frontmatter doesn't look like
 * a task (no `id` or `status` field).
 */
export function parseTaskFrontmatter(
  fm: Record<string, unknown>,
): TaskFrontmatter | null {
  // Must have at least an id or status to be considered a task
  if (!fm.id && !fm.status) return null;

  return {
    id: String(fm.id ?? ""),
    title: String(fm.title ?? "Untitled Task"),
    status: (VALID_STATUSES.includes(fm.status as TaskStatus)
      ? fm.status
      : "pending") as TaskStatus,
    priority: (VALID_PRIORITIES.includes(fm.priority as TaskPriority)
      ? fm.priority
      : "medium") as TaskPriority,
    type: (VALID_TYPES.includes(fm.type as TaskType)
      ? fm.type
      : "other") as TaskType,
    assignee: String(fm.assignee ?? ""),
    created: String(fm.created ?? ""),
    updated: String(fm.updated ?? ""),
    due: fm.due ? String(fm.due) : undefined,
    completed_at: fm.completed_at ? String(fm.completed_at) : undefined,
    source: String(fm.source ?? "manual"),
    parent_task: fm.parent_task ? String(fm.parent_task) : undefined,
    depends_on: Array.isArray(fm.depends_on)
      ? fm.depends_on.map(String)
      : [],
    scope: Array.isArray(fm.scope) ? fm.scope.map(String) : [],
    context_notes: Array.isArray(fm.context_notes)
      ? fm.context_notes.map(String)
      : [],
    timeout_minutes: typeof fm.timeout_minutes === "number"
      ? fm.timeout_minutes
      : 60,
    tags: Array.isArray(fm.tags)
      ? fm.tags.filter((t): t is string => typeof t === "string")
      : [],
  };
}

/**
 * Build the markdown body template for a new task.
 */
export function buildTaskBody(
  description: string,
  acceptanceCriteria?: string[],
): string {
  const parts: string[] = [];

  parts.push("## Description");
  parts.push("");
  parts.push(description || "_No description provided._");
  parts.push("");

  if (acceptanceCriteria && acceptanceCriteria.length > 0) {
    parts.push("## Acceptance Criteria");
    parts.push("");
    for (const criterion of acceptanceCriteria) {
      parts.push(`- [ ] ${criterion}`);
    }
    parts.push("");
  }

  parts.push("## Agent Log");
  parts.push("");
  parts.push("<!-- Agents append their progress updates here -->");
  parts.push("");

  return parts.join("\n");
}

/**
 * Build a filename-safe slug from a task title.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 60);
}

/**
 * Build the file path for a task note.
 */
export function buildTaskPath(tasksFolder: string, id: string, title: string): string {
  const slug = slugify(title);
  return `${tasksFolder}/${id}-${slug}.md`;
}
