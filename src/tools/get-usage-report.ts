/**
 * get_usage_report tool — Aggregate token usage and cost across agents,
 * tasks, and projects.
 *
 * Scans all usage records in the Usage/ folder, filters by the provided
 * criteria, and returns totals grouped by agent and model.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { Config } from "../config.js";
import { parseNote } from "../frontmatter.js";
import { safeToolHandler } from "../errors.js";

export const getUsageReportSchema = {
  project_id: z.string().optional().describe(
    "Filter by project.",
  ),
  agent_id: z.string().optional().describe(
    "Filter by agent.",
  ),
  task_id: z.string().optional().describe(
    "Filter by task.",
  ),
  from_date: z.string().optional().describe(
    "Start date (ISO or YYYY-MM-DD).",
  ),
  to_date: z.string().optional().describe(
    "End date (ISO or YYYY-MM-DD).",
  ),
};

interface UsageRecord {
  id: string;
  agent_id: string;
  task_id?: string;
  project_id?: string;
  input_tokens: number;
  output_tokens: number;
  model?: string;
  cost_usd?: number;
  duration_seconds?: number;
  timestamp: string;
}

interface GroupBucket {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  count: number;
}

export const getUsageReportHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: {
      project_id?: string;
      agent_id?: string;
      task_id?: string;
      from_date?: string;
      to_date?: string;
    }) => {
      const folder = config.usageFolder;

      // Scan usage folder for all .md files
      let entries;
      try {
        entries = await vault.list(folder, {
          recursive: false,
          extensionFilter: [".md", ".markdown"],
        });
      } catch {
        // Folder doesn't exist yet — return empty report
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              report: {
                total_input_tokens: 0,
                total_output_tokens: 0,
                total_cost_usd: 0,
                record_count: 0,
                by_agent: {},
                by_model: {},
              },
              message: "No usage records found.",
            }, null, 2),
          }],
        };
      }

      // Parse all usage records
      const records: UsageRecord[] = [];

      for (const entry of entries) {
        if (entry.type !== "file") continue;

        try {
          const raw = await vault.readNote(entry.path);
          const parsed = parseNote(raw);
          const fm = parsed.frontmatter;

          // Skip files that don't have input_tokens in frontmatter
          if (typeof fm.input_tokens !== "number") continue;

          records.push({
            id: String(fm.id ?? ""),
            agent_id: String(fm.agent_id ?? "unknown"),
            task_id: fm.task_id ? String(fm.task_id) : undefined,
            project_id: fm.project_id ? String(fm.project_id) : undefined,
            input_tokens: fm.input_tokens as number,
            output_tokens: typeof fm.output_tokens === "number" ? fm.output_tokens : 0,
            model: fm.model ? String(fm.model) : undefined,
            cost_usd: typeof fm.cost_usd === "number" ? fm.cost_usd : undefined,
            duration_seconds: typeof fm.duration_seconds === "number" ? fm.duration_seconds : undefined,
            timestamp: String(fm.timestamp ?? ""),
          });
        } catch {
          // Skip unreadable files
        }
      }

      // Filter by criteria
      let filtered = records;

      if (input.project_id) {
        filtered = filtered.filter((r) => r.project_id === input.project_id);
      }
      if (input.agent_id) {
        filtered = filtered.filter((r) => r.agent_id === input.agent_id);
      }
      if (input.task_id) {
        filtered = filtered.filter((r) => r.task_id === input.task_id);
      }
      if (input.from_date) {
        const from = new Date(input.from_date).getTime();
        filtered = filtered.filter((r) => new Date(r.timestamp).getTime() >= from);
      }
      if (input.to_date) {
        const to = new Date(input.to_date).getTime();
        filtered = filtered.filter((r) => new Date(r.timestamp).getTime() <= to);
      }

      // Aggregate totals
      let total_input_tokens = 0;
      let total_output_tokens = 0;
      let total_cost_usd = 0;

      const byAgent: Record<string, GroupBucket> = {};
      const byModel: Record<string, GroupBucket> = {};

      for (const record of filtered) {
        total_input_tokens += record.input_tokens;
        total_output_tokens += record.output_tokens;
        total_cost_usd += record.cost_usd ?? 0;

        // Group by agent
        const agentKey = record.agent_id;
        if (!byAgent[agentKey]) {
          byAgent[agentKey] = { input_tokens: 0, output_tokens: 0, cost_usd: 0, count: 0 };
        }
        byAgent[agentKey].input_tokens += record.input_tokens;
        byAgent[agentKey].output_tokens += record.output_tokens;
        byAgent[agentKey].cost_usd += record.cost_usd ?? 0;
        byAgent[agentKey].count += 1;

        // Group by model
        const modelKey = record.model ?? "unknown";
        if (!byModel[modelKey]) {
          byModel[modelKey] = { input_tokens: 0, output_tokens: 0, cost_usd: 0, count: 0 };
        }
        byModel[modelKey].input_tokens += record.input_tokens;
        byModel[modelKey].output_tokens += record.output_tokens;
        byModel[modelKey].cost_usd += record.cost_usd ?? 0;
        byModel[modelKey].count += 1;
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            report: {
              total_input_tokens,
              total_output_tokens,
              total_cost_usd: Math.round(total_cost_usd * 1_000_000) / 1_000_000,
              record_count: filtered.length,
              by_agent: byAgent,
              by_model: byModel,
            },
            filters_applied: {
              project_id: input.project_id ?? null,
              agent_id: input.agent_id ?? null,
              task_id: input.task_id ?? null,
              from_date: input.from_date ?? null,
              to_date: input.to_date ?? null,
            },
            message: `Usage report: ${filtered.length} records, ${total_input_tokens} input / ${total_output_tokens} output tokens.`,
          }, null, 2),
        }],
      };
    },
  );
