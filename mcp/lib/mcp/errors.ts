/**
 * lib/mcp/errors.ts
 * Structured ok/error envelope pentru toate tool responses
 */

export type McpContent = { type: "text"; text: string }[];

export function mcpOk(data: unknown): { content: McpContent } {
  return {
    content: [{
      type: "text" as const,
      text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
    }],
  };
}

export function mcpErr(code: string, message: string, extra?: Record<string, unknown>): { content: McpContent } {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ ok: false, error: { code, message, ...extra } }),
    }],
  };
}

// Error codes standard
export const ERR = {
  REDIS_DOWN:       "REDIS_DOWN",
  NOT_FOUND:        "NOT_FOUND",
  INVALID_INPUT:    "INVALID_INPUT",
  EXTERNAL_API:     "EXTERNAL_API",
  INTERNAL:         "INTERNAL",
  UNAUTHORIZED:     "UNAUTHORIZED",
  RATE_LIMITED:     "RATE_LIMITED",
  FORBIDDEN:        "FORBIDDEN",
} as const;