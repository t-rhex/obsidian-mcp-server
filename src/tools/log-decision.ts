/**
 * log_decision tool — Create a structured decision record in the vault.
 *
 * Decisions are lightweight ADRs (Architecture Decision Records) stored
 * as markdown notes in the Decisions/ folder. They capture:
 * - What was decided
 * - Why (context and rationale)
 * - What alternatives were considered
 * - What the consequences are
 *
 * Future agents can query these to understand WHY the codebase is the
 * way it is, not just WHAT it does.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { Config } from "../config.js";
import { serializeNote } from "../frontmatter.js";
import { safeToolHandler } from "../errors.js";
import { nowISO, slugify } from "../task-schema.js";

export const logDecisionSchema = {
  title: z.string().describe(
    "Short title for the decision (e.g. 'Use JWT over session tokens', 'Adopt Zod for validation').",
  ),
  context: z.string().describe(
    "What is the situation? What problem are we solving? What constraints exist?",
  ),
  decision: z.string().describe(
    "What was decided? State the decision clearly and directly.",
  ),
  alternatives: z.array(z.string()).optional().describe(
    "What other options were considered? Brief description of each.",
  ),
  consequences: z.array(z.string()).optional().describe(
    "What are the consequences of this decision? Both positive and negative.",
  ),
  status: z.enum(["proposed", "accepted", "deprecated", "superseded"]).optional().default("accepted").describe(
    "Decision status. Default: accepted.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Tags for categorization (e.g. 'auth', 'architecture', 'performance').",
  ),
  project: z.string().optional().describe(
    "Project ID this decision relates to.",
  ),
  task_id: z.string().optional().describe(
    "Task ID that prompted this decision.",
  ),
  supersedes: z.string().optional().describe(
    "Path to a previous decision this one supersedes.",
  ),
  source: z.string().optional().default("agent").describe(
    "Who made this decision (e.g. 'agent', 'human', 'agent-claude-1').",
  ),
};

export const logDecisionHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: {
      title: string;
      context: string;
      decision: string;
      alternatives?: string[];
      consequences?: string[];
      status?: string;
      tags?: string[];
      project?: string;
      task_id?: string;
      supersedes?: string;
      source?: string;
    }) => {
      const folder = config.decisionsFolder;
      const now = nowISO();
      const datePrefix = now.split("T")[0];
      const slug = slugify(input.title);
      const fileName = `${datePrefix}-${slug}.md`;
      const filePath = `${folder}/${fileName}`;

      // Build frontmatter
      const frontmatter: Record<string, unknown> = {
        title: input.title,
        status: input.status ?? "accepted",
        created: now,
        updated: now,
        source: input.source ?? "agent",
      };

      if (input.tags && input.tags.length > 0) frontmatter.tags = input.tags;
      if (input.project) frontmatter.project = input.project;
      if (input.task_id) frontmatter.task_id = input.task_id;
      if (input.supersedes) frontmatter.supersedes = input.supersedes;

      // Build body
      const parts: string[] = [];

      parts.push("## Context");
      parts.push("");
      parts.push(input.context);
      parts.push("");

      parts.push("## Decision");
      parts.push("");
      parts.push(input.decision);
      parts.push("");

      if (input.alternatives && input.alternatives.length > 0) {
        parts.push("## Alternatives Considered");
        parts.push("");
        for (const alt of input.alternatives) {
          parts.push(`- ${alt}`);
        }
        parts.push("");
      }

      if (input.consequences && input.consequences.length > 0) {
        parts.push("## Consequences");
        parts.push("");
        for (const con of input.consequences) {
          parts.push(`- ${con}`);
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
            decision: {
              title: input.title,
              status: input.status ?? "accepted",
              path: filePath,
              created: now,
            },
            message: `Decision logged: "${input.title}" (${filePath})`,
          }, null, 2),
        }],
      };
    },
  );
