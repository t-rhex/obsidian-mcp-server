/**
 * git_sync tool — Git operations for vault synchronization.
 *
 * Supports status, commit, pull, push, sync (all-in-one),
 * log, diff, init, remote_add, and remote_list actions.
 */

import { z } from "zod";
import { writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { GitOps } from "../git.js";
import { Vault } from "../vault.js";
import { safeToolHandler } from "../errors.js";

export const gitSyncSchema = {
  action: z.enum([
    "status", "commit", "pull", "push", "sync",
    "log", "diff", "init", "remote_add", "remote_list",
  ]).describe(
    "Git action to perform. 'sync' does pull+commit+push in one operation. " +
    "'init' initializes a new git repo with a sensible .gitignore.",
  ),
  message: z.string().optional().describe(
    "Commit message (for 'commit' and 'sync' actions). Auto-generated if not provided.",
  ),
  remote_name: z.string().optional().describe(
    "Remote name (for 'remote_add'). Defaults to 'origin'.",
  ),
  remote_url: z.string().optional().describe(
    "Remote URL (for 'remote_add'). e.g. 'git@github.com:user/vault.git'",
  ),
  path: z.string().optional().describe(
    "File path for 'diff' action. If omitted, shows all changes.",
  ),
  limit: z.number().optional().default(10).describe(
    "Number of commits to show for 'log' action. Default: 10.",
  ),
};

const DEFAULT_GITIGNORE = `\
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/plugins/obsidian-git/data.json
.trash/
.DS_Store
`;

interface GitSyncInput {
  action: "status" | "commit" | "pull" | "push" | "sync" | "log" | "diff" | "init" | "remote_add" | "remote_list";
  message?: string;
  remote_name?: string;
  remote_url?: string;
  path?: string;
  limit?: number;
}

export const gitSyncHandler = (git: GitOps, vault: Vault) =>
  safeToolHandler(async (input: GitSyncInput) => {
    const respond = (data: unknown) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(data),
        },
      ],
    });

    switch (input.action) {
      case "init": {
        const result = await git.init();

        // Create .gitignore if it doesn't exist
        const gitignorePath = join(vault.resolvePath("."), ".gitignore");
        let gitignoreCreated = false;
        try {
          await access(gitignorePath, constants.F_OK);
        } catch {
          // File doesn't exist — create it
          await writeFile(gitignorePath, DEFAULT_GITIGNORE, "utf-8");
          gitignoreCreated = true;
        }

        return respond({
          success: true,
          action: "init",
          result,
          gitignoreCreated,
          message: gitignoreCreated
            ? "Repository initialized with .gitignore"
            : "Repository initialized (.gitignore already exists)",
        });
      }

      case "commit": {
        await git.assertGitReady();
        await git.add();
        const commitResult = await git.commit(input.message ?? "manual commit");
        return respond({
          success: true,
          action: "commit",
          hash: commitResult.hash,
          message: commitResult.message,
        });
      }

      case "sync": {
        await git.assertGitReady();
        const syncResult = await git.sync(input.message);
        return respond({
          success: true,
          action: "sync",
          ...syncResult,
        });
      }

      case "pull": {
        await git.assertGitReady();
        const pullResult = await git.pull();
        return respond({
          success: pullResult.success,
          action: "pull",
          message: pullResult.message,
        });
      }

      case "push": {
        await git.assertGitReady();
        const pushResult = await git.push();
        return respond({
          success: pushResult.success,
          action: "push",
          message: pushResult.message,
        });
      }

      case "status": {
        await git.assertGitReady();
        const statusResult = await git.status();
        return respond({
          success: true,
          action: "status",
          ...statusResult,
        });
      }

      case "log": {
        await git.assertGitReady();
        const logResult = await git.log(input.limit ?? 10);
        return respond({
          success: true,
          action: "log",
          commits: logResult,
          count: logResult.length,
        });
      }

      case "diff": {
        await git.assertGitReady();
        const diffResult = await git.diff(input.path);
        return respond({
          success: true,
          action: "diff",
          diff: diffResult || "(no changes)",
          path: input.path ?? "(all files)",
        });
      }

      case "remote_add": {
        await git.assertGitReady();
        if (!input.remote_url) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "MISSING_PARAMETER",
                  message: "remote_url is required for 'remote_add' action.",
                }),
              },
            ],
            isError: true,
          };
        }

        const remoteName = input.remote_name ?? "origin";
        const result = await git.remoteAdd(remoteName, input.remote_url);
        return respond({
          success: true,
          action: "remote_add",
          name: remoteName,
          url: input.remote_url,
          message: result,
        });
      }

      case "remote_list": {
        await git.assertGitReady();
        const remotes = await git.remoteList();
        return respond({
          success: true,
          action: "remote_list",
          remotes,
          count: remotes.length,
        });
      }
    }
  });
