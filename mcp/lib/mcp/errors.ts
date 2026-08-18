/**
 * lib/mcp/errors.ts
 * Structured ok/error envelope pentru toate tool responses.
 *
 * PH-14: răspunsul de SUCCES e expus ȘI ca `structuredContent` (obiect real) pe lângă blocul `text` (backwards-compat
 * + human display), iar tool-urile declară `outputSchema` (PREFLIGHT_OUTPUT_SCHEMA, STRICT succes) → clientul primește
 * output TIPAT, nu doar un blob JSON în `content.text`. Tool-urile de date trec payload-ul structurat prin `data`.
 * Erorile (isError:true) NU poartă `structuredContent` — vezi mcpErr pentru motivul de conformitate cu clientul SDK.
 */
import { z } from "zod";

export type McpContent = { type: "text"; text: string }[];

export type McpConfidence = "LOW" | "MEDIUM" | "HIGH";

export type McpDataQuality = {
  wsFlow?:    "present" | "partial" | "absent";
  risk?:      "cached" | "stale" | "missing";
  liquidity?: "confirmed" | "estimated" | "unknown";
};

/**
 * PH-14: meta-ul unui răspuns de SUCCES. `freshnessSec`/`coverageNote` sunt `.nullable()` INTENȚIONAT:
 * `null` = „necunoscut explicit" (worker viu dar fără dată), distinct de câmp absent = „nu se aplică". mcpResponse
 * păstrează `null`; doar `undefined` elimină cheia (vezi mai jos).
 */
const PREFLIGHT_META_SCHEMA = z.object({
  freshnessSec: z.number().nullable().optional(),
  confidence:   z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  coverageNote: z.string().nullable().optional(),
  warnings:     z.array(z.string()).optional(),
  dataQuality:  z.object({
    wsFlow:    z.enum(["present", "partial", "absent"]).optional(),
    risk:      z.enum(["cached", "stale", "missing"]).optional(),
    liquidity: z.enum(["confirmed", "estimated", "unknown"]).optional(),
  }).optional(),
  evidence:     z.record(z.string(), z.unknown()).optional(),
}).optional();

/**
 * PH-14: schema de OUTPUT publicată clienților și validată de SDK pe `structuredContent` (`outputSchema` pe fiecare
 * tool). SDK-ul validează structuredContent DOAR pentru răspunsuri de SUCCES — un răspuns cu `isError:true` sare
 * peste validare (server/mcp.ts: `if (result.isError) return;`). Deci `outputSchema` descrie STRICT forma de succes:
 *   { ok:true, format:"preflight.response.v1", text, data?, meta? }
 * `ok`/`format` sunt LITERALE (nu boolean/string liber) și obiectul e `.strict()` → validează exact această formă și
 * RESPINGE combinații contradictorii: `{ok:false}`, `{ok:true, error:{...}}`, succes fără `text`/`format`.
 * `data` rămâne `z.unknown()` — envelope-ul e tipat, tiparea payload-ului per-tool e follow-up separat (nu PH-14).
 */
export const PREFLIGHT_OUTPUT_SCHEMA = z.object({
  ok:     z.literal(true),
  format: z.literal("preflight.response.v1"),
  text:   z.string(),
  data:   z.unknown().optional(),
  meta:   PREFLIGHT_META_SCHEMA,
}).strict();

/**
 * PH-14: envelope-ul de EROARE. NU e publicat prin `outputSchema` (SDK-ul sare peste validarea erorilor), dar îl
 * ținem strict pentru guard-urile interne/teste: `ok:false` literal + `error` OBLIGATORIU cu `code`+`message`.
 * `error` acceptă câmpuri extra (`retryAfter`) prin catchall; top-level `.strict()` respinge un `{ok:false}` gol sau
 * un `{ok:false, ...succes...}` hibrid.
 */
export const preflightErrorEnvelopeSchema = z.object({
  ok:    z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }).catchall(z.unknown()),
}).strict();

export function mcpOk(data: unknown): { content: McpContent; structuredContent: Record<string, unknown> } {
  const structured: Record<string, unknown> =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { ok: true, text: typeof data === "string" ? data : JSON.stringify(data) };
  return {
    content: [{
      type: "text" as const,
      text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
    }],
    structuredContent: structured,
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
  const payload = { ok: false as const, error: { code, message, ...extra } };
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(payload),
    }],
    // PH-14 (cgpt R1 #1): NU expunem `structuredContent` pe erori. `outputSchema` descrie STRICT forma de SUCCES,
    // iar un client SDK conform validează ORICE `structuredContent` prezent față de outputSchema, INCLUSIV pe
    // răspunsuri isError (client/index.ts: validează dacă `result.structuredContent` există, indiferent de isError).
    // Un envelope {ok:false,error} ar fi respins de acel client (lipsă format/text, ok≠true). Contractul MCP: erorile
    // poartă `isError:true` + `content.text` (aici JSON {ok:false,error{code,message,...extra}} — pe deplin
    // machine-readable). Serverul sare validarea outputSchema pe isError; clientul sare verificarea de
    // structuredContent-lipsă pe isError. `preflightErrorEnvelopeSchema` validează forma acestui text-payload în teste.
    isError: true,
  };
}

export function mcpResponse(params: {
  text:           string;
  data?:          unknown;         // PH-14: payload structurat (tool-urile de date), pe lângă `text` (human/compat)
  freshnessSec?:  number | null;
  confidence?:    McpConfidence;
  coverageNote?:  string | null;
  warnings?:      string[];
  dataQuality?:   McpDataQuality;
  evidence?:      Record<string, unknown>;
}): { content: McpContent; structuredContent: Record<string, unknown> } {
  const {
    text, data, freshnessSec, confidence,
    coverageNote, warnings, dataQuality, evidence,
  } = params;

  const meta: Record<string, unknown> = {};

  // PH-14 (cgpt R1 #2): `null` e SEMNIFICATIV (necunoscut explicit) → păstrat în meta; doar `undefined` elimină
  // cheia. Schema declară freshnessSec/coverageNote `.nullable()`, deci `null` validează. Înainte, `!== null`
  // ștergea distincția „necunoscut" vs „necompletat".
  if (freshnessSec !== undefined)                        meta.freshnessSec = freshnessSec; // păstrează null
  if (confidence   !== undefined)                        meta.confidence   = confidence;
  if (coverageNote !== undefined)                        meta.coverageNote = coverageNote; // păstrează null
  if (warnings     !== undefined && warnings.length > 0) meta.warnings     = warnings;
  if (dataQuality  !== undefined)                        meta.dataQuality  = dataQuality;
  if (evidence     !== undefined)                        meta.evidence     = evidence;

  const envelope: Record<string, unknown> = { ok: true, format: "preflight.response.v1", text, meta };
  if (data !== undefined) envelope.data = data; // PH-14: expune payload-ul structurat în structuredContent

  return mcpOk(envelope);
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
