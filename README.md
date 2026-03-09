# mcp-obsidian-vault

An MCP (Model Context Protocol) server that gives AI assistants direct filesystem access to your Obsidian vault. No Obsidian running required — reads and writes markdown files directly on disk.

## Features

- **Read, create, update, delete notes** with YAML frontmatter support
- **Wikilinks** — resolve `[[links]]`, find backlinks, outlinks, and broken links
- **Full-text search** across your vault with regex support and timeout protection
- **Browse vault structure** with recursive listing and depth control
- **Tag management** — read, add, remove tags from frontmatter (deduplicates automatically)
- **Daily notes** — get, create, or append by date (`today`, `yesterday`, `2025-03-08`, etc.)
- **Git sync (optional)** — commit, pull, push, and full sync via git CLI. Auto-sync after every write pushes to remote automatically. Git is entirely optional — the server works perfectly without it.
- **Task orchestration** — create, claim, update, and complete tasks with structured frontmatter. Turn your vault into an agent task queue with dependency tracking, scope isolation, and auto-generated dashboards.

## Installation

```bash
npx mcp-obsidian-vault
```

Or install globally:

```bash
npm install -g mcp-obsidian-vault
```

## Quick Start

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "mcp-obsidian-vault"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/vault"
      }
    }
  }
}
```

### With git auto-sync

Enable `GIT_AUTO_SYNC` to automatically commit and push to remote after every write. Requires the vault to be a git repo with a remote configured. If no remote is configured, changes are committed locally only.

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "mcp-obsidian-vault"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/vault",
        "GIT_AUTO_SYNC": "true"
      }
    }
  }
}
```

### Without git (notes only)

If you don't need git sync at all, just set `OBSIDIAN_VAULT_PATH` — that's it. The `git_sync` tool will still be available but won't do anything unless your vault is a git repo. No git installation required for basic note operations.

### From source

```bash
git clone https://github.com/t-rhex/obsidian-mcp-server.git
cd obsidian-mcp-server
npm install
npm run build
OBSIDIAN_VAULT_PATH=/path/to/vault node build/index.js
```

## Tools

### `read_note`

Read a note's content, frontmatter, tags, and file metadata.

```
path: "Projects/my-note.md"     # .md added automatically if missing
includeRaw: false                # include unparsed content
```

### `create_note`

Create a new note with optional YAML frontmatter. Parent folders are created automatically.

```
path: "Projects/new-idea"
content: "# My Idea\n\nSome content here."
frontmatter: { "tags": ["idea", "project"], "status": "draft" }
overwrite: false                 # fails if note exists (default)
```

### `update_note`

Update an existing note. Supports replace, append, or prepend modes. Can merge frontmatter.

```
path: "Projects/my-note"
content: "## New Section\n\nAdded content."
mode: "append"                   # "replace" | "append" | "prepend"
frontmatter: { "status": "in-progress" }  # merged with existing
```

### `delete_note`

Delete a note. Moves to `.trash/` by default (Obsidian convention).

```
path: "Projects/old-note"
permanent: false                 # true for hard delete
```

### `search_vault`

Full-text search across all notes. Supports plain text and regex.

```
query: "meeting notes"
regex: false
caseSensitive: false
folder: "Projects"               # limit to subfolder
maxResults: 20
```

### `list_vault`

Browse the vault's file and folder structure.

```
path: "Projects"                 # defaults to vault root
recursive: true
maxDepth: 5
notesOnly: false                 # true to filter to .md files only
```

### `manage_tags`

Read, add, or remove tags on a note's YAML frontmatter.

```
path: "Projects/my-note"
action: "add"                    # "list" | "add" | "remove"
tags: ["important", "review"]
```

### `daily_note`

Get, create, or append to daily notes.

```
action: "append"                 # "get" | "create" | "append"
date: "today"                    # "today" | "yesterday" | "tomorrow" | "2025-03-08"
content: "- Met with team about roadmap"
```

### `wikilinks`

Navigate Obsidian `[[wikilinks]]`. Supports `[[note]]`, `[[note|alias]]`, `[[note#heading]]`, and `[[note#^blockid]]`.

```
action: "backlinks"              # "resolve" | "backlinks" | "outlinks" | "unresolved"
path: "Projects/my-note"
```

| Action | Description |
|--------|-------------|
| `resolve` | Find the file a `[[wikilink]]` points to (set `path` to the link target) |
| `backlinks` | Find all notes that link TO a given note |
| `outlinks` | List all `[[wikilinks]]` FROM a note, with resolution status |
| `unresolved` | Find all broken `[[wikilinks]]` across the entire vault |

### `git_sync`

Git version control for your vault.

```
action: "sync"                   # full pull + commit + push
message: "update notes"          # optional commit message
```

| Action | Description |
|--------|-------------|
| `status` | Show working tree status (staged, modified, untracked) |
| `commit` | Stage all changes and commit |
| `pull` | Pull from remote (with `--rebase` by default) |
| `push` | Push to remote |
| `sync` | Pull + stage all + commit + push in one operation |
| `log` | Show recent commit history |
| `diff` | Show uncommitted changes |
| `init` | Initialize git repo with a sensible `.gitignore` |
| `remote_add` | Add a git remote |
| `remote_list` | List configured remotes |

### `create_task`

Create a new task in the vault's task queue. Tasks are markdown notes in the `Tasks/` folder with structured YAML frontmatter.

```
title: "Implement auth module"
description: "Build JWT-based authentication for the API."
priority: "high"                 # "critical" | "high" | "medium" | "low"
type: "code"                     # "code" | "research" | "writing" | "maintenance" | "other"
due: "2026-03-15"               # optional deadline
depends_on: ["task-abc-123"]     # task IDs that must complete first
context_notes: ["Projects/api"]  # vault notes with relevant context
scope: ["src/auth.ts"]           # advisory: files this task intends to modify
acceptance_criteria: ["Tests pass", "Docs written"]
source: "github-issue-42"       # where this task came from
timeout_minutes: 120             # max time before agent is considered stuck
```

### `list_tasks`

Query tasks by status, priority, type, or assignee.

```
status: "pending"                # filter by status, or "all"
priority: "high"                 # filter by priority, or "all"
type: "code"                     # filter by type, or "all"
assignee: "claude-code-1"       # filter by assignee
unassigned_only: true            # only unclaimed tasks
limit: 50                        # max results
include_completed: false         # include terminal states
```

### `claim_task`

Atomically claim a pending task for an agent. Prevents race conditions — if two agents try to claim the same task, the second gets a `TASK_ALREADY_CLAIMED` error.

```
task_id: "task-2026-03-09-abc123"
assignee: "claude-code-1"
```

Checks dependency completion before allowing claim. Blocked tasks cannot be claimed until all `depends_on` tasks are completed.

### `update_task`

Update a task's status, priority, or append progress to the Agent Log.

```
task_id: "task-2026-03-09-abc123"
status: "in_progress"            # validates state transitions
log_entry: "Started implementation. Found 3 API endpoints to modify."
priority: "critical"             # change priority if needed
```

Valid status transitions are enforced:
- `pending` → `claimed`, `blocked`, `cancelled`
- `claimed` → `in_progress`, `pending` (unclaim), `blocked`, `cancelled`
- `in_progress` → `completed`, `failed`, `blocked`, `pending`, `cancelled`
- `blocked` → `pending`, `cancelled`
- `completed` → `pending` (reopen)
- `failed` → `pending` (retry — clears assignee, increments `retry_count`)
- `cancelled` → `pending` (reactivate)

### `complete_task`

Mark a task as completed (or failed/cancelled) with a summary and deliverables.

```
task_id: "task-2026-03-09-abc123"
summary: "Auth module implemented with JWT support."
deliverables: ["src/auth.ts", "src/auth.test.ts", "https://github.com/org/repo/pull/42"]
status: "completed"              # "completed" | "failed" | "cancelled"
error_reason: "Missing dependency"  # if status is "failed"
```

Automatically unblocks dependent tasks when a task is completed — sets them from `blocked` to `pending`.

## Agent Workflow

The task tools are designed for AI agent orchestration. Here's the typical workflow:

```
1. Human/agent creates a task:       create_task(title: "Fix login bug", ...)
2. Agent finds available work:        list_tasks(status: "pending", unassigned_only: true)
3. Agent claims a task:               claim_task(task_id: "task-...", assignee: "claude-1")
4. Agent starts work:                 update_task(task_id: "task-...", status: "in_progress")
5. Agent logs progress:               update_task(task_id: "task-...", log_entry: "Found root cause...")
6. Agent finishes:                    complete_task(task_id: "task-...", summary: "Fixed!", deliverables: [...])
```

### Task Note Structure

Tasks are stored as markdown notes in the `Tasks/` folder (configurable via `TASKS_FOLDER`):

```markdown
---
id: task-2026-03-09-abc123
title: Implement auth module
status: in_progress
priority: high
type: code
assignee: claude-code-1
created: 2026-03-09
updated: 2026-03-09
depends_on: []
scope:
  - src/auth.ts
context_notes:
  - Projects/api-design
timeout_minutes: 120
tags:
  - auth
  - api
---

## Description

Build JWT-based authentication for the API.

## Acceptance Criteria

- [ ] Tests pass
- [ ] Docs written

## Agent Log

- **[2026-03-09 14:30:00]** Starting implementation. Found 3 endpoints to modify.
- **[2026-03-09 15:45:00] [COMPLETED]** Auth module implemented with JWT support.

## Deliverables

- src/auth.ts
- src/auth.test.ts
```

A `DASHBOARD.md` is auto-generated in the tasks folder after every mutation, showing summary counts, active tasks, pending queue, blocked tasks, and recent completions.

### Robustness Features

- **Retry failed tasks** — failed/cancelled tasks can be retried via `update_task(status: "pending")`. Assignee is cleared, `retry_count` incremented, and the task re-enters the queue.
- **Unclaim stuck tasks** — if an agent crashes, a claimed task can be unclaimed via `update_task(status: "pending")` to make it available again.
- **Timeout detection** — `list_tasks` returns `is_overdue: true` for tasks that have exceeded their `timeout_minutes` since `claimed_at`.
- **Dependency validation** — `create_task` warns if `depends_on` references nonexistent task IDs.
- **Dashboard health** — all mutation responses include `dashboard_refreshed: true/false` so callers know if the dashboard is current.
- **ISO timestamps** — `created`, `updated`, `completed_at`, and `claimed_at` use full ISO 8601 datetimes for precise ordering.
- **Scope is advisory** — `scope[]` tells agents which files a task intends to modify, but is not enforced by the server. Agents should respect it to avoid conflicts.

### Known Limitations

- **No true atomic claims** — the claim operation is read-check-write without file locking. This is safe for a single MCP server process (Node.js event loop), but if multiple server processes share the same vault directory, a race condition is possible. For multi-process setups, use external coordination.
- **Scope is not enforced** — the server does not block writes outside a task's `scope[]`. Enforcement would require middleware in the vault write path.
- **No automatic timeout recovery** — `is_overdue` is reported in `list_tasks` output, but timed-out tasks are not automatically released. A dispatcher (Phase 2) will handle this.

## Configuration

All configuration is via environment variables.

### Required

| Variable | Description |
|----------|-------------|
| `OBSIDIAN_VAULT_PATH` | Absolute path to your Obsidian vault folder |

### Optional — Vault

| Variable | Default | Description |
|----------|---------|-------------|
| `DAILY_NOTE_FOLDER` | `Daily Notes` | Subfolder for daily notes |
| `DAILY_NOTE_FORMAT` | `YYYY-MM-DD` | Date format for daily note filenames (only `YYYY-MM-DD` is currently supported) |
| `TRASH_ON_DELETE` | `true` | Move deleted files to `.trash/` instead of permanent delete |
| `MAX_FILE_SIZE_BYTES` | `10485760` | Maximum file size to read in bytes (default 10 MB) |
| `MAX_SEARCH_RESULTS` | `50` | Maximum search results returned |
| `SEARCH_TIMEOUT_MS` | `30000` | Search timeout in milliseconds |
| `NOTE_EXTENSIONS` | `.md,.markdown` | File extensions treated as notes (comma-separated) |
| `TASKS_FOLDER` | `Tasks` | Subfolder for task notes (relative to vault root) |

### Optional — Git Sync

| Variable | Default | Description |
|----------|---------|-------------|
| `GIT_AUTO_SYNC` | `false` | Auto commit + push after every write/delete. Pushes to remote if configured, otherwise commits locally only. |
| `GIT_AUTO_SYNC_DEBOUNCE_MS` | `5000` | Wait time after last write before auto-syncing |
| `GIT_COMMIT_MESSAGE_PREFIX` | `vault: ` | Prefix for auto-commit messages |
| `GIT_REMOTE` | `origin` | Default git remote name |
| `GIT_BRANCH` | `main` | Default git branch name |
| `GIT_TIMEOUT_MS` | `30000` | Timeout for git operations |
| `GIT_PULL_REBASE` | `true` | Use `--rebase` on git pull |

## Setting Up Git Sync

If your vault isn't a git repo yet, use the `git_sync` tool:

```
1. git_sync(action: "init")
2. git_sync(action: "remote_add", remote_url: "git@github.com:you/vault.git")
3. git_sync(action: "sync", message: "initial commit")
```

From then on, set `GIT_AUTO_SYNC=true` to automatically commit and push after every change, or use `git_sync(action: "sync")` manually.

> **Don't want git?** That's fine — skip all of this. The server works without git. Just set `OBSIDIAN_VAULT_PATH` and go.

## Syncing Between Laptop and Phone

Use git sync to keep your vault in sync across devices. The MCP server handles the laptop side; your phone uses the Obsidian Git community plugin.

### Setup

1. **Laptop** — configure this MCP server with `GIT_AUTO_SYNC=true` pointing at a **private** GitHub repo
2. **Phone (iOS)** — install [Obsidian Git](https://github.com/Vinzent03/obsidian-git) community plugin, or use [Working Copy](https://workingcopy.app/) as a git client and point Obsidian at the cloned repo
3. **Phone (Android)** — install [Obsidian Git](https://github.com/Vinzent03/obsidian-git) community plugin (has built-in git support on Android)

### How it works

```
Laptop (MCP server)                    GitHub (private repo)                Phone (Obsidian Git)
       │                                       │                                   │
       ├── edit note ──► auto-commit + push ──►│                                   │
       │                                       │◄── pull on open ──────────────────┤
       │                                       │                                   ├── edit note
       │                                       │◄── commit + push ─────────────────┤
       │◄── pull (next auto-sync) ────────────┤                                   │
```

- **Laptop → Phone**: MCP auto-sync pushes after every write. Open Obsidian on your phone and the Git plugin pulls latest.
- **Phone → Laptop**: Obsidian Git plugin commits and pushes. Next time the MCP server writes, auto-sync pulls before pushing (pull → commit → push).
- **Conflict resolution**: `GIT_PULL_REBASE=true` (default) keeps history clean. If a merge conflict occurs, the `git_sync` tool reports it and you can resolve manually.

### Recommended Obsidian Git plugin settings (phone)

| Setting | Value | Why |
|---------|-------|-----|
| Auto pull on open | Enabled | Get latest notes when you open the app |
| Auto push after commit | Enabled | Push your edits immediately |
| Pull on interval | 5–10 min | Catch changes while the app is open |
| Commit message | `mobile: {{date}}` | Distinguish mobile vs MCP commits |

> **Important**: Use a **private** GitHub repo for your vault. Your notes are personal — don't expose them publicly.

## Security

- **Path traversal prevention** — all paths validated against vault root, including symlink resolution via `realpath`
- **Symlink safety** — symlinks that escape the vault are blocked; symlinks are excluded from list/search
- **No shell injection** — git commands use `execFile` (not `exec`)
- **Atomic writes** — temp file + rename prevents partial writes on crash
- **Overwrite protection** — `create_note` fails if the note already exists unless explicitly overridden
- **Trash safety** — delete never silently falls through to permanent deletion; unique filenames prevent collision in `.trash/`
- **File size limits** — configurable cap (default 10 MB) prevents reading huge files
- **Search timeout** — prevents runaway searches from hanging the server
- **Git operation lock** — mutex prevents concurrent git commands from conflicting

## Project Structure

```
src/
├── index.ts              # MCP server entry point, tool registration, auto-sync wiring
├── config.ts             # Environment variable parsing with validation
├── errors.ts             # Typed error codes and safe handler wrapper
├── vault.ts              # Filesystem operations (path safety, atomic writes, list, search)
├── frontmatter.ts        # YAML frontmatter parse/serialize, tag extraction
├── git.ts                # Git CLI wrapper with locking and timeouts
├── task-schema.ts        # Task types, ID generation, validation, body template
├── task-dashboard.ts     # Task scanning, dashboard generation
└── tools/
    ├── read-note.ts
    ├── create-note.ts
    ├── update-note.ts
    ├── delete-note.ts
    ├── search-vault.ts
    ├── list-vault.ts
    ├── manage-tags.ts
    ├── daily-note.ts
    ├── wikilinks.ts
    ├── git-sync.ts
    ├── create-task.ts    # Create tasks with structured frontmatter
    ├── list-tasks.ts     # Query tasks by filters
    ├── claim-task.ts     # Atomic task claiming with race condition prevention
    ├── update-task.ts    # Update status, append to agent log
    └── complete-task.ts  # Mark done, link deliverables, unblock dependents
```

## License

MIT
