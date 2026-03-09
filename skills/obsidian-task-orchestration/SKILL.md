---
name: obsidian-task-orchestration
description: "Use when managing tasks, projects, or multi-agent workflows in an Obsidian vault via MCP. This skill should be used when creating tasks, claiming work, updating progress, completing deliverables, decomposing projects into sub-tasks, or monitoring project status through the mcp-obsidian-vault task tools (create_task, list_tasks, claim_task, update_task, complete_task, create_project, get_project_status)."
---

# Obsidian Task Orchestration

Drive multi-agent task workflows through an Obsidian vault. Tasks are markdown notes with structured YAML frontmatter. The vault is the single source of truth — no external database, no API. Agents read, claim, update, and complete tasks through MCP tools.

This skill covers three roles: **Worker** (claim and execute tasks), **Manager** (create projects, monitor progress, handle failures), and **Assistant** (vault queries, daily notes, organization).

## MCP Tools Reference

### Task Tools

| Tool | Purpose | Key Parameters |
|------|---------|---------------|
| `create_task` | Create a task note | `title`, `description`, `priority`, `type`, `depends_on`, `scope`, `acceptance_criteria` |
| `list_tasks` | Query tasks by filters | `status`, `priority`, `type`, `assignee`, `project`, `exclude_projects` |
| `claim_task` | Atomically claim a pending task | `task_id`, `assignee` |
| `update_task` | Update status, append to agent log | `task_id`, `status`, `log_message` |
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

## Worker Workflow

Use this workflow when you are an agent executing a specific task.

### 1. Find Available Work

```
list_tasks(status: "pending", priority: "critical")
list_tasks(status: "pending", type: "code")
```

Always check for critical tasks first. Filter by `type` if you specialize (code, research, writing).

### 2. Claim a Task

```
claim_task(task_id: "task-2026-03-09-abc123", assignee: "agent-claude-1")
```

Claiming is atomic — if another agent claims first, you get an error. Move on to the next task. Never skip claiming; working on unclaimed tasks causes conflicts.

### 3. Read the Full Task

```
read_note(path: "Tasks/task-2026-03-09-abc123-implement-jwt.md")
```

Read the full note to understand description, acceptance criteria, context notes, and scope. Check `depends_on` — if dependencies aren't met, the claim will have been rejected.

### 4. Log Progress as You Work

```
update_task(task_id: "task-2026-03-09-abc123", status: "in_progress",
  log_message: "Starting JWT implementation. Reading auth module at src/auth/.")
```

Log meaningful progress — what you're doing, what you found, decisions made. These entries are timestamped and visible to managers.

### 5. Complete the Task

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

Failed tasks can be retried. The `retry_count` increments automatically.

### 6. Handle Blocked Tasks

If you discover a blocker mid-work:

```
update_task(task_id: "task-2026-03-09-abc123", status: "blocked",
  log_message: "Blocked: need database migration from task-2026-03-09-def456 to complete first.")
```

## Manager Workflow

Use this workflow when orchestrating work across multiple agents.

### 1. Decompose Work into Projects

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

`depends_on_indices` references other tasks in the same array by index. Tasks with unmet dependencies start as `blocked` and unblock automatically when their dependencies complete.

### 2. Monitor Progress

```
get_project_status(project_id: "proj-2026-03-09-xyz789")
```

Returns: progress percentage, status breakdown, active agents, overdue tasks, and blockers. Check regularly and act on blockers.

### 3. Handle Failures

When a task fails:

1. Check the Agent Log in the task note for details
2. Either retry (the task goes back to `pending` with incremented `retry_count`) or cancel it
3. If a failed task blocks others, those remain blocked until the failed task is resolved

```
update_task(task_id: "task-...", status: "pending",
  log_message: "Retrying: previous failure was transient API timeout.")
```

### 4. Use list_tasks for Dashboard Queries

```
list_tasks(status: "failed")                          # What broke?
list_tasks(status: "in_progress")                     # Who's working?
list_tasks(project: "proj-2026-03-09-xyz789")         # All tasks in a project
list_tasks(assignee: "agent-claude-1")                # What's this agent doing?
list_tasks(exclude_projects: true, status: "pending") # Standalone tasks only
```

## Assistant Workflow

Use this workflow for vault organization, daily summaries, and note management.

### Daily Standup Summary

1. `list_tasks(status: "completed")` — what finished recently
2. `list_tasks(status: "in_progress")` — what's active
3. `list_tasks(status: "blocked")` — what needs attention
4. Append summary to `daily_note(action: "append", content: "## Task Summary\n...")`

### Tag Management

Use `manage_tags` on task notes for cross-cutting concerns:

```
manage_tags(path: "Tasks/task-...", action: "add", tags: ["sprint-4", "backend"])
```

### Finding Related Work

Use `wikilinks(action: "backlinks", path: "Projects/auth-system")` to find all notes that reference a project.

## Guardrails

1. **Always claim before working.** Never start work on a task you haven't claimed. The claim is your lock.
2. **Log progress frequently.** Silent agents are indistinguishable from stuck agents. Log at least when starting, at key milestones, and when done.
3. **Respect scope.** The `scope` field lists files a task intends to modify. If two tasks have overlapping scope, they should have a dependency between them.
4. **Don't skip status transitions.** Follow the state machine: pending -> claimed -> in_progress -> completed. See `references/state-machine.md` for all valid transitions.
5. **Use `complete_task`, not `update_task`, for terminal states.** `complete_task` handles deliverables, unblocks dependents, and refreshes the dashboard.
6. **Failed is not final.** A failed task can be retried by moving it back to pending. Include the failure reason so the next agent knows what happened.
7. **Projects are containers, not tasks.** Don't claim or complete a project directly. Complete its sub-tasks. The project status is a rollup.
8. **Set realistic timeouts.** The `timeout_minutes` field (default: 60) helps managers detect stuck agents. Set it based on task complexity.

## References

- `references/task-schema.md` — All frontmatter fields with types, defaults, and descriptions
- `references/state-machine.md` — Valid status transitions, error codes, and edge cases
- `references/project-guide.md` — Project decomposition patterns and dependency strategies
- `examples/worker-workflow.md` — Complete end-to-end worker session
- `examples/project-creation.md` — Real project decomposition with dependency wiring
