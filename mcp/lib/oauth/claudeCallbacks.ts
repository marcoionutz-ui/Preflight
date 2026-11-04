/**
 * lib/oauth/claudeCallbacks.ts — lotul OAuth staging (design rev3 §3): callback-urile EXACTE ale hosted apps Claude.
 *
 * Frunză PURĂ (zero I/O, zero importuri) → tsx-testabilă. Politica de redirect pentru clienții `public` (CIMD fixat,
 * §2) e o listă închisă de DOUĂ valori, în cod (nu în variabile de mediu) → aceeași în staging și producție.
 *
 * Comparația e pe ȘIR EXACT (`===`): fără trim, fără normalizare URL (slash final, port implicit, case pe host),
 * fără prefix, fără wildcard, fără excepția loopback RFC 8252 (Claude Code / loopback sunt în afara beta-ului, O3).
 * Orice altă formă — chiar echivalentă semantic după parsare — e refuzată: un URI care nu e octet-cu-octet unul
 * dintre cele două NU e un callback Claude.
 */

/** Callback-urile OAuth ale hosted apps Claude (claude.ai, Desktop, mobile, Cowork). Ordinea e cea canonică. */
export const CLAUDE_CALLBACKS: readonly string[] = Object.freeze([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);

/** True DOAR dacă `uri` e un string identic (===) cu unul dintre `CLAUDE_CALLBACKS`. Non-string → false. */
export function isClaudeCallback(uri: unknown): boolean {
  if (typeof uri !== "string") return false;
  for (const cb of CLAUDE_CALLBACKS) if (uri === cb) return true;
  return false;
}
