/**
 * Centralized error types for the Obsidian MCP server.
 * Every error carries a machine-readable `code` so tool handlers
 * can return structured, actionable error messages to the LLM.
 */

export enum ErrorCode {
  VAULT_NOT_FOUND = "VAULT_NOT_FOUND",
  NOTE_NOT_FOUND = "NOTE_NOT_FOUND",
  NOTE_ALREADY_EXISTS = "NOTE_ALREADY_EXISTS",
  PATH_TRAVERSAL = "PATH_TRAVERSAL",
  INVALID_PATH = "INVALID_PATH",
  INVALID_FRONTMATTER = "INVALID_FRONTMATTER",
  WRITE_FAILED = "WRITE_FAILED",
  DELETE_FAILED = "DELETE_FAILED",
  SEARCH_TIMEOUT = "SEARCH_TIMEOUT",
  SEARCH_FAILED = "SEARCH_FAILED",
  CONFIG_INVALID = "CONFIG_INVALID",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  FILE_TOO_LARGE = "FILE_TOO_LARGE",
  GIT_NOT_INITIALIZED = "GIT_NOT_INITIALIZED",
  GIT_COMMAND_FAILED = "GIT_COMMAND_FAILED",
  GIT_CONFLICT = "GIT_CONFLICT",
  GIT_PUSH_FAILED = "GIT_PUSH_FAILED",
  GIT_TIMEOUT = "GIT_TIMEOUT",
  GIT_NOT_INSTALLED = "GIT_NOT_INSTALLED",
}

export class VaultError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "VaultError";
    this.code = code;
    this.details = details;
  }

  /** Format for MCP tool error responses */
  toToolResponse(): { type: "text"; text: string }[] {
    return [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: this.code,
          message: this.message,
          ...(this.details ? { details: this.details } : {}),
        }),
      },
    ];
  }
}

/**
 * Wrap an async tool handler so unhandled errors become structured responses
 * instead of crashing the server.
 */
export function safeToolHandler<T>(
  fn: (input: T) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>,
): (input: T) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  return async (input: T) => {
    try {
      return await fn(input);
    } catch (err) {
      if (err instanceof VaultError) {
        return { content: err.toToolResponse(), isError: true };
      }
      const message =
        err instanceof Error ? err.message : "An unknown error occurred";
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "INTERNAL_ERROR", message }),
          },
        ],
        isError: true,
      };
    }
  };
}
