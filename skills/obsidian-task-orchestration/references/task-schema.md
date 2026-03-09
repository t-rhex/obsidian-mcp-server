# Task Schema Reference

Every task is a markdown note in the `Tasks/` folder with YAML frontmatter. This document defines every field.

## Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique identifier. Auto-generated as `task-YYYY-MM-DD-xxxxxx`. |
| `title` | `string` | Short, descriptive title. Used in filenames and dashboards. |
| `status` | `TaskStatus` | Current state. See state-machine.md for valid transitions. |
| `priority` | `TaskPriority` | `critical`, `high`, `medium`, `low`. Default: `medium`. |
| `type` | `TaskType` | `code`, `research`, `writing`, `maintenance`, `project`, `other`. Default: `other`. |
| `created` | `string` | ISO 8601 datetime when the task was created. |
| `updated` | `string` | ISO 8601 datetime of last modification. |

## Identity & Tracking Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `assignee` | `string` | `""` | Agent ID that claimed this task. Empty when unclaimed. |
| `source` | `string` | `"manual"` | Origin of the task: `manual`, `github-issue-42`, `agent-spawned`, etc. |
| `retry_count` | `number` | `0` | How many times this task has been retried after failure. |
| `claimed_at` | `string?` | — | ISO 8601 datetime when the task was claimed. Used for timeout detection. |
| `completed_at` | `string?` | — | ISO 8601 datetime when the task reached a terminal state. |

## Relationship Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `project` | `string?` | — | Project ID this task belongs to (e.g. `proj-2026-03-09-abc123`). |
| `parent_task` | `string?` | — | Parent task ID if this is a sub-task. |
| `depends_on` | `string[]` | `[]` | Task IDs that must complete before this task can be claimed. |

## Advisory Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `scope` | `string[]` | `[]` | File paths this task intends to modify. Not enforced — advisory for conflict detection. |
| `context_notes` | `string[]` | `[]` | Vault note paths that provide context (e.g. `Projects/my-api`). |
| `timeout_minutes` | `number` | `60` | Max minutes before an agent is considered stuck. Used by `get_project_status` for overdue detection. |
| `due` | `string?` | — | Deadline in `YYYY-MM-DD` format. |
| `tags` | `string[]` | `[]` | Freeform tags for categorization. |

## Task Body Sections

The markdown body of a task note follows this structure:

```markdown
## Description

What needs to be done, with full context.

## Acceptance Criteria

- [ ] First criterion
- [ ] Second criterion

## Deliverables

- src/auth/jwt.ts
- test/auth/jwt.test.ts

## Agent Log

<!-- Agents append their progress updates here -->
- **[2026-03-09 14:30:00]** Claimed task. Reading context notes.
- **[2026-03-09 14:45:00]** Implemented JWT signing with RS256.
- **[2026-03-09 15:00:00]** [COMPLETED] All acceptance criteria met.
```

## Type Definitions

```typescript
type TaskStatus = "pending" | "claimed" | "in_progress" | "completed"
                | "failed" | "blocked" | "cancelled";

type TaskPriority = "critical" | "high" | "medium" | "low";

type TaskType = "code" | "research" | "writing" | "maintenance"
              | "project" | "other";
```

## ID Formats

- **Task ID**: `task-YYYY-MM-DD-xxxxxx` (e.g. `task-2026-03-09-a7b3c2`)
- **Project ID**: `proj-YYYY-MM-DD-xxxxxx` (e.g. `proj-2026-03-09-x1y2z3`)
- The 6-char suffix is random alphanumeric (base-36).

## File Path Convention

Task notes are stored at: `Tasks/{id}-{slug}.md`

The slug is derived from the title: lowercase, non-alphanumeric characters replaced with hyphens, max 60 characters. Example: `Tasks/task-2026-03-09-a7b3c2-implement-jwt-auth.md`
