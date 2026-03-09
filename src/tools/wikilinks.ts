/**
 * wikilinks tool — Resolve [[wikilinks]], find backlinks, and discover connections.
 *
 * This is essential for navigating Obsidian vaults the way users do.
 * Supports:
 *   - [[note]]           → simple link
 *   - [[note|alias]]     → aliased link
 *   - [[note#heading]]   → heading link
 *   - [[note#^blockid]]  → block reference
 */

import { z } from "zod";
import { Vault } from "../vault.js";
import { parseNote } from "../frontmatter.js";
import { safeToolHandler } from "../errors.js";
import { basename, extname } from "node:path";

export const wikilinksSchema = {
  action: z.enum(["resolve", "backlinks", "outlinks", "unresolved"]).describe(
    "'resolve' — find the file a [[wikilink]] points to. " +
    "'backlinks' — find all notes linking to a given note. " +
    "'outlinks' — list all wikilinks in a note. " +
    "'unresolved' — find all wikilinks in the vault that don't point to existing notes.",
  ),
  path: z.string().optional().describe(
    "Note path (for 'backlinks' and 'outlinks' actions). " +
    "For 'resolve', this is the wikilink target to resolve (e.g. 'My Note').",
  ),
  limit: z.number().optional().default(50).describe(
    "Maximum number of results. Default: 50.",
  ),
};

/** Regex to match [[wikilinks]] including aliases and headings */
const WIKILINK_REGEX = /\[\[([^\]|#]+?)(?:#([^\]|]*?))?(?:\|([^\]]*?))?\]\]/g;

export interface WikiLink {
  /** Raw target (e.g. "My Note") */
  target: string;
  /** Optional heading (e.g. "Section 1") */
  heading?: string;
  /** Optional display alias */
  alias?: string;
  /** Line number where the link appears */
  line: number;
}

/**
 * Extract all wikilinks from a note's raw content.
 * Skips wikilinks inside code blocks.
 */
function extractWikilinks(raw: string): WikiLink[] {
  // Strip code blocks before scanning
  const stripped = raw
    .replace(/```[\s\S]*?```/g, (match) => "\n".repeat(match.split("\n").length - 1))
    .replace(/`[^`]*`/g, "");

  const links: WikiLink[] = [];
  const lines = stripped.split("\n");

  for (let i = 0; i < lines.length; i++) {
    WIKILINK_REGEX.lastIndex = 0;
    let match;
    while ((match = WIKILINK_REGEX.exec(lines[i])) !== null) {
      links.push({
        target: match[1].trim(),
        heading: match[2]?.trim() || undefined,
        alias: match[3]?.trim() || undefined,
        line: i + 1,
      });
    }
  }

  return links;
}

/**
 * Try to resolve a wikilink target to an actual file in the vault.
 * Obsidian resolves links by matching basenames (shortest unique path).
 */
async function resolveWikilink(
  vault: Vault,
  target: string,
): Promise<string | null> {
  // Get all note files
  const entries = await vault.list("", {
    recursive: true,
    extensionFilter: [".md", ".markdown"],
  });

  const files = entries.filter((e) => e.type === "file");
  const targetLower = target.toLowerCase();

  // 1. Exact path match (with or without extension)
  for (const f of files) {
    const pathNoExt = f.path.replace(/\.(md|markdown)$/, "");
    if (pathNoExt.toLowerCase() === targetLower || f.path.toLowerCase() === targetLower) {
      return f.path;
    }
  }

  // 2. Basename match (Obsidian's default resolution)
  for (const f of files) {
    const name = basename(f.path, extname(f.path));
    if (name.toLowerCase() === targetLower) {
      return f.path;
    }
  }

  return null;
}

export const wikilinksHandler = (vault: Vault) =>
  safeToolHandler(
    async (input: { action: string; path?: string; limit?: number }) => {
      const maxResults = input.limit ?? 50;

      // ─── resolve: Find what file a [[wikilink]] points to ─────────
      if (input.action === "resolve") {
        if (!input.path) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "MISSING_PATH", message: "Provide the wikilink target to resolve in the 'path' parameter." }) }],
            isError: true,
          };
        }

        const resolved = await resolveWikilink(vault, input.path);

        if (!resolved) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                target: input.path,
                resolved: false,
                message: `No note found matching [[${input.path}]]`,
              }),
            }],
          };
        }

        const raw = await vault.readNote(resolved);
        const parsed = parseNote(raw);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              target: input.path,
              resolved: true,
              path: resolved,
              frontmatter: parsed.frontmatter,
              tags: parsed.tags,
              outlinks: extractWikilinks(raw).map((l) => l.target),
            }, null, 2),
          }],
        };
      }

      // ─── backlinks: Find all notes linking TO a given note ────────
      if (input.action === "backlinks") {
        if (!input.path) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "MISSING_PATH", message: "Provide the note path to find backlinks for." }) }],
            isError: true,
          };
        }

        const targetPath = vault.ensureNoteExtension(input.path);
        const targetName = basename(targetPath, extname(targetPath)).toLowerCase();

        // Get all notes
        const entries = await vault.list("", {
          recursive: true,
          extensionFilter: [".md", ".markdown"],
        });

        const backlinks: { source: string; links: { line: number; context: string }[] }[] = [];

        for (const entry of entries) {
          if (entry.type !== "file") continue;
          if (backlinks.length >= maxResults) break;

          try {
            const raw = await vault.readNote(entry.path);
            const links = extractWikilinks(raw);
            const lines = raw.split("\n");

            const matchingLinks = links.filter((l) => {
              const lt = l.target.toLowerCase();
              const pathNoExt = targetPath.replace(/\.(md|markdown)$/, "").toLowerCase();
              return lt === targetName || lt === pathNoExt || lt === targetPath.toLowerCase();
            });

            if (matchingLinks.length > 0) {
              backlinks.push({
                source: entry.path,
                links: matchingLinks.map((l) => ({
                  line: l.line,
                  context: (lines[l.line - 1] || "").substring(0, 200),
                })),
              });
            }
          } catch {
            // Skip unreadable files
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              target: input.path,
              totalBacklinks: backlinks.length,
              backlinks,
            }, null, 2),
          }],
        };
      }

      // ─── outlinks: List all wikilinks FROM a note ─────────────────
      if (input.action === "outlinks") {
        if (!input.path) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "MISSING_PATH", message: "Provide the note path to extract outlinks from." }) }],
            isError: true,
          };
        }

        const raw = await vault.readNote(input.path);
        const links = extractWikilinks(raw);

        // Try to resolve each link
        const resolved = await Promise.all(
          links.slice(0, maxResults).map(async (link) => {
            const target = await resolveWikilink(vault, link.target);
            return {
              target: link.target,
              heading: link.heading,
              alias: link.alias,
              line: link.line,
              resolved: target !== null,
              resolvedPath: target,
            };
          }),
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              source: vault.ensureNoteExtension(input.path),
              totalLinks: links.length,
              links: resolved,
            }, null, 2),
          }],
        };
      }

      // ─── unresolved: Find broken wikilinks across vault ───────────
      if (input.action === "unresolved") {
        const entries = await vault.list("", {
          recursive: true,
          extensionFilter: [".md", ".markdown"],
        });

        const unresolved: { source: string; brokenLinks: string[] }[] = [];
        let totalBroken = 0;

        for (const entry of entries) {
          if (entry.type !== "file") continue;
          if (totalBroken >= maxResults) break;

          try {
            const raw = await vault.readNote(entry.path);
            const links = extractWikilinks(raw);
            const broken: string[] = [];

            for (const link of links) {
              const target = await resolveWikilink(vault, link.target);
              if (!target) {
                broken.push(link.target);
                totalBroken++;
                if (totalBroken >= maxResults) break;
              }
            }

            if (broken.length > 0) {
              unresolved.push({
                source: entry.path,
                brokenLinks: [...new Set(broken)],
              });
            }
          } catch {
            // Skip unreadable files
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              totalBrokenLinks: totalBroken,
              files: unresolved,
            }, null, 2),
          }],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "INVALID_ACTION", message: `Unknown action: ${input.action}` }) }],
        isError: true,
      };
    },
  );
