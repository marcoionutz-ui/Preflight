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

/**
 * PH-7: mesajul generic returnat clientului pentru o eroare INTERNĂ neașteptată. Stabil (nu variază cu inputul)
 * ca să nu scurgem detalii interne.
 */
export const GENERIC_TOOL_ERROR = "An internal error occurred while processing the request.";

/**
 * PH-7: eroarea REALĂ a unui tool (hostname Redis, detalii Supabase, stack) rămâne DOAR în logul server-side —
 * clientul primește `GENERIC_TOOL_ERROR`. Fără asta, `mcpErr(ERR.INTERNAL, e.message)` reflecta excepția brută în
 * răspunsul MCP (scurgere de internals). Leaf PUR (`log` injectat) → testabil; analog `sanitizeTokenError` (E5).
 */
export function sanitizeToolError(
  err: unknown,
  log: (label: string, detail: unknown) => void = console.error,
): string {
  log("[MCP TOOL ERROR]", err instanceof Error ? (err.stack ?? err.message) : err);
  return GENERIC_TOOL_ERROR;
}

export function mcpErr(code: string, message: string, extra?: Record<string, unknown>): { content: McpContent; isError: true } {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ ok: false, error: { code, message, ...extra } }),
    }],
    // `isError` e câmpul standard MCP pentru semnalarea unui tool call eșuat
    // — fără el, un client vede doar text JSON cu `ok:false` îngropat în el
    // și poate interpreta apelul ca reușit.
    isError: true,
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
  INVALID_TOKEN:    "INVALID_TOKEN",
  RATE_LIMITED:     "RATE_LIMITED",
  FORBIDDEN:        "FORBIDDEN",
  QUOTA_EXCEEDED:   "QUOTA_EXCEEDED",
  // E10 — bounded degradation → fail-closed când Redis nu poate aplica gate-ul.
  // Distincte semantic de omologii lor „limită reală atinsă": UNAVAILABLE = „nu pot verifica", nu „ai depășit".
  AUTH_UNAVAILABLE:       "AUTH_UNAVAILABLE",
  RATE_LIMIT_UNAVAILABLE: "RATE_LIMIT_UNAVAILABLE",
  QUOTA_UNAVAILABLE:      "QUOTA_UNAVAILABLE",
} as const;