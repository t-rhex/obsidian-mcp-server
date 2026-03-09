---
name: obsidian-task-orchestration
description: "Use when managing tasks, projects, multi-agent workflows, or knowledge persistence in an Obsidian vault via MCP. This skill should be used when creating tasks, claiming work, updating progress, completing deliverables, decomposing projects into sub-tasks, monitoring project status, logging decisions or discoveries, or starting a new session that needs context about ongoing work. Triggers on: get_context, create_task, list_tasks, claim_task, update_task, complete_task, create_project, get_project_status, log_decision, log_discovery."
---

# Obsidian Task Orchestration

Drive multi-agent task workflows through an Obsidian vault. Tasks are markdown notes with structured YAML frontmatter. The vault is the single source of truth — no external database, no API. Agents read, claim, update, and complete tasks through MCP tools.

This skill covers three roles: **Worker** (claim and execute tasks), **Manager** (create projects, monitor progress, handle failures), and **Assistant** (vault queries, daily notes, organization). All roles share a **context-first** discipline: start every session by calling `get_context`.

## Start Every Session Here

```
get_context()
```

This returns a structured briefing: active projects, in-progress work, pending tasks, blockers, failures, recent decisions, recent discoveries, and pinned context notes. Read it before doing anything else. If you're focused on a specific project:

```
get_context(project_id: "proj-2026-03-09-xyz789")
```

## MCP Tools Reference

### Context & Knowledge Tools

| Tool | Purpose | Key Parameters |
|------|---------|---------------|
| `get_context` | Session briefing — active work, blockers, recent decisions/discoveries | `project_id?`, `hours?` (default: 48) |
| `log_decision` | Record an architectural/design decision with rationale | `title`, `context`, `decision`, `alternatives?`, `consequences?` |
| `log_discovery` | Record a gotcha, TIL, or finding for future agents | `title`, `discovery`, `impact?`, `recommendation?`, `category?` |

### Task Tools

| Tool | Purpose | Key Parameters |
|------|---------|---------------|
| `create_task` | Create a task note | `title`, `description`, `priority`, `type`, `depends_on`, `scope`, `acceptance_criteria` |
| `list_tasks` | Query tasks by filters | `status`, `priority`, `type`, `assignee`, `project`, `exclude_projects` |
| `claim_task` | Atomically claim a pending task | `task_id`, `assignee` |
| `update_task` | Update status, append to agent log | `task_id`, `status`, `log_entry` |
| `complete_task` | Mark done with deliverables | `task_id`, `deliverables`, `summary`, `status` (completed/failed) |
| `create_project` | Create project with sub-tasks | `title`, `description`, `tasks[]` with `depends_on_indices` |
| `get_project_status` | Rollup progress and blockers | `project_id` |

### Supporting Vault Tools

| Tool | When to Use |
|------|------------|
| `read_note` | Read a task note's full content and frontmatter |
| `search_vault` | Find tasks or notes by content keywords |
| `daily_note` | Append progress summaries to daily notes |
| `manage_tags` | Tag tasks for categorization |
| `wikilinks` | Find backlinks to a task or project note |

## Context-First Discipline

### Log Decisions When You Make Them

Whenever you choose between approaches, reject an alternative, or commit to an architecture:

```
log_decision(
  title: "Use Zod v4 over io-ts for validation",
  context: "Need runtime validation for MCP tool inputs. Must work with TypeScript 5.7+.",
  decision: "Use Zod v4. Better TS inference, smaller bundle, more active maintenance.",
  alternatives: ["io-ts — heavier, less ergonomic", "joi — no native TS support"],
  consequences: ["Positive: z.infer gives us types for free", "Negative: Zod v4 has breaking changes from v3"],
  tags: ["validation", "dependencies"]
)
```

### Log Discoveries When You Find Them

Whenever you discover a gotcha, workaround, environment quirk, or non-obvious behavior:

```
log_discovery(
  title: "gray-matter crashes on undefined values in frontmatter",
  discovery: "js-yaml (used by gray-matter) throws when serializing objects with undefined values. Must strip them before calling serializeNote().",
  impact: "high",
  recommendation: "Always filter frontmatter through Object.entries().filter() before serialization.",
  category: "bug",
  tags: ["yaml", "gray-matter", "serialization"],
  related_files: ["src/frontmatter.ts"]
)
```

### Why This Matters

Without these records, the next agent (or your next session) will:
1. Re-evaluate decisions you already made
2. Re-discover bugs you already found
3. Choose approaches you already rejected
4. Waste time on problems you already solved

## Worker Workflow

### 1. Get Context

```
get_context()
```

Read the briefing. Check for active work you might be resuming, recent failures that need retrying, and relevant decisions/discoveries.

### 2. Find Available Work

```
list_tasks(status: "pending", priority: "critical")
list_tasks(status: "pending", type: "code")
```

Always check for critical tasks first. Filter by `type` if you specialize (code, research, writing).

### 3. Claim a Task

```
claim_task(task_id: "task-2026-03-09-abc123", assignee: "agent-claude-1")
```

Claiming is atomic — if another agent claims first, you get an error. Move on to the next task. Never skip claiming; working on unclaimed tasks causes conflicts.

### 4. Read the Full Task

```
read_note(path: "Tasks/task-2026-03-09-abc123-implement-jwt.md")
```

Read the full note to understand description, acceptance criteria, context notes, and scope.

### 5. Log Progress as You Work

```
update_task(task_id: "task-2026-03-09-abc123", status: "in_progress",
  log_entry: "Starting JWT implementation. Reading auth module at src/auth/.")
```

Log meaningful progress — what you're doing, what you found, decisions made. These entries are timestamped and visible to managers.

### 6. Log Decisions and Discoveries Along the Way

If you choose a library, discover a bug, or find a non-obvious pattern — log it immediately. Don't wait until the task is complete.

### 7. Complete the Task

```
complete_task(task_id: "task-2026-03-09-abc123",
  status: "completed",
  summary: "Implemented JWT auth with RS256 signing, refresh token rotation, and rate limiting.",
  deliverables: ["src/auth/jwt.ts", "src/auth/refresh.ts", "test/auth/jwt.test.ts"])
```

If you fail, be honest:

```
complete_task(task_id: "task-2026-03-09-abc123",
  status: "failed",
  summary: "Cannot implement — dependency on external API that returns 503.")
```

## Manager Workflow

### 1. Get Context

```
get_context()
```

Check what's active, what's blocked, what failed, what was recently decided.

### 2. Decompose Work into Projects

```
create_project(
  title: "Auth System Rewrite",
  description: "Replace session-based auth with JWT. Must support refresh tokens and rate limiting.",
  priority: "high",
  tasks: [
    { title: "Design API schema", type: "research", description: "..." },
    { title: "Implement JWT service", type: "code", depends_on_indices: [0], description: "..." },
    { title: "Add refresh token rotation", type: "code", depends_on_indices: [1], description: "..." },
    { title: "Write integration tests", type: "code", depends_on_indices: [1], description: "..." },
    { title: "Update API documentation", type: "writing", depends_on_indices: [1, 2], description: "..." }
  ]
)
```

### 3. Monitor Progress

```
get_project_status(project_id: "proj-2026-03-09-xyz789")
```

Returns: progress percentage, status breakdown, active agents, overdue tasks, and blockers.

### 4. Handle Failures

When a task fails:

1. Read the Agent Log in the task note for details
2. Check recent discoveries — the failure root cause may already be documented
3. Retry or cancel:

```
update_task(task_id: "task-...", status: "pending",
  log_entry: "Retrying: previous failure was transient API timeout.")
```

### 5. Log Strategic Decisions

When you make project-level decisions (scope changes, priority shifts, approach pivots):

```
log_decision(
  title: "Defer rate limiting to v2",
  context: "Rate limiting requires Redis, which adds infrastructure complexity.",
  decision: "Ship JWT auth without rate limiting in v1. Add it in v2.",
  project: "proj-2026-03-09-xyz789"
)
```

## Assistant Workflow

### Daily Standup Summary

1. `get_context(hours: 24)` — get the last 24 hours of activity
2. Append summary to `daily_note(action: "append", content: "## Task Summary\n...")`

### Finding Related Work

Use `wikilinks(action: "backlinks", path: "Projects/auth-system")` to find all notes that reference a project. Use `search_vault` to find decisions or discoveries by keyword.

## Guardrails

1. **Start with `get_context`.** Every new session. No exceptions. This is how you avoid duplicating work or missing context.
2. **Always claim before working.** Never start work on a task you haven't claimed. The claim is your lock.
3. **Log decisions and discoveries immediately.** Don't batch them. The moment you make a choice or discover something, persist it.
4. **Log progress frequently.** Silent agents are indistinguishable from stuck agents. Log at least when starting, at key milestones, and when done.
5. **Respect scope.** The `scope` field lists files a task intends to modify. If two tasks have overlapping scope, they should have a dependency between them.
6. **Don't skip status transitions.** Follow the state machine: pending -> claimed -> in_progress -> completed. See `references/state-machine.md` for all valid transitions.
7. **Use `complete_task`, not `update_task`, for terminal states.** `complete_task` handles deliverables, unblocks dependents, and refreshes the dashboard.
8. **Failed is not final.** A failed task can be retried by moving it back to pending. Include the failure reason so the next agent knows what happened.
9. **Projects are containers, not tasks.** Don't claim or complete a project directly. Complete its sub-tasks. The project status is a rollup.

## References

- `references/task-schema.md` — All frontmatter fields with types, defaults, and descriptions
- `references/state-machine.md` — Valid status transitions, error codes, and edge cases
- `references/project-guide.md` — Project decomposition patterns and dependency strategies
- `examples/worker-workflow.md` — Complete end-to-end worker session
- `examples/project-creation.md` — Real project decomposition with dependency wiring
