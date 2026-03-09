# mcp-obsidian-vault

## Build & Test

```sh
npm install && npm run build
npm test                    # 317 integration tests (node test/run.mjs)
npm run dev                 # tsc --watch
```

## Architecture

27 MCP tools: 10 vault + 7 task/project + 3 context + 4 agent/review + 3 usage/timeout.
TypeScript ES modules, Node ≥ 18. Ships as `npx mcp-obsidian-vault`.

Key deps: `@modelcontextprotocol/sdk` v1.x, `zod` v4, `gray-matter`.

```
src/index.ts          — MCP server entry, tool + prompt registration
src/tools/*.ts        — one file per tool (27 files)
src/config.ts         — env var parsing (vault, git, webhooks, folders)
src/errors.ts         — ErrorCode enum, VaultError, safeToolHandler wrapper
src/vault.ts          — filesystem ops: path safety, atomic writes, list, search
src/frontmatter.ts    — YAML frontmatter parse/serialize, tag extraction
src/git.ts            — git CLI wrapper with mutex lock
src/events.ts         — EventBus with typed task lifecycle events
src/webhooks.ts       — WebhookEmitter with HMAC-SHA256 signing
src/agent-registry.ts — agent profiles, scanning, capability matching
src/task-schema.ts    — task types, ID gen, validation, body template
src/task-dashboard.ts — scan tasks, generate DASHBOARD.md
```

## Tool Categories

### Vault (10 tools)
read_note, create_note, update_note, delete_note, search_vault,
list_vault, manage_tags, daily_note, wikilinks, git_sync

### Task Orchestration (7 tools)
create_task, list_tasks, claim_task, update_task, complete_task,
create_project, get_project_status

### Context Persistence (3 tools)
get_context, log_decision, log_discovery

### Review & HITL (1 tool)
review_task — approve/reject/request_changes on tasks with review_required

### Agent Management (3 tools)
register_agent, list_agents, suggest_assignee

### Timeout & Usage (3 tools)
check_timeouts, log_usage, get_usage_report

## Task State Machine

```
pending → claimed → in_progress → completed
                  → in_progress → needs_review → completed (approve)
                                               → revision_requested → in_progress (revise)
                  → in_progress → failed
blocked → pending (auto-unblock when deps complete)
completed/failed/cancelled → pending (reopen/retry)
```

## Conventions

- Every tool handler is wrapped in `safeToolHandler()` (src/errors.ts).
- Zod v4: `z.record()` requires two args — `z.record(z.string(), z.unknown())`.
- Frontmatter: strip `undefined` values before serialize (js-yaml crash).
  Also strip `undefined` from nested objects (e.g. routing_rules[].deactivate).
- Writes are atomic: write to `.tmp` file, then `rename()`.
- All paths resolved via `realpathSync` and validated against vault root.
- routing_rules use `idx:N` references in create_project, resolved to task IDs automatically.

## Gotchas

- macOS `/tmp` is a symlink to `/private/tmp` — resolve vault path with `realpathSync`.
- opencode MCP config has no `env` field — use `sh -c` with inline env vars.
- `gray-matter`: `undefined` in frontmatter object crashes `js-yaml` dump.
- Git: use HTTPS remotes (no SSH keys configured on GitHub).
- routing_rules with `deactivate: undefined` also crash js-yaml — omit the key entirely.

## Context-First Discipline

Every new session should call `get_context()` first. It returns:
active projects, in-progress work, blockers, recent decisions, discoveries,
review queue (needs_review tasks), and revision-requested tasks.
