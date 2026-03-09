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
