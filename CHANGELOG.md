# Changelog

All notable changes to this project will be documented in this file.

## [0.4.0] - 2026-03-09

### Added
- **Worktree-aware task coordination** — track which agent is working on which git branch/worktree for parallel multi-agent development:
  - `claim_task` accepts optional `worktree_branch` and `worktree_path` parameters
  - `list_tasks` includes `worktree_branch` and `worktree_path` in task output
  - `get_context` shows worktree branches for all in-progress work and active project agents
  - `complete_task` response includes `worktree_branch` and a "ready for PR" message when present
  - New `TaskFrontmatter` fields: `worktree_branch`, `worktree_path`
- **Multi-Agent Parallel Development** section in README documenting Claude Code `--worktree`, opencode/Codex manual setup, and end-to-end coordination workflow

### Fixed
- **YAML serialization crash** — `serializeNote` now recursively strips `undefined` values from frontmatter before passing to js-yaml, preventing "unacceptable kind of an object to dump [object Undefined]" crashes. This hardening applies to all note writes, not just worktree fields.

### Tests
- 33 new worktree metadata tests covering claim with/without worktree, list output, get_context, complete response, and frontmatter round-trip (375 total assertions)

## [0.3.2] - 2026-03-09

### Fixed
- **Legacy flat project backward compatibility** — appending tasks to a v0.3.0 project (flat `Tasks/proj-xxx.md` structure without subfolder) no longer incorrectly creates a new subfolder. Appended tasks now correctly stay at the `Tasks/` root alongside existing tasks.

### Tests
- Added backward-compat test for legacy flat project append (342 total assertions)

## [0.3.1] - 2026-03-09

### Added
- **Per-project subfolders** — `create_project` now creates a subfolder for each project under `Tasks/`. Sub-tasks are placed in the same subfolder, keeping related work organized. Standalone tasks (no project) remain at the `Tasks/` root.
  - Folder structure: `Tasks/{project-slug}/proj-xxx.md`, `Tasks/{project-slug}/task-xxx.md`
  - `scanTasks` now scans recursively to find tasks in subfolders
  - `create_task` with a `project` field automatically places the task in the project's subfolder
  - Append mode respects existing project subfolder paths
  - Backward compatible: tasks already in the flat `Tasks/` folder are still found by recursive scan
- 17 new integration tests (334 total)

## [0.3.0] - 2026-03-09

### Added
- **Human-in-the-Loop (HITL)** — tasks with `review_required: true` redirect to `needs_review` status on completion instead of auto-completing. New `review_task` tool lets humans/agents approve, reject, or request changes with feedback.
  - New task statuses: `needs_review`, `revision_requested`
  - New frontmatter fields: `review_required`, `reviewer`, `feedback`, `review_count`, `risk_level`
- **Agent Registry** — register AI agents with capabilities, track their status, and route tasks intelligently:
  - `register_agent` — register/update an agent profile with capabilities, tags, and model info
  - `list_agents` — query agents with filters (capability, tag, status, available_only)
  - `suggest_assignee` — capability-based routing suggestions for a given task
  - Agent profiles stored as markdown notes in configurable `Agents/` folder
- **Retry & Escalation** — automatic retry and escalation for failed/stuck tasks:
  - `check_timeouts` — scan for overdue tasks, auto-retry up to `max_retries`, escalate when exhausted
  - New frontmatter fields: `max_retries`, `retry_delay_minutes`, `escalate_to`, `escalation_status`
  - Supports `dry_run` mode for preview without changes
- **Conditional Workflows (Routing Rules)** — output-based branching after task completion:
  - Tasks can have `routing_rules` with `output_contains`, `output_matches`, or `status_is` conditions
  - Rules selectively `activate` (unblock) or `deactivate` (cancel) dependent tasks based on completion output
  - `create_project` resolves `idx:N` references in routing rules to real task IDs automatically
- **Token & Cost Tracking** — monitor AI resource usage across agents and tasks:
  - `log_usage` — record input/output tokens, model, cost, and duration per interaction
  - `get_usage_report` — aggregate usage stats with filters (agent, task, project, date range) and grouping by agent/model
  - Usage records stored in configurable `Usage/` folder
- **Event System** — internal EventBus with typed events for task lifecycle notifications
- **Webhook Notifications** — fire-and-forget HTTP POST to configured URLs on task events, with HMAC-SHA256 signing and retry
- **Dashboard enhancements** — new "Needs Review" and "Revision Requested" sections in DASHBOARD.md
- **Context briefing enhancements** — `get_context` now includes review queue and revision-requested tasks
- 5 new environment variables: `WEBHOOK_URL`, `WEBHOOK_SECRET`, `WEBHOOK_TIMEOUT_MS`, `AGENTS_FOLDER`, `USAGE_FOLDER`
- 74 new integration tests (317 total)

### Fixed
- `get_usage_report` test assertions accessed response fields at wrong nesting level
- `routing_rules` with `deactivate: undefined` caused js-yaml serialization crash (gray-matter gotcha)

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
- **Agent prompts** — 3 MCP prompts discoverable by clients, also available as markdown files:
  - `task-worker` — system prompt for coding agents that find, claim, and complete tasks autonomously
  - `project-manager` — system prompt for orchestrator agents that plan projects and monitor progress
  - `vault-assistant` — system prompt for note management agents
- **`TASKS_FOLDER` environment variable** — configurable task folder location (default: `Tasks`)
- **Context persistence** — 3 new tools for cross-session knowledge continuity:
  - `get_context` — structured session briefing: active projects, in-progress work, pending tasks, blockers, failures, recent decisions, recent discoveries, pinned notes. Call this first in every new session.
  - `log_decision` — create structured decision records (ADR-lite) in `Decisions/` folder with context, rationale, alternatives, and consequences
  - `log_discovery` — capture gotchas, TILs, and findings in `Discoveries/` folder with impact, recommendation, and related files
- **Pinned context notes** — notes with `pinned: true` in frontmatter are surfaced by `get_context`
- **`DECISIONS_FOLDER` environment variable** — configurable decisions folder (default: `Decisions`)
- **`DISCOVERIES_FOLDER` environment variable** — configurable discoveries folder (default: `Discoveries`)
- **Agent skill** — `obsidian-task-orchestration` skill for Claude Code / opencode / skills.sh, teaching agents the context-first workflow
- 181 new integration tests (215 total)

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
