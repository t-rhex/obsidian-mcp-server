/**
 * Agent registry — stored agent profiles for capability-based routing.
 *
 * Agent profiles are markdown notes in the Agents/ folder with structured
 * YAML frontmatter. Agents can self-register or be auto-registered when
 * they first claim a task.
 */

import { Vault } from "./vault.js";
import { parseNote, serializeNote } from "./frontmatter.js";
import { nowISO, TaskType } from "./task-schema.js";
import type { TaskEntry } from "./task-dashboard.js";

export interface AgentProfile {
  id: string;
  status: "active" | "idle" | "offline";
  capabilities: string[];
  tags: string[];
  max_concurrent: number;
  current_tasks: number;
  model: string;
  registered: string;
  last_seen: string;
  tasks_completed: number;
  tasks_failed: number;
  description: string;
}

/**
 * Parse raw frontmatter into an AgentProfile.
 * Returns null if the frontmatter doesn't look like an agent profile.
 */
export function parseAgentProfile(fm: Record<string, unknown>): AgentProfile | null {
  if (!fm.id || typeof fm.id !== "string") return null;

  return {
    id: String(fm.id),
    status: (["active", "idle", "offline"].includes(fm.status as string)
      ? fm.status
      : "active") as AgentProfile["status"],
    capabilities: Array.isArray(fm.capabilities)
      ? fm.capabilities.map(String)
      : [],
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
    max_concurrent: typeof fm.max_concurrent === "number" ? fm.max_concurrent : 3,
    current_tasks: typeof fm.current_tasks === "number" ? fm.current_tasks : 0,
    model: fm.model ? String(fm.model) : "",
    registered: fm.registered ? String(fm.registered) : "",
    last_seen: fm.last_seen ? String(fm.last_seen) : "",
    tasks_completed: typeof fm.tasks_completed === "number" ? fm.tasks_completed : 0,
    tasks_failed: typeof fm.tasks_failed === "number" ? fm.tasks_failed : 0,
    description: fm.description ? String(fm.description) : "",
  };
}

/**
 * Scan the agents folder and return all agent profiles.
 */
export async function scanAgents(
  vault: Vault,
  agentsFolder: string,
): Promise<Array<{ path: string; agent: AgentProfile }>> {
  const results: Array<{ path: string; agent: AgentProfile }> = [];

  try {
    const entries = await vault.list(agentsFolder, {
      recursive: false,
      extensionFilter: [".md", ".markdown"],
    });

    for (const entry of entries) {
      if (entry.type !== "file") continue;

      try {
        const raw = await vault.readNote(entry.path);
        const parsed = parseNote(raw);
        const agent = parseAgentProfile(parsed.frontmatter);
        if (agent) {
          results.push({ path: entry.path, agent });
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Folder doesn't exist yet — that's fine
  }

  return results;
}

/**
 * Build the file path for an agent profile note.
 */
export function buildAgentPath(agentsFolder: string, agentId: string): string {
  const safe = agentId.replace(/[^a-z0-9_-]/gi, "-").substring(0, 80);
  return `${agentsFolder}/${safe}.md`;
}

/**
 * Build frontmatter for an agent profile.
 */
export function buildAgentFrontmatter(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  const now = nowISO();
  return {
    id: overrides.id,
    status: overrides.status ?? "active",
    capabilities: overrides.capabilities ?? [],
    tags: overrides.tags ?? [],
    max_concurrent: overrides.max_concurrent ?? 3,
    current_tasks: overrides.current_tasks ?? 0,
    model: overrides.model ?? "",
    registered: overrides.registered ?? now,
    last_seen: overrides.last_seen ?? now,
    tasks_completed: overrides.tasks_completed ?? 0,
    tasks_failed: overrides.tasks_failed ?? 0,
    description: overrides.description ?? "",
  };
}

/**
 * Match agents to a task based on capability overlap and availability.
 * Returns agents sorted by match score (highest first).
 */
export function matchAgents(
  agents: AgentProfile[],
  taskType: string,
  taskTags: string[],
): Array<{ agent: AgentProfile; score: number; reasons: string[] }> {
  const results: Array<{ agent: AgentProfile; score: number; reasons: string[] }> = [];

  for (const agent of agents) {
    if (agent.status === "offline") continue;
    if (agent.current_tasks >= agent.max_concurrent) continue;

    let score = 0;
    const reasons: string[] = [];

    // Type match
    if (agent.capabilities.includes(taskType)) {
      score += 10;
      reasons.push(`capability match: ${taskType}`);
    }

    // Tag overlap
    const tagOverlap = taskTags.filter((t) => agent.tags.includes(t));
    if (tagOverlap.length > 0) {
      score += tagOverlap.length * 3;
      reasons.push(`tag match: ${tagOverlap.join(", ")}`);
    }

    // Availability bonus (fewer current tasks = better)
    const availabilityScore = agent.max_concurrent - agent.current_tasks;
    score += availabilityScore;
    reasons.push(`${availabilityScore} slots available`);

    // Success rate bonus
    const total = agent.tasks_completed + agent.tasks_failed;
    if (total > 0) {
      const successRate = agent.tasks_completed / total;
      score += Math.round(successRate * 5);
      reasons.push(`${Math.round(successRate * 100)}% success rate`);
    }

    // Idle agents get a small bonus
    if (agent.status === "idle") {
      score += 2;
      reasons.push("idle");
    }

    if (score > 0) {
      results.push({ agent, score, reasons });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Auto-register or update an agent's profile.
 * Used by claim_task for unregistered agents.
 */
export async function ensureAgentProfile(
  vault: Vault,
  agentsFolder: string,
  agentId: string,
  update?: Partial<AgentProfile>,
): Promise<{ path: string; agent: AgentProfile; created: boolean }> {
  const agentPath = buildAgentPath(agentsFolder, agentId);
  const now = nowISO();

  try {
    // Try to read existing profile
    const raw = await vault.readNote(agentPath);
    const parsed = parseNote(raw);
    const existing = parseAgentProfile(parsed.frontmatter);

    if (existing) {
      // Update existing profile
      const updatedFm: Record<string, unknown> = {
        ...parsed.frontmatter,
        last_seen: now,
        ...update,
      };
      // Strip undefined
      const clean = Object.fromEntries(
        Object.entries(updatedFm).filter(([, v]) => v !== undefined),
      ) as Record<string, unknown>;
      const content = serializeNote(clean, parsed.content);
      await vault.writeNote(agentPath, content, { overwrite: true });
      const updated = parseAgentProfile(clean)!;
      return { path: agentPath, agent: updated, created: false };
    }
  } catch {
    // Profile doesn't exist — create a new one
  }

  // Create new profile
  const profile = buildAgentFrontmatter({
    id: agentId,
    ...update,
    registered: now,
    last_seen: now,
  });

  const fmClean = Object.fromEntries(
    Object.entries(profile).filter(([, v]) => v !== undefined),
  ) as Record<string, unknown>;

  const body = `## Agent: ${agentId}\n\n_Auto-registered on first task claim._\n`;
  const content = serializeNote(fmClean, body);
  await vault.writeNote(agentPath, content, { overwrite: false });

  return { path: agentPath, agent: profile, created: true };
}
