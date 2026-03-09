# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-03-09

### Added
- **Task orchestration system** — 5 new MCP tools for AI agent task management:
  - `create_task` — create tasks with structured YAML frontmatter (priority, type, dependencies, scope, acceptance criteria)
  - `list_tasks` — query tasks by status, priority, type, assignee with filtering and sorting
  - `claim_task` — atomically claim pending tasks with race condition prevention and dependency checking
  - `update_task` — update status/priority/type, append timestamped entries to Agent Log, with state transition validation
  - `complete_task` — mark tasks done/failed/cancelled with summary, deliverables, and automatic unblocking of dependent tasks
- **Task schema** — structured frontmatter with `id`, `title`, `status`, `priority`, `type`, `assignee`, `depends_on`, `scope`, `context_notes`, `timeout_minutes`, `claimed_at`, `retry_count`, and more
- **Auto-generated dashboard** — `DASHBOARD.md` refreshed after every task mutation with summary counts, active/pending/blocked/completed sections
- **Dependency tracking** — tasks with `depends_on` are auto-blocked and can't be claimed until dependencies complete; completing a task automatically unblocks dependents
- **Dependency validation** — `create_task` warns if `depends_on` references nonexistent task IDs
- **Status transition validation** — enforces valid state machine transitions (e.g. can't jump from `pending` to `completed`)
- **Retry / reopen support** — failed, cancelled, and completed tasks can transition back to `pending` (clears assignee, increments `retry_count`)
- **Unclaim support** — claimed tasks can be set back to `pending` for reassignment (e.g. when an agent crashes)
- **Timeout detection** — `list_tasks` returns `is_overdue: true` for tasks exceeding their `timeout_minutes` since `claimed_at`
- **Dashboard health reporting** — all mutation responses include `dashboard_refreshed: true/false`
- **ISO 8601 timestamps** — `created`, `updated`, `completed_at`, `claimed_at` all use full ISO datetimes for precise ordering
- **Advisory scope** — `scope[]` field documents which files a task intends to modify (not enforced — honest about limitations)
- **Shared section editing** — `appendToAgentLog` and `addDeliverables` extracted to shared module with case-insensitive heading matching
- **Project orchestration** — 2 additional tools for multi-agent project management:
  - `create_project` — create a project with multiple sub-tasks in one call, wire dependencies via array indices
  - `get_project_status` — rollup progress (3/7 completed, 43%), active agents, overdue tasks, blockers
- **Project field on tasks** — `project` field links sub-tasks to their parent project
- **Project filter in list_tasks** — `project` parameter + `exclude_projects` flag
- **Dashboard projects section** — shows all projects with sub-task progress
- **`TASKS_FOLDER` environment variable** — configurable task folder location (default: `Tasks`)
- 127 new integration tests for task tools (161 total, up from 34)

## [0.1.2] - 2026-03-09

### Fixed
- **Critical**: `gitCommitMessagePrefix` config was silently ignored — `git.ts` read a non-existent property name (`gitAutoCommitPrefix` instead of `gitCommitMessagePrefix`)
- **Critical**: Server reported version `1.0.0` to MCP clients instead of actual package version
- **Critical**: Git operations (status, commit, pull, push, log, diff, remote_add, remote_list) gave opaque errors on non-git vaults instead of helpful "run init first" message
- **Critical**: Inline `#tag` regex missed tags at the start of lines (missing multiline flag)
- Wikilink resolution was O(n) per link (full vault listing each time) — now builds a file index once per request
- Git lock could queue indefinitely if an operation got stuck — now times out after 60 seconds
- Auto-sync debounce timer was not cleared on server shutdown, risking orphaned git operations
- Git log parsing broke on commit messages containing `|` — now uses null byte delimiter
- `.txt` files were included in default note extensions (Obsidian doesn't use `.txt`)
- `DAILY_NOTE_FORMAT` was silently accepted but ignored — now warns if set to unsupported value

### Added
- `--help` and `--version` CLI flags
- `MAX_FILE_SIZE_BYTES` environment variable (configurable, default 10 MB)
- Windows CI testing (ubuntu + windows matrix)
- Auto-push to remote after auto-sync commit (when remote is configured)
- Graceful skip of pull/push when no git remote is configured
- Auto `-u` flag on first push to set up upstream tracking
- Laptop-to-phone sync documentation with Obsidian Git plugin guide

### Changed
- Default `NOTE_EXTENSIONS` changed from `.md,.markdown,.txt` to `.md,.markdown`
- Build script no longer uses `chmod +x` (cross-platform compatible)
- Server name in MCP protocol changed from `obsidian-vault` to `mcp-obsidian-vault`
- Git config accessors replaced unsafe `unknown` casts with direct typed property access

## [0.1.1] - 2026-03-09

### Added
- GitHub Actions CI (Node 18/20/22 matrix)
- 34 integration tests
- Fixed package-lock.json to match renamed package
- CI git identity configuration for test suite

## [0.1.0] - 2026-03-09

### Added
- Initial release with 10 MCP tools: `read_note`, `create_note`, `update_note`, `delete_note`, `search_vault`, `list_vault`, `manage_tags`, `daily_note`, `git_sync`, `wikilinks`
- Direct filesystem access — no Obsidian required
- YAML frontmatter support via gray-matter
- Git sync with auto-commit after writes (debounced)
- Path traversal prevention with symlink safety
- Atomic writes to prevent data loss
- Published to npm as `mcp-obsidian-vault`
