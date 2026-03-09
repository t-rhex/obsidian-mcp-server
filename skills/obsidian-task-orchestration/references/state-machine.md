# Task State Machine

## Status Transitions

```
                    ┌──────────┐
         ┌─────────│  pending  │◄──────────────┐
         │         └──────────┘                │
         │           │      │                  │
         │     claim │      │ block            │ reopen/retry/
         │           ▼      ▼                  │ reactivate/unclaim
         │    ┌─────────┐ ┌─────────┐          │
         │    │ claimed  │ │ blocked │──────────┤
         │    └─────────┘ └─────────┘          │
  cancel │      │    │                         │
         │ start│    │ unclaim                 │
         │      ▼    └────────────────────────►│
         │  ┌────────────┐                     │
         ├──│in_progress │─────────────────────┤
         │  └────────────┘                     │
         │      │       │                      │
         │  done│   fail│                      │
         │      ▼       ▼                      │
         │ ┌──────────┐ ┌────────┐             │
         └►│completed │ │ failed │─────────────┘
           └──────────┘ └────────┘
                │
                │ reopen
                └──────────────────────────────┘
```

## Valid Transitions Table

| From | To | Action | Side Effects |
|------|----|--------|-------------|
| `pending` | `claimed` | Agent calls `claim_task` | Sets `assignee`, `claimed_at` |
| `pending` | `blocked` | Dependency added | — |
| `pending` | `cancelled` | Manager cancels | — |
| `claimed` | `in_progress` | Agent calls `update_task` | — |
| `claimed` | `pending` | Unclaim (agent gives up) | Clears `assignee`, `claimed_at` |
| `claimed` | `blocked` | Blocker discovered | — |
| `claimed` | `cancelled` | Manager cancels | — |
| `in_progress` | `completed` | Agent calls `complete_task` | Sets `completed_at`, unblocks dependents |
| `in_progress` | `failed` | Agent calls `complete_task(status: "failed")` | Sets `completed_at` |
| `in_progress` | `blocked` | Blocker discovered | — |
| `in_progress` | `pending` | Agent unclaims | Clears `assignee` |
| `in_progress` | `cancelled` | Manager cancels | — |
| `blocked` | `pending` | Dependencies met / unblocked | Auto-triggered by `complete_task` on dependency |
| `blocked` | `cancelled` | Manager cancels | — |
| `completed` | `pending` | Reopen task | Clears `assignee`, `completed_at` |
| `failed` | `pending` | Retry | Clears `assignee`, increments `retry_count` |
| `cancelled` | `pending` | Reactivate | — |

## Error Codes

| Error | When | Resolution |
|-------|------|-----------|
| `TASK_NOT_FOUND` | Task ID doesn't match any note in Tasks/ | Check the ID with `list_tasks` |
| `ALREADY_CLAIMED` | Another agent claimed the task first | Pick a different task |
| `INVALID_TRANSITION` | Status change violates state machine | Check the transition table above |
| `NOT_A_PROJECT` | `get_project_status` called on a non-project task | Use `list_tasks(type: "project")` to find projects |
| `PROJECT_NOT_FOUND` | Project ID doesn't exist | Verify with `list_tasks(type: "project")` |
| `INVALID_DEPENDENCY_INDEX` | `depends_on_indices` out of range in `create_project` | Indices are 0-based, must be < array length |
| `SELF_DEPENDENCY` | Task depends on itself | Remove the self-referencing index |

## Automatic Behaviors

### Dependency Unblocking

When `complete_task` marks a task as `completed`, it scans all tasks in the same project for those that have the completed task in their `depends_on` list. If all of a blocked task's dependencies are now completed, the blocked task is automatically moved to `pending`.

### Dashboard Refresh

Every mutation (`create_task`, `claim_task`, `update_task`, `complete_task`, `create_project`) refreshes the task dashboard at `Tasks/Dashboard.md`. This is a generated overview with task counts by status, priority, and recent activity.

### Retry Semantics

Moving a `failed` task back to `pending`:
- Clears `assignee` (so any agent can claim it)
- Increments `retry_count`
- The failure reason remains in the Agent Log for the next agent to read

### Timeout Detection

`get_project_status` compares `claimed_at` + `timeout_minutes` against the current time. Tasks exceeding their timeout appear in the `overdue` array. The system does NOT auto-unclaim — a manager must decide how to handle overdue tasks.
