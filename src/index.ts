#!/usr/bin/env node

/**
 * Obsidian MCP Server — Direct filesystem access to your Obsidian vault.
 *
 * No Obsidian running required. Reads and writes markdown files directly.
 * Optional git sync for version control and cross-device synchronization.
 *
 * Configuration via environment variables:
 *   OBSIDIAN_VAULT_PATH       (required) — Absolute path to your vault folder
 *   DAILY_NOTE_FOLDER         (optional) — Subfolder for daily notes (default: "Daily Notes")
 *   DAILY_NOTE_FORMAT         (optional) — Date format for filenames (default: "YYYY-MM-DD")
 *   TRASH_ON_DELETE            (optional) — Move to .trash instead of permanent delete (default: true)
 *   MAX_SEARCH_RESULTS         (optional) — Max search results (default: 50)
 *   SEARCH_TIMEOUT_MS          (optional) — Search timeout in ms (default: 30000)
 *   GIT_AUTO_SYNC              (optional) — Auto commit+push after writes (default: false)
 *   GIT_AUTO_SYNC_DEBOUNCE_MS  (optional) — Debounce period before auto-sync (default: 5000)
 *   GIT_COMMIT_MESSAGE_PREFIX  (optional) — Prefix for auto-commit messages (default: "vault: ")
 *   GIT_REMOTE                 (optional) — Default git remote name (default: "origin")
 *   GIT_BRANCH                 (optional) — Default git branch name (default: "main")
 *   GIT_TIMEOUT_MS             (optional) — Timeout for git operations (default: 30000)
 *   GIT_PULL_REBASE            (optional) — Use --rebase on pull (default: true)
 *   TASKS_FOLDER               (optional) — Subfolder for task notes (default: "Tasks")
 *   DECISIONS_FOLDER           (optional) — Subfolder for decision records (default: "Decisions")
 *   DISCOVERIES_FOLDER         (optional) — Subfolder for discovery notes (default: "Discoveries")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { loadConfig } from "./config.js";
import { Vault } from "./vault.js";
import { GitOps } from "./git.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string; description: string };

import { readNoteSchema, readNoteHandler } from "./tools/read-note.js";
import { createNoteSchema, createNoteHandler } from "./tools/create-note.js";
import { updateNoteSchema, updateNoteHandler } from "./tools/update-note.js";
import { deleteNoteSchema, deleteNoteHandler } from "./tools/delete-note.js";
import { searchVaultSchema, searchVaultHandler } from "./tools/search-vault.js";
import { listVaultSchema, listVaultHandler } from "./tools/list-vault.js";
import { manageTagsSchema, manageTagsHandler } from "./tools/manage-tags.js";
import { dailyNoteSchema, dailyNoteHandler } from "./tools/daily-note.js";
import { gitSyncSchema, gitSyncHandler } from "./tools/git-sync.js";
import { wikilinksSchema, wikilinksHandler } from "./tools/wikilinks.js";
import { createTaskSchema, createTaskHandler } from "./tools/create-task.js";
import { listTasksSchema, listTasksHandler } from "./tools/list-tasks.js";
import { claimTaskSchema, claimTaskHandler } from "./tools/claim-task.js";
import { updateTaskSchema, updateTaskHandler } from "./tools/update-task.js";
import { completeTaskSchema, completeTaskHandler } from "./tools/complete-task.js";
import { createProjectSchema, createProjectHandler } from "./tools/create-project.js";
import { getProjectStatusSchema, getProjectStatusHandler } from "./tools/get-project-status.js";
import { getContextSchema, getContextHandler } from "./tools/get-context.js";
import { logDecisionSchema, logDecisionHandler } from "./tools/log-decision.js";
import { logDiscoverySchema, logDiscoveryHandler } from "./tools/log-discovery.js";
import { reviewTaskSchema, reviewTaskHandler } from "./tools/review-task.js";
import { registerAgentSchema, registerAgentHandler } from "./tools/register-agent.js";
import { listAgentsSchema, listAgentsHandler } from "./tools/list-agents.js";
import { suggestAssigneeSchema, suggestAssigneeHandler } from "./tools/suggest-assignee.js";
import { checkTimeoutsSchema, checkTimeoutsHandler } from "./tools/check-timeouts.js";
import { logUsageSchema, logUsageHandler } from "./tools/log-usage.js";
import { getUsageReportSchema, getUsageReportHandler } from "./tools/get-usage-report.js";
import { registerPrompts } from "./prompts.js";
import { EventBus } from "./events.js";
import { WebhookEmitter } from "./webhooks.js";

// ─── Bootstrap ──────────────────────────────────────────────────────

async function main() {
  // Handle --help and --version flags
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`mcp-obsidian-vault v${pkg.version}`);
    console.log();
    console.log("MCP server for Obsidian vaults — direct filesystem access with git sync.");
    console.log();
    console.log("Usage:");
    console.log("  OBSIDIAN_VAULT_PATH=/path/to/vault mcp-obsidian-vault");
    console.log();
    console.log("Environment variables:");
    console.log("  OBSIDIAN_VAULT_PATH       (required) Absolute path to your vault");
    console.log("  GIT_AUTO_SYNC             Auto commit+push after writes (default: false)");
    console.log("  DAILY_NOTE_FOLDER         Subfolder for daily notes (default: Daily Notes)");
    console.log();
    console.log("See https://github.com/t-rhex/obsidian-mcp-server for full documentation.");
    process.exit(0);
  }

  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log(pkg.version);
    process.exit(0);
  }

  // Load and validate configuration
  const config = loadConfig();
  const vault = new Vault(config);
  const git = new GitOps(config);

  // ─── Event System Setup ──────────────────────────────────────────

  const eventBus = new EventBus();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Auto-sync: triggered by vault writes via the event bus
  if (config.gitAutoSync) {
    const autoSync = async () => {
      try {
        const isRepo = await git.isGitRepo();
        if (!isRepo) {
          console.error("Auto-sync: Vault is not a git repo, skipping.");
          return;
        }
        const isInstalled = await git.isGitInstalled();
        if (!isInstalled) {
          console.error("Auto-sync: Git is not installed, skipping.");
          return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const message = `${config.gitCommitMessagePrefix}auto-sync ${timestamp}`;
        const result = await git.sync(message);
        console.error(`Auto-sync completed: ${result.message}`);
      } catch (err) {
        console.error("Auto-sync failed:", err instanceof Error ? err.message : err);
      }
    };

    vault.onWrite = (_path: string) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        autoSync();
      }, config.gitAutoSyncDebounceMs);
    };

    console.error(`Auto-sync enabled (debounce: ${config.gitAutoSyncDebounceMs}ms)`);
  }

  // Webhook emitter (optional)
  if (config.webhookUrls.length > 0) {
    const webhooks = new WebhookEmitter({
      urls: config.webhookUrls,
      secret: config.webhookSecret || undefined,
      timeoutMs: config.webhookTimeoutMs,
    });
    eventBus.onEvent((event) => {
      webhooks.send(event).catch(() => { /* fire-and-forget */ });
    });
    console.error(`Webhooks enabled: ${config.webhookUrls.length} URL(s) configured`);
  }

  // ─── Server Setup ─────────────────────────────────────────────────

  const server = new McpServer({
    name: "mcp-obsidian-vault",
    version: pkg.version,
  });

  // ─── Register Tools ─────────────────────────────────────────────

  server.tool(
    "read_note",
    "Read a note's content, frontmatter, tags, and metadata from the vault. " +
    "Returns parsed frontmatter, markdown content, tags (from frontmatter and inline), and file stats.",
    readNoteSchema,
    readNoteHandler(vault),
  );

  server.tool(
    "create_note",
    "Create a new note in the vault with optional YAML frontmatter. " +
    "Parent folders are created automatically. Fails if the note already exists (unless overwrite=true).",
    createNoteSchema,
    createNoteHandler(vault),
  );

  server.tool(
    "update_note",
    "Update an existing note. Supports three modes: 'replace' (overwrite body), " +
    "'append' (add to end), or 'prepend' (add to beginning). " +
    "Can also merge new frontmatter fields into existing frontmatter.",
    updateNoteSchema,
    updateNoteHandler(vault),
  );

  server.tool(
    "delete_note",
    "Delete a note from the vault. By default moves to .trash/ (Obsidian convention) " +
    "instead of permanent deletion. Set permanent=true for hard delete.",
    deleteNoteSchema,
    deleteNoteHandler(vault),
  );

  server.tool(
    "search_vault",
    "Full-text search across all notes in the vault. Supports plain text and regex patterns. " +
    "Returns matching files with line numbers and context. Can filter by folder.",
    searchVaultSchema,
    searchVaultHandler(vault),
  );

  server.tool(
    "list_vault",
    "List files and folders in the vault. Supports recursive listing with depth control. " +
    "Hidden folders (.obsidian, .trash, .git) are excluded by default.",
    listVaultSchema,
    listVaultHandler(vault),
  );

  server.tool(
    "manage_tags",
    "Read, add, or remove tags on a note. Tags are managed in YAML frontmatter. " +
    "Also reads inline #tags from the note content. Handles deduplication automatically.",
    manageTagsSchema,
    manageTagsHandler(vault),
  );

  server.tool(
    "daily_note",
    "Get, create, or append to a daily note. Supports 'today', 'yesterday', 'tomorrow', " +
    "or any date string (YYYY-MM-DD). Daily notes are stored in a configurable folder.",
    dailyNoteSchema,
    dailyNoteHandler(vault, config),
  );

  server.tool(
    "git_sync",
    "Git version control for your vault. Actions: 'status' (show changes), " +
    "'commit' (stage all + commit), 'pull' (fetch remote changes), 'push' (push to remote), " +
    "'sync' (pull+commit+push in one operation), 'log' (commit history), 'diff' (show changes), " +
    "'init' (initialize git repo + .gitignore), 'remote_add' (add remote), 'remote_list' (list remotes).",
    gitSyncSchema,
    gitSyncHandler(git, vault),
  );

  server.tool(
    "wikilinks",
    "Navigate Obsidian [[wikilinks]]. Actions: 'resolve' (find file a wikilink points to), " +
    "'backlinks' (find all notes linking to a note), 'outlinks' (list all links from a note), " +
    "'unresolved' (find broken wikilinks across the vault). Supports [[note]], [[note|alias]], " +
    "[[note#heading]], and [[note#^blockid]] syntax.",
    wikilinksSchema,
    wikilinksHandler(vault),
  );

  // ─── Task Orchestration Tools ─────────────────────────────────

  server.tool(
    "create_task",
    "Create a new task in the vault's task queue with structured YAML frontmatter. " +
    "Tasks are markdown notes in the Tasks/ folder. Supports priority, type, dependencies, " +
    "scope isolation, context notes, and acceptance criteria. Auto-refreshes the task dashboard.",
    createTaskSchema,
    createTaskHandler(vault, config),
  );

  server.tool(
    "list_tasks",
    "Query tasks by status, priority, type, or assignee. Returns a filtered, sorted list " +
    "of tasks from the vault's task queue. Use to find available work or monitor progress.",
    listTasksSchema,
    listTasksHandler(vault, config),
  );

  server.tool(
    "claim_task",
    "Atomically claim a pending task for an agent. Sets status to 'claimed' and records the assignee. " +
    "Prevents race conditions — if two agents try to claim the same task, the second gets a clear error. " +
    "Checks dependency completion before allowing claim.",
    claimTaskSchema,
    claimTaskHandler(vault, config),
  );

  server.tool(
    "update_task",
    "Update a task's status, priority, type, or assignee. Append progress entries to the Agent Log. " +
    "Validates status transitions (e.g. cannot go from 'pending' to 'completed' — must claim first). " +
    "Use this to move tasks through the workflow.",
    updateTaskSchema,
    updateTaskHandler(vault, config),
  );

  server.tool(
    "complete_task",
    "Mark a task as completed (or failed/cancelled) with a summary and optional deliverables. " +
    "Records completed_at timestamp, appends to Agent Log, links deliverable files/URLs, " +
    "and automatically unblocks dependent tasks.",
    completeTaskSchema,
    completeTaskHandler(vault, config),
  );

  server.tool(
    "create_project",
    "Create a project with multiple sub-tasks in one call. " +
    "Use depends_on_indices to wire up task dependencies by array position. " +
    "Independent tasks can be claimed by different agents in parallel. " +
    "Returns all task IDs for immediate claiming. " +
    "Append mode: pass project_id to add new sub-tasks to an existing project.",
    createProjectSchema,
    createProjectHandler(vault, config),
  );

  server.tool(
    "get_project_status",
    "Get rollup status of a project: progress percentage, status breakdown, " +
    "active agents, overdue tasks, and blockers. " +
    "Use list_tasks(type: 'project') to find project IDs.",
    getProjectStatusSchema,
    getProjectStatusHandler(vault, config),
  );

  // ─── Context & Knowledge Tools ────────────────────────────────

  server.tool(
    "get_context",
    "Get a structured briefing of the vault's current state. " +
    "Returns active projects, in-progress work, pending tasks, blockers, failures, " +
    "recent decisions, recent discoveries, and pinned notes. " +
    "Call this FIRST in any new session to understand what's going on.",
    getContextSchema,
    getContextHandler(vault, config),
  );

  server.tool(
    "log_decision",
    "Log an architectural or design decision as a structured record. " +
    "Captures context, rationale, alternatives considered, and consequences. " +
    "Future agents can find these via get_context to understand WHY things were done.",
    logDecisionSchema,
    logDecisionHandler(vault, config),
  );

  server.tool(
    "log_discovery",
    "Log a discovery, gotcha, or TIL (Today I Learned) as a structured note. " +
    "Captures what was found, its impact, and recommendations. " +
    "Prevents future agents from re-discovering the same things.",
    logDiscoverySchema,
    logDiscoveryHandler(vault, config),
  );

  // ─── HITL & Review Tools ───────────────────────────────────────

  server.tool(
    "review_task",
    "Approve or reject a task in needs_review status. " +
    "Used by humans to gate high-risk work. " +
    "Approve sends to completed and unblocks dependents. Reject sends to revision_requested.",
    reviewTaskSchema,
    reviewTaskHandler(vault, config),
  );

  // ─── Agent Registry Tools ────────────────────────────────────────

  server.tool(
    "register_agent",
    "Register an agent with capabilities, tags, and capacity. " +
    "Creates or updates an agent profile in the Agents/ folder. " +
    "Used for capability-based task routing.",
    registerAgentSchema,
    registerAgentHandler(vault, config),
  );

  server.tool(
    "list_agents",
    "List registered agents. Filter by capability, tag, status, or availability. " +
    "Shows current workload and capacity for each agent.",
    listAgentsSchema,
    listAgentsHandler(vault, config),
  );

  server.tool(
    "suggest_assignee",
    "Given a task ID, suggest the best agents to assign based on capability match, " +
    "tag overlap, availability, and success rate. Returns ranked suggestions.",
    suggestAssigneeSchema,
    suggestAssigneeHandler(vault, config),
  );

  // ─── Retry & Escalation Tools ────────────────────────────────────

  server.tool(
    "check_timeouts",
    "Scan for overdue and failed tasks. Auto-retry failed tasks within max_retries, " +
    "escalate exhausted tasks to escalate_to agent/human, release timed-out tasks. " +
    "Use dry_run=true to preview actions without making changes.",
    checkTimeoutsSchema,
    checkTimeoutsHandler(vault, config),
  );

  // ─── Usage Tracking Tools ────────────────────────────────────────

  server.tool(
    "log_usage",
    "Record token/cost usage for a task or agent. " +
    "Stores structured usage records in the Usage/ folder. " +
    "Optionally appends usage summary to the task's Agent Log.",
    logUsageSchema,
    logUsageHandler(vault, config),
  );

  server.tool(
    "get_usage_report",
    "Aggregate token and cost usage across tasks, agents, projects, and time ranges. " +
    "Returns totals and breakdowns by agent and model.",
    getUsageReportSchema,
    getUsageReportHandler(vault, config),
  );

  // ─── Register Prompts ────────────────────────────────────────────

  registerPrompts(server);

  // ─── Connect Transport ──────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Obsidian MCP Server started. Vault: ${config.vaultPath}`);

  // Wire event bus to MCP logging notifications (after connect)
  eventBus.onEvent((event) => {
    server.server.sendLoggingMessage({
      level: "info",
      logger: "vault-events",
      data: event,
    }).catch(() => { /* ignore if client doesn't support logging */ });
  });

  // ─── Graceful Shutdown ──────────────────────────────────────────

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.error("Shutting down Obsidian MCP Server...");
    // Clear any pending auto-sync debounce timer
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    try {
      await server.close();
    } catch {
      // Ignore close errors during shutdown
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  // Log uncaught errors and exit — continuing after uncaughtException is unsafe
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception (exiting):", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err);
  });
}

main().catch((err) => {
  console.error("Fatal error starting Obsidian MCP Server:", err);
  process.exit(1);
});
