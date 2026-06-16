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

export type McpConfidence = "LOW" | "MEDIUM" | "HIGH";

export type McpDataQuality = {
  wsFlow?:    "present" | "partial" | "absent";
  risk?:      "cached" | "stale" | "missing";
  liquidity?: "confirmed" | "estimated" | "unknown";
};

export function mcpResponse(params: {
  text:           string;
  freshnessSec?:  number | null;
  confidence?:    McpConfidence;
  coverageNote?:  string | null;
  warnings?:      string[];
  dataQuality?:   McpDataQuality;
  evidence?:      Record<string, unknown>;
}): { content: McpContent } {
  const {
    text, freshnessSec, confidence,
    coverageNote, warnings, dataQuality, evidence,
  } = params;

  const meta: Record<string, unknown> = {};

  if (freshnessSec !== undefined && freshnessSec !== null) meta.freshnessSec = freshnessSec;
  if (confidence   !== undefined)                          meta.confidence   = confidence;
  if (coverageNote !== undefined && coverageNote !== null) meta.coverageNote = coverageNote;
  if (warnings     !== undefined && warnings.length > 0)  meta.warnings     = warnings;
  if (dataQuality  !== undefined)                         meta.dataQuality  = dataQuality;
  if (evidence     !== undefined)                         meta.evidence     = evidence;

  return mcpOk({
    ok:     true,
    format: "preflight.response.v1",
    text,
    meta,
  });
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
  QUOTA_EXCEEDED:   "QUOTA_EXCEEDED",
} as const;