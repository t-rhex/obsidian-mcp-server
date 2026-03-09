# Project Decomposition Guide

## What Is a Project?

A project is a task note with `type: "project"` that groups related sub-tasks. The project note holds the high-level description and goals. Sub-tasks reference it via `project: "proj-..."` and contain the actual work.

Projects are created atomically with `create_project` — the project note and all sub-tasks are created in a single call. Dependencies between sub-tasks are wired via `depends_on_indices`.

## Decomposition Principles

### 1. Each Task Should Be Independently Claimable

A sub-task should make sense to an agent reading it in isolation. Include enough context in the description and `context_notes` so the agent doesn't need to read the project note to start working.

**Good**: "Implement JWT token signing using RS256. See `Projects/auth-design` for the API schema."
**Bad**: "Do the next step."

### 2. Minimize Dependencies

The more dependencies between tasks, the more sequential (and slower) the project becomes. Aim for a wide, shallow dependency graph:

```
Good: Fan-out pattern           Bad: Sequential chain
     ┌─ Task B                  Task A → Task B → Task C → Task D
A ───┼─ Task C
     └─ Task D
```

### 3. Use Scope to Prevent Conflicts

When two tasks modify the same files, either:
- Add a dependency between them (`depends_on_indices`)
- Give them non-overlapping `scope` arrays

```json
{ "title": "Refactor auth module", "scope": ["src/auth/"] },
{ "title": "Add rate limiting",    "scope": ["src/middleware/"] }
```

### 4. Right-Size Your Tasks

Too granular = overhead from many small claims. Too large = blocked for a long time.

| Task Size | Good For | Example |
|-----------|----------|---------|
| 15-30 min | Focused code changes | "Add validation to /api/users endpoint" |
| 30-60 min | Features with tests | "Implement JWT signing + unit tests" |
| 1-2 hours | Complex features | "Design and implement refresh token rotation" |
| > 2 hours | Should be split further | Break into sub-tasks |

## Dependency Patterns

### Fan-Out (Parallel Start)

All tasks can start immediately. Good for independent work streams.

```
create_project(
  title: "API Hardening",
  tasks: [
    { title: "Add input validation",    type: "code" },
    { title: "Add rate limiting",       type: "code" },
    { title: "Add request logging",     type: "code" },
    { title: "Write security tests",    type: "code" }
  ]
)
```

### Pipeline (Sequential)

Each task depends on the previous. Use when work must be done in order.

```
create_project(
  title: "Database Migration",
  tasks: [
    { title: "Design new schema",         type: "research" },
    { title: "Write migration scripts",   type: "code", depends_on_indices: [0] },
    { title: "Run migration in staging",  type: "maintenance", depends_on_indices: [1] },
    { title: "Verify data integrity",     type: "code", depends_on_indices: [2] }
  ]
)
```

### Diamond (Converging Parallels)

Multiple parallel tracks converge at a final task.

```
create_project(
  title: "Release v2.0",
  tasks: [
    { title: "Implement feature A",    type: "code" },
    { title: "Implement feature B",    type: "code" },
    { title: "Update documentation",   type: "writing" },
    { title: "Integration testing",    type: "code", depends_on_indices: [0, 1] },
    { title: "Write release notes",    type: "writing", depends_on_indices: [0, 1, 2] }
  ]
)
```

### Research-Then-Execute

A research phase informs the implementation phase.

```
create_project(
  title: "Performance Optimization",
  tasks: [
    { title: "Profile current performance",  type: "research" },
    { title: "Identify top 3 bottlenecks",   type: "research", depends_on_indices: [0] },
    { title: "Fix bottleneck 1",             type: "code", depends_on_indices: [1] },
    { title: "Fix bottleneck 2",             type: "code", depends_on_indices: [1] },
    { title: "Fix bottleneck 3",             type: "code", depends_on_indices: [1] },
    { title: "Verify performance gains",     type: "code", depends_on_indices: [2, 3, 4] }
  ]
)
```

## Monitoring a Project

### Regular Check-Ins

Call `get_project_status(project_id)` to see:

- **Progress**: `completed/total` with percentage
- **Active agents**: Who's working on what
- **Overdue tasks**: Agents that may be stuck (exceeded `timeout_minutes`)
- **Blockers**: Tasks waiting on incomplete dependencies

### What to Do When Things Go Wrong

| Situation | Action |
|-----------|--------|
| Task failed | Read Agent Log, decide to retry or cancel. `update_task(status: "pending")` to retry. |
| Agent stuck (overdue) | Contact the agent or unclaim the task: `update_task(status: "pending")`. |
| Blocker discovered | Add a new task to resolve the blocker, wire it as a dependency. |
| Scope conflict | Check for overlapping `scope` arrays. Add dependencies if needed. |
| All tasks done | Project auto-detects completion. No explicit action needed. |

### Creating Follow-Up Tasks

If a completed task reveals more work, create a sub-task linked to the project via `parent_task`:

```
create_task(
  title: "Handle edge case in JWT expiry",
  description: "Discovered during task-2026-03-09-abc123: ...",
  parent_task: "proj-2026-03-09-xyz789",
  source: "agent-spawned"
)
```

This links the new task to the existing project via the `parent_task` field. It will appear in `get_project_status` rollups.
