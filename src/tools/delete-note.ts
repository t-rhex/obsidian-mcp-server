/**
 * delete_note tool — Delete a note from the vault.
 * By default, moves to .trash/ (Obsidian convention) instead of permanent delete.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { safeToolHandler } from "../errors.js";

export const deleteNoteSchema = {
  path: z.string().describe(
    "Path to the note to delete, relative to vault root.",
  ),
  permanent: z.boolean().optional().default(false).describe(
    "If true, permanently delete the file instead of moving to .trash/. " +
    "Default is false (moves to trash).",
  ),
};

export const deleteNoteHandler = (vault: Vault) =>
  safeToolHandler(async (input: { path: string; permanent?: boolean }) => {
    const result = await vault.deleteNote(input.path, { permanent: input.permanent });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            path: result.path,
            trashed: result.trashed,
            message: result.trashed
              ? `Note moved to .trash/: ${result.path}`
              : `Note permanently deleted: ${result.path}`,
          }),
        },
      ],
    };
  });
