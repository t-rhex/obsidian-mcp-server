/**
 * Configuration management — reads and validates environment variables
 * with sensible defaults.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ErrorCode, VaultError } from "./errors.js";

export interface Config {
  /** Absolute path to the Obsidian vault root */
  vaultPath: string;
  /** Subfolder for daily notes (relative to vault root) */
  dailyNoteFolder: string;
  /** Date format for daily note filenames (YYYY-MM-DD style) */
  dailyNoteFormat: string;
  /** Max file size in bytes to read (protection against huge files) */
  maxFileSizeBytes: number;
  /** Max number of search results returned */
  maxSearchResults: number;
  /** Search timeout in milliseconds */
  searchTimeoutMs: number;
  /** Whether to move deleted files to .trash instead of permanent delete */
  trashOnDelete: boolean;
  /** File extensions considered as notes */
  noteExtensions: string[];
  /** Enable auto git commit+push after writes */
  gitAutoSync: boolean;
  /** Debounce period (ms) before auto-syncing after last write */
  gitAutoSyncDebounceMs: number;
  /** Prefix for auto-commit messages */
  gitCommitMessagePrefix: string;
  /** Default git remote name */
  gitRemote: string;
  /** Default git branch name */
  gitBranch: string;
  /** Timeout for git operations in ms */
  gitTimeoutMs: number;
  /** Use --rebase on git pull */
  gitPullRebase: boolean;
  /** Subfolder for task notes (relative to vault root) */
  tasksFolder: string;
}

const DEFAULT_CONFIG: Omit<Config, "vaultPath"> = {
  dailyNoteFolder: "Daily Notes",
  dailyNoteFormat: "YYYY-MM-DD",
  maxFileSizeBytes: 10 * 1024 * 1024, // 10 MB
  maxSearchResults: 50,
  searchTimeoutMs: 30_000, // 30 seconds
  trashOnDelete: true,
  noteExtensions: [".md", ".markdown"],
  gitAutoSync: false,
  gitAutoSyncDebounceMs: 5000,
  gitCommitMessagePrefix: "vault: ",
  gitRemote: "origin",
  gitBranch: "main",
  gitTimeoutMs: 30_000,
  gitPullRebase: true,
  tasksFolder: "Tasks",
};

export function loadConfig(): Config {
  const rawPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!rawPath) {
    throw new VaultError(
      ErrorCode.CONFIG_INVALID,
      "OBSIDIAN_VAULT_PATH environment variable is required. " +
        "Set it to the absolute path of your Obsidian vault folder.",
    );
  }

  const resolvedPath = resolve(rawPath);

  if (!existsSync(resolvedPath)) {
    throw new VaultError(ErrorCode.VAULT_NOT_FOUND, `Vault path does not exist: ${resolvedPath}`);
  }

  const stat = statSync(resolvedPath);
  if (!stat.isDirectory()) {
    throw new VaultError(
      ErrorCode.CONFIG_INVALID,
      `Vault path is not a directory: ${resolvedPath}`,
    );
  }

  // Resolve symlinks in the vault path itself (e.g. /tmp -> /private/tmp on macOS)
  // so that real-path comparisons in vault.ts work correctly.
  const vaultPath = realpathSync(resolvedPath);

  return {
    ...DEFAULT_CONFIG,
    vaultPath,
    dailyNoteFolder:
      process.env.DAILY_NOTE_FOLDER ?? DEFAULT_CONFIG.dailyNoteFolder,
    dailyNoteFormat: (() => {
      const fmt = process.env.DAILY_NOTE_FORMAT ?? DEFAULT_CONFIG.dailyNoteFormat;
      if (fmt !== "YYYY-MM-DD") {
        console.error(
          `Warning: DAILY_NOTE_FORMAT="${fmt}" is not supported. Only YYYY-MM-DD is currently implemented. Using YYYY-MM-DD.`,
        );
        return "YYYY-MM-DD";
      }
      return fmt;
    })(),
    maxFileSizeBytes: parsePositiveInt(
      process.env.MAX_FILE_SIZE_BYTES,
      DEFAULT_CONFIG.maxFileSizeBytes,
    ),
    maxSearchResults: parsePositiveInt(
      process.env.MAX_SEARCH_RESULTS,
      DEFAULT_CONFIG.maxSearchResults,
    ),
    searchTimeoutMs: parsePositiveInt(
      process.env.SEARCH_TIMEOUT_MS,
      DEFAULT_CONFIG.searchTimeoutMs,
    ),
    trashOnDelete: parseBool(
      process.env.TRASH_ON_DELETE,
      DEFAULT_CONFIG.trashOnDelete,
    ),
    noteExtensions: process.env.NOTE_EXTENSIONS
      ? process.env.NOTE_EXTENSIONS.split(",").map((e) => {
          const trimmed = e.trim();
          return trimmed.startsWith(".") ? trimmed : "." + trimmed;
        })
      : DEFAULT_CONFIG.noteExtensions,
    gitAutoSync: parseBool(process.env.GIT_AUTO_SYNC, DEFAULT_CONFIG.gitAutoSync),
    gitAutoSyncDebounceMs: parsePositiveInt(process.env.GIT_AUTO_SYNC_DEBOUNCE_MS, DEFAULT_CONFIG.gitAutoSyncDebounceMs),
    gitCommitMessagePrefix: process.env.GIT_COMMIT_MESSAGE_PREFIX ?? DEFAULT_CONFIG.gitCommitMessagePrefix,
    gitRemote: process.env.GIT_REMOTE ?? DEFAULT_CONFIG.gitRemote,
    gitBranch: process.env.GIT_BRANCH ?? DEFAULT_CONFIG.gitBranch,
    gitTimeoutMs: parsePositiveInt(process.env.GIT_TIMEOUT_MS, DEFAULT_CONFIG.gitTimeoutMs),
    gitPullRebase: parseBool(process.env.GIT_PULL_REBASE, DEFAULT_CONFIG.gitPullRebase),
    tasksFolder: process.env.TASKS_FOLDER ?? DEFAULT_CONFIG.tasksFolder,
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return ["true", "1", "yes"].includes(value.toLowerCase());
}
