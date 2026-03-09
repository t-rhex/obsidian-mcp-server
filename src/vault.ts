/**
 * Vault filesystem operations — safe, validated access to the Obsidian vault.
 *
 * Key robustness features:
 * - Path traversal prevention (no escaping vault root, symlink-aware)
 * - Atomic writes via write-to-temp-then-rename
 * - File size limits
 * - Hidden file/folder exclusion (.obsidian, .trash, etc.)
 * - Auto-creation of parent directories
 * - Safe trash deletion (no silent permanent delete on rename failure)
 */

import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Config } from "./config.js";
import { ErrorCode, VaultError } from "./errors.js";

/** Directories that should never be exposed or modified */
const HIDDEN_DIRS = new Set([".obsidian", ".trash", ".git", ".DS_Store"]);

export interface ListEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  extension?: string;
  size?: number;
  modifiedAt?: string;
}

export interface SearchResult {
  path: string;
  matches: { line: number; content: string }[];
  score: number;
}

export class Vault {
  /** Optional callback invoked after successful write or delete operations */
  public onWrite: ((path: string) => void) | null = null;

  constructor(private readonly config: Config) {}

  // ─── Path Safety ──────────────────────────────────────────────────

  /**
   * Resolve a user-supplied relative path to an absolute path inside the vault.
   * Throws on any path traversal attempt.
   */
  resolvePath(relativePath: string): string {
    // EDGE-1 + EDGE-2: Empty/whitespace paths
    const trimmed = relativePath.trim();
    if (trimmed.length === 0) {
      throw new VaultError(ErrorCode.INVALID_PATH, "Path cannot be empty");
    }

    // Normalize and clean
    const cleaned = normalize(trimmed).replace(/^\/+/, "");

    if (cleaned.includes("\0")) {
      throw new VaultError(ErrorCode.INVALID_PATH, "Path contains null bytes");
    }

    const absolute = resolve(this.config.vaultPath, cleaned);
    const rel = relative(this.config.vaultPath, absolute);

    // If the relative path starts with ".." we've escaped the vault
    if (rel.startsWith("..") || resolve(absolute) === resolve(this.config.vaultPath, "..", rel)) {
      throw new VaultError(
        ErrorCode.PATH_TRAVERSAL,
        `Path "${relativePath}" would escape the vault root`,
        { attempted: relativePath },
      );
    }

    // SEC-2: Prefix check must use separator to prevent prefix bypass
    if (absolute !== this.config.vaultPath && !absolute.startsWith(this.config.vaultPath + sep)) {
      throw new VaultError(
        ErrorCode.PATH_TRAVERSAL,
        `Resolved path escapes vault: ${absolute}`,
      );
    }

    return absolute;
  }

  /**
   * SEC-1: Resolve path and validate the real path (after symlink resolution)
   * is still inside the vault. For files that don't exist yet (write operations),
   * validate the parent directory's real path instead.
   */
  private resolveAndValidateRealPath(relativePath: string): string {
    const absPath = this.resolvePath(relativePath);

    try {
      // Try to resolve symlinks on the actual path
      const realPath = realpathSync(absPath);
      this.validateRealPathInVault(realPath);
      return absPath;
    } catch (err) {
      // If the file doesn't exist yet (e.g., for write operations),
      // validate the parent directory's real path instead
      if (err instanceof VaultError) throw err;

      const parentDir = dirname(absPath);
      try {
        const realParent = realpathSync(parentDir);
        this.validateRealPathInVault(realParent);
      } catch (parentErr) {
        if (parentErr instanceof VaultError) throw parentErr;
        // Parent doesn't exist either — will be created by mkdir later, that's ok.
        // The resolvePath check above already validated the logical path.
      }
      return absPath;
    }
  }

  private validateRealPathInVault(realPath: string): void {
    if (realPath !== this.config.vaultPath && !realPath.startsWith(this.config.vaultPath + sep)) {
      throw new VaultError(
        ErrorCode.PATH_TRAVERSAL,
        `Real path escapes vault after symlink resolution`,
      );
    }
  }

  /**
   * Convert absolute path back to vault-relative path for display.
   */
  relativePath(absolutePath: string): string {
    return relative(this.config.vaultPath, absolutePath);
  }

  /**
   * Ensure a path has a valid note extension; add .md if missing.
   */
  ensureNoteExtension(filePath: string): string {
    const ext = extname(filePath);
    if (this.config.noteExtensions.includes(ext)) return filePath;
    return filePath + ".md";
  }

  // ─── Read Operations ──────────────────────────────────────────────

  /**
   * Read a note's raw content as a UTF-8 string.
   * Validates existence and file size in a single stat call.
   */
  async readNote(relativePath: string): Promise<string> {
    const absPath = this.resolveAndValidateRealPath(this.ensureNoteExtension(relativePath));

    // ERR-3: Single stat call replaces assertFileExists + assertFileSizeLimit
    let stats;
    try {
      stats = await stat(absPath);
    } catch {
      const relPath = this.relativePath(absPath);
      throw new VaultError(ErrorCode.NOTE_NOT_FOUND, `Note not found: ${relPath}`, {
        path: relPath,
      });
    }

    if (stats.size > this.config.maxFileSizeBytes) {
      throw new VaultError(
        ErrorCode.FILE_TOO_LARGE,
        `File exceeds size limit (${(stats.size / 1024 / 1024).toFixed(1)} MB > ${(this.config.maxFileSizeBytes / 1024 / 1024).toFixed(1)} MB)`,
        { size: stats.size, limit: this.config.maxFileSizeBytes },
      );
    }

    return readFile(absPath, "utf-8");
  }

  /**
   * Check if a file exists at the given vault-relative path.
   */
  async exists(relativePath: string): Promise<boolean> {
    const absPath = this.resolvePath(relativePath);
    try {
      await access(absPath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file stats for a vault-relative path.
   */
  async stat(relativePath: string): Promise<{
    size: number;
    createdAt: string;
    modifiedAt: string;
    isDirectory: boolean;
  }> {
    const absPath = this.resolvePath(relativePath);
    await this.assertFileExists(absPath);
    const stats = await stat(absPath);
    return {
      size: stats.size,
      createdAt: stats.birthtime.toISOString(),
      modifiedAt: stats.mtime.toISOString(),
      isDirectory: stats.isDirectory(),
    };
  }

  // ─── Write Operations ─────────────────────────────────────────────

  /**
   * Write content to a note using atomic write (temp file + rename).
   * Auto-creates parent directories.
   */
  async writeNote(
    relativePath: string,
    content: string,
    options: { overwrite?: boolean } = {},
  ): Promise<string> {
    const notePath = this.ensureNoteExtension(relativePath);
    const absPath = this.resolveAndValidateRealPath(notePath);

    // Overwrite protection
    if (!options.overwrite) {
      const fileExists = await this.fileExists(absPath);
      if (fileExists) {
        throw new VaultError(
          ErrorCode.NOTE_ALREADY_EXISTS,
          `Note already exists: ${notePath}. Set overwrite=true to replace.`,
          { path: notePath },
        );
      }
    }

    // Ensure parent directory exists
    const dir = dirname(absPath);
    await mkdir(dir, { recursive: true });

    // Atomic write: write to temp file, then rename
    const tempPath = join(dir, `.${basename(absPath)}.${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, content, "utf-8");
      await rename(tempPath, absPath);
    } catch (err) {
      // Clean up temp file on failure
      try {
        await unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw new VaultError(
        ErrorCode.WRITE_FAILED,
        `Failed to write note: ${err instanceof Error ? err.message : "Unknown error"}`,
        { path: notePath },
      );
    }

    // Write callback hook for git auto-sync
    this.onWrite?.(notePath);

    return notePath;
  }

  /**
   * Append content to an existing note.
   */
  async appendNote(relativePath: string, content: string): Promise<string> {
    const notePath = this.ensureNoteExtension(relativePath);
    const absPath = this.resolveAndValidateRealPath(notePath);
    await this.assertFileExists(absPath);

    const existing = await readFile(absPath, "utf-8");
    const separator = existing.endsWith("\n") ? "" : "\n";
    await this.writeNote(notePath, existing + separator + content, {
      overwrite: true,
    });

    return notePath;
  }

  // ─── Delete Operations ────────────────────────────────────────────

  /**
   * Delete a note. If trashOnDelete is enabled (and permanent is not true),
   * moves to .trash/ instead. Uses collision-safe trash filenames.
   * Never silently falls through to permanent delete on rename failure.
   */
  async deleteNote(
    relativePath: string,
    options?: { permanent?: boolean },
  ): Promise<{ trashed: boolean; path: string }> {
    const notePath = this.ensureNoteExtension(relativePath);
    const absPath = this.resolveAndValidateRealPath(notePath);
    await this.assertFileExists(absPath);

    const permanent = options?.permanent ?? false;

    if (!permanent && this.config.trashOnDelete) {
      const trashDir = join(this.config.vaultPath, ".trash");
      await mkdir(trashDir, { recursive: true });

      // BUG-3: Use unique trash filename to avoid collisions
      const name = basename(absPath, extname(absPath));
      const ext = extname(absPath);
      const trashFilename = `${name}.${Date.now()}.${randomUUID().slice(0, 8)}${ext}`;
      const trashPath = join(trashDir, trashFilename);

      try {
        await rename(absPath, trashPath);
        // Write callback hook for git auto-sync
        this.onWrite?.(notePath);
        return { trashed: true, path: notePath };
      } catch {
        // BUG-2: If rename fails (e.g. cross-device), try copy-to-trash-then-delete
        // Do NOT fall through to permanent unlink
        try {
          const fileContent = await readFile(absPath);
          await writeFile(trashPath, fileContent);
          await unlink(absPath);
          // Write callback hook for git auto-sync
          this.onWrite?.(notePath);
          return { trashed: true, path: notePath };
        } catch (copyErr) {
          throw new VaultError(
            ErrorCode.DELETE_FAILED,
            `Failed to move note to trash: ${copyErr instanceof Error ? copyErr.message : "Unknown error"}`,
            { path: notePath },
          );
        }
      }
    }

    // Permanent delete
    try {
      await unlink(absPath);
      // Write callback hook for git auto-sync
      this.onWrite?.(notePath);
      return { trashed: false, path: notePath };
    } catch (err) {
      throw new VaultError(
        ErrorCode.DELETE_FAILED,
        `Failed to delete: ${err instanceof Error ? err.message : "Unknown error"}`,
        { path: notePath },
      );
    }
  }

  // ─── List Operations ──────────────────────────────────────────────

  /**
   * List files and directories at a vault-relative path.
   * Excludes hidden directories by default.
   */
  async list(
    relativePath: string = "",
    options: {
      recursive?: boolean;
      maxDepth?: number;
      includeHidden?: boolean;
      extensionFilter?: string[];
    } = {},
  ): Promise<ListEntry[]> {
    const absPath = this.resolvePath(relativePath || ".");

    // ERR-1: Wrap initial stat in try/catch
    let stats;
    try {
      stats = await stat(absPath);
    } catch {
      const relPath = this.relativePath(absPath);
      throw new VaultError(
        ErrorCode.NOTE_NOT_FOUND,
        `Path not found: ${relPath || "."}`,
        { path: relPath },
      );
    }

    if (!stats.isDirectory()) {
      throw new VaultError(
        ErrorCode.INVALID_PATH,
        `Not a directory: ${relativePath}`,
      );
    }

    const results: ListEntry[] = [];
    await this.walkDir(absPath, results, {
      recursive: options.recursive ?? false,
      maxDepth: options.maxDepth ?? 10,
      currentDepth: 0,
      includeHidden: options.includeHidden ?? false,
      extensionFilter: options.extensionFilter,
    });

    return results;
  }

  private async walkDir(
    dirPath: string,
    results: ListEntry[],
    options: {
      recursive: boolean;
      maxDepth: number;
      currentDepth: number;
      includeHidden: boolean;
      extensionFilter?: string[];
    },
  ): Promise<void> {
    if (options.currentDepth > options.maxDepth) return;

    // ERR-1: Wrap readdir in try/catch — skip unreadable dirs
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return; // Skip unreadable directories
    }

    for (const entry of entries) {
      // Skip hidden dirs
      if (!options.includeHidden && HIDDEN_DIRS.has(entry.name)) continue;
      if (!options.includeHidden && entry.name.startsWith(".")) continue;

      // EDGE-7: Skip symlinks entirely to avoid symlink loops
      if (entry.isSymbolicLink()) continue;

      const entryPath = join(dirPath, entry.name);
      const relPath = this.relativePath(entryPath);

      if (entry.isDirectory()) {
        results.push({
          name: entry.name,
          path: relPath,
          type: "directory",
        });

        if (options.recursive) {
          await this.walkDir(entryPath, results, {
            ...options,
            currentDepth: options.currentDepth + 1,
          });
        }
      } else if (entry.isFile()) {
        const ext = extname(entry.name);

        // Apply extension filter
        if (options.extensionFilter && !options.extensionFilter.includes(ext)) {
          continue;
        }

        // ERR-2: Wrap stat in try/catch — skip files that can't be stat'd
        try {
          const fileStat = await stat(entryPath);
          results.push({
            name: entry.name,
            path: relPath,
            type: "file",
            extension: ext,
            size: fileStat.size,
            modifiedAt: fileStat.mtime.toISOString(),
          });
        } catch {
          // Skip files that can't be stat'd
        }
      }
    }
  }

  // ─── Search ───────────────────────────────────────────────────────

  /**
   * Full-text search across all notes in the vault.
   * Supports plain text and regex patterns.
   * Has timeout protection and result limits.
   */
  async search(
    query: string,
    options: {
      regex?: boolean;
      caseSensitive?: boolean;
      maxResults?: number;
      folder?: string;
      extensionFilter?: string[];
    } = {},
  ): Promise<SearchResult[]> {
    const maxResults = options.maxResults ?? this.config.maxSearchResults;
    const extensions = options.extensionFilter ?? this.config.noteExtensions;

    let pattern: RegExp;
    try {
      const flags = options.caseSensitive ? "g" : "gi";
      pattern = options.regex
        ? new RegExp(query, flags)
        : new RegExp(escapeRegex(query), flags);
    } catch (err) {
      throw new VaultError(
        ErrorCode.SEARCH_FAILED,
        `Invalid search pattern: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    }

    const searchRoot = options.folder
      ? this.resolvePath(options.folder)
      : this.config.vaultPath;

    const results: SearchResult[] = [];
    const startTime = Date.now();

    await this.searchDir(searchRoot, pattern, extensions, results, {
      maxResults,
      startTime,
      timeoutMs: this.config.searchTimeoutMs,
    });

    // Sort by number of matches (most relevant first)
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, maxResults);
  }

  private async searchDir(
    dirPath: string,
    pattern: RegExp,
    extensions: string[],
    results: SearchResult[],
    limits: { maxResults: number; startTime: number; timeoutMs: number },
  ): Promise<void> {
    // Timeout protection
    if (Date.now() - limits.startTime > limits.timeoutMs) {
      throw new VaultError(
        ErrorCode.SEARCH_TIMEOUT,
        `Search timed out after ${limits.timeoutMs}ms`,
      );
    }

    if (results.length >= limits.maxResults) return;

    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return; // Skip unreadable directories
    }

    for (const entry of entries) {
      if (HIDDEN_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      if (results.length >= limits.maxResults) return;

      // EDGE-8: Skip symlinks entirely to avoid symlink loops
      if (entry.isSymbolicLink()) continue;

      const entryPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        await this.searchDir(entryPath, pattern, extensions, results, limits);
      } else if (entry.isFile() && extensions.includes(extname(entry.name))) {
        try {
          const fileStat = await stat(entryPath);
          // Skip files exceeding size limit
          if (fileStat.size > this.config.maxFileSizeBytes) continue;

          const content = await readFile(entryPath, "utf-8");
          const lines = content.split("\n");
          const matches: { line: number; content: string }[] = [];

          for (let i = 0; i < lines.length; i++) {
            // Reset regex lastIndex for each line
            pattern.lastIndex = 0;
            if (pattern.test(lines[i])) {
              matches.push({
                line: i + 1,
                content: lines[i].substring(0, 200), // Truncate long lines
              });
            }
          }

          if (matches.length > 0) {
            results.push({
              path: this.relativePath(entryPath),
              matches: matches.slice(0, 10), // Max 10 match contexts per file
              score: matches.length,
            });
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  // ─── Internal Helpers ─────────────────────────────────────────────

  private async assertFileExists(absPath: string): Promise<void> {
    try {
      await access(absPath, constants.F_OK);
    } catch {
      const relPath = this.relativePath(absPath);
      throw new VaultError(ErrorCode.NOTE_NOT_FOUND, `Note not found: ${relPath}`, {
        path: relPath,
      });
    }
  }

  private async fileExists(absPath: string): Promise<boolean> {
    try {
      await access(absPath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
