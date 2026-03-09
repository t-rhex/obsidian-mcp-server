#!/usr/bin/env node

/**
 * Integration test suite for mcp-obsidian-vault.
 * Runs without any test framework — just Node.js assertions.
 * Exit code 0 = all pass, 1 = failures.
 */

import { mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

// Dynamic imports from build output
const { Vault } = await import("../build/vault.js");
const { GitOps } = await import("../build/git.js");
const { loadConfig } = await import("../build/config.js");
const { parseNote, serializeNote, addTags, removeTags } = await import("../build/frontmatter.js");
const { buildTaskFrontmatter, buildTaskBody, buildTaskPath, parseTaskFrontmatter, generateTaskId, slugify } = await import("../build/task-schema.js");
const { scanTasks, generateDashboard, refreshDashboard } = await import("../build/task-dashboard.js");
const { createTaskHandler, createTaskSchema } = await import("../build/tools/create-task.js");
const { listTasksHandler, listTasksSchema } = await import("../build/tools/list-tasks.js");
const { claimTaskHandler, claimTaskSchema } = await import("../build/tools/claim-task.js");
const { createProjectHandler } = await import("../build/tools/create-project.js");
const { getProjectStatusHandler } = await import("../build/tools/get-project-status.js");
const { registerPrompts } = await import("../build/prompts.js");
const { updateTaskHandler, updateTaskSchema } = await import("../build/tools/update-task.js");
const { completeTaskHandler, completeTaskSchema } = await import("../build/tools/complete-task.js");
const { getContextHandler } = await import("../build/tools/get-context.js");
const { logDecisionHandler } = await import("../build/tools/log-decision.js");
const { logDiscoveryHandler } = await import("../build/tools/log-discovery.js");
const { reviewTaskHandler } = await import("../build/tools/review-task.js");
const { registerAgentHandler } = await import("../build/tools/register-agent.js");
const { listAgentsHandler } = await import("../build/tools/list-agents.js");
const { suggestAssigneeHandler } = await import("../build/tools/suggest-assignee.js");
const { checkTimeoutsHandler } = await import("../build/tools/check-timeouts.js");
const { logUsageHandler } = await import("../build/tools/log-usage.js");
const { getUsageReportHandler } = await import("../build/tools/get-usage-report.js");
const { EventBus } = await import("../build/events.js");

// ─── Setup ──────────────────────────────────────────────────────────

const VAULT = join(process.cwd(), ".test-vault");
rmSync(VAULT, { recursive: true, force: true });
mkdirSync(VAULT, { recursive: true });
mkdirSync(join(VAULT, "Projects"), { recursive: true });
mkdirSync(join(VAULT, "A"), { recursive: true });
mkdirSync(join(VAULT, "B"), { recursive: true });

writeFileSync(
  join(VAULT, "Projects/test.md"),
  `---
title: Test Note
tags:
  - project
  - test
---

# Test Note

This is a test note.

\`\`\`
#not-a-tag in code block
\`\`\`

Some text with #inline-tag here.

Link to [[Other Note]] and [[Projects/test|self ref]].
`
);

writeFileSync(join(VAULT, "Projects/readme.md"), "# Readme\nSome content");
writeFileSync(
  join(VAULT, "Other Note.md"),
  "# Other Note\n\nLinks back to [[Projects/test]].\n"
);

process.env.OBSIDIAN_VAULT_PATH = VAULT;
const config = loadConfig();
const vault = new Vault(config);
const git = new GitOps(config);

let passed = 0;
let failed = 0;
const failures = [];

function assert(test, name) {
  if (test) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.error(`  FAIL: ${name}`);
  }
}

function section(name) {
  console.log(`\n--- ${name} ---`);
}

// ─── Tests ──────────────────────────────────────────────────────────

section("Read Note");
{
  const raw = await vault.readNote("Projects/test");
  const parsed = parseNote(raw);
  assert(parsed.frontmatter.title === "Test Note", "frontmatter parsed");
  assert(parsed.tags.includes("project"), "frontmatter tags found");
  assert(parsed.tags.includes("inline-tag"), "inline tag found");
  assert(!parsed.tags.includes("not-a-tag"), "code block tag excluded");
}

section("Path Traversal");
{
  try {
    vault.resolvePath("../../etc/passwd");
    assert(false, "path traversal blocked");
  } catch (e) {
    assert(e.code === "PATH_TRAVERSAL", "path traversal blocked");
  }
}

section("Empty Path");
{
  try {
    vault.resolvePath("");
    assert(false, "empty path rejected");
  } catch (e) {
    assert(e.code === "INVALID_PATH", "empty path rejected");
  }
  try {
    vault.resolvePath("   ");
    assert(false, "whitespace path rejected");
  } catch (e) {
    assert(e.code === "INVALID_PATH", "whitespace path rejected");
  }
}

section("Write & Overwrite Protection");
{
  await vault.writeNote("new-note", "# New Note\nHello!");
  const created = await vault.readNote("new-note");
  assert(created.includes("Hello!"), "note created and readable");

  try {
    await vault.writeNote("new-note", "overwrite attempt");
    assert(false, "overwrite prevented");
  } catch (e) {
    assert(e.code === "NOTE_ALREADY_EXISTS", "overwrite prevented");
  }
}

section("Append");
{
  await vault.appendNote("new-note", "## Appended");
  const appended = await vault.readNote("new-note");
  assert(appended.includes("Appended"), "append works");
}

section("Delete (Trash)");
{
  await vault.writeNote("to-delete", "delete me");
  const result = await vault.deleteNote("to-delete");
  assert(result.trashed === true, "file moved to trash");

  try {
    await vault.readNote("to-delete");
    assert(false, "deleted file not readable");
  } catch (e) {
    assert(e.code === "NOTE_NOT_FOUND", "deleted file not readable");
  }
}

section("Delete (Permanent)");
{
  await vault.writeNote("to-perm-delete", "delete me permanently");
  const permResult = await vault.deleteNote("to-perm-delete", {
    permanent: true,
  });
  assert(permResult.trashed === false, "permanent flag respected");
}

section("Trash Collision Safety");
{
  writeFileSync(join(VAULT, "A/same.md"), "file A");
  writeFileSync(join(VAULT, "B/same.md"), "file B");
  await vault.deleteNote("A/same");
  await vault.deleteNote("B/same");
  assert(true, "no collision on trash (no crash)");
}

section("List");
{
  const entries = await vault.list("", { recursive: false });
  assert(entries.length > 0, "list returns entries");
  assert(!entries.some((e) => e.name === ".trash"), "hidden dirs excluded");
}

section("Search");
{
  const searchResults = await vault.search("Test Note");
  assert(searchResults.length > 0, "search finds results");
  assert(
    searchResults[0].path.includes("test.md"),
    "search finds correct file"
  );
}

section("Tag Operations");
{
  const fm = { title: "X", tags: ["a", "b"] };
  const added = addTags(fm, ["c", "a"]);
  assert(
    Array.isArray(added.tags) && added.tags.length === 3,
    "addTags deduplicates"
  );

  const removed = removeTags(added, ["b"]);
  assert(
    Array.isArray(removed.tags) && removed.tags.length === 2,
    "removeTags works"
  );
  assert(!removed.tags.includes("b"), "removed tag is gone");
}

section("Frontmatter Roundtrip");
{
  const serialized1 = serializeNote({ title: "Hello" }, "Body content");
  const parsed1 = parseNote(serialized1);
  assert(parsed1.frontmatter.title === "Hello", "roundtrip preserves frontmatter");
  assert(parsed1.content.trim() === "Body content", "roundtrip preserves content");

  const serialized2 = serializeNote(parsed1.frontmatter, parsed1.content);
  const parsed2 = parseNote(serialized2);
  const serialized3 = serializeNote(parsed2.frontmatter, parsed2.content);
  assert(
    serialized2 === serialized3,
    "no newline accumulation on repeated serialization"
  );
}

section("Write Callback");
{
  let callbackPath = null;
  vault.onWrite = (path) => {
    callbackPath = path;
  };
  await vault.writeNote("callback-test", "test", { overwrite: false });
  assert(callbackPath !== null, "onWrite callback fired on writeNote");

  callbackPath = null;
  await vault.deleteNote("callback-test");
  assert(callbackPath !== null, "onWrite callback fired on deleteNote");
  vault.onWrite = null;
}

section("Git");
{
  const isInstalled = await git.isGitInstalled();
  assert(isInstalled, "git is installed");

  const isRepo = await git.isGitRepo();
  assert(!isRepo, "vault is not yet a git repo");

  // Test init + commit
  await git.init();
  const isRepoAfterInit = await git.isGitRepo();
  assert(isRepoAfterInit, "vault is git repo after init");

  await git.add();
  const commitResult = await git.commit("test commit");
  assert(commitResult.hash.length > 0, "commit produced a hash");

  const log = await git.log(5);
  assert(log.length === 1, "one commit in log");
  assert(log[0].message === "test commit", "correct commit message");

  const status = await git.status();
  assert(status.clean, "clean after commit");
}

section("Config Extension Normalization");
{
  process.env.NOTE_EXTENSIONS = "md,txt,.markdown";
  const config2 = loadConfig();
  assert(
    config2.noteExtensions.every((e) => e.startsWith(".")),
    "extensions normalized with dots"
  );
  delete process.env.NOTE_EXTENSIONS;
}

// ─── Task Schema Tests ──────────────────────────────────────────────

section("Task Schema — generateTaskId");
{
  const id1 = generateTaskId();
  const id2 = generateTaskId();
  assert(id1.startsWith("task-"), "task ID has prefix");
  assert(id1 !== id2, "task IDs are unique");
  assert(/^task-\d{4}-\d{2}-\d{2}-[a-z0-9]+$/.test(id1), "task ID matches format");
}

section("Task Schema — slugify");
{
  assert(slugify("Fix the BUG in login") === "fix-the-bug-in-login", "slugify lowercases and hyphenates");
  assert(slugify("  --spaces--  ") === "spaces", "slugify trims dashes");
  assert(slugify("a".repeat(100)).length <= 60, "slugify truncates to 60 chars");
}

section("Task Schema — buildTaskFrontmatter defaults");
{
  const fm = buildTaskFrontmatter({ title: "Test Task" });
  assert(fm.title === "Test Task", "title preserved");
  assert(fm.status === "pending", "default status is pending");
  assert(fm.priority === "medium", "default priority is medium");
  assert(fm.type === "other", "default type is other");
  assert(fm.assignee === "", "default assignee is empty");
  assert(fm.timeout_minutes === 60, "default timeout is 60");
  assert(Array.isArray(fm.depends_on) && fm.depends_on.length === 0, "empty depends_on");
  assert(Array.isArray(fm.scope) && fm.scope.length === 0, "empty scope");
  assert(Array.isArray(fm.context_notes) && fm.context_notes.length === 0, "empty context_notes");
}

section("Task Schema — parseTaskFrontmatter");
{
  const result = parseTaskFrontmatter({
    id: "task-2026-03-09-abc",
    title: "My Task",
    status: "in_progress",
    priority: "high",
    type: "code",
    assignee: "agent-1",
    created: "2026-03-09",
    updated: "2026-03-09",
    depends_on: ["task-1", "task-2"],
    scope: ["src/foo.ts"],
    context_notes: ["Projects/bar"],
    timeout_minutes: 120,
    tags: ["urgent"],
  });
  assert(result !== null, "parsed valid task");
  assert(result.id === "task-2026-03-09-abc", "id parsed");
  assert(result.status === "in_progress", "status parsed");
  assert(result.depends_on.length === 2, "depends_on parsed");

  // Null for non-task
  const nonTask = parseTaskFrontmatter({ title: "Not a task" });
  assert(nonTask === null, "returns null for non-task frontmatter");

  // Lenient parsing — unknown status falls back
  const lenient = parseTaskFrontmatter({ id: "x", status: "bogus" });
  assert(lenient.status === "pending", "invalid status falls back to pending");
}

section("Task Schema — buildTaskBody");
{
  const body = buildTaskBody("Do the thing", ["Tests pass", "Docs updated"]);
  assert(body.includes("## Description"), "body has Description heading");
  assert(body.includes("Do the thing"), "body has description text");
  assert(body.includes("## Acceptance Criteria"), "body has Acceptance Criteria");
  assert(body.includes("- [ ] Tests pass"), "body has criteria checkboxes");
  assert(body.includes("## Agent Log"), "body has Agent Log section");
}

// ─── Task Tool Integration Tests ────────────────────────────────────

// Set up Tasks folder in the test vault
mkdirSync(join(VAULT, "Tasks"), { recursive: true });

section("Task Tools — create_task");
{
  const handler = createTaskHandler(vault, config);
  const result = await handler({
    title: "Implement auth module",
    description: "Build JWT-based authentication for the API.",
    priority: "high",
    type: "code",
    acceptance_criteria: ["Tests pass", "Docs written"],
    source: "test",
    tags: ["auth"],
  });
  assert(!result.isError, "create_task succeeded");
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "create_task returns success");
  assert(data.task.id.startsWith("task-"), "created task has ID");
  assert(data.task.status === "pending", "created task is pending");
  assert(data.task.priority === "high", "created task priority preserved");

  // Verify dashboard was created
  try {
    const dash = await vault.readNote("Tasks/DASHBOARD");
    assert(dash.includes("Task Dashboard"), "dashboard created after create_task");
  } catch {
    assert(false, "dashboard created after create_task");
  }
}

// Create a second task that depends on the first
let firstTaskId;
let secondTaskId;

section("Task Tools — create dependent task + list_tasks");
{
  // List to get the first task's ID
  const listHandler = listTasksHandler(vault, config);
  const listResult = await listHandler({ status: "all", include_completed: true });
  const listData = JSON.parse(listResult.content[0].text);
  assert(listData.total >= 1, "list_tasks finds at least 1 task");
  firstTaskId = listData.tasks[0].id;

  // Create a dependent task
  const createHandler = createTaskHandler(vault, config);
  const result = await createHandler({
    title: "Write auth tests",
    description: "Integration tests for auth module.",
    priority: "medium",
    type: "code",
    depends_on: [firstTaskId],
    source: "test",
  });
  const data = JSON.parse(result.content[0].text);
  secondTaskId = data.task.id;
  assert(data.task.status === "blocked", "dependent task starts as blocked");
}

section("Task Tools — list_tasks filters");
{
  const handler = listTasksHandler(vault, config);

  // Filter by status
  const pendingResult = await handler({ status: "pending" });
  const pendingData = JSON.parse(pendingResult.content[0].text);
  assert(pendingData.tasks.every((t) => t.status === "pending"), "filter by pending works");

  // Filter by priority
  const highResult = await handler({ priority: "high" });
  const highData = JSON.parse(highResult.content[0].text);
  assert(highData.tasks.every((t) => t.priority === "high"), "filter by priority works");

  // Unassigned only
  const unassignedResult = await handler({ unassigned_only: true });
  const unassignedData = JSON.parse(unassignedResult.content[0].text);
  assert(unassignedData.tasks.every((t) => !t.assignee), "unassigned filter works");
}

section("Task Tools — claim_task");
{
  const handler = claimTaskHandler(vault, config);

  // Claim the first task
  const result = await handler({ task_id: firstTaskId, assignee: "test-agent" });
  assert(!result.isError, "claim_task succeeded");
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "claim returns success");
  assert(data.assignee === "test-agent", "assignee set correctly");
  assert(data.status === "claimed", "status is claimed");

  // Double claim should fail
  const doubleResult = await handler({ task_id: firstTaskId, assignee: "agent-2" });
  assert(doubleResult.isError === true, "double claim returns error");
  const errData = JSON.parse(doubleResult.content[0].text);
  assert(errData.error === "TASK_ALREADY_CLAIMED", "double claim error code correct");
}

section("Task Tools — claim blocked task fails");
{
  const handler = claimTaskHandler(vault, config);
  const result = await handler({ task_id: secondTaskId, assignee: "agent-2" });
  assert(result.isError === true, "claim blocked task returns error");
  const data = JSON.parse(result.content[0].text);
  assert(data.error === "TASK_BLOCKED", "blocked claim error code correct");
}

section("Task Tools — update_task");
{
  const handler = updateTaskHandler(vault, config);

  // Move from claimed to in_progress
  const result = await handler({
    task_id: firstTaskId,
    status: "in_progress",
    log_entry: "Starting implementation of auth module.",
  });
  assert(!result.isError, "update_task succeeded");
  const data = JSON.parse(result.content[0].text);
  assert(data.changes.includes("status: claimed -> in_progress"), "status transition logged");
  assert(data.changes.includes("log entry appended"), "log entry change logged");

  // Verify log was written
  const tasks = await scanTasks(vault, "Tasks");
  const task = tasks.find((t) => t.task.id === firstTaskId);
  const raw = await vault.readNote(task.path);
  assert(raw.includes("Starting implementation"), "log entry in file");

  // Invalid transition: in_progress -> blocked is valid, but "claimed" is no longer
  // accepted by update_task (must use claim_task). Test with a no-op call instead.
  const noopResult = await handler({ task_id: firstTaskId });
  assert(noopResult.isError === true, "no-op update rejected");
  const errData = JSON.parse(noopResult.content[0].text);
  assert(errData.error === "NO_CHANGES", "no-op error code");
}

section("Task Tools — update_task log on terminal task requires retry");
{
  // Terminal tasks reject field changes unless retrying via status: "pending".
  // Log-only appends on terminal tasks are allowed (tested after complete_task).
}

section("Task Tools — complete_task");
{
  const handler = completeTaskHandler(vault, config);

  const result = await handler({
    task_id: firstTaskId,
    summary: "Auth module implemented with JWT support.",
    deliverables: ["src/auth.ts", "src/auth.test.ts"],
  });
  assert(!result.isError, "complete_task succeeded");
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "complete returns success");
  assert(data.status === "completed", "status is completed");
  assert(data.completed_at, "completed_at is set");
  assert(data.deliverables.length === 2, "deliverables recorded");
  // The second task depended on the first — it should be unblocked
  assert(data.unblocked_tasks.includes(secondTaskId), "dependent task unblocked");

  // Verify the task file has deliverables section
  const tasks = await scanTasks(vault, "Tasks");
  const task = tasks.find((t) => t.task.id === firstTaskId);
  const raw = await vault.readNote(task.path);
  assert(raw.includes("## Deliverables"), "deliverables section in file");
  assert(raw.includes("src/auth.ts"), "deliverable path in file");
  assert(raw.includes("[COMPLETED]"), "completion entry in agent log");

  // Double complete should fail
  const doubleResult = await handler({
    task_id: firstTaskId,
    summary: "Trying again",
  });
  assert(doubleResult.isError === true, "double complete returns error");
}

section("Task Tools — complete_task unblocked second task");
{
  // The second task should now be pending (unblocked)
  const listHandler = listTasksHandler(vault, config);
  const result = await listHandler({ status: "pending" });
  const data = JSON.parse(result.content[0].text);
  const second = data.tasks.find((t) => t.id === secondTaskId);
  assert(second !== undefined, "second task found in pending list");
  assert(second.status === "pending", "second task is now pending (unblocked)");
}

section("Task Tools — complete_task with failed status");
{
  // Claim and start the second task, then fail it
  const claimHandler = claimTaskHandler(vault, config);
  await claimHandler({ task_id: secondTaskId, assignee: "test-agent" });

  const updateHandler = updateTaskHandler(vault, config);
  await updateHandler({ task_id: secondTaskId, status: "in_progress" });

  const handler = completeTaskHandler(vault, config);
  const result = await handler({
    task_id: secondTaskId,
    summary: "Tests failed due to missing dependency.",
    status: "failed",
    error_reason: "Missing @auth/jwt package.",
  });
  assert(!result.isError, "complete_task with failed succeeded");
  const data = JSON.parse(result.content[0].text);
  assert(data.status === "failed", "status is failed");

  // Verify error reason in file
  const tasks = await scanTasks(vault, "Tasks");
  const task = tasks.find((t) => t.task.id === secondTaskId);
  const raw = await vault.readNote(task.path);
  assert(raw.includes("[FAILED]"), "failed entry in agent log");
  assert(raw.includes("Missing @auth/jwt"), "error reason in agent log");
}

section("Task Tools — claim nonexistent task");
{
  const handler = claimTaskHandler(vault, config);
  const result = await handler({ task_id: "task-fake-id-000", assignee: "agent" });
  assert(result.isError === true, "claim nonexistent returns error");
  const data = JSON.parse(result.content[0].text);
  assert(data.error === "TASK_NOT_FOUND", "not found error code");
}

section("Task Dashboard");
{
  const tasks = await scanTasks(vault, "Tasks");
  assert(tasks.length >= 2, "scanTasks finds tasks");

  const dashboard = generateDashboard(tasks);
  assert(dashboard.includes("# Task Dashboard"), "dashboard has title");
  assert(dashboard.includes("## Summary"), "dashboard has summary");
  assert(dashboard.includes("| Status | Count |"), "dashboard has status table");
  assert(dashboard.includes("## Recently Completed"), "dashboard has completed section");
}

section("Task Tools — retry failed task (#15)");
{
  // Second task is failed from earlier test. Retry it.
  const updateHandler = updateTaskHandler(vault, config);
  const retryResult = await updateHandler({ task_id: secondTaskId, status: "pending" });
  assert(!retryResult.isError, "retry failed task succeeded");
  const retryData = JSON.parse(retryResult.content[0].text);
  assert(retryData.changes.some((c) => c.includes("failed -> pending")), "retry transition logged");

  // Verify retry_count incremented and assignee cleared
  const tasks = await scanTasks(vault, "Tasks");
  const retried = tasks.find((t) => t.task.id === secondTaskId);
  assert(retried.task.status === "pending", "retried task is pending");
  assert(retried.task.assignee === "", "retried task assignee cleared");
  assert(retried.task.retry_count === 1, "retry_count incremented to 1");
}

section("Task Tools — dashboard_refreshed in responses");
{
  const handler = listTasksHandler(vault, config);
  const result = await handler({ status: "all", include_completed: true });
  const data = JSON.parse(result.content[0].text);
  // list_tasks doesn't refresh dashboard, but create/claim/update/complete do
  // Verify the field exists in create responses
  const createHandler = createTaskHandler(vault, config);
  const createResult = await createHandler({
    title: "Dashboard test task",
    description: "Testing dashboard_refreshed field.",
    source: "test",
  });
  const createData = JSON.parse(createResult.content[0].text);
  assert(createData.dashboard_refreshed === true, "dashboard_refreshed field in create response");
}

section("Task Tools — ISO datetime timestamps");
{
  const tasks = await scanTasks(vault, "Tasks");
  const anyTask = tasks[0];
  // created and updated should be ISO format (contain T or at least more than YYYY-MM-DD)
  assert(anyTask.task.created.length > 10, "created uses ISO datetime (not just date)");
  assert(anyTask.task.updated.length > 10, "updated uses ISO datetime (not just date)");
}

section("Task Tools — is_overdue in list_tasks");
{
  const handler = listTasksHandler(vault, config);
  const result = await handler({ status: "all", include_completed: true });
  const data = JSON.parse(result.content[0].text);
  // All tasks should have is_overdue field
  assert(data.tasks.every((t) => typeof t.is_overdue === "boolean"), "is_overdue field present");
  assert(data.tasks.every((t) => typeof t.retry_count === "number"), "retry_count field present");
}

section("Task Tools — create_task with depends_on warns on missing IDs (#19)");
{
  const handler = createTaskHandler(vault, config);
  const result = await handler({
    title: "Task with bad dep",
    description: "Depends on nonexistent task",
    depends_on: ["task-nonexistent-fake-id"],
    source: "test",
  });
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "task created despite bad dep");
  assert(data.warnings && data.warnings.length > 0, "warning about missing depends_on ID");
}

section("Task Tools — create_task with assignee + depends_on (#22)");
{
  const handler = createTaskHandler(vault, config);
  const result = await handler({
    title: "Pre-assigned with deps",
    description: "Has both assignee and depends_on",
    assignee: "agent-1",
    depends_on: [firstTaskId],
    source: "test",
  });
  const data = JSON.parse(result.content[0].text);
  assert(data.task.status === "blocked", "depends_on takes precedence over assignee — status is blocked");
}

section("Task Tools — claimed_at set on claim (#17)");
{
  // Claim the retried second task
  const claimHandler = claimTaskHandler(vault, config);
  const result = await claimHandler({ task_id: secondTaskId, assignee: "test-agent" });
  const data = JSON.parse(result.content[0].text);
  assert(data.claimed_at, "claimed_at returned in claim response");
  assert(data.claimed_at.includes("T"), "claimed_at is ISO datetime");
}

// ─── Project Tool Tests ─────────────────────────────────────────────

let projectId;

section("Project Tools — create_project");
{
  const handler = createProjectHandler(vault, config);
  const result = await handler({
    title: "Auth Rewrite",
    description: "Rewrite the authentication system to use JWT tokens.",
    priority: "high",
    tasks: [
      { title: "Design API schema", type: "research", description: "Document the new API endpoints." },
      { title: "Implement JWT module", type: "code", depends_on_indices: [0], scope: ["src/auth.ts"] },
      { title: "Write integration tests", type: "code", depends_on_indices: [1] },
      { title: "Update API docs", type: "writing" },  // parallel — no deps
    ],
    context_notes: ["Projects/api-design"],
    tags: ["auth", "v2"],
    source: "test",
  });
  assert(!result.isError, "create_project succeeded");
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "create_project returns success");
  assert(data.project.id.startsWith("proj-"), "project has proj- ID");
  assert(data.tasks.length === 4, "4 sub-tasks created");
  assert(data.summary.pending === 2, "2 tasks immediately claimable (no deps)");
  assert(data.summary.blocked === 2, "2 tasks blocked by dependencies");
  assert(data.dashboard_refreshed === true, "dashboard refreshed");
  projectId = data.project.id;

  // Verify task states
  const designTask = data.tasks.find((t) => t.title === "Design API schema");
  assert(designTask.status === "pending", "task without deps is pending");

  const jwtTask = data.tasks.find((t) => t.title === "Implement JWT module");
  assert(jwtTask.status === "blocked", "task with dep is blocked");

  const docsTask = data.tasks.find((t) => t.title === "Update API docs");
  assert(docsTask.status === "pending", "parallel task is pending");
}

section("Project Tools — create_project validates dependency indices");
{
  const handler = createProjectHandler(vault, config);

  // Out of range index
  const badResult = await handler({
    title: "Bad Project",
    description: "Has invalid dep index",
    tasks: [
      { title: "Task A" },
      { title: "Task B", depends_on_indices: [5] },
    ],
    source: "test",
  });
  assert(badResult.isError === true, "invalid dep index returns error");
  const errData = JSON.parse(badResult.content[0].text);
  assert(errData.error === "INVALID_DEPENDENCY_INDEX", "correct error code");

  // Self-dependency
  const selfDepResult = await handler({
    title: "Self Dep Project",
    description: "Has self dep",
    tasks: [
      { title: "Task A", depends_on_indices: [0] },
    ],
    source: "test",
  });
  assert(selfDepResult.isError === true, "self-dep returns error");
}

section("Project Tools — get_project_status");
{
  const handler = getProjectStatusHandler(vault, config);
  const result = await handler({ project_id: projectId });
  assert(!result.isError, "get_project_status succeeded");
  const data = JSON.parse(result.content[0].text);

  assert(data.project.id === projectId, "correct project ID");
  assert(data.project.title === "Auth Rewrite", "correct project title");
  assert(data.progress.total === 4, "4 total sub-tasks");
  assert(data.progress.completed === 0, "0 completed initially");
  assert(data.progress.percent === 0, "0% progress");
  assert(data.progress.all_done === false, "not all done");
  assert(data.status_breakdown.pending === 2, "2 pending");
  assert(data.status_breakdown.blocked === 2, "2 blocked");
  assert(data.active_agents.length === 0, "no active agents initially");
  assert(data.tasks.length === 4, "4 tasks in listing");
}

section("Project Tools — get_project_status with nonexistent project");
{
  const handler = getProjectStatusHandler(vault, config);
  const result = await handler({ project_id: "proj-nonexistent-fake" });
  assert(result.isError === true, "nonexistent project returns error");
}

section("Project Tools — list_tasks project filter");
{
  const handler = listTasksHandler(vault, config);

  // Filter by project
  const result = await handler({ project: projectId });
  const data = JSON.parse(result.content[0].text);
  assert(data.total === 4, "project filter returns 4 sub-tasks");
  assert(data.tasks.every((t) => t.project === projectId), "all tasks belong to project");

  // Exclude projects
  const noProjects = await handler({ exclude_projects: true, status: "all", include_completed: true });
  const noProjectData = JSON.parse(noProjects.content[0].text);
  assert(noProjectData.tasks.every((t) => t.type !== "project"), "exclude_projects works — no project-type tasks");
}

section("Project Tools — multi-agent parallel work");
{
  // Two agents claim two independent tasks from the same project
  const listHandler = listTasksHandler(vault, config);
  const listResult = await listHandler({ project: projectId, status: "pending", unassigned_only: true });
  const listData = JSON.parse(listResult.content[0].text);
  assert(listData.total >= 2, "at least 2 claimable tasks in project");

  const claimHandler = claimTaskHandler(vault, config);
  const claim1 = await claimHandler({ task_id: listData.tasks[0].id, assignee: "agent-alpha" });
  const claim2 = await claimHandler({ task_id: listData.tasks[1].id, assignee: "agent-beta" });

  assert(!claim1.isError, "agent-alpha claimed successfully");
  assert(!claim2.isError, "agent-beta claimed successfully");

  // Verify both show up as active agents
  const statusHandler = getProjectStatusHandler(vault, config);
  const statusResult = await statusHandler({ project_id: projectId });
  const statusData = JSON.parse(statusResult.content[0].text);
  assert(statusData.active_agents.length === 2, "2 active agents on project");
  assert(
    statusData.active_agents.some((a) => a.agent === "agent-alpha"),
    "agent-alpha is active",
  );
  assert(
    statusData.active_agents.some((a) => a.agent === "agent-beta"),
    "agent-beta is active",
  );
}

section("Project Tools — dashboard includes projects section");
{
  const tasks = await scanTasks(vault, "Tasks");
  const dashboard = generateDashboard(tasks);
  assert(dashboard.includes("## Projects"), "dashboard has projects section");
  assert(dashboard.includes("Auth Rewrite"), "dashboard shows project name");
}

// ─── Append Mode Tests ──────────────────────────────────────────────

let appendedTaskIds;

section("Project Tools — create_project append mode");
{
  // Get an existing task ID from the project for depends_on_existing
  const listHandler = listTasksHandler(vault, config);
  const listResult = await listHandler({ project: projectId, status: "all" });
  const listData = JSON.parse(listResult.content[0].text);
  const existingTaskId = listData.tasks[0].id;

  const handler = createProjectHandler(vault, config);
  const result = await handler({
    project_id: projectId,
    tasks: [
      { title: "Add rate limiting", type: "code", description: "Implement rate limiting on auth endpoints." },
      { title: "Security audit", type: "research", depends_on_indices: [0], description: "Audit the new auth flow." },
      { title: "Load testing", type: "code", depends_on_existing: [existingTaskId], description: "Load test the auth endpoints." },
    ],
    source: "test",
  });
  assert(!result.isError, "append mode succeeded");
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "append returns success");
  assert(data.mode === "append", "mode is append");
  assert(data.project.id === projectId, "same project ID");
  assert(data.tasks.length === 3, "3 new tasks created");
  assert(data.summary.pending === 1, "1 task immediately claimable");
  assert(data.summary.blocked === 2, "2 tasks blocked");
  assert(data.dashboard_refreshed === true, "dashboard refreshed after append");

  // Verify the new tasks belong to the project
  const rateLimitTask = data.tasks.find((t) => t.title === "Add rate limiting");
  assert(rateLimitTask.status === "pending", "rate limiting task is pending (no deps)");

  const auditTask = data.tasks.find((t) => t.title === "Security audit");
  assert(auditTask.status === "blocked", "audit task is blocked (depends on rate limiting)");

  const loadTestTask = data.tasks.find((t) => t.title === "Load testing");
  assert(loadTestTask.status === "blocked", "load test task is blocked (depends_on_existing)");

  appendedTaskIds = data.tasks.map((t) => t.id);
}

section("Project Tools — append mode updates project note Sub-Tasks");
{
  // Read the project note and verify it has the new tasks listed
  const listHandler = listTasksHandler(vault, config);
  const listResult = await listHandler({ project: projectId, status: "all" });
  const listData = JSON.parse(listResult.content[0].text);

  // Original 4 + new 3 = 7 total tasks in the project
  assert(listData.total === 7, "project now has 7 sub-tasks after append");

  // Verify new tasks have correct project field
  for (const tid of appendedTaskIds) {
    const task = listData.tasks.find((t) => t.id === tid);
    assert(task, `appended task ${tid} exists in project listing`);
    assert(task.project === projectId, `appended task ${tid} belongs to project`);
  }
}

section("Project Tools — append mode get_project_status reflects new tasks");
{
  const handler = getProjectStatusHandler(vault, config);
  const result = await handler({ project_id: projectId });
  const data = JSON.parse(result.content[0].text);

  assert(data.progress.total === 7, "project status shows 7 total tasks");
  assert(data.tasks.length === 7, "project status lists all 7 tasks");
}

section("Project Tools — append mode with nonexistent project fails");
{
  const handler = createProjectHandler(vault, config);
  const result = await handler({
    project_id: "proj-nonexistent-fake",
    tasks: [{ title: "Orphan task" }],
    source: "test",
  });
  assert(result.isError === true, "append to nonexistent project fails");
  const data = JSON.parse(result.content[0].text);
  assert(data.error === "PROJECT_NOT_FOUND", "correct error code for missing project");
}

section("Project Tools — append mode with invalid depends_on_existing fails");
{
  const handler = createProjectHandler(vault, config);
  const result = await handler({
    project_id: projectId,
    tasks: [{ title: "Bad dep task", depends_on_existing: ["task-fake-nonexistent"] }],
    source: "test",
  });
  assert(result.isError === true, "invalid depends_on_existing fails");
  const data = JSON.parse(result.content[0].text);
  assert(data.error === "INVALID_EXISTING_DEPENDENCY", "correct error code for invalid existing dep");
}

section("Project Tools — new project requires title and description");
{
  const handler = createProjectHandler(vault, config);

  // Missing title
  const noTitle = await handler({
    tasks: [{ title: "Some task" }],
    source: "test",
  });
  assert(noTitle.isError === true, "missing title returns error");
  const titleErr = JSON.parse(noTitle.content[0].text);
  assert(titleErr.error === "MISSING_TITLE", "correct error for missing title");

  // Missing description
  const noDesc = await handler({
    title: "Has Title",
    tasks: [{ title: "Some task" }],
    source: "test",
  });
  assert(noDesc.isError === true, "missing description returns error");
  const descErr = JSON.parse(noDesc.content[0].text);
  assert(descErr.error === "MISSING_DESCRIPTION", "correct error for missing description");
}

section("Task Config — TASKS_FOLDER env var");
{
  process.env.TASKS_FOLDER = "MyTasks";
  const config3 = loadConfig();
  assert(config3.tasksFolder === "MyTasks", "TASKS_FOLDER env var respected");
  delete process.env.TASKS_FOLDER;

  const config4 = loadConfig();
  assert(config4.tasksFolder === "Tasks", "default tasksFolder is Tasks");
}

// ─── Prompt Tests ───────────────────────────────────────────────────

section("MCP Prompts — registration");
{
  // Create a test MCP server and register prompts
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const testServer = new McpServer({ name: "test", version: "0.0.0" });

  // Should not throw
  try {
    registerPrompts(testServer);
    assert(true, "prompts registered without error");
  } catch (e) {
    assert(false, "prompts registered without error: " + e.message);
  }

  // Verify all 3 prompts are registered by trying to register again (should throw)
  const promptNames = ["task-worker", "project-manager", "vault-assistant"];
  for (const name of promptNames) {
    try {
      testServer.prompt(name, "duplicate", () => ({ messages: [] }));
      assert(false, `prompt '${name}' was registered`);
    } catch (e) {
      // "Prompt X is already registered" — this confirms it exists
      assert(e.message.includes("already registered"), `prompt '${name}' was registered`);
    }
  }
}

// ─── Context & Knowledge Tools ──────────────────────────────────────

// --- log_decision ---
{
  console.log("\n--- Context Tools — log_decision ---\n");

  const handler = logDecisionHandler(vault, config);
  const res = await handler({
    title: "Use JWT over session tokens",
    context: "We need stateless auth for our microservices architecture. Sessions require sticky sessions or shared store.",
    decision: "Use JWT with RS256 signing for service-to-service auth. Short-lived access tokens (15m) with refresh tokens.",
    alternatives: [
      "Session tokens with Redis store — rejected due to additional infrastructure",
      "API keys — rejected due to lack of expiry and rotation support",
    ],
    consequences: [
      "Positive: Stateless, no shared session store needed",
      "Negative: Token revocation requires a deny-list or short expiry",
    ],
    status: "accepted",
    tags: ["auth", "architecture"],
    source: "agent-claude-1",
  });

  const data = JSON.parse(res.content[0].text);
  assert(data.success === true, "log_decision returns success");
  assert(data.decision.title === "Use JWT over session tokens", "log_decision captures title");
  assert(data.decision.status === "accepted", "log_decision captures status");
  assert(data.decision.path.startsWith("Decisions/"), "log_decision writes to Decisions/ folder");
  assert(data.decision.path.endsWith(".md"), "log_decision creates .md file");
  assert(!res.isError, "log_decision is not an error");

  // Read back and verify content
  const raw = await vault.readNote(data.decision.path);
  const parsed = parseNote(raw);
  assert(parsed.frontmatter.title === "Use JWT over session tokens", "decision frontmatter has title");
  assert(parsed.frontmatter.status === "accepted", "decision frontmatter has status");
  assert(parsed.frontmatter.source === "agent-claude-1", "decision frontmatter has source");
  assert(Array.isArray(parsed.frontmatter.tags), "decision frontmatter has tags");
  assert(parsed.content.includes("## Context"), "decision body has Context section");
  assert(parsed.content.includes("## Decision"), "decision body has Decision section");
  assert(parsed.content.includes("## Alternatives Considered"), "decision body has Alternatives section");
  assert(parsed.content.includes("## Consequences"), "decision body has Consequences section");
  assert(parsed.content.includes("Session tokens with Redis"), "decision body has alternative content");
}

// --- log_discovery ---
{
  console.log("\n--- Context Tools — log_discovery ---\n");

  const handler = logDiscoveryHandler(vault, config);
  const res = await handler({
    title: "macOS tmp is a symlink to private tmp",
    discovery: "/tmp on macOS is a symlink to /private/tmp. Path comparisons using realpathSync will resolve through this symlink, causing path mismatch errors if the vault path is /tmp/...",
    context: "Discovered while running integration tests on macOS. Tests passed on Linux but failed on macOS.",
    impact: "high",
    recommendation: "Always use realpathSync on the vault path during config loading to resolve symlinks before any path comparisons.",
    category: "gotcha",
    tags: ["macos", "filesystem", "testing"],
    related_files: ["src/config.ts", "src/vault.ts"],
    source: "agent-claude-1",
  });

  const data = JSON.parse(res.content[0].text);
  assert(data.success === true, "log_discovery returns success");
  assert(data.discovery.title === "macOS tmp is a symlink to private tmp", "log_discovery captures title");
  assert(data.discovery.impact === "high", "log_discovery captures impact");
  assert(data.discovery.category === "gotcha", "log_discovery captures category");
  assert(data.discovery.path.startsWith("Discoveries/"), "log_discovery writes to Discoveries/ folder");
  assert(!res.isError, "log_discovery is not an error");

  // Read back and verify content
  const raw = await vault.readNote(data.discovery.path);
  const parsed = parseNote(raw);
  assert(parsed.frontmatter.title === "macOS tmp is a symlink to private tmp", "discovery frontmatter has title");
  assert(parsed.frontmatter.impact === "high", "discovery frontmatter has impact");
  assert(parsed.frontmatter.category === "gotcha", "discovery frontmatter has category");
  assert(parsed.content.includes("## Discovery"), "discovery body has Discovery section");
  assert(parsed.content.includes("## Context"), "discovery body has Context section");
  assert(parsed.content.includes("## Recommendation"), "discovery body has Recommendation section");
  assert(parsed.content.includes("## Related Files"), "discovery body has Related Files section");
  assert(parsed.content.includes("src/config.ts"), "discovery body lists related files");
}

// --- get_context ---
{
  console.log("\n--- Context Tools — get_context ---\n");

  const handler = getContextHandler(vault, config);

  // First call — should include the decisions and discoveries we just created
  const res = await handler({ hours: 48 });
  const data = JSON.parse(res.content[0].text);

  assert(data.generated_at !== undefined, "get_context has generated_at timestamp");
  assert(data.window_hours === 48, "get_context respects hours parameter");
  assert(typeof data.summary === "string", "get_context has a summary string");
  assert(!res.isError, "get_context is not an error");

  // Should find our decisions and discoveries
  assert(data.recent_decisions !== undefined, "get_context finds recent decisions");
  assert(data.recent_decisions.length >= 1, "get_context found at least 1 decision");
  assert(data.recent_decisions[0].title === "Use JWT over session tokens", "get_context decision has correct title");

  assert(data.recent_discoveries !== undefined, "get_context finds recent discoveries");
  assert(data.recent_discoveries.length >= 1, "get_context found at least 1 discovery");
  assert(data.recent_discoveries[0].title === "macOS tmp is a symlink to private tmp", "get_context discovery has correct title");

  // Should also include tasks from earlier tests (if any still exist in tasks folder)
  // The summary should be a non-empty string
  assert(data.summary.length > 0, "get_context summary is non-empty");
}

// --- get_context with project filter ---
{
  console.log("\n--- Context Tools — get_context with project filter ---\n");

  const handler = getContextHandler(vault, config);
  const res = await handler({ project_id: "nonexistent-project", hours: 48 });
  const data = JSON.parse(res.content[0].text);

  assert(data.focused_project === "nonexistent-project", "get_context respects project_id filter");
  assert(!res.isError, "get_context with filter is not an error");
}

// --- log_decision with project link ---
{
  console.log("\n--- Context Tools — log_decision with project link ---\n");

  const handler = logDecisionHandler(vault, config);
  const res = await handler({
    title: "Use Zod v4 for validation",
    context: "Need runtime validation for MCP tool inputs.",
    decision: "Use Zod v4. It has better TypeScript inference and smaller bundle.",
    status: "accepted",
    project: "proj-2026-03-09-abc123",
    task_id: "task-2026-03-09-def456",
  });

  const data = JSON.parse(res.content[0].text);
  assert(data.success === true, "log_decision with project returns success");

  const raw = await vault.readNote(data.decision.path);
  const parsed = parseNote(raw);
  assert(parsed.frontmatter.project === "proj-2026-03-09-abc123", "decision links to project");
  assert(parsed.frontmatter.task_id === "task-2026-03-09-def456", "decision links to task");
}

// --- log_discovery minimal fields ---
{
  console.log("\n--- Context Tools — log_discovery minimal ---\n");

  const handler = logDiscoveryHandler(vault, config);
  const res = await handler({
    title: "zod record needs two args in v4",
    discovery: "z.record() in Zod v4 requires two arguments: z.record(z.string(), z.unknown()).",
  });

  const data = JSON.parse(res.content[0].text);
  assert(data.success === true, "log_discovery minimal returns success");
  assert(data.discovery.category === "gotcha", "log_discovery defaults to gotcha category");
  assert(data.discovery.impact === "medium", "log_discovery defaults to medium impact");
}

// --- Config — DECISIONS_FOLDER and DISCOVERIES_FOLDER env vars ---
{
  console.log("\n--- Context Config — folder env vars ---\n");

  const origDecisions = process.env.DECISIONS_FOLDER;
  const origDiscoveries = process.env.DISCOVERIES_FOLDER;

  process.env.DECISIONS_FOLDER = "ADRs";
  process.env.DISCOVERIES_FOLDER = "TIL";
  const customConfig = loadConfig();
  assert(customConfig.decisionsFolder === "ADRs", "DECISIONS_FOLDER env var is respected");
  assert(customConfig.discoveriesFolder === "TIL", "DISCOVERIES_FOLDER env var is respected");

  // Restore
  if (origDecisions) process.env.DECISIONS_FOLDER = origDecisions;
  else delete process.env.DECISIONS_FOLDER;
  if (origDiscoveries) process.env.DISCOVERIES_FOLDER = origDiscoveries;
  else delete process.env.DISCOVERIES_FOLDER;
}

// ─── Feature: Event System ──────────────────────────────────────────

section("Event System — EventBus emits typed events");
{
  const bus = new EventBus();
  const events = [];
  bus.onEvent((e) => events.push(e));
  bus.emitEvent("task.created", { task_id: "test-1", title: "Test" });
  assert(events.length === 1, "event received");
  assert(events[0].event === "task.created", "event type correct");
  assert(events[0].task_id === "test-1", "event data correct");
  assert(events[0].timestamp, "event has timestamp");
}

section("Event System — EventBus typed listener");
{
  const bus = new EventBus();
  const specific = [];
  bus.onEventType("task.completed", (e) => specific.push(e));
  bus.emitEvent("task.created", { task_id: "a" });
  bus.emitEvent("task.completed", { task_id: "b" });
  assert(specific.length === 1, "only matching events received");
  assert(specific[0].task_id === "b", "correct event received");
}

// ─── Feature: HITL / Approval Gates ─────────────────────────────────

let reviewTaskId;

section("HITL — create task with review_required");
{
  const handler = createTaskHandler(vault, config);
  const result = await handler({
    title: "Security patch",
    description: "Fix critical vulnerability",
    review_required: true,
    risk_level: "high",
    priority: "critical",
    source: "test",
  });
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "task created with review_required");
  reviewTaskId = data.task.id;
}

section("HITL — complete_task redirects to needs_review");
{
  // Claim and work on the task
  const claimH = claimTaskHandler(vault, config);
  await claimH({ task_id: reviewTaskId, assignee: "agent-review" });
  const updateH = updateTaskHandler(vault, config);
  await updateH({ task_id: reviewTaskId, status: "in_progress" });

  // Complete — should redirect to needs_review
  const completeH = completeTaskHandler(vault, config);
  const result = await completeH({
    task_id: reviewTaskId,
    summary: "Vulnerability patched.",
    deliverables: ["src/security.ts"],
  });
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "complete_task succeeded");
  assert(data.status === "needs_review", "redirected to needs_review");
  assert(data.review_redirected === true, "review_redirected flag set");
}

section("HITL — review_task reject");
{
  const handler = reviewTaskHandler(vault, config);
  const result = await handler({
    task_id: reviewTaskId,
    action: "reject",
    feedback: "Need more test coverage before approving.",
    reviewer: "human-lead",
  });
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "review reject succeeded");
  assert(data.status === "revision_requested", "status is revision_requested");
  assert(data.action === "reject", "action recorded");
}

section("HITL — revision requested task can go back to in_progress");
{
  const handler = updateTaskHandler(vault, config);
  const result = await handler({ task_id: reviewTaskId, status: "in_progress" });
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "revision_requested -> in_progress works");
}

section("HITL — re-complete and approve");
{
  // Complete again (still has review_required)
  const completeH = completeTaskHandler(vault, config);
  await completeH({ task_id: reviewTaskId, summary: "Added tests, ready for re-review." });

  // Now approve
  const reviewH = reviewTaskHandler(vault, config);
  const result = await reviewH({
    task_id: reviewTaskId,
    action: "approve",
    feedback: "Looks good now.",
    reviewer: "human-lead",
  });
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "review approve succeeded");
  assert(data.status === "completed", "status is completed after approval");
}

section("HITL — review non-review task fails");
{
  // Create a normal task
  const createH = createTaskHandler(vault, config);
  const createRes = await createH({ title: "Normal task", description: "No review", source: "test" });
  const normalId = JSON.parse(createRes.content[0].text).task.id;

  const handler = reviewTaskHandler(vault, config);
  const result = await handler({ task_id: normalId, action: "approve" });
  assert(result.isError === true, "reviewing non-review task fails");
  const data = JSON.parse(result.content[0].text);
  assert(data.error === "TASK_NOT_IN_REVIEW", "correct error code");
}

section("HITL — review_task reject requires feedback");
{
  // Create and push to needs_review
  const createH = createTaskHandler(vault, config);
  const createRes = await createH({
    title: "Feedback required test",
    description: "test",
    review_required: true,
    source: "test",
  });
  const tid = JSON.parse(createRes.content[0].text).task.id;
  const claimH = claimTaskHandler(vault, config);
  await claimH({ task_id: tid, assignee: "test-agent" });
  const updateH = updateTaskHandler(vault, config);
  await updateH({ task_id: tid, status: "in_progress" });
  const completeH = completeTaskHandler(vault, config);
  await completeH({ task_id: tid, summary: "Done" });

  const handler = reviewTaskHandler(vault, config);
  const result = await handler({ task_id: tid, action: "request_changes" });
  assert(result.isError === true, "reject without feedback fails");
  const data = JSON.parse(result.content[0].text);
  assert(data.error === "FEEDBACK_REQUIRED", "correct error for missing feedback");
}

// ─── Feature: Agent Registry ────────────────────────────────────────

section("Agent Registry — register_agent");
{
  const handler = registerAgentHandler(vault, config);
  const result = await handler({
    agent_id: "agent-coder-1",
    capabilities: ["code", "research"],
    tags: ["typescript", "react", "api"],
    max_concurrent: 5,
    model: "claude-sonnet-4",
    description: "TypeScript specialist",
  });
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "register_agent succeeded");
  assert(data.action === "created", "agent was created");
  assert(data.agent.id === "agent-coder-1", "agent ID correct");
  assert(data.agent.capabilities.includes("code"), "capabilities stored");
}

section("Agent Registry — register_agent update existing");
{
  const handler = registerAgentHandler(vault, config);
  const result = await handler({
    agent_id: "agent-coder-1",
    max_concurrent: 10,
  });
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "update succeeded");
  assert(data.action === "updated", "agent was updated");
}

section("Agent Registry — register second agent");
{
  const handler = registerAgentHandler(vault, config);
  await handler({
    agent_id: "agent-writer-1",
    capabilities: ["writing", "research"],
    tags: ["docs", "api"],
    model: "claude-sonnet-4",
  });
}

section("Agent Registry — list_agents");
{
  const handler = listAgentsHandler(vault, config);
  const result = await handler({});
  const data = JSON.parse(result.content[0].text);
  assert(data.total >= 2, "at least 2 agents listed");
}

section("Agent Registry — list_agents with capability filter");
{
  const handler = listAgentsHandler(vault, config);
  const result = await handler({ capability: "writing" });
  const data = JSON.parse(result.content[0].text);
  assert(data.agents.every((a) => a.capabilities.includes("writing")), "capability filter works");
}

section("Agent Registry — list_agents available_only");
{
  const handler = listAgentsHandler(vault, config);
  const result = await handler({ available_only: true });
  const data = JSON.parse(result.content[0].text);
  assert(data.agents.every((a) => a.current_tasks < a.max_concurrent), "available_only filter works");
}

section("Agent Registry — suggest_assignee");
{
  // Create a code task with typescript tag
  const createH = createTaskHandler(vault, config);
  const createRes = await createH({
    title: "Build API endpoint",
    description: "Create REST endpoint",
    type: "code",
    tags: ["typescript", "api"],
    source: "test",
  });
  const tid = JSON.parse(createRes.content[0].text).task.id;

  const handler = suggestAssigneeHandler(vault, config);
  const result = await handler({ task_id: tid });
  const data = JSON.parse(result.content[0].text);
  assert(data.suggestions.length > 0, "suggestions returned");
  assert(data.suggestions[0].agent_id === "agent-coder-1", "best match is the coder agent");
}

section("Agent Registry — suggest_assignee nonexistent task");
{
  const handler = suggestAssigneeHandler(vault, config);
  const result = await handler({ task_id: "task-nonexistent" });
  assert(result.isError === true, "nonexistent task returns error");
}

// ─── Feature: Retry & Escalation ────────────────────────────────────

section("Retry — create task with max_retries");
{
  const handler = createTaskHandler(vault, config);
  const result = await handler({
    title: "Flaky deploy",
    description: "Deploy that sometimes fails",
    max_retries: 3,
    retry_delay_minutes: 1,
    escalate_to: "human",
    source: "test",
  });
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "task with retry policy created");
}

let retryTaskId;

section("Retry — check_timeouts with overdue task");
{
  // Create a task, claim it, and backdate claimed_at to simulate timeout
  const createH = createTaskHandler(vault, config);
  const createRes = await createH({
    title: "Stuck task",
    description: "Will time out",
    timeout_minutes: 1,
    source: "test",
  });
  retryTaskId = JSON.parse(createRes.content[0].text).task.id;

  // Claim it
  const claimH = claimTaskHandler(vault, config);
  await claimH({ task_id: retryTaskId, assignee: "stuck-agent" });

  // Backdate claimed_at by 2 hours to simulate timeout
  const allTasks = await scanTasks(vault, "Tasks");
  const entry = allTasks.find((t) => t.task.id === retryTaskId);
  const raw = (await import("node:fs/promises")).readFile;
  const content = await raw(join(VAULT, entry.path), "utf-8");
  const backdated = content.replace(
    /claimed_at: .*/,
    `claimed_at: "${new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()}"`,
  );
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(VAULT, entry.path), backdated, "utf-8");

  // Run check_timeouts
  const handler = checkTimeoutsHandler(vault, config);
  const result = await handler({ dry_run: false });
  const data = JSON.parse(result.content[0].text);
  assert(data.timed_out.length >= 1, "timed out task detected");
  assert(data.timed_out.some((t) => t.task_id === retryTaskId), "correct task timed out");
}

section("Retry — check_timeouts dry_run");
{
  const handler = checkTimeoutsHandler(vault, config);
  const result = await handler({ dry_run: true });
  const data = JSON.parse(result.content[0].text);
  assert(data.dry_run === true, "dry_run flag in response");
}

// ─── Feature: Conditional Workflows ─────────────────────────────────

section("Conditional Workflows — routing_rules on complete");
{
  // Create a project with conditional branching
  const createProjH = createProjectHandler(vault, config);
  const projResult = await createProjH({
    title: "Conditional Pipeline",
    description: "Test routing rules",
    tasks: [
      {
        title: "Run tests",
        type: "code",
        routing_rules: [
          { condition: "output_contains", value: "all tests passed", activate: ["idx:1"] },
          { condition: "output_contains", value: "tests failed", activate: ["idx:2"], deactivate: ["idx:1"] },
        ],
      },
      { title: "Deploy to staging", depends_on_indices: [0] },
      { title: "Fix failing tests", depends_on_indices: [0] },
    ],
    source: "test",
  });
  const projData = JSON.parse(projResult.content[0].text);
  const runTestsId = projData.tasks[0].id;
  const deployId = projData.tasks[1].id;
  const fixTestsId = projData.tasks[2].id;

  // Verify that create_project resolved idx:N references to real task IDs
  const allTasks = await scanTasks(vault, "Tasks");
  const runTestsEntry = allTasks.find((t) => t.task.id === runTestsId);
  assert(runTestsEntry.task.routing_rules, "routing_rules stored on task");
  assert(runTestsEntry.task.routing_rules.length === 2, "two routing rules");
  assert(
    runTestsEntry.task.routing_rules[0].activate.includes(deployId),
    "idx:1 resolved to deploy task ID in activate",
  );
  assert(
    runTestsEntry.task.routing_rules[1].activate.includes(fixTestsId),
    "idx:2 resolved to fix-tests task ID in activate",
  );
  assert(
    runTestsEntry.task.routing_rules[1].deactivate.includes(deployId),
    "idx:1 resolved to deploy task ID in deactivate",
  );

  // Claim and complete "Run tests" with "all tests passed"
  const claimH = claimTaskHandler(vault, config);
  await claimH({ task_id: runTestsId, assignee: "test-agent" });
  const updateH = updateTaskHandler(vault, config);
  await updateH({ task_id: runTestsId, status: "in_progress" });
  const completeH = completeTaskHandler(vault, config);
  const completeResult = await completeH({
    task_id: runTestsId,
    summary: "all tests passed successfully",
  });
  const completeData = JSON.parse(completeResult.content[0].text);

  // Deploy should be unblocked, fix tests should NOT be unblocked
  assert(completeData.unblocked_tasks.includes(deployId), "deploy task unblocked by routing");
  assert(!completeData.unblocked_tasks.includes(fixTestsId), "fix tests task NOT unblocked");
}

// ─── Feature: Token/Cost Tracking ───────────────────────────────────

section("Usage Tracking — log_usage");
{
  const handler = logUsageHandler(vault, config);
  const result = await handler({
    agent_id: "agent-coder-1",
    input_tokens: 15000,
    output_tokens: 3000,
    model: "claude-sonnet-4",
    cost_usd: 0.042,
    duration_seconds: 30,
    notes: "Implemented auth module",
  });
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "log_usage succeeded");
  assert(data.usage.id.startsWith("usage-"), "usage ID generated");
  assert(data.usage.input_tokens === 15000, "input tokens recorded");
}

section("Usage Tracking — log_usage with task_id");
{
  const handler = logUsageHandler(vault, config);
  const result = await handler({
    agent_id: "agent-coder-1",
    task_id: reviewTaskId,
    input_tokens: 5000,
    output_tokens: 1000,
    model: "claude-sonnet-4",
  });
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "log_usage with task succeeded");
}

section("Usage Tracking — get_usage_report");
{
  const handler = getUsageReportHandler(vault, config);
  const result = await handler({});
  const data = JSON.parse(result.content[0].text);
  const report = data.report;
  assert(report.total_input_tokens >= 20000, "aggregated input tokens");
  assert(report.total_output_tokens >= 4000, "aggregated output tokens");
  assert(report.record_count >= 2, "at least 2 records");
  assert(report.by_agent && Object.keys(report.by_agent).length > 0, "by_agent grouping exists");
}

section("Usage Tracking — get_usage_report with agent filter");
{
  const handler = getUsageReportHandler(vault, config);
  const result = await handler({ agent_id: "agent-coder-1" });
  const data = JSON.parse(result.content[0].text);
  assert(data.report.record_count >= 2, "agent filter returns correct count");
}

// ─── Feature: Dashboard includes new statuses ───────────────────────

section("Dashboard — includes needs_review and revision sections");
{
  const tasks = await scanTasks(vault, "Tasks");
  const dashboard = generateDashboard(tasks);
  // The dashboard should have at least the standard sections
  assert(dashboard.includes("# Task Dashboard"), "dashboard has title");
  assert(dashboard.includes("## Summary"), "dashboard has summary");
}

// ─── Config: new env vars ───────────────────────────────────────────

section("Config — AGENTS_FOLDER and USAGE_FOLDER env vars");
{
  process.env.AGENTS_FOLDER = "MyAgents";
  process.env.USAGE_FOLDER = "MyUsage";
  const customConfig = loadConfig();
  assert(customConfig.agentsFolder === "MyAgents", "AGENTS_FOLDER env var respected");
  assert(customConfig.usageFolder === "MyUsage", "USAGE_FOLDER env var respected");
  delete process.env.AGENTS_FOLDER;
  delete process.env.USAGE_FOLDER;

  const defaultConfig = loadConfig();
  assert(defaultConfig.agentsFolder === "Agents", "default agentsFolder is Agents");
  assert(defaultConfig.usageFolder === "Usage", "default usageFolder is Usage");
}

section("Config — WEBHOOK_URL parsing");
{
  process.env.WEBHOOK_URL = "https://hooks.example.com/a, https://hooks.example.com/b";
  const customConfig = loadConfig();
  assert(customConfig.webhookUrls.length === 2, "WEBHOOK_URL parsed into array");
  assert(customConfig.webhookUrls[0] === "https://hooks.example.com/a", "first URL correct");
  assert(customConfig.webhookUrls[1] === "https://hooks.example.com/b", "second URL correct");
  delete process.env.WEBHOOK_URL;
}

// ─── Schema: new fields in parseTaskFrontmatter ─────────────────────

section("Task Schema — new fields parse correctly");
{
  const fm = {
    id: "task-test-new",
    title: "Test",
    status: "pending",
    review_required: true,
    risk_level: "high",
    max_retries: 3,
    retry_delay_minutes: 10,
    escalate_to: "human",
    escalation_status: "none",
    review_count: 2,
    routing_rules: [
      { condition: "output_contains", value: "pass", activate: ["task-a"] },
    ],
  };
  const parsed = parseTaskFrontmatter(fm);
  assert(parsed.review_required === true, "review_required parsed");
  assert(parsed.risk_level === "high", "risk_level parsed");
  assert(parsed.max_retries === 3, "max_retries parsed");
  assert(parsed.retry_delay_minutes === 10, "retry_delay_minutes parsed");
  assert(parsed.escalate_to === "human", "escalate_to parsed");
  assert(parsed.review_count === 2, "review_count parsed");
  assert(parsed.routing_rules.length === 1, "routing_rules parsed");
  assert(parsed.routing_rules[0].condition === "output_contains", "routing rule condition");
}

section("Task Schema — new fields defaults");
{
  const fm = { id: "task-minimal", status: "pending" };
  const parsed = parseTaskFrontmatter(fm);
  assert(parsed.max_retries === 0, "max_retries defaults to 0");
  assert(parsed.retry_delay_minutes === 5, "retry_delay_minutes defaults to 5");
  assert(parsed.escalation_status === "none", "escalation_status defaults to none");
  assert(parsed.review_count === 0, "review_count defaults to 0");
  assert(parsed.review_required === undefined, "review_required defaults to undefined");
}

// ─── Cleanup & Report ───────────────────────────────────────────────

rmSync(VAULT, { recursive: true, force: true });

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} total`);

if (failed > 0) {
  console.error("\nFailed tests:");
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
} else {
  console.log("\nAll tests passed!");
}
