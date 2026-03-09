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
const { updateTaskHandler, updateTaskSchema } = await import("../build/tools/update-task.js");
const { completeTaskHandler, completeTaskSchema } = await import("../build/tools/complete-task.js");

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

  // Invalid transition: in_progress -> claimed (not valid)
  const badResult = await handler({ task_id: firstTaskId, status: "claimed" });
  // claimed is not in the valid transitions for in_progress
  // Actually: in_progress -> [completed, failed, blocked, pending, cancelled]
  // So claimed should fail
  // Wait - let me check the transitions. in_progress valid: completed, failed, blocked, pending, cancelled
  // claimed is NOT in that list, so this should fail
  // Actually no - looking at the code, "claimed" IS NOT a valid transition from in_progress
  assert(badResult.isError === true, "invalid transition rejected");
  const errData = JSON.parse(badResult.content[0].text);
  assert(errData.error === "INVALID_TRANSITION", "invalid transition error code");
}

section("Task Tools — update_task log only on terminal task");
{
  // First complete the task, then try to append a log
  // (We'll test this after complete_task)
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

section("Task Config — TASKS_FOLDER env var");
{
  process.env.TASKS_FOLDER = "MyTasks";
  const config3 = loadConfig();
  assert(config3.tasksFolder === "MyTasks", "TASKS_FOLDER env var respected");
  delete process.env.TASKS_FOLDER;

  const config4 = loadConfig();
  assert(config4.tasksFolder === "Tasks", "default tasksFolder is Tasks");
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
