/**
 * lib/mcp/toolCallLog.ts — lot OAuth staging §9 (S2) / §10: O linie de log per `tools/call`.
 *
 * Format EXACT: `[MCP TOOL] name=<tool> isError=<true|false> structured=<ok|absent|invalid>`
 *   - `isError`    = `true` DOAR dacă rezultatul are `isError === true` (mcpErr, refuz de scope/quota, eroare internă);
 *                    orice altceva (absent, `false`, alt tip) → `false`.
 *   - `structured` = starea `structuredContent` (contractul PH-14 / `PREFLIGHT_OUTPUT_SCHEMA`: succesul are `ok: true`):
 *       `absent`  → câmpul lipsește / e `undefined` / `null` (forma normală a erorilor `mcpErr`);
 *       `ok`      → obiect (non-array) cu `ok === true`;
 *       `invalid` → prezent dar altceva (primitiv, array, obiect fără `ok: true`).
 *     Linia NU revalidează schema completă (SDK-ul face asta după handler); `ok` aici = forma de succes declarată.
 *
 * Decizii:
 *   - Fără argumente, fără `content`, fără `text`, fără id-uri de client/user, fără tokenuri: doar numele tool-ului
 *     (constantă din cod, la înregistrare) și două stări închise. Linia e evidența S2 din proba manuală.
 *   - Numele e sanitizat la `[A-Za-z0-9_.-]` (altceva → `?`, max 64): un nume nu poate injecta câmpuri sau linii noi.
 *   - Frunză PURĂ (zero importuri) → testabilă în tsx. Apelul de log e în `createInstrumentedServer` (middleware.ts),
 *     punctul central prin care trec TOATE tool-urile, pe TOATE căile de ieșire (refuz scope, quota, succes, excepție).
 */

export type StructuredState = "ok" | "absent" | "invalid";

export const TOOL_CALL_LOG_PREFIX = "[MCP TOOL]";

/** Starea `structuredContent` a unui rezultat de tool (vezi header). Totală pe `unknown`. */
export function classifyStructuredContent(result: unknown): StructuredState {
  if (typeof result !== "object" || result === null) return "absent";
  const sc = (result as Record<string, unknown>).structuredContent;
  if (sc === undefined || sc === null) return "absent";
  if (typeof sc !== "object" || Array.isArray(sc)) return "invalid";
  return (sc as Record<string, unknown>).ok === true ? "ok" : "invalid";
}

/** `true` DOAR pentru `isError === true` strict. */
export function resultIsError(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as Record<string, unknown>).isError === true;
}

/** Numele tool-ului, sigur pentru o linie de log cu câmpuri `k=v`. */
export function sanitizeToolName(name: unknown): string {
  if (typeof name !== "string" || name === "") return "?";
  return name.slice(0, 64).replace(/[^A-Za-z0-9_.-]/g, "?");
}

/** Linia de log pentru un `tools/call` terminat. Nu citește nimic în afară de `isError` și `structuredContent`. */
export function formatToolCallLog(name: unknown, result: unknown): string {
  return `${TOOL_CALL_LOG_PREFIX} name=${sanitizeToolName(name)} isError=${resultIsError(result)} structured=${classifyStructuredContent(result)}`;
}
