/**
 * lib/mcp/scopes.ts
 * Tool → scope mapping
 * MVP: read:all pentru toate toolurile
 * Future: read:pipeline, read:market, read:pair, read:safety, read:reports
 */

// Core public tools — accesibile cu read:basic
// Advanced / internal — necesită read:all sau scope granular dedicat

export const TOOL_SCOPES: Record<string, string[]> = {
  // ── Core public (6 tools) ─────────────────────────────────────────────────
  tp_situation_report:  ["read:basic", "read:all", "read:reports"],
  tp_next_action:       ["read:basic", "read:all", "read:reports"],
  tp_candidate_brief:   ["read:basic", "read:all", "read:reports"],
  tp_late_move_context: ["read:basic", "read:all", "read:pipeline"],
  tp_preflight_safety:  ["read:basic", "read:all", "read:safety"],
  tp_watch_pair:        ["read:basic", "read:all"],

  // ── Advanced / internal ───────────────────────────────────────────────────
  tp_health_check:      ["read:all", "read:market"],
  tp_market_overview:   ["read:all", "read:market"],
  tp_worker_pipeline:   ["read:all", "read:pipeline"],
  tp_worker_snapshot:   ["read:all", "read:pipeline"],
  tp_pair_context:      ["read:all", "read:pair"],
  tp_why_not:           ["read:all", "read:reports"],
  tp_recent_pipeline_drops: ["read:all", "read:reports"],
  tp_position_context:  ["read:all", "read:positions"],
  tp_chain_report:      ["read:all", "read:reports", "read:market"],
};

/**
 * Verifică dacă clientul are scope-ul necesar pentru un tool.
 * Clientul e autorizat dacă are cel puțin unul din scope-urile acceptate.
 */
export function hasScope(clientScopes: string[], toolName: string): boolean {
  const required = TOOL_SCOPES[toolName];
  if (!required) return false; // tool necunoscut — deny by default
  return required.some(s => clientScopes.includes(s));
}

/**
 * E10: entitlement pe DOUĂ straturi — tool-ul e permis DOAR dacă ȘI tokenul (scope-urile clientului) ȘI planul
 * rezolvat (`allowed_scopes`) îl permit. Un plan necunoscut degradat la `free_trial` (allowed_scopes = read:basic)
 * restrânge astfel efectiv accesul, nu doar quota — chiar dacă tokenul poartă `read:all`. Fără OR-ul periculos:
 * ambele verificări trec prin `hasScope` (scope ∈ lista acceptată a tool-ului), niciodată „scope == toolScope".
 */
export function toolAuthorized(toolName: string, tokenScopes: string[], planScopes: string[]): boolean {
  return hasScope(tokenScopes, toolName) && hasScope(planScopes, toolName);
}