/**
 * Frontmatter parsing and serialization for Obsidian markdown notes.
 *
 * Uses gray-matter for YAML frontmatter extraction.
 * Handles malformed frontmatter gracefully — never crashes, always recovers.
 */

import matter from "gray-matter";

export interface ParsedNote {
  /** YAML frontmatter as a plain object */
  frontmatter: Record<string, unknown>;
  /** Note body (markdown content after frontmatter) */
  content: string;
  /** Whether the note had valid frontmatter */
  hasFrontmatter: boolean;
  /** Tags extracted from frontmatter and inline #tags */
  tags: string[];
}

/**
 * Parse a raw note string into frontmatter + content.
 * Gracefully handles missing or malformed frontmatter.
 */
export function parseNote(raw: string): ParsedNote {
  let frontmatter: Record<string, unknown> = {};
  let content = raw;
  let hasFrontmatter = false;

  try {
    const parsed = matter(raw);
    if (parsed.data && typeof parsed.data === "object") {
      frontmatter = parsed.data as Record<string, unknown>;
      content = parsed.content;
      hasFrontmatter = Object.keys(frontmatter).length > 0 || raw.startsWith("---");
    }
  } catch {
    // Malformed frontmatter — treat entire content as body
    content = raw;
  }

  const tags = extractTags(frontmatter, content);

  return { frontmatter, content, hasFrontmatter, tags };
}

/**
 * Serialize frontmatter and content back into a raw note string.
 */
export function serializeNote(
  frontmatter: Record<string, unknown>,
  content: string,
): string {
  const hasFm = Object.keys(frontmatter).length > 0;

  if (!hasFm) return content;

  // EDGE-9: Trim leading newlines from content to prevent accumulating blank lines
  const result = matter.stringify(content.replace(/^\n+/, ''), frontmatter);
  return result;
}

/**
 * Extract tags from both frontmatter `tags` field and inline #tags in content.
 * Deduplicates and normalizes (lowercase, no leading #).
 */
function extractTags(
  frontmatter: Record<string, unknown>,
  content: string,
): string[] {
  const tagSet = new Set<string>();

  // From frontmatter
  const fmTags = frontmatter.tags;
  if (Array.isArray(fmTags)) {
    for (const tag of fmTags) {
      if (typeof tag === "string") {
        tagSet.add(normalizeTag(tag));
      }
    }
  } else if (typeof fmTags === "string") {
    // Handle comma-separated string format
    for (const tag of fmTags.split(",")) {
      const trimmed = tag.trim();
      if (trimmed) tagSet.add(normalizeTag(trimmed));
    }
  }

  // EDGE-4: Strip fenced code blocks and inline code before scanning for tags
  const strippedContent = content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '');

  // From inline #tags in content
  // Matches #tag but not inside code blocks or URLs
  const inlineTagRegex = /(?:^|\s)#([a-zA-Z0-9_\-/]+)/g;
  let match;
  while ((match = inlineTagRegex.exec(strippedContent)) !== null) {
    tagSet.add(normalizeTag(match[1]));
  }

  // EDGE-6: Filter out empty strings that normalizeTag might produce
  tagSet.delete("");

  return Array.from(tagSet).sort();
}

/**
 * Normalize a tag: remove leading #, lowercase.
 */
function normalizeTag(tag: string): string {
  return tag.replace(/^#+/, "").toLowerCase().trim();
}

/**
 * Add tags to a note's frontmatter (deduplicates).
 * Returns the updated frontmatter object.
 */
export function addTags(
  frontmatter: Record<string, unknown>,
  newTags: string[],
): Record<string, unknown> {
  const existing = getFrontmatterTags(frontmatter);
  const combined = new Set(existing.map(normalizeTag));
  for (const tag of newTags) {
    combined.add(normalizeTag(tag));
  }
  return {
    ...frontmatter,
    tags: Array.from(combined).sort(),
  };
}

/**
 * Remove tags from a note's frontmatter.
 * Returns the updated frontmatter object.
 */
export function removeTags(
  frontmatter: Record<string, unknown>,
  tagsToRemove: string[],
): Record<string, unknown> {
  const existing = getFrontmatterTags(frontmatter);
  const removeSet = new Set(tagsToRemove.map(normalizeTag));
  const remaining = existing.filter((t) => !removeSet.has(normalizeTag(t)));

  const updated = { ...frontmatter };
  if (remaining.length === 0) {
    delete updated.tags;
  } else {
    updated.tags = remaining;
  }
  return updated;
}

/**
 * Get tags from frontmatter as a string array.
 */
function getFrontmatterTags(frontmatter: Record<string, unknown>): string[] {
  const fmTags = frontmatter.tags;
  if (Array.isArray(fmTags)) {
    return fmTags.filter((t): t is string => typeof t === "string");
  }
  if (typeof fmTags === "string") {
    return fmTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}
