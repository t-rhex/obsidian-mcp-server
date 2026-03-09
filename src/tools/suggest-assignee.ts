/**
 * suggest_assignee tool — Find the best agents for a given task.
 *
 * Reads the task's type and tags, scans all registered agents, and
 * uses capability-based matching to rank them. Returns the top 5
 * suggestions with scores and reasons.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { Config } from "../config.js";
import { safeToolHandler } from "../errors.js";
import { scanAgents, matchAgents } from "../agent-registry.js";
import { scanTasks } from "../task-dashboard.js";

export const suggestAssigneeSchema = {
  task_id: z.string().describe(
    "The task ID to find suitable agents for (e.g. 'task-2026-03-09-abc123').",
  ),
};

export const suggestAssigneeHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: { task_id: string }) => {
      const tasksFolder = config.tasksFolder;
      const agentsFolder = config.agentsFolder;

      // Find the task by ID
      const allTasks = await scanTasks(vault, tasksFolder);
      const entry = allTasks.find((t) => t.task.id === input.task_id);

      if (!entry) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "TASK_NOT_FOUND",
              message: `No task found with ID: ${input.task_id}`,
            }),
          }],
          isError: true,
        };
      }

      const { task } = entry;

      // Scan all registered agents
      const allAgents = await scanAgents(vault, agentsFolder);

      if (allAgents.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              task_id: task.id,
              title: task.title,
              type: task.type,
              tags: task.tags,
              suggestions: [],
              message: "No agents registered. Use register_agent to add agent profiles.",
            }, null, 2),
          }],
        };
      }

      // Match agents to the task
      const agents = allAgents.map((a) => a.agent);
      const ranked = matchAgents(agents, task.type, task.tags);

      // Return top 5
      const top = ranked.slice(0, 5);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            task_id: task.id,
            title: task.title,
            type: task.type,
            tags: task.tags,
            suggestions: top.map((match) => ({
              agent_id: match.agent.id,
              score: match.score,
              reasons: match.reasons,
              status: match.agent.status,
              current_tasks: match.agent.current_tasks,
              max_concurrent: match.agent.max_concurrent,
              capabilities: match.agent.capabilities,
            })),
            total_agents_scanned: allAgents.length,
            total_matches: ranked.length,
            message: top.length > 0
              ? `Found ${ranked.length} matching agent(s). Top suggestion: ${top[0].agent.id} (score: ${top[0].score}).`
              : "No suitable agents found. All agents are either offline, at capacity, or have no matching capabilities.",
          }, null, 2),
        }],
      };
    },
  );
