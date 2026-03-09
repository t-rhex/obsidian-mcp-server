# Worker Workflow Example

A complete end-to-end session of an agent claiming and completing a task.

## Scenario

Agent `agent-claude-1` picks up a coding task from the vault.

## Step 1: Find Available Work

```
> list_tasks(status: "pending", type: "code")

Response:
{
  "tasks": [
    {
      "id": "task-2026-03-09-a7b3c2",
      "title": "Add input validation to /api/users",
      "priority": "high",
      "type": "code",
      "project": "proj-2026-03-09-x1y2z3",
      "depends_on": [],
      "path": "Tasks/task-2026-03-09-a7b3c2-add-input-validation-to-api-users.md"
    },
    {
      "id": "task-2026-03-09-d4e5f6",
      "title": "Write unit tests for auth module",
      "priority": "medium",
      "type": "code",
      "project": null,
      "depends_on": [],
      "path": "Tasks/task-2026-03-09-d4e5f6-write-unit-tests-for-auth-module.md"
    }
  ],
  "count": 2
}
```

The first task is high priority and part of a project. Claim it.

## Step 2: Claim the Task

```
> claim_task(task_id: "task-2026-03-09-a7b3c2", assignee: "agent-claude-1")

Response:
{
  "success": true,
  "task": {
    "id": "task-2026-03-09-a7b3c2",
    "title": "Add input validation to /api/users",
    "status": "claimed",
    "assignee": "agent-claude-1",
    "claimed_at": "2026-03-09T14:00:00.000Z"
  }
}
```

## Step 3: Read the Full Task

```
> read_note(path: "Tasks/task-2026-03-09-a7b3c2-add-input-validation-to-api-users.md")

Response:
---
id: task-2026-03-09-a7b3c2
title: Add input validation to /api/users
status: claimed
priority: high
type: code
assignee: agent-claude-1
project: proj-2026-03-09-x1y2z3
scope:
  - src/routes/users.ts
  - src/validators/user.ts
context_notes:
  - Projects/api-v2-design
timeout_minutes: 60
---

## Description

Add Zod validation to the POST /api/users endpoint. Currently accepts any body.
Must validate: email (valid format), name (1-100 chars), role (admin|user|viewer).

## Acceptance Criteria

- [ ] POST /api/users returns 400 with validation errors for invalid input
- [ ] Valid input still creates the user successfully
- [ ] Error response includes field-level error messages

## Agent Log

<!-- Agents append their progress updates here -->
```

Now read the context note for more background:

```
> read_note(path: "Projects/api-v2-design.md")
```

## Step 4: Start Working and Log Progress

```
> update_task(task_id: "task-2026-03-09-a7b3c2", status: "in_progress",
    log_message: "Reading api-v2-design for schema requirements. Will add Zod schemas to src/validators/user.ts.")
```

(Agent does the actual coding work here — edits files, runs tests, etc.)

```
> update_task(task_id: "task-2026-03-09-a7b3c2",
    log_message: "Created UserCreateSchema with email, name, role validation. Added middleware to POST /api/users.")
```

(Agent runs tests to verify.)

```
> update_task(task_id: "task-2026-03-09-a7b3c2",
    log_message: "All 3 acceptance criteria passing. Running full test suite before completing.")
```

## Step 5: Complete the Task

```
> complete_task(
    task_id: "task-2026-03-09-a7b3c2",
    status: "completed",
    summary: "Added Zod validation to POST /api/users. Validates email format, name length (1-100), and role enum. Returns 400 with field-level errors on invalid input.",
    deliverables: [
      "src/validators/user.ts",
      "src/routes/users.ts",
      "test/routes/users.test.ts"
    ]
  )

Response:
{
  "success": true,
  "task": {
    "id": "task-2026-03-09-a7b3c2",
    "status": "completed",
    "completed_at": "2026-03-09T14:42:00.000Z"
  },
  "unblocked": ["task-2026-03-09-g7h8i9"],
  "message": "Task completed. 1 dependent task unblocked."
}
```

The `unblocked` field shows that completing this task unblocked another task that was waiting on it.

## Step 6: Pick Up Next Task

The worker loops back to Step 1 and looks for the next available task.

## Failure Scenario

If the agent encounters an unrecoverable problem:

```
> complete_task(
    task_id: "task-2026-03-09-a7b3c2",
    status: "failed",
    summary: "Cannot add validation: the users route uses a custom request parser that doesn't support middleware. Needs refactoring first."
  )
```

A manager can then retry the task (which sends it back to `pending` with `retry_count: 1`) or create a new prerequisite task to fix the underlying issue.
