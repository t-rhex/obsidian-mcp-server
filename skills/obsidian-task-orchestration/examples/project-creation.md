# Project Creation Example

A complete example of creating a project with dependency wiring, then monitoring it.

## Scenario

A manager agent needs to coordinate a migration from REST to GraphQL for the user service.

## Step 1: Create the Project

```
> create_project(
    title: "User Service GraphQL Migration",
    description: "Migrate the /api/users REST endpoints to GraphQL. Keep REST endpoints working during migration (dual-serve). Target: remove REST endpoints in v3.0.",
    priority: "high",
    due: "2026-03-20",
    context_notes: ["Projects/graphql-standards", "Projects/user-service-arch"],
    tags: ["migration", "graphql", "q1-2026"],
    tasks: [
      {
        "title": "Design GraphQL schema for User type",
        "type": "research",
        "description": "Define User type, queries (user, users, me), and mutations (createUser, updateUser, deleteUser). Follow patterns in Projects/graphql-standards.",
        "acceptance_criteria": [
          "Schema covers all existing REST endpoint functionality",
          "Follows project GraphQL naming conventions",
          "Schema reviewed in Projects/graphql-standards"
        ],
        "timeout_minutes": 90
      },
      {
        "title": "Set up GraphQL server and middleware",
        "type": "code",
        "description": "Add Apollo Server to the Express app. Configure middleware, error handling, and context injection (auth, db).",
        "scope": ["src/server.ts", "src/graphql/"],
        "acceptance_criteria": [
          "GraphQL endpoint available at /graphql",
          "Playground accessible in development",
          "Auth context properly injected"
        ],
        "timeout_minutes": 60
      },
      {
        "title": "Implement User resolvers",
        "type": "code",
        "depends_on_indices": [0, 1],
        "description": "Implement resolvers for all User queries and mutations defined in the schema. Reuse existing service layer.",
        "scope": ["src/graphql/resolvers/user.ts", "src/graphql/schema/user.graphql"],
        "acceptance_criteria": [
          "All queries return correct data",
          "All mutations work with proper validation",
          "Error handling matches REST API behavior"
        ],
        "timeout_minutes": 120
      },
      {
        "title": "Write GraphQL integration tests",
        "type": "code",
        "depends_on_indices": [2],
        "description": "Test all User queries and mutations via supertest against the GraphQL endpoint.",
        "scope": ["test/graphql/user.test.ts"],
        "acceptance_criteria": [
          "100% query/mutation coverage",
          "Tests cover auth and validation errors",
          "Tests run in CI"
        ],
        "timeout_minutes": 90
      },
      {
        "title": "Add deprecation warnings to REST endpoints",
        "type": "code",
        "depends_on_indices": [2],
        "description": "Add Deprecation header to all /api/users/* REST responses. Log usage for migration tracking.",
        "scope": ["src/routes/users.ts", "src/middleware/deprecation.ts"],
        "acceptance_criteria": [
          "Deprecation: true header on all /api/users responses",
          "Usage logged with endpoint and caller info"
        ],
        "timeout_minutes": 45
      },
      {
        "title": "Update API documentation",
        "type": "writing",
        "depends_on_indices": [0, 2],
        "description": "Document the new GraphQL endpoint, schema, and migration guide for consumers.",
        "acceptance_criteria": [
          "GraphQL endpoint documented with examples",
          "Migration guide for REST consumers",
          "Deprecation timeline documented"
        ],
        "timeout_minutes": 60
      }
    ]
  )
```

### Response

```json
{
  "success": true,
  "project": {
    "id": "proj-2026-03-09-m4n5o6",
    "title": "User Service GraphQL Migration",
    "priority": "high",
    "path": "Tasks/proj-2026-03-09-m4n5o6-user-service-graphql-migration.md",
    "task_count": 6
  },
  "tasks": [
    { "id": "task-2026-03-09-p1q2r3", "title": "Design GraphQL schema for User type",         "status": "pending" },
    { "id": "task-2026-03-09-s4t5u6", "title": "Set up GraphQL server and middleware",         "status": "pending" },
    { "id": "task-2026-03-09-v7w8x9", "title": "Implement User resolvers",                     "status": "blocked" },
    { "id": "task-2026-03-09-y1z2a3", "title": "Write GraphQL integration tests",              "status": "blocked" },
    { "id": "task-2026-03-09-b4c5d6", "title": "Add deprecation warnings to REST endpoints",   "status": "blocked" },
    { "id": "task-2026-03-09-e7f8g9", "title": "Update API documentation",                     "status": "blocked" }
  ],
  "summary": { "total": 6, "pending": 2, "blocked": 4, "claimed": 0 }
}
```

Tasks 0 and 1 are `pending` (no dependencies) — agents can claim them immediately.
Tasks 2-5 are `blocked` — they'll unblock automatically as dependencies complete.

### Dependency Graph

```
[0] Design schema ──────┬──► [2] Implement resolvers ──┬──► [3] Write tests
                        │                               │
[1] Set up server ──────┘                               └──► [4] Deprecation warnings

[0] Design schema ──────┬──► [5] Update docs
[2] Implement resolvers ┘
```

## Step 2: Monitor Progress

After some time, check status:

```
> get_project_status(project_id: "proj-2026-03-09-m4n5o6")

Response:
{
  "project": {
    "id": "proj-2026-03-09-m4n5o6",
    "title": "User Service GraphQL Migration",
    "priority": "high",
    "status": "in_progress"
  },
  "progress": { "completed": 2, "total": 6, "percent": 33, "all_done": false },
  "status_breakdown": {
    "pending": 0, "claimed": 0, "in_progress": 2,
    "blocked": 0, "completed": 2, "failed": 0, "cancelled": 0
  },
  "active_agents": [
    { "agent": "agent-claude-1", "task_id": "task-2026-03-09-v7w8x9", "task_title": "Implement User resolvers", "status": "in_progress" },
    { "agent": "agent-claude-2", "task_id": "task-2026-03-09-e7f8g9", "task_title": "Update API documentation", "status": "in_progress" }
  ],
  "overdue": [],
  "blockers": [],
  "message": "Project \"User Service GraphQL Migration\": 2/6 tasks completed (33%). 2 active, 0 pending, 0 blocked."
}
```

All dependencies were resolved — tasks 0 and 1 completed, which unblocked tasks 2-5. Two agents are working on the remaining tasks.

## Step 3: Handle a Failure

If task 2 (Implement User resolvers) fails:

```
> list_tasks(project: "proj-2026-03-09-m4n5o6", status: "failed")

Response:
{
  "tasks": [{
    "id": "task-2026-03-09-v7w8x9",
    "title": "Implement User resolvers",
    "status": "failed",
    "retry_count": 0
  }]
}
```

Read the Agent Log to understand why:

```
> read_note(path: "Tasks/task-2026-03-09-v7w8x9-implement-user-resolvers.md")
```

Decide to retry:

```
> update_task(task_id: "task-2026-03-09-v7w8x9", status: "pending",
    log_message: "Retrying: previous failure was due to missing db migration. Migration now applied.")
```

The task goes back to `pending` with `retry_count: 1`, and any agent can claim it.
