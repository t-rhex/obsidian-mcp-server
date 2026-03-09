/**
 * update_note tool — Update an existing note's content.
 * Supports full replacement, appending, or prepending.
 * Can also update frontmatter fields selectively.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { parseNote, serializeNote } from "../frontmatter.js";
import { safeToolHandler } from "../errors.js";

export const updateNoteSchema = {
  path: z.string().describe(
    "Path to the note to update, relative to vault root.",
  ),
  content: z.string().optional().describe(
    "New content for the note body. Behavior depends on 'mode'.",
  ),
  mode: z.enum(["replace", "append", "prepend"]).optional().default("replace").describe(
    "How to apply the content: 'replace' overwrites the body, " +
    "'append' adds to end, 'prepend' adds to beginning. Default: replace.",
  ),
  frontmatter: z.record(z.string(), z.unknown()).optional().describe(
    "Frontmatter fields to merge into the existing frontmatter. " +
    "Existing fields not specified here are preserved.",
  ),
};

export const updateNoteHandler = (vault: Vault) =>
  safeToolHandler(
    async (input: {
      path: string;
      content?: string;
      mode?: "replace" | "append" | "prepend";
      frontmatter?: Record<string, unknown>;
    }) => {
      const raw = await vault.readNote(input.path);
      const parsed = parseNote(raw);
      const mode = input.mode ?? "replace";

      // Determine new content
      let newContent: string;
      if (input.content !== undefined) {
        switch (mode) {
          case "append":
            newContent = parsed.content + "\n" + input.content;
            break;
          case "prepend":
            newContent = input.content + "\n" + parsed.content;
            break;
          case "replace":
          default:
            newContent = input.content;
            break;
        }
      } else {
        newContent = parsed.content;
      }

      // Merge frontmatter
      const newFrontmatter = input.frontmatter
        ? { ...parsed.frontmatter, ...input.frontmatter }
        : parsed.frontmatter;

      const serialized = serializeNote(newFrontmatter, newContent);
      const writtenPath = await vault.writeNote(input.path, serialized, {
        overwrite: true,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              path: writtenPath,
              mode,
              message: `Note updated (${mode}) at ${writtenPath}`,
            }),
          },
        ],
      };
    },
  );
