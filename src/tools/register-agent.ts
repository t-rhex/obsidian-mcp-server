/**
 * register_agent tool — Register or update an agent profile.
 *
 * Creates a new agent profile in the Agents/ folder, or updates an
 * existing one if the agent_id already exists. Agent profiles store
 * capabilities, tags, and metadata used for task routing.
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { Config } from "../config.js";
import { safeToolHandler } from "../errors.js";
import { ensureAgentProfile } from "../agent-registry.js";

export const registerAgentSchema = {
  agent_id: z.string().describe(
    "Unique identifier for the agent (e.g. 'claude-code-1', 'research-agent').",
  ),
  capabilities: z.array(z.string()).optional().describe(
    "Task types this agent can handle (e.g. ['code', 'research', 'writing']).",
  ),
  tags: z.array(z.string()).optional().describe(
    "Specialization tags (e.g. ['typescript', 'react', 'database']).",
  ),
  max_concurrent: z.number().optional().describe(
    "Maximum number of parallel tasks this agent can handle. Default: 3.",
  ),
  model: z.string().optional().describe(
    "LLM model name powering this agent (e.g. 'claude-opus-4-6', 'gpt-4o').",
  ),
  description: z.string().optional().describe(
    "Human-readable description of what this agent does.",
  ),
};

export const registerAgentHandler = (vault: Vault, config: Config) =>
  safeToolHandler(
    async (input: {
      agent_id: string;
      capabilities?: string[];
      tags?: string[];
      max_concurrent?: number;
      model?: string;
      description?: string;
    }) => {
      const agentsFolder = config.agentsFolder;

      const result = await ensureAgentProfile(
        vault,
        agentsFolder,
        input.agent_id,
        {
          capabilities: input.capabilities,
          tags: input.tags,
          max_concurrent: input.max_concurrent,
          model: input.model,
          description: input.description,
        },
      );

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            action: result.created ? "created" : "updated",
            path: result.path,
            agent: result.agent,
            message: result.created
              ? `Agent "${input.agent_id}" registered successfully.`
              : `Agent "${input.agent_id}" profile updated.`,
          }, null, 2),
        }],
      };
    },
  );
