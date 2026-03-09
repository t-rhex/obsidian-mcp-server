/**
 * list_agents tool — Query registered agents with optional filters.
 *
 * Returns agent profiles from the Agents/ folder, filtered by
 * capability, tag, status, or availability. Useful for discovering
 * which agents are available for task assignment.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { Config } from "../config.js";
import { safeToolHandler } from "../errors.js";
import { scanAgents } from "../agent-registry.js";

export const listAgentsSchema = {
  capability: z.string().optional().describe(
    "Filter by capability (e.g. 'code', 'research'). Only agents with this capability are returned.",
  ),
  available_only: z.boolean().optional().default(false).describe(
    "Only return agents with open task slots (current_tasks < max_concurrent). Default: false.",
  ),
  tag: z.string().optional().describe(
    "Filter by specialization tag (e.g. 'typescript', 'react').",
  ),
  status: z.enum(["active", "idle", "offline", "all"]).optional().default("all").describe(
    "Filter by agent status. Default: all.",
  ),
};

export const listAgentsHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: {
      capability?: string;
      available_only?: boolean;
      tag?: string;
      status?: "active" | "idle" | "offline" | "all";
    }) => {
      const agentsFolder = config.agentsFolder;
      const allAgents = await scanAgents(vault, agentsFolder);

      let filtered = allAgents;

      // Filter by capability
      if (input.capability) {
        filtered = filtered.filter((entry) =>
          entry.agent.capabilities.includes(input.capability!),
        );
      }

      // Filter by tag
      if (input.tag) {
        filtered = filtered.filter((entry) =>
          entry.agent.tags.includes(input.tag!),
        );
      }

      // Filter by status
      if (input.status && input.status !== "all") {
        filtered = filtered.filter((entry) =>
          entry.agent.status === input.status,
        );
      }

      // Filter by availability
      if (input.available_only) {
        filtered = filtered.filter((entry) =>
          entry.agent.current_tasks < entry.agent.max_concurrent,
        );
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            total: filtered.length,
            agents: filtered.map((entry) => ({
              id: entry.agent.id,
              status: entry.agent.status,
              capabilities: entry.agent.capabilities,
              tags: entry.agent.tags,
              max_concurrent: entry.agent.max_concurrent,
              current_tasks: entry.agent.current_tasks,
              available_slots: entry.agent.max_concurrent - entry.agent.current_tasks,
              model: entry.agent.model || null,
              description: entry.agent.description || null,
              tasks_completed: entry.agent.tasks_completed,
              tasks_failed: entry.agent.tasks_failed,
              last_seen: entry.agent.last_seen || null,
              path: entry.path,
            })),
          }, null, 2),
        }],
      };
    },
  );
