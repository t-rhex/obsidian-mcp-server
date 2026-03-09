/**
 * read_note tool — Read a note's content, frontmatter, tags, and metadata.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { parseNote } from "../frontmatter.js";
import { safeToolHandler } from "../errors.js";

export const readNoteSchema = {
  path: z.string().describe(
    "Path to the note relative to vault root (e.g. 'Projects/my-note.md'). " +
    "Extension .md is added automatically if missing.",
  ),
  includeRaw: z.boolean().optional().default(false).describe(
    "If true, include the raw unparsed content in the response.",
  ),
};

export const readNoteHandler = (vault: Vault) =>
  safeToolHandler(async (input: { path: string; includeRaw?: boolean }) => {
    const raw = await vault.readNote(input.path);
    const parsed = parseNote(raw);
    const stats = await vault.stat(vault.ensureNoteExtension(input.path));

    const result: Record<string, unknown> = {
      path: vault.ensureNoteExtension(input.path),
      frontmatter: parsed.frontmatter,
      content: parsed.content,
      tags: parsed.tags,
      hasFrontmatter: parsed.hasFrontmatter,
      stats: {
        size: stats.size,
        createdAt: stats.createdAt,
        modifiedAt: stats.modifiedAt,
      },
    };

    if (input.includeRaw) {
      result.raw = raw;
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  });
