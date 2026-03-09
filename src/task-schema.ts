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
  | "cancelled"
  | "needs_review"
  | "revision_requested";

export type TaskPriority = "critical" | "high" | "medium" | "low";

export type TaskType = "code" | "research" | "writing" | "maintenance" | "project" | "other";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RoutingRule {
  condition: "output_contains" | "output_matches" | "status_is";
  value: string;
  activate: string[];
  deactivate?: string[];
}

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
  claimed_at?: string;
  retry_count: number;
  source: string;
  project?: string;
  parent_task?: string;
  depends_on: string[];
  scope: string[];
  context_notes: string[];
  timeout_minutes: number;
  tags: string[];
  // ─── HITL / Review fields ─────────────────────────────────────
  review_required?: boolean;
  reviewer?: string;
  feedback?: string;
  review_count: number;
  risk_level?: RiskLevel;
  // ─── Retry / Escalation fields ────────────────────────────────
  max_retries: number;
  retry_delay_minutes: number;
  escalate_to?: string;
  escalation_status: "none" | "escalated";
  // ─── Conditional workflow fields ──────────────────────────────
  routing_rules?: RoutingRule[];
}

export const VALID_STATUSES: TaskStatus[] = [
  "pending", "claimed", "in_progress", "completed", "failed", "blocked", "cancelled",
  "needs_review", "revision_requested",
];

export const VALID_PRIORITIES: TaskPriority[] = [
  "critical", "high", "medium", "low",
];

export const VALID_TYPES: TaskType[] = [
  "code", "research", "writing", "maintenance", "project", "other",
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
 * Generate a unique project ID based on date and a random suffix.
 */
export function generateProjectId(): string {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const rand = Math.random().toString(36).substring(2, 8);
  return `proj-${date}-${rand}`;
}

/**
 * Build the file path for a project note.
 */
export function buildProjectPath(tasksFolder: string, id: string, title: string): string {
  const slug = slugify(title);
  return `${tasksFolder}/${id}-${slug}.md`;
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
  const isoNow = nowISO();
  return {
    id: overrides.id ?? generateTaskId(),
    title: overrides.title,
    status: overrides.status ?? "pending",
    priority: overrides.priority ?? "medium",
    type: overrides.type ?? "other",
    assignee: overrides.assignee ?? "",
    created: overrides.created ?? isoNow,
    updated: overrides.updated ?? isoNow,
    due: overrides.due,
    claimed_at: overrides.claimed_at,
    retry_count: overrides.retry_count ?? 0,
    source: overrides.source ?? "manual",
    project: overrides.project,
    parent_task: overrides.parent_task,
    depends_on: overrides.depends_on ?? [],
    scope: overrides.scope ?? [],
    context_notes: overrides.context_notes ?? [],
    timeout_minutes: overrides.timeout_minutes ?? 60,
    tags: overrides.tags ?? [],
    // HITL
    review_required: overrides.review_required,
    reviewer: overrides.reviewer,
    feedback: overrides.feedback,
    review_count: overrides.review_count ?? 0,
    risk_level: overrides.risk_level,
    // Retry / Escalation
    max_retries: overrides.max_retries ?? 0,
    retry_delay_minutes: overrides.retry_delay_minutes ?? 5,
    escalate_to: overrides.escalate_to,
    escalation_status: overrides.escalation_status ?? "none",
    // Conditional workflows
    routing_rules: overrides.routing_rules,
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
    claimed_at: fm.claimed_at ? String(fm.claimed_at) : undefined,
    retry_count: typeof fm.retry_count === "number" ? fm.retry_count : 0,
    source: String(fm.source ?? "manual"),
    project: fm.project ? String(fm.project) : undefined,
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
    // HITL
    review_required: fm.review_required === true ? true : undefined,
    reviewer: fm.reviewer ? String(fm.reviewer) : undefined,
    feedback: fm.feedback ? String(fm.feedback) : undefined,
    review_count: typeof fm.review_count === "number" ? fm.review_count : 0,
    risk_level: (["low", "medium", "high", "critical"].includes(fm.risk_level as string)
      ? fm.risk_level
      : undefined) as RiskLevel | undefined,
    // Retry / Escalation
    max_retries: typeof fm.max_retries === "number" ? fm.max_retries : 0,
    retry_delay_minutes: typeof fm.retry_delay_minutes === "number" ? fm.retry_delay_minutes : 5,
    escalate_to: fm.escalate_to ? String(fm.escalate_to) : undefined,
    escalation_status: (["none", "escalated"].includes(fm.escalation_status as string)
      ? fm.escalation_status
      : "none") as "none" | "escalated",
    // Conditional workflows
    routing_rules: Array.isArray(fm.routing_rules)
      ? fm.routing_rules.filter(
          (r): r is RoutingRule =>
            typeof r === "object" && r !== null && "condition" in r && "value" in r && "activate" in r,
        )
      : undefined,
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

/**
 * Get current ISO datetime string (e.g. "2026-03-09T14:30:00Z").
 * Used for precise timestamps in mutations (updated, completed_at, claimed_at).
 */
export function nowISO(): string {
  return new Date().toISOString();
}

// ─── Section Editing Helpers ────────────────────────────────────────

/**
 * Case-insensitive, whitespace-tolerant heading matcher.
 * Matches "## Agent Log", "## agent log", "##  Agent Log:", etc.
 */
function findHeading(content: string, headingName: string): { index: number; length: number } | null {
  const regex = new RegExp(`^##\\s+${headingName}\\b.*$`, "mi");
  const match = regex.exec(content);
  if (!match) return null;
  return { index: match.index, length: match[0].length };
}

/**
 * Find the end boundary of a ## section (start of next ## heading or end of content).
 */
function findSectionEnd(content: string, afterHeadingIndex: number): number {
  const remaining = content.substring(afterHeadingIndex);
  const nextH2 = remaining.search(/^## /m);
  return nextH2 !== -1 ? afterHeadingIndex + nextH2 : content.length;
}

/**
 * Append a timestamped entry to the Agent Log section of a task note.
 * If no Agent Log section exists, one is created at the end.
 * The timestamp is added automatically — pass only the log text.
 */
export function appendToAgentLog(content: string, logText: string): string {
  const timestamp = new Date().toISOString().replace("T", " ").split(".")[0];
  const entry = `\n- **[${timestamp}]** ${logText}`;

  const heading = findHeading(content, "agent\\s+log");

  if (heading) {
    const sectionEnd = findSectionEnd(content, heading.index + heading.length);
    const isAtEnd = sectionEnd === content.length;

    if (isAtEnd) {
      return content.trimEnd() + "\n" + entry + "\n";
    } else {
      return (
        content.substring(0, sectionEnd).trimEnd() +
        "\n" + entry + "\n\n" +
        content.substring(sectionEnd)
      );
    }
  } else {
    // No Agent Log section — create one at the end
    return content.trimEnd() + "\n\n## Agent Log\n" + entry + "\n";
  }
}

/**
 * Append a pre-formatted entry (with its own timestamp/prefix) to the Agent Log.
 * Used by complete_task which formats its own [COMPLETED]/[FAILED] entries.
 */
export function appendRawToAgentLog(content: string, rawEntry: string): string {
  const heading = findHeading(content, "agent\\s+log");

  if (heading) {
    const sectionEnd = findSectionEnd(content, heading.index + heading.length);
    const isAtEnd = sectionEnd === content.length;

    if (isAtEnd) {
      return content.trimEnd() + "\n" + rawEntry + "\n";
    } else {
      return (
        content.substring(0, sectionEnd).trimEnd() +
        "\n" + rawEntry + "\n\n" +
        content.substring(sectionEnd)
      );
    }
  } else {
    return content.trimEnd() + "\n\n## Agent Log\n" + rawEntry + "\n";
  }
}

/**
 * Add deliverables to the Deliverables section.
 * Appends to existing deliverables rather than replacing them.
 * Creates the section before Agent Log if it doesn't exist.
 */
export function addDeliverables(content: string, deliverables: string[]): string {
  const newLines = deliverables.map((d) => `- ${d}`).join("\n");
  const heading = findHeading(content, "deliverables");

  if (heading) {
    // Append to existing section — insert before the section end
    const sectionEnd = findSectionEnd(content, heading.index + heading.length);
    const existingSection = content.substring(heading.index + heading.length, sectionEnd);
    const isAtEnd = sectionEnd === content.length;

    if (isAtEnd) {
      return content.trimEnd() + "\n" + newLines + "\n";
    } else {
      return (
        content.substring(0, sectionEnd).trimEnd() +
        "\n" + newLines + "\n\n" +
        content.substring(sectionEnd)
      );
    }
  } else {
    // Create before Agent Log if it exists, otherwise at end
    const agentLog = findHeading(content, "agent\\s+log");
    const section = `## Deliverables\n\n${newLines}\n`;

    if (agentLog) {
      return (
        content.substring(0, agentLog.index) +
        section + "\n" +
        content.substring(agentLog.index)
      );
    }
    return content.trimEnd() + "\n\n" + section;
  }
}
