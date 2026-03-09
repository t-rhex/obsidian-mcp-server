/**
 * manage_tags tool — Read, add, or remove tags from a note's frontmatter.
 * Handles deduplication and normalization automatically.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { addTags, parseNote, removeTags, serializeNote } from "../frontmatter.js";
import { safeToolHandler } from "../errors.js";

export const manageTagsSchema = {
  path: z.string().describe(
    "Path to the note, relative to vault root.",
  ),
  action: z.enum(["list", "add", "remove"]).describe(
    "'list' to view tags, 'add' to add tags, 'remove' to remove tags.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Tags to add or remove (without leading #). Required for 'add' and 'remove' actions.",
  ),
};

export const manageTagsHandler = (vault: Vault) =>
  safeToolHandler(
    async (input: { path: string; action: "list" | "add" | "remove"; tags?: string[] }) => {
      const raw = await vault.readNote(input.path);
      const parsed = parseNote(raw);

      if (input.action === "list") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                path: vault.ensureNoteExtension(input.path),
                tags: parsed.tags,
                frontmatterTags: Array.isArray(parsed.frontmatter.tags)
                  ? parsed.frontmatter.tags
                  : [],
                inlineTags: parsed.tags.filter((t) => {
                  const fmTags = parsed.frontmatter.tags;
                  if (!Array.isArray(fmTags)) return true;
                  const normalized = fmTags
                    .filter((ft): ft is string => typeof ft === "string")
                    .map((ft) => ft.toLowerCase().replace(/^#/, ""));
                  return !normalized.includes(t);
                }),
              }),
            },
          ],
        };
      }

      if (!input.tags || input.tags.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "MISSING_TAGS",
                message: "The 'tags' parameter is required for 'add' and 'remove' actions.",
              }),
            },
          ],
          isError: true,
        };
      }

      let updatedFrontmatter: Record<string, unknown>;
      if (input.action === "add") {
        updatedFrontmatter = addTags(parsed.frontmatter, input.tags);
      } else {
        updatedFrontmatter = removeTags(parsed.frontmatter, input.tags);
      }

      const serialized = serializeNote(updatedFrontmatter, parsed.content);
      await vault.writeNote(input.path, serialized, { overwrite: true });

      const updatedParsed = parseNote(serialized);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              path: vault.ensureNoteExtension(input.path),
              action: input.action,
              tagsModified: input.tags,
              currentTags: updatedParsed.tags,
            }),
          },
        ],
      };
    },
  );
