/**
 * log_discovery tool — Capture a discovery, gotcha, or TIL in the vault.
 *
 * Discoveries are structured notes in the Discoveries/ folder that persist
 * knowledge learned during development. They capture:
 * - What was discovered (the fact)
 * - How it was discovered (the context)
 * - Why it matters (the impact)
 * - What to do about it (the recommendation)
 *
 * Future agents can find these via get_context or search_vault to avoid
 * re-discovering the same things.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { Config } from "../config.js";
import { serializeNote } from "../frontmatter.js";
import { safeToolHandler } from "../errors.js";
import { nowISO, slugify } from "../task-schema.js";

export const logDiscoverySchema = {
  title: z.string().describe(
    "Short title for the discovery (e.g. 'macOS /tmp is a symlink to /private/tmp', " +
    "'gray-matter crashes on undefined values').",
  ),
  discovery: z.string().describe(
    "What was discovered? State the finding clearly.",
  ),
  context: z.string().optional().describe(
    "How was this discovered? What were you doing when you found this?",
  ),
  impact: z.enum(["critical", "high", "medium", "low"]).optional().default("medium").describe(
    "How impactful is this discovery? Critical = breaks things if ignored. Default: medium.",
  ),
  recommendation: z.string().optional().describe(
    "What should be done about this? A concrete action or pattern to follow.",
  ),
  category: z.enum(["bug", "gotcha", "pattern", "tool", "config", "performance", "security", "other"]).optional().default("gotcha").describe(
    "Type of discovery. Default: gotcha.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Tags for categorization (e.g. 'macos', 'yaml', 'typescript').",
  ),
  project: z.string().optional().describe(
    "Project ID this discovery relates to.",
  ),
  task_id: z.string().optional().describe(
    "Task ID during which this was discovered.",
  ),
  source: z.string().optional().default("agent").describe(
    "Who made this discovery (e.g. 'agent', 'human', 'agent-claude-1').",
  ),
  related_files: z.array(z.string()).optional().describe(
    "File paths related to this discovery (code files, config files, etc.).",
  ),
};

export const logDiscoveryHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: {
      title: string;
      discovery: string;
      context?: string;
      impact?: string;
      recommendation?: string;
      category?: string;
      tags?: string[];
      project?: string;
      task_id?: string;
      source?: string;
      related_files?: string[];
    }) => {
      const folder = config.discoveriesFolder;
      const now = nowISO();
      const datePrefix = now.split("T")[0];
      const slug = slugify(input.title);
      const fileName = `${datePrefix}-${slug}.md`;
      const filePath = `${folder}/${fileName}`;

      // Build frontmatter
      const frontmatter: Record<string, unknown> = {
        title: input.title,
        category: input.category ?? "gotcha",
        impact: input.impact ?? "medium",
        created: now,
        updated: now,
        source: input.source ?? "agent",
      };

      if (input.tags && input.tags.length > 0) frontmatter.tags = input.tags;
      if (input.project) frontmatter.project = input.project;
      if (input.task_id) frontmatter.task_id = input.task_id;
      if (input.related_files && input.related_files.length > 0) {
        frontmatter.related_files = input.related_files;
      }

      // Build body
      const parts: string[] = [];

      parts.push("## Discovery");
      parts.push("");
      parts.push(input.discovery);
      parts.push("");

      if (input.context) {
        parts.push("## Context");
        parts.push("");
        parts.push(input.context);
        parts.push("");
      }

      if (input.recommendation) {
        parts.push("## Recommendation");
        parts.push("");
        parts.push(input.recommendation);
        parts.push("");
      }

      if (input.related_files && input.related_files.length > 0) {
        parts.push("## Related Files");
        parts.push("");
        for (const f of input.related_files) {
          parts.push(`- \`${f}\``);
        }
        parts.push("");
      }

      const content = serializeNote(frontmatter, parts.join("\n"));
      await vault.writeNote(filePath, content, { overwrite: false });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            discovery: {
              title: input.title,
              category: input.category ?? "gotcha",
              impact: input.impact ?? "medium",
              path: filePath,
              created: now,
            },
            message: `Discovery logged: "${input.title}" (${filePath})`,
          }, null, 2),
        }],
      };
    },
  );
