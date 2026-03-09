/**
 * daily_note tool — Get or create daily notes by date.
 * Uses configurable folder and date format.
 * Supports today, yesterday, tomorrow, or arbitrary dates.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { Config } from "../config.js";
import { parseNote, serializeNote } from "../frontmatter.js";
import { safeToolHandler } from "../errors.js";

export const dailyNoteSchema = {
  action: z.enum(["get", "create", "append"]).describe(
    "'get' to read, 'create' to create/overwrite, 'append' to add content to existing.",
  ),
  date: z.string().optional().describe(
    "Date for the daily note. Accepts 'today', 'yesterday', 'tomorrow', " +
    "or a date string like '2025-03-08'. Defaults to 'today'.",
  ),
  content: z.string().optional().describe(
    "Content for the daily note. Required for 'create' and 'append' actions.",
  ),
  frontmatter: z.record(z.string(), z.unknown()).optional().describe(
    "Optional frontmatter for the note (only used with 'create' action).",
  ),
};

export const dailyNoteHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: {
      action: "get" | "create" | "append";
      date?: string;
      content?: string;
      frontmatter?: Record<string, unknown>;
    }) => {
      const dateStr = resolveDate(input.date ?? "today");
      const notePath = buildDailyNotePath(config, dateStr);

      if (input.action === "get") {
        const exists = await vault.exists(notePath);
        if (!exists) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  exists: false,
                  date: dateStr,
                  path: notePath,
                  message: `No daily note found for ${dateStr}`,
                }),
              },
            ],
          };
        }

        const raw = await vault.readNote(notePath);
        const parsed = parseNote(raw);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                exists: true,
                date: dateStr,
                path: notePath,
                frontmatter: parsed.frontmatter,
                content: parsed.content,
                tags: parsed.tags,
              }, null, 2),
            },
          ],
        };
      }

      if (input.action === "create") {
        const body = input.content ?? "";
        const fm = input.frontmatter ?? { date: dateStr };
        const serialized = serializeNote(fm, body);
        await vault.writeNote(notePath, serialized, { overwrite: true });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                date: dateStr,
                path: notePath,
                message: `Daily note created for ${dateStr}`,
              }),
            },
          ],
        };
      }

      if (input.action === "append") {
        if (!input.content) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "MISSING_CONTENT",
                  message: "Content is required for 'append' action.",
                }),
              },
            ],
            isError: true,
          };
        }

        const exists = await vault.exists(notePath);
        if (!exists) {
          // Create the note if it doesn't exist
          const fm = { date: dateStr };
          const serialized = serializeNote(fm, input.content);
          await vault.writeNote(notePath, serialized, { overwrite: false });
        } else {
          await vault.appendNote(notePath, input.content);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                date: dateStr,
                path: notePath,
                message: exists
                  ? `Content appended to daily note for ${dateStr}`
                  : `Daily note created and content added for ${dateStr}`,
              }),
            },
          ],
        };
      }

      // Should never reach here due to zod validation, but just in case
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "INVALID_ACTION", message: `Unknown action: ${input.action}` }),
          },
        ],
        isError: true,
      };
    },
  );

/**
 * Resolve a human-readable date reference to YYYY-MM-DD format.
 */
function resolveDate(input: string): string {
  const lower = input.toLowerCase().trim();
  const now = new Date();

  switch (lower) {
    case "today":
      return formatDate(now);
    case "yesterday": {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      return formatDate(d);
    }
    case "tomorrow": {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      return formatDate(d);
    }
    default: {
      // Try to parse as a date
      // Force local time interpretation to avoid timezone offset issues
      const parsed = new Date(input + "T00:00:00");
      if (isNaN(parsed.getTime())) {
        // If parsing fails, return the input as-is (maybe already formatted)
        return input;
      }
      return formatDate(parsed);
    }
  }
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildDailyNotePath(config: Config, dateStr: string): string {
  const folder = config.dailyNoteFolder;
  return folder ? `${folder}/${dateStr}.md` : `${dateStr}.md`;
}
