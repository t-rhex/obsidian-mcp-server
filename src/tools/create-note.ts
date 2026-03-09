/**
 * create_note tool — Create a new note with optional frontmatter.
 * Refuses to overwrite existing notes unless explicitly told to.
 * Auto-creates parent folders.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { serializeNote } from "../frontmatter.js";
import { safeToolHandler } from "../errors.js";

export const createNoteSchema = {
  path: z.string().describe(
    "Path for the new note relative to vault root (e.g. 'Projects/new-idea.md'). " +
    "Extension .md is added automatically if missing. Parent folders are created as needed.",
  ),
  content: z.string().describe("Markdown content for the note body."),
  frontmatter: z.record(z.string(), z.unknown()).optional().describe(
    "Optional YAML frontmatter as a JSON object (e.g. { title: 'My Note', tags: ['idea', 'project'] }).",
  ),
  overwrite: z.boolean().optional().default(false).describe(
    "If true, overwrite an existing note at this path. Default is false (fails if note exists).",
  ),
};

export const createNoteHandler = (vault: Vault) =>
  safeToolHandler(
    async (input: {
      path: string;
      content: string;
      frontmatter?: Record<string, unknown>;
      overwrite?: boolean;
    }) => {
      const noteContent = input.frontmatter
        ? serializeNote(input.frontmatter, input.content)
        : input.content;

      const writtenPath = await vault.writeNote(input.path, noteContent, {
        overwrite: input.overwrite ?? false,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              path: writtenPath,
              message: `Note created at ${writtenPath}`,
            }),
          },
        ],
      };
    },
  );
