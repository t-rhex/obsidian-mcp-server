/**
 * Git CLI wrapper — safe, robust git operations for vault synchronization.
 *
 * Key features:
 * - Uses execFile (no shell injection)
 * - All commands scoped to vault working directory
 * - Configurable timeout per command
 * - Mutex lock to prevent concurrent git operations
 * - Structured error handling via VaultError
 */

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { ErrorCode, VaultError } from "./errors.js";
import { Config } from "./config.js";

/** Lock acquisition timeout in ms */
const LOCK_TIMEOUT_MS = 60_000;

export class GitOps {
  private readonly cwd: string;
  private readonly config: Config;
  private locked = false;
  private lockQueue: (() => void)[] = [];

  constructor(config: Config) {
    this.cwd = config.vaultPath;
    this.config = config;
  }

  // ─── Lock Management ────────────────────────────────────────────

  private async acquireLock(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new VaultError(
            ErrorCode.GIT_TIMEOUT,
            `Git lock acquisition timed out after ${LOCK_TIMEOUT_MS}ms. Another git operation may be stuck.`,
          ),
        );
      }, LOCK_TIMEOUT_MS);
      this.lockQueue.push(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private releaseLock(): void {
    if (this.lockQueue.length > 0) {
      const next = this.lockQueue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }

  // ─── Core Execution ─────────────────────────────────────────────

  private async execGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
    await this.acquireLock();
    try {
      return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile(
          "git",
          args,
          {
            cwd: this.cwd,
            timeout: this.config.gitTimeoutMs,
            maxBuffer: 10 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            if (error) {
              // Handle git not installed (ENOENT)
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                reject(
                  new VaultError(
                    ErrorCode.GIT_NOT_INSTALLED,
                    "Git is not installed or not found in PATH",
                  ),
                );
                return;
              }

              // Handle timeout
              if (error.killed || error.message?.includes("ETIMEDOUT")) {
                reject(
                  new VaultError(
                    ErrorCode.GIT_TIMEOUT,
                    `Git command timed out after ${this.config.gitTimeoutMs}ms: git ${args.join(" ")}`,
                    { args, timeout: this.config.gitTimeoutMs },
                  ),
                );
                return;
              }

              const combinedOutput = `${stdout}\n${stderr}`;

              // Detect merge conflicts
              if (combinedOutput.includes("CONFLICT")) {
                reject(
                  new VaultError(
                    ErrorCode.GIT_CONFLICT,
                    `Merge conflict detected: ${stderr.trim() || stdout.trim()}`,
                    { args, stderr: stderr.trim(), stdout: stdout.trim() },
                  ),
                );
                return;
              }

              // Detect push failures
              if (
                args[0] === "push" ||
                stderr.includes("rejected") ||
                stderr.includes("failed to push")
              ) {
                if (args[0] === "push") {
                  reject(
                    new VaultError(
                      ErrorCode.GIT_PUSH_FAILED,
                      `Git push failed: ${stderr.trim() || error.message}`,
                      { args, stderr: stderr.trim() },
                    ),
                  );
                  return;
                }
              }

              // Generic git command failure
              reject(
                new VaultError(
                  ErrorCode.GIT_COMMAND_FAILED,
                  `Git command failed: git ${args.join(" ")}\n${stderr.trim() || error.message}`,
                  { args, stderr: stderr.trim(), exitCode: error.code },
                ),
              );
              return;
            }

            resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
          },
        );
      });
    } finally {
      this.releaseLock();
    }
  }

  // ─── Public Methods ─────────────────────────────────────────────

  /**
   * Check if git is installed. Does NOT use the lock.
   */
  async isGitInstalled(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      execFile("git", ["--version"], { timeout: 5000 }, (error) => {
        resolve(!error);
      });
    });
  }

  /**
   * Check if the vault is a git repository.
   */
  async isGitRepo(): Promise<boolean> {
    try {
      await access(join(this.cwd, ".git"), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Assert git is installed and vault is a git repo. Throws on failure.
   */
  async assertGitReady(): Promise<void> {
    const installed = await this.isGitInstalled();
    if (!installed) {
      throw new VaultError(
        ErrorCode.GIT_NOT_INSTALLED,
        "Git is not installed or not found in PATH. Please install git.",
      );
    }

    const isRepo = await this.isGitRepo();
    if (!isRepo) {
      throw new VaultError(
        ErrorCode.GIT_NOT_INITIALIZED,
        `Vault at ${this.cwd} is not a git repository. Run 'init' first.`,
        { vaultPath: this.cwd },
      );
    }
  }

  /**
   * Initialize a git repository in the vault.
   */
  async init(): Promise<string> {
    const { stdout } = await this.execGit(["init"]);
    return stdout.trim();
  }

  /**
   * Get the working tree status.
   */
  async status(): Promise<{
    staged: string[];
    modified: string[];
    untracked: string[];
    clean: boolean;
  }> {
    const { stdout } = await this.execGit(["status", "--porcelain=v1"]);

    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];

    const lines = stdout.split("\n").filter((line) => line.length > 0);

    for (const line of lines) {
      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const filePath = line.substring(3);

      // Staged changes (index has A, M, D, R, C)
      if (indexStatus === "A" || indexStatus === "M" || indexStatus === "D" || indexStatus === "R" || indexStatus === "C") {
        staged.push(filePath);
      }

      // Working tree modifications
      if (workTreeStatus === "M" || workTreeStatus === "D") {
        modified.push(filePath);
      }

      // Untracked files
      if (indexStatus === "?" && workTreeStatus === "?") {
        untracked.push(filePath);
      }
    }

    return {
      staged,
      modified,
      untracked,
      clean: lines.length === 0,
    };
  }

  /**
   * Stage files for commit.
   */
  async add(paths: string[] = ["."]): Promise<string> {
    const { stdout } = await this.execGit(["add", ...paths]);
    return stdout.trim();
  }

  /**
   * Commit staged changes.
   */
  async commit(message: string): Promise<{ hash: string; message: string }> {
    try {
      const { stdout } = await this.execGit(["commit", "-m", message]);
      // Parse commit hash from output like "[main abc1234] commit message"
      const match = stdout.match(/\[[\w\s/.()-]+\s+([a-f0-9]+)\]/);
      const hash = match?.[1] ?? "unknown";
      return { hash, message };
    } catch (err) {
      if (
        err instanceof VaultError &&
        err.message.includes("nothing to commit")
      ) {
        return { hash: "", message: "nothing to commit, working tree clean" };
      }
      throw err;
    }
  }

  /**
   * Pull changes from remote.
   */
  async pull(): Promise<{ success: boolean; message: string }> {
    const args = ["pull"];
    if (this.config.gitPullRebase) {
      args.push("--rebase");
    }

    try {
      const { stdout, stderr } = await this.execGit(args);
      const output = `${stdout}\n${stderr}`;

      if (output.includes("Already up to date")) {
        return { success: true, message: "Already up to date." };
      }

      return { success: true, message: stdout.trim() || "Pull completed." };
    } catch (err) {
      if (err instanceof VaultError && err.code === ErrorCode.GIT_CONFLICT) {
        return { success: false, message: err.message };
      }
      throw err;
    }
  }

  /**
   * Push changes to remote. Automatically uses -u on first push when
   * the branch has no upstream tracking branch configured.
   */
  async push(): Promise<{ success: boolean; message: string }> {
    const remote = this.config.gitRemote;
    const branch = this.config.gitBranch;

    // Check if upstream tracking is configured
    let hasUpstream = false;
    try {
      const { stdout } = await this.execGit([
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{u}",
      ]);
      hasUpstream = stdout.trim().length > 0;
    } catch {
      hasUpstream = false;
    }

    const args = hasUpstream
      ? ["push", remote, branch]
      : ["push", "-u", remote, branch];

    const { stdout, stderr } = await this.execGit(args);
    return {
      success: true,
      message: stderr.trim() || stdout.trim() || "Push completed.",
    };
  }

  /**
   * Get commit log.
   */
  async log(
    limit: number = 10,
  ): Promise<{ hash: string; date: string; message: string; author: string }[]> {
    const { stdout } = await this.execGit([
      "log",
      `--format=%H%x00%aI%x00%an%x00%s`,
      `-n`,
      String(limit),
    ]);

    if (!stdout.trim()) {
      return [];
    }

    return stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [hash, date, author, ...messageParts] = line.split("\0");
        return {
          hash: hash ?? "",
          date: date ?? "",
          author: author ?? "",
          message: messageParts.join("\0"),
        };
      });
  }

  /**
   * Show diff of working tree changes.
   */
  async diff(path?: string): Promise<string> {
    const args = ["diff"];
    if (path) {
      args.push("--", path);
    }
    const { stdout } = await this.execGit(args);
    return stdout;
  }

  /**
   * Add a remote repository.
   */
  async remoteAdd(name: string, url: string): Promise<string> {
    const { stdout } = await this.execGit(["remote", "add", name, url]);
    return stdout.trim() || `Remote '${name}' added with URL: ${url}`;
  }

  /**
   * List configured remotes.
   */
  async remoteList(): Promise<{ name: string; url: string; type: string }[]> {
    const { stdout } = await this.execGit(["remote", "-v"]);

    if (!stdout.trim()) {
      return [];
    }

    return stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        // Format: "origin\thttps://github.com/user/repo.git (fetch)"
        const match = line.match(/^(\S+)\t(\S+)\s+\((\w+)\)$/);
        if (match) {
          return { name: match[1], url: match[2], type: match[3] };
        }
        // Fallback parse
        const parts = line.split(/\s+/);
        return {
          name: parts[0] ?? "",
          url: parts[1] ?? "",
          type: (parts[2] ?? "").replace(/[()]/g, ""),
        };
      });
  }

  /**
   * Check if a remote is configured (i.e. has at least one remote).
   */
  async hasRemote(): Promise<boolean> {
    try {
      const remotes = await this.remoteList();
      return remotes.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * All-in-one sync: add all → commit → pull (if remote) → push (if remote).
   * Gracefully skips pull/push when no remote is configured.
   */
  async sync(
    message?: string,
  ): Promise<{
    committed: boolean;
    pulled: boolean;
    pushed: boolean;
    message: string;
  }> {
    // Stage all changes
    await this.add(["-A"]);

    // Check status
    const currentStatus = await this.status();
    let committed = false;
    let commitMsg = "";

    if (!currentStatus.clean) {
      // Build commit message
      const prefix = this.config.gitCommitMessagePrefix;
      const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
      const finalMessage = message ?? `${prefix}${timestamp}`;

      const result = await this.commit(finalMessage);
      committed = result.hash !== "";
      commitMsg = result.message;
    }

    // Check if a remote is configured before attempting pull/push
    const remoteConfigured = await this.hasRemote();
    if (!remoteConfigured) {
      const parts: string[] = [];
      if (committed) parts.push(`Committed: ${commitMsg}`);
      else parts.push("Nothing to commit");
      parts.push("No remote configured, skipping pull/push");
      return { committed, pulled: false, pushed: false, message: parts.join(". ") };
    }

    // Pull
    let pulled = false;
    let pullMsg = "";
    try {
      const pullResult = await this.pull();
      pulled = pullResult.success;
      pullMsg = pullResult.message;
    } catch (err) {
      if (err instanceof VaultError && err.code === ErrorCode.GIT_CONFLICT) {
        return {
          committed,
          pulled: false,
          pushed: false,
          message: `Committed: ${committed}. Pull failed due to merge conflict: ${err.message}`,
        };
      }
      // If pull fails for other reasons (e.g. no upstream tracking branch yet),
      // log but continue to push which will set up tracking
      pullMsg = err instanceof Error ? err.message : String(err);
    }

    // Push
    let pushed = false;
    let pushMsg = "";
    try {
      const pushResult = await this.push();
      pushed = pushResult.success;
      pushMsg = pushResult.message;
    } catch (err) {
      if (err instanceof VaultError && err.code === ErrorCode.GIT_PUSH_FAILED) {
        return {
          committed,
          pulled,
          pushed: false,
          message: `Committed: ${committed}. Pulled: ${pulled}. Push failed: ${err.message}`,
        };
      }
      throw err;
    }

    const parts: string[] = [];
    if (committed) parts.push(`Committed: ${commitMsg}`);
    else parts.push("Nothing to commit");
    if (pulled) parts.push(`Pull: ${pullMsg}`);
    if (pushed) parts.push(`Push: ${pushMsg}`);

    return {
      committed,
      pulled,
      pushed,
      message: parts.join(". "),
    };
  }
}
