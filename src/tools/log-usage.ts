/**
 * log_usage tool — Record token usage and cost for an agent operation.
 *
 * Usage records are markdown notes in the Usage/ folder with structured
 * YAML frontmatter. They track input/output tokens, model, cost, and
 * duration for individual agent operations. If a task_id is provided,
 * a summary is also appended to that task's Agent Log.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { Config } from "../config.js";
import { serializeNote, parseNote } from "../frontmatter.js";
import { safeToolHandler } from "../errors.js";
import { nowISO, appendToAgentLog } from "../task-schema.js";
import { scanTasks } from "../task-dashboard.js";

export const logUsageSchema = {
  agent_id: z.string().describe(
    "Which agent is reporting usage.",
  ),
  task_id: z.string().optional().describe(
    "Task this usage is for.",
  ),
  project_id: z.string().optional().describe(
    "Project this usage is for.",
  ),
  input_tokens: z.number().describe(
    "Input tokens consumed.",
  ),
  output_tokens: z.number().describe(
    "Output tokens consumed.",
  ),
  model: z.string().optional().describe(
    "LLM model used.",
  ),
  cost_usd: z.number().optional().describe(
    "Estimated cost in USD.",
  ),
  duration_seconds: z.number().optional().describe(
    "How long the operation took in seconds.",
  ),
  notes: z.string().optional().describe(
    "Free-text notes about this usage record.",
  ),
};

export const logUsageHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: {
      agent_id: string;
      task_id?: string;
      project_id?: string;
      input_tokens: number;
      output_tokens: number;
      model?: string;
      cost_usd?: number;
      duration_seconds?: number;
      notes?: string;
    }) => {
      const folder = config.usageFolder;
      const now = nowISO();
      const date = now.split("T")[0];
      const rand = Math.random().toString(36).substring(2, 8);
      const id = `usage-${date}-${rand}`;
      const filePath = `${folder}/${id}.md`;

      // Build frontmatter
      const frontmatter: Record<string, unknown> = {
        id,
        agent_id: input.agent_id,
        input_tokens: input.input_tokens,
        output_tokens: input.output_tokens,
        timestamp: now,
      };

      if (input.task_id) frontmatter.task_id = input.task_id;
      if (input.project_id) frontmatter.project_id = input.project_id;
      if (input.model) frontmatter.model = input.model;
      if (input.cost_usd !== undefined) frontmatter.cost_usd = input.cost_usd;
      if (input.duration_seconds !== undefined) frontmatter.duration_seconds = input.duration_seconds;

      // Build body
      const parts: string[] = [];

      parts.push("## Description");
      parts.push("");
      parts.push(input.notes || `Usage record for agent ${input.agent_id}.`);
      parts.push("");

      const content = serializeNote(frontmatter, parts.join("\n"));
      await vault.writeNote(filePath, content, { overwrite: false });

      // If task_id is provided, append usage entry to the task's Agent Log
      if (input.task_id) {
        try {
          const tasks = await scanTasks(vault, config.tasksFolder);
          const entry = tasks.find((t) => t.task.id === input.task_id);
          if (entry) {
            const raw = await vault.readNote(entry.path);
            const parsed = parseNote(raw);
            const modelStr = input.model ? ` (${input.model})` : "";
            const logText = `Usage: ${input.input_tokens} in / ${input.output_tokens} out${modelStr}`;
            const updatedContent = appendToAgentLog(parsed.content, logText);
            const newContent = serializeNote(parsed.frontmatter, updatedContent);
            await vault.writeNote(entry.path, newContent, { overwrite: true });
          }
        } catch {
          // Best-effort — don't fail the usage log if task update fails
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            usage: {
              id,
              agent_id: input.agent_id,
              task_id: input.task_id,
              project_id: input.project_id,
              input_tokens: input.input_tokens,
              output_tokens: input.output_tokens,
              model: input.model,
              cost_usd: input.cost_usd,
              duration_seconds: input.duration_seconds,
              path: filePath,
              timestamp: now,
            },
            message: `Usage logged: ${id} (${input.input_tokens} in / ${input.output_tokens} out)`,
          }, null, 2),
        }],
      };
    },
  );
