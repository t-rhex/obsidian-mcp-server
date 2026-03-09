/**
 * list_vault tool — Browse the vault's file and folder structure.
 * Supports recursive listing, depth limits, and extension filtering.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { safeToolHandler } from "../errors.js";

export const listVaultSchema = {
  path: z.string().optional().default("").describe(
    "Folder path relative to vault root. Defaults to vault root.",
  ),
  recursive: z.boolean().optional().default(false).describe(
    "If true, list contents recursively. Default: false.",
  ),
  maxDepth: z.number().optional().default(5).describe(
    "Maximum depth for recursive listing. Default: 5.",
  ),
  notesOnly: z.boolean().optional().default(false).describe(
    "If true, only show note files (markdown). Default: false (shows all files and folders).",
  ),
};

export const listVaultHandler = (vault: Vault) =>
  safeToolHandler(
    async (input: {
      path?: string;
      recursive?: boolean;
      maxDepth?: number;
      notesOnly?: boolean;
    }) => {
      const entries = await vault.list(input.path ?? "", {
        recursive: input.recursive,
        maxDepth: input.maxDepth,
        extensionFilter: input.notesOnly ? [".md", ".markdown"] : undefined,
      });

      // Summarize
      const dirs = entries.filter((e) => e.type === "directory");
      const files = entries.filter((e) => e.type === "file");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                path: input.path || "/",
                summary: {
                  totalDirectories: dirs.length,
                  totalFiles: files.length,
                },
                entries: entries.map((e) => ({
                  name: e.name,
                  path: e.path,
                  type: e.type,
                  ...(e.extension ? { extension: e.extension } : {}),
                  ...(e.size !== undefined ? { size: e.size } : {}),
                  ...(e.modifiedAt ? { modifiedAt: e.modifiedAt } : {}),
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
