/**
 * lib/mcp/canaryMcpClient.ts — PH-12 12.5b-2 (driver Gate 1: client HTTP pentru /api/mcp).
 *
 * Pasul 6 al fluxului: după ce ai access_token-ul (12.5b-1), lovești endpoint-ul MCP autentificat cu `Bearer <token>`
 * și dovedești că serverul răspunde autorizat cu FORMA MCP corectă. Transportul e INJECTAT (`PostJson`) → leaf-ul e
 * testabil complet fără rețea; adaptorul real peste `fetch` intră în orchestrator (12.5b-3).
 *
 * Contractul serverului (recon pe cod): `/api/mcp` = `mcp-handler` (streamable HTTP, JSON-RPC 2.0) montat sub
 * `authenticate(req)` Bearer. Două forme de răspuns tratate agnostic:
 *   1) `application/json` → un singur obiect JSON-RPC;
 *   2) `text/event-stream` (SSE) → una+ ramuri `event: message` / `data: {...}` (SDK-ul MCP răspunde deseori pe SSE).
 * Eroarea de AUTH e la nivel HTTP (401/503/429) cu `{ok:false, error:{code, message}}`; eroarea de PROTOCOL e la
 * nivel JSON-RPC (HTTP 200 cu `{jsonrpc, id, error:{code, message}}`).
 *
 * DOMENIU (leaf, declarat): construiește cererea, parsează răspunsul, validează FORMA (envelope JSON-RPC + shape MCP).
 * Handshake-ul `initialize` → `notifications/initialized` → (session-id, dacă transportul e stateful) NU e făcut aici:
 * `buildJsonRpcRequest`/`buildJsonRpcNotification` sunt generice, deci orchestratorul (12.5b-3) compune handshake-ul cu
 * ACELEAȘI primitive și verifică pe serverul local (12.5b-4) dacă modul stateless chiar acceptă `tools/call` direct.
 *
 * Anti-leak (regula ta): `Bearer <token>` e SECRET și trăiește DOAR în headerul cererii — nu apare niciodată în `reason`.
 * Textele NECONTROLATE nu ajung în `reason`: (1) transport throw → mesaj GENERIC (nu `Error.message`); (2) body HTTP de
 * eroare → DOAR un `error.code` din allowlist-ul de auth (cod scurt, ne-secret), niciodată `message`; (3) eroarea
 * JSON-RPC → DOAR `code`-ul numeric (ne-secret), niciodată `message` (poate reflecta argumentele tool-ului). Zero logging.
 */

/** Răspuns HTTP minimal: status + headere (pt. content-type) + text(). Subset compatibil cu `Response`. */
export interface McpHttpResponse {
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
}
/** Transport injectat: POST application/json cu headere (inclusiv Authorization). Adaptorul real peste `fetch` e în orchestrator. */
export type PostJson = (url: string, body: string, headers: Record<string, string>) => Promise<McpHttpResponse>;

export interface McpClientConfig {
  mcpEndpoint: string; // ex. http://127.0.0.1:<port>/api/mcp
}

/** Rezultatul unui apel MCP orientat-cerere (tools/call, tools/list). */
export type McpCallResult =
  | { ok: true;  content: unknown[]; isError: boolean; structuredContent?: unknown }
  | { ok: false; stage: "transport" | "http" | "parse" | "jsonrpc"; status: number | null; reason: string };

/** Rezultatul unui tools/list (probă de protocol fără efecte). */
export type McpListResult =
  | { ok: true;  tools: Array<{ name: string }> }
  | { ok: false; stage: "transport" | "http" | "parse" | "jsonrpc"; status: number | null; reason: string };

// Coduri de eroare de AUTH pe care serverul le emite (recon authPolicy.ts). DOAR acestea ajung în `reason` la un
// răspuns HTTP de eroare; orice alt `code` (sau `message`) → doar statusul.
const AUTH_ERROR_CODES = new Set([
  "UNAUTHORIZED", "INVALID_TOKEN", "AUTH_UNAVAILABLE", "RATE_LIMITED", "RATE_LIMIT_UNAVAILABLE",
]);

// ────────────────────────────── builders JSON-RPC (generice, refolosite de orchestrator) ──────────────────────────────

/** Cerere JSON-RPC 2.0 (are `id` → serverul RĂSPUNDE). `params` opțional. */
export function buildJsonRpcRequest(id: number | string, method: string, params?: unknown): string {
  const msg: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) msg.params = params;
  return JSON.stringify(msg);
}

/** Notificare JSON-RPC 2.0 (FĂRĂ `id` → serverul NU răspunde; ex. notifications/initialized). */
export function buildJsonRpcNotification(method: string, params?: unknown): string {
  const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) msg.params = params;
  return JSON.stringify(msg);
}

// ────────────────────────────── parser răspuns (JSON + SSE) ──────────────────────────────

/** Ia (case-insensitive) headerul cerut din maparea de headere. */
function header(headers: Record<string, string>, name: string): string {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === want) return typeof v === "string" ? v : "";
  }
  return "";
}

/** Extrage obiectele JSON dintr-un flux SSE: adună liniile `data:` pe eveniment, JSON.parse fiecare. Tolerant la gunoi. */
function extractSseObjects(body: string): unknown[] {
  const out: unknown[] = [];
  for (const ev of body.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = [];
    for (const line of ev.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) continue;
    try { out.push(JSON.parse(dataLines.join("\n"))); } catch { /* data ne-JSON → ignoră (heartbeat/comment) */ }
  }
  return out;
}

/** Toate obiectele JSON-RPC din răspuns, indiferent de encoding (JSON simplu vs SSE). */
function decodeEnvelopes(contentType: string, body: string): unknown[] {
  if (/text\/event-stream/i.test(contentType)) return extractSseObjects(body);
  try {
    const j: unknown = JSON.parse(body);
    return Array.isArray(j) ? j : [j]; // un batch JSON-RPC ar fi array; noi trimitem o cerere → un obiect
  } catch {
    return [];
  }
}

type Envelope =
  | { kind: "result"; result: Record<string, unknown> }
  | { kind: "error";  code: number }
  | { kind: "malformed" };

/** Alege plicul JSON-RPC cu `id`-ul așteptat și îl clasifică (result | error | malformed). Fail-closed. */
function pickEnvelope(objs: unknown[], expectedId: number | string): Envelope {
  for (const o of objs) {
    if (!o || typeof o !== "object") continue;
    const rec = o as Record<string, unknown>;
    if (rec.jsonrpc !== "2.0" || rec.id !== expectedId) continue;
    if (rec.error && typeof rec.error === "object") {
      const code = (rec.error as { code?: unknown }).code;
      return { kind: "error", code: typeof code === "number" ? code : 0 }; // DOAR codul numeric; niciodată message
    }
    if (rec.result && typeof rec.result === "object") {
      return { kind: "result", result: rec.result as Record<string, unknown> };
    }
    return { kind: "malformed" }; // are id-ul nostru dar nici result nici error → contradictoriu
  }
  return { kind: "malformed" };
}

/** Reason fără leak dintr-un body HTTP de eroare de auth: DOAR un `error.code` allowlisted; niciodată `message`. */
function httpErrorReason(status: number, body: string): string {
  try {
    const j: unknown = JSON.parse(body);
    const err = j && typeof j === "object" ? (j as { error?: unknown }).error : undefined;
    const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
    if (typeof code === "string" && AUTH_ERROR_CODES.has(code)) return `HTTP ${status} ${code}`;
  } catch { /* body ne-JSON → doar statusul */ }
  return `HTTP ${status}`;
}

// ────────────────────────────── nucleu: POST JSON-RPC + clasificare comună ──────────────────────────────

type CoreFail = { ok: false; stage: "transport" | "http" | "parse" | "jsonrpc"; status: number | null; reason: string };

/** POST o CERERE JSON-RPC autentificată, clasifică transport/http/parse/jsonrpc; întoarce `result` la succes. */
async function postRequest(
  post: PostJson,
  cfg:  McpClientConfig,
  accessToken: string,
  id: number,
  method: string,
  params: unknown,
): Promise<{ ok: true; result: Record<string, unknown> } | CoreFail> {
  let res: McpHttpResponse;
  try {
    res = await post(cfg.mcpEndpoint, buildJsonRpcRequest(id, method, params), {
      "Content-Type":  "application/json",
      "Accept":        "application/json, text/event-stream", // SDK-ul poate răspunde pe oricare
      "Authorization": `Bearer ${accessToken}`,               // SECRET — doar aici, niciodată în reason
    });
  } catch {
    return { ok: false, stage: "transport", status: null, reason: "transport error" }; // GENERIC (fără Error.message)
  }

  const body = await res.text().catch(() => "");
  if (res.status !== 200) {
    return { ok: false, stage: "http", status: res.status, reason: httpErrorReason(res.status, body) };
  }

  const env = pickEnvelope(decodeEnvelopes(header(res.headers, "content-type"), body), id);
  if (env.kind === "error")     return { ok: false, stage: "jsonrpc", status: 200, reason: `JSON-RPC error ${env.code}` };
  if (env.kind === "malformed") return { ok: false, stage: "parse",   status: 200, reason: "răspuns MCP malformat (envelope JSON-RPC absent/contradictoriu)" };
  return { ok: true, result: env.result };
}

// ────────────────────────────── operații publice ──────────────────────────────

/**
 * Pasul 6: apelează un tool MCP autentificat (`tools/call`). Succesul = HTTP 200 + envelope JSON-RPC `result` cu FORMA
 * MCP `CallToolResult` (`content: []`, `isError?: bool`). `isError` e SURFAȚAT (nu ascuns): un tool care întoarce
 * `isError:true` e răspuns MCP valid la nivel de protocol → ok:true; orchestratorul (care știe tool-ul + argumentele)
 * decide dacă `isError:false` e cerut. Anti-leak: token-ul e doar în header.
 */
export async function callMcpTool(
  post: PostJson,
  cfg:  McpClientConfig,
  args: { accessToken: string; tool: string; toolArgs?: Record<string, unknown> },
): Promise<McpCallResult> {
  const r = await postRequest(post, cfg, args.accessToken, 1, "tools/call", {
    name: args.tool,
    arguments: args.toolArgs ?? {},
  });
  if (!r.ok) return r;

  const content = r.result.content;
  if (!Array.isArray(content)) {
    return { ok: false, stage: "parse", status: 200, reason: "CallToolResult fără `content: []` (formă MCP invalidă)" };
  }
  const rawIsError = r.result.isError;
  if (rawIsError !== undefined && typeof rawIsError !== "boolean") {
    return { ok: false, stage: "parse", status: 200, reason: "CallToolResult `isError` non-boolean (formă invalidă)" };
  }
  const out: McpCallResult = { ok: true, content, isError: rawIsError === true };
  if (r.result.structuredContent !== undefined) out.structuredContent = r.result.structuredContent;
  return out;
}

/**
 * Probă de protocol fără efecte: `tools/list`. Succesul = HTTP 200 + `result.tools: Array<{name:string}>`. Util ca
 * smoke minimal (dovedește token acceptat + rutare MCP) fără a atinge logica vreunui tool.
 */
export async function listMcpTools(
  post: PostJson,
  cfg:  McpClientConfig,
  args: { accessToken: string },
): Promise<McpListResult> {
  const r = await postRequest(post, cfg, args.accessToken, 1, "tools/list", {});
  if (!r.ok) return r;

  const tools = r.result.tools;
  if (!Array.isArray(tools)) {
    return { ok: false, stage: "parse", status: 200, reason: "tools/list fără `tools: []` (formă invalidă)" };
  }
  for (const t of tools) {
    if (!t || typeof t !== "object" || typeof (t as { name?: unknown }).name !== "string") {
      return { ok: false, stage: "parse", status: 200, reason: "tools/list: intrare fără `name: string`" };
    }
  }
  return { ok: true, tools: tools as Array<{ name: string }> };
}
