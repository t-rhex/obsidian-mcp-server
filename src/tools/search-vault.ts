/**
 * search_vault tool — Full-text search across all notes.
 * Supports plain text and regex, with configurable limits and timeouts.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { safeToolHandler } from "../errors.js";

export const searchVaultSchema = {
  query: z.string().describe(
    "Search query. Plain text by default; set regex=true for regular expressions.",
  ),
  regex: z.boolean().optional().default(false).describe(
    "Treat the query as a regular expression.",
  ),
  caseSensitive: z.boolean().optional().default(false).describe(
    "Whether the search is case-sensitive. Default: false.",
  ),
  folder: z.string().optional().describe(
    "Limit search to a specific folder (relative to vault root).",
  ),
  maxResults: z.number().optional().default(20).describe(
    "Maximum number of matching files to return. Default: 20.",
  ),
};

export const searchVaultHandler = (vault: Vault) =>
  safeToolHandler(
    async (input: {
      query: string;
      regex?: boolean;
      caseSensitive?: boolean;
      folder?: string;
      maxResults?: number;
    }) => {
      const results = await vault.search(input.query, {
        regex: input.regex,
        caseSensitive: input.caseSensitive,
        folder: input.folder,
        maxResults: input.maxResults,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                query: input.query,
                totalResults: results.length,
                results: results.map((r) => ({
                  path: r.path,
                  matchCount: r.score,
                  matches: r.matches,
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
